// Road grade statistics: how steep the graded road profiles are. Used by
// tools/gradecheck.ts and the unit tests to keep roads drivable.

import {dist2, type Vec2} from '../math/vec.ts';

export interface GradeStats {
  /** Steepest segment grade (rise / run). */
  max: number;
  /** 99th percentile of segment grade, weighted by segment length. */
  p99: number;
  /** Segments steeper than 15% (beyond rounding). */
  over15: number;
  /** Segments measured. */
  segments: number;
}

/**
 * Grade of every segment of the given profiles (points and heights per
 * point). Segments shorter than `minRun` metres are skipped (junction
 * endpoints snapped onto a resampled point).
 */
export function gradeStats(
  profiles: {pts: Vec2[]; heights: number[]}[],
  minRun = 1,
): GradeStats {
  const g: [number, number][] = [];
  for (const c of profiles) {
    for (let i = 0; i + 1 < c.pts.length; i++) {
      const run = dist2(c.pts[i], c.pts[i + 1]);
      if (run < minRun) continue;
      g.push([Math.abs(c.heights[i + 1] - c.heights[i]) / run, run]);
    }
  }
  if (!g.length) return {max: 0, p99: 0, over15: 0, segments: 0};
  g.sort((a, b) => a[0] - b[0]);
  let total = 0;
  for (const [, w] of g) total += w;
  let acc = 0;
  let p99 = g[g.length - 1][0];
  for (const [v, w] of g) {
    acc += w;
    if (acc >= 0.99 * total) {
      p99 = v;
      break;
    }
  }
  return {
    max: g[g.length - 1][0],
    p99,
    // (A road graded to exactly 15% is not over it.)
    over15: g.filter(([v]) => v > 0.15 + 1e-4).length,
    segments: g.length,
  };
}

/**
 * Edges of a height graph: vertex pairs `a[k]`, `b[k]` and the most height
 * may change along each (`rise[k]`, grade times length).
 */
export interface RiseGraph {
  n: number;
  a: Int32Array;
  b: Int32Array;
  rise: Float32Array;
}

/**
 * Lower envelope over `src` (NaN entries are no source): out[v] =
 * min over sources u of src[u] + (cheapest total rise from u to v); `sign`
 * -1 gives the upper envelope max(src - rise). Relaxes the edges in sweeps
 * (alternating direction) until nothing changes: with vertices numbered
 * along chains a sweep carries a change down a whole chain, and the inputs
 * here are mostly close to it already, so it takes few.
 */
function envelope(g: RiseGraph, src: Float64Array, sign: 1 | -1) {
  const n = src.length;
  const {a, b, rise} = g;
  const m = a.length;
  const out = new Float64Array(n);
  for (let v = 0; v < n; v++)
    out[v] = Number.isNaN(src[v]) ? Infinity : sign * src[v];
  for (let s = 0, changed = true; changed; s++) {
    changed = false;
    const back = (s & 1) === 1;
    for (let k = 0; k < m; k++) {
      const e = back ? m - 1 - k : k;
      const u = a[e];
      const v = b[e];
      const r = rise[e];
      if (out[u] + r < out[v]) {
        out[v] = out[u] + r;
        changed = true;
      } else if (out[v] + r < out[u]) {
        out[u] = out[v] + r;
        changed = true;
      }
    }
  }
  if (sign < 0) for (let v = 0; v < n; v++) out[v] = -out[v];
  return out;
}

/** How near its target a vertex's bound must be to take part in descend. */
const BOUND_NEAR = 30;

/** Per-vertex limits on the heights (NaN = none). */
export interface HeightBounds {
  floor?: Float64Array;
  /** Yields to the floor where they conflict. */
  ceil?: Float64Array;
}

/**
 * Dual coordinate descent for fitRises and fitPath: `sweeps` passes over
 * the edges (`edges` runs one pass, forwards or backwards), then over the
 * bounded vertices. Returns the heights.
 */
