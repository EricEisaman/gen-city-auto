// Junction geometry shared by road meshing and traffic: per-arm setbacks
// (where the road strip ends and the junction polygon begins) and junction
// outlines.

import {dist2, type Vec2} from '../math/vec.ts';
import {ROAD_WIDTH, type CityLayout, type RoadChain} from './layout.ts';

export interface Arm {
  chain: number;
  end: 0 | 1;
  dir: Vec2;
  width: number;
  setback: number;
  angle: number;
}

export interface JunctionGeom {
  arms: Arm[];
  /** Outline (math-CCW in x/z) at road surface. */
  outline: Vec2[];
}

export interface RoadGeom {
  junctions: JunctionGeom[];
  /** Per chain: setback at start and end. */
  setbacks: [number, number][];
  /** Per chain: cumulative arc length per point. */
  arc: number[][];
}

export function chainLength(c: RoadChain) {
  let l = 0;
  for (let i = 1; i < c.pts.length; i++) l += dist2(c.pts[i - 1], c.pts[i]);
  return l;
}

function armDir(c: RoadChain, end: 0 | 1): Vec2 {
  const n = c.pts.length;
  const a = end === 0 ? c.pts[0] : c.pts[n - 1];
  // Look a few meters along the chain for a stable direction.
  let b = end === 0 ? c.pts[1] : c.pts[n - 2];
  for (let k = 1; k < n; k++) {
    const q = end === 0 ? c.pts[k] : c.pts[n - 1 - k];
    b = q;
    if (dist2(a, q) > 6) break;
  }
  const l = dist2(a, b) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

export function computeRoadGeom(L: CityLayout): RoadGeom {
  const setbacks: [number, number][] = L.chains.map(() => [0, 0]);
  const arc = L.chains.map(c => {
    const a = [0];
    for (let i = 1; i < c.pts.length; i++)
      a.push(a[i - 1] + dist2(c.pts[i - 1], c.pts[i]));
    return a;
  });
  const junctions: JunctionGeom[] = L.junctions.map(j => {
    const arms: Arm[] = j.arms.map(a => {
      const c = L.chains[a.chain];
      const dir = armDir(c, a.end);
      return {
        chain: a.chain,
        end: a.end,
        dir,
        width: ROAD_WIDTH[c.kind],
        setback: 0,
        angle: Math.atan2(dir[1], dir[0]),
      };
    });
    arms.sort((a, b) => a.angle - b.angle);
    const k = arms.length;
    if (k >= 2) {
      for (let i = 0; i < k; i++) {
        const A = arms[i];
        const B = arms[(i + 1) % k];
        // Left edge of A (CCW side) meets right edge of B.
        const la: Vec2 = [-A.dir[1], A.dir[0]];
        const lb: Vec2 = [-B.dir[1], B.dir[0]];
        const pa: Vec2 = [la[0] * A.width * 0.5, la[1] * A.width * 0.5];
        const pb: Vec2 = [-lb[0] * B.width * 0.5, -lb[1] * B.width * 0.5];
        const den = A.dir[0] * B.dir[1] - A.dir[1] * B.dir[0];
        if (Math.abs(den) < 0.15) continue; // nearly straight through
        const dx = pb[0] - pa[0];
        const dy = pb[1] - pa[1];
        const t = (dx * B.dir[1] - dy * B.dir[0]) / den;
        const q: Vec2 = [pa[0] + A.dir[0] * t, pa[1] + A.dir[1] * t];
        const sa = q[0] * A.dir[0] + q[1] * A.dir[1];
        const sb = q[0] * B.dir[0] + q[1] * B.dir[1];
        A.setback = Math.max(A.setback, sa);
        B.setback = Math.max(B.setback, sb);
      }
    }
    for (const a of arms) {
      const len = arc[a.chain][arc[a.chain].length - 1];
      a.setback = Math.min(
        Math.max(a.setback, k > 2 ? 1 : 0) + (k > 2 ? 1.5 : 0),
        30,
        len * 0.45,
      );
      setbacks[a.chain][a.end] = a.setback;
    }
    const outline: Vec2[] = [];
    for (const a of arms) {
      const l: Vec2 = [-a.dir[1], a.dir[0]];
      const px = j.p[0] + a.dir[0] * a.setback;
      const pz = j.p[1] + a.dir[1] * a.setback;
      outline.push([px - l[0] * a.width * 0.5, pz - l[1] * a.width * 0.5]);
      outline.push([px + l[0] * a.width * 0.5, pz + l[1] * a.width * 0.5]);
    }
    return {arms, outline};
  });
  return {junctions, setbacks, arc};
}

/** Point and tangent at arc length s along a chain. */
export function chainAt(
  c: RoadChain,
  arc: number[],
  s: number,
): {p: Vec2; d: Vec2; h: number} {
  const n = c.pts.length;
  if (s <= 0) s = 0;
  const total = arc[n - 1];
  if (s >= total) s = total;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arc[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = arc[hi] - arc[lo] || 1;
  const t = (s - arc[lo]) / seg;
  const a = c.pts[lo];
  const b = c.pts[hi];
  // Tangents blend smoothly between segments (vertex tangent = average of the
  // adjacent segment directions) so headings never jump at polyline vertices.
  const segDir = (i: number): Vec2 => {
    const i0 = Math.max(0, Math.min(n - 2, i));
    const p = c.pts[i0];
    const q = c.pts[i0 + 1];
    const l = dist2(p, q) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  };
  const cur = segDir(lo);
  const prev = lo > 0 ? segDir(lo - 1) : cur;
  const next = hi < n - 1 ? segDir(hi) : cur;
  const ta: Vec2 = [cur[0] + prev[0], cur[1] + prev[1]];
  const tb: Vec2 = [cur[0] + next[0], cur[1] + next[1]];
  const dx = ta[0] + (tb[0] - ta[0]) * t;
  const dz = ta[1] + (tb[1] - ta[1]) * t;
  const dl = Math.hypot(dx, dz) || 1;
  // Heights: smooth (Hermite-like) blend for gentle grade changes.
  const st = t * t * (3 - 2 * t);
  return {
    p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    d: [dx / dl, dz / dl],
    h: c.heights[lo] + (c.heights[hi] - c.heights[lo]) * (t * 0.5 + st * 0.5),
  };
}