function descend(
  target: Float64Array,
  weight: Float64Array,
  {floor, ceil}: HeightBounds,
  sweeps: number,
  edges: (h: Float64Array, inv: Float64Array, back: boolean) => void,
) {
  const n = target.length;
  const h = Float64Array.from(target);
  const inv = Float64Array.from(weight, w => 1 / w);
  // Multipliers of the floor (pushing up) and the ceiling (pushing down).
  const up = new Float64Array(n);
  const down = new Float64Array(n);
  // Only bounds near the target take part (one far off is unlikely to bind;
  // the clamp after the descent holds them all in any case).
  const near: number[] = [];
  for (let v = 0; v < n; v++)
    if (
      (floor && floor[v] > target[v] - BOUND_NEAR) ||
      (ceil && ceil[v] < target[v] + BOUND_NEAR)
    )
      near.push(v);
  for (let s = 0; s < sweeps; s++) {
    edges(h, inv, (s & 1) === 1);
    for (const v of near) {
      const f = floor ? floor[v] : NaN;
      const c = ceil ? ceil[v] : NaN;
      let h0 = h[v] - up[v] * inv[v] + down[v] * inv[v];
      up[v] = Number.isNaN(f) ? 0 : Math.max(0, (f - h0) * weight[v]);
      h0 += up[v] * inv[v];
      down[v] = Number.isNaN(c) ? 0 : Math.max(0, (h0 - c) * weight[v]);
      h[v] = h0 - down[v] * inv[v];
    }
  }
  return h;
}

/** The best multiplier for an edge of rise r whose ends differ by d. */
const threshold = (d: number, r: number, inv: number) =>
  d > r ? (d - r) / inv : d < -r ? (d + r) / inv : 0;

/**
 * Heights on the graph that keep every edge within its rise and within
 * `bounds`, close to `target` in the least-squares sense (each vertex
 * weighted by `weight`, which must be > 0).
 *
 * Solved on the dual: a multiplier per edge (the earth "moved" along it)
 * and per bounded vertex, by coordinate descent: each edge in turn takes the
 * exact best value given the rest (a soft threshold), which converges to the
 * optimum (descent on the primal heights alone stalls wherever a run of
 * edges is at its limit). `sweeps` passes alternate direction; vertices of a
 * chain should be numbered in order along it so a pass carries a change
 * along the whole chain. When it stops the heights are clamped to what the
 * bounds and the `fixed` vertices (kept as they are; they must allow a
 * solution) leave open, and what is left over the rises is removed by the
 * minimax fit to that (the mean of its cut-only and fill-only envelopes).
 */
export function fitRises(
  g: RiseGraph,
  target: Float64Array,
  weight: Float64Array,
  bounds: HeightBounds = {},
  sweeps = 300,
  fixed?: Uint8Array,
): Float64Array {
  const n = g.n;
  const m = g.a.length;
  const {a, b, rise} = g;
  // Floors as high as the rises make them; ceilings no lower than that.
  const lo = bounds.floor
    ? envelope(g, bounds.floor, -1)
    : new Float64Array(n).fill(-Infinity);
  let ceil = bounds.ceil;
  if (ceil) ceil = Float64Array.from(ceil, (c, v) => Math.max(c, lo[v]));
  const y = new Float64Array(m);
  const edge = (h: Float64Array, inv: Float64Array, e: number) => {
    const va = a[e];
    const vb = b[e];
    const z0 = y[e];
    // Heights with this edge's multiplier taken out.
    const ha = h[va] + z0 * inv[va];
    const hb = h[vb] - z0 * inv[vb];
    const z = threshold(ha - hb, rise[e], inv[va] + inv[vb]);
    y[e] = z;
    h[va] = ha - z * inv[va];
    h[vb] = hb + z * inv[vb];
  };
  const h = descend(
    target,
    weight,
    {floor: bounds.floor, ceil},
    sweeps,
    (h, inv, back) => {
      if (back) for (let e = m - 1; e >= 0; e--) edge(h, inv, e);
      else for (let e = 0; e < m; e++) edge(h, inv, e);
    },
  );
  // Into the range every rise allows from the bounds and the fixed
  // vertices, then the minimax fit, which keeps it.
  const hi = ceil ? envelope(g, ceil, 1) : undefined;
  if (fixed) {
    const src = Float64Array.from(h, (v, i) => (fixed[i] ? v : NaN));
    const below = envelope(g, src, -1);
    const above = envelope(g, src, 1);
    for (let v = 0; v < n; v++) {
      lo[v] = Math.max(lo[v], below[v]);
      if (hi) hi[v] = Math.min(hi[v], above[v]);
    }
    if (!hi) return clampFit(g, h, lo, above);
  }
  return clampFit(g, h, lo, hi);
}

function clampFit(
  g: RiseGraph,
  h: Float64Array,
  lo: Float64Array,
  hi?: Float64Array,
) {
  const n = h.length;
  for (let v = 0; v < n; v++) {
    h[v] = Math.max(h[v], lo[v]);
    if (hi) h[v] = Math.min(h[v], hi[v]);
  }
  const cut = envelope(g, h, 1);
  const fill = envelope(g, h, -1);
  for (let v = 0; v < n; v++) h[v] = (cut[v] + fill[v]) / 2;
  return h;
}

/**
 * fitRises on a path (vertex i joined to i + 1 by `rise[i]`) whose two ends
 * are fixed at their targets, which must allow a solution; the same steps,
 * with the envelopes as two scans.
 */
export function fitPath(
  target: Float64Array,
  weight: Float64Array,
  bounds: HeightBounds,
  rise: Float32Array,
  sweeps: number,
): Float64Array {
  const n = target.length;
  const scan = (v: Float64Array, sign: 1 | -1) => {
    // In place: the lower (sign 1) or upper (-1) envelope of v.
    for (let i = 1; i < n; i++)
      v[i] = sign * Math.min(sign * v[i], sign * v[i - 1] + rise[i - 1]);
    for (let i = n - 2; i >= 0; i--)
      v[i] = sign * Math.min(sign * v[i], sign * v[i + 1] + rise[i]);
    return v;
  };
  const lo = bounds.floor
    ? scan(
        Float64Array.from(bounds.floor, f => (Number.isNaN(f) ? -Infinity : f)),
        -1,
      )
    : new Float64Array(n).fill(-Infinity);
  let ceil = bounds.ceil;
  if (ceil) ceil = Float64Array.from(ceil, (c, v) => Math.max(c, lo[v]));
  const y = new Float64Array(n - 1);
  const edge = (h: Float64Array, inv: Float64Array, e: number) => {
    const z0 = y[e];
    const ha = h[e] + z0 * inv[e];
    const hb = h[e + 1] - z0 * inv[e + 1];
    const z = threshold(ha - hb, rise[e], inv[e] + inv[e + 1]);
    y[e] = z;
    h[e] = ha - z * inv[e];
    h[e + 1] = hb + z * inv[e + 1];
  };
  const h = descend(
    target,
    weight,
    {floor: bounds.floor, ceil},
    sweeps,
    (h, inv, back) => {
      if (back) for (let e = n - 2; e >= 0; e--) edge(h, inv, e);
      else for (let e = 0; e < n - 1; e++) edge(h, inv, e);
    },
  );
  // The ends as they were; the range they and the bounds leave; the
  // minimax fit.
  h[0] = target[0];
  h[n - 1] = target[n - 1];
  const below = new Float64Array(n).fill(-Infinity);
  const above = ceil
    ? Float64Array.from(ceil, c => (Number.isNaN(c) ? Infinity : c))
    : new Float64Array(n).fill(Infinity);
  below[0] = above[0] = h[0];
  below[n - 1] = above[n - 1] = h[n - 1];
  scan(below, -1);
  scan(above, 1);
  const cut = new Float64Array(n);
  for (let i = 0; i < n; i++)
    cut[i] = Math.min(above[i], Math.max(lo[i], below[i], h[i]));
  const fill = scan(Float64Array.from(cut), -1);
  scan(cut, 1);
  for (let i = 0; i < n; i++) h[i] = (cut[i] + fill[i]) / 2;
  return h;
}
