// Junction geometry shared by road meshing and traffic: per-arm setbacks
// (where the road strip ends and the junction polygon begins) and junction
// outlines.

import {dist2, polygonArea, type Vec2} from '../math/vec.ts';
import {
  ROAD_WIDTH,
  SIDEWALK,
  type CityLayout,
  type RoadChain,
} from './layout.ts';

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
  /**
   * Surface polygon as drawn (outline with kerb-return fillets, or the hull
   * of a merged cluster), with the road surface height per point (each
   * point takes the height of the arm end it belongs to). Empty when a
   * cluster partner draws it.
   */
  plate: Vec2[];
  plateH: number[];
  /** Centre height of the plate fan. */
  centerH: number;
  /** Merged cluster: the plate (a hull) may overlap strips; drawn low. */
  low: boolean;
  /** Merged cluster lead: every member junction (itself first). */
  members?: number[];
  /**
   * The road surface proper, for prop landing tests: [plate], or for a
   * merged cluster's lead its members' own plates (the hull also spans
   * sidewalk corners).
   */
  cover: Vec2[][];
  /**
   * Fans (first point is the hub) filling between a kerb-return fillet and
   * the strip edge where the fillet starts beyond the arm mouth.
   */
  slivers: {pts: Vec2[]; h: number[]}[];
  /**
   * This junction's kerb returns (the fillets it rounded), each arc from
   * arm k's kerb to arm k + 1's, with the block it belongs to (street-edge
   * fixtures: corner bollards).
   */
  corners: {pts: Vec2[]; block: number}[];
}

/** A rounded kerb return replacing a sharp block curb corner. */
export interface CurbFillet {
  /** Arc from the side of curb[vertex - 1] to the side of curb[vertex + 1]. */
  pts: Vec2[];
  /** Road surface height under each arc point. */
  h: number[];
}

export interface RoadGeom {
  junctions: JunctionGeom[];
  /** Per chain: setback at start and end. */
  setbacks: [number, number][];
  /** Per chain: cumulative arc length per point. */
  arc: number[][];
  /** Per block: curb vertex index -> fillet. */
  fillets: Map<number, Map<number, CurbFillet>>;
  /**
   * Per chain: too short to draw between its setbacks; its two junctions
   * share one plate (layout quirk: two junctions a few metres apart).
   */
  absorbed: boolean[];
  /** Street light spots, filled by gen-base's streetLightSpots(). */
  lightSpots?: {
    p: [number, number, number];
    dir: Vec2;
    kind: number;
    sodium: boolean;
    angle: number;
  }[];
}

/** Grid of block curb vertices, for matching junction corners to blocks. */
function curbGrid(L: CityLayout) {
  const g = new Map<number, [number, number][]>();
  const key = (x: number, z: number) =>
    (Math.floor(z / 4) + 4096) * 8192 + Math.floor(x / 4) + 4096;
  L.blocks.forEach((b, bi) =>
    b.curb.forEach((q, vi) => {
      const k = key(q[0], q[1]);
      const l = g.get(k);
      if (l) l.push([bi, vi]);
      else g.set(k, [[bi, vi]]);
    }),
  );
  return (q: Vec2, r: number) => {
    let best: [number, number] | null = null;
    let bd = r;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const [bi, vi] of g.get(key(q[0] + dx * 4, q[1] + dz * 4)) ?? []) {
          const d = dist2(L.blocks[bi].curb[vi], q);
          if (d < bd) {
            bd = d;
            best = [bi, vi];
          }
        }
    return best;
  };
}

/**
 * Kerb-return arc at curb vertex i of `poly` (only at a convex corner): radius
 * up to R0, limited so the cut stays within `depth` of the corner and the
 * arc within 45 % of each adjacent edge. 4 segments.
 */
function filletArc(poly: Vec2[], i: number, R0: number, depth: number) {
  const n = poly.length;
  const v = poly[i];
  const p = poly[(i + n - 1) % n];
  const q = poly[(i + 1) % n];
  const l1 = dist2(p, v);
  const l2 = dist2(v, q);
  if (l1 < 1 || l2 < 1) return null;
  const e1: Vec2 = [(v[0] - p[0]) / l1, (v[1] - p[1]) / l1];
  const e2: Vec2 = [(q[0] - v[0]) / l2, (q[1] - v[1]) / l2];
  const orient = polygonArea(poly) > 0 ? 1 : -1;
  const cr = e1[0] * e2[1] - e1[1] * e2[0];
  if (cr * orient <= 0) return null;
  const alpha = Math.acos(
    Math.max(-1, Math.min(1, e1[0] * e2[0] + e1[1] * e2[1])),
  );
  if (alpha < 0.35 || alpha > 2.6) return null;
  const tanH = Math.tan(alpha / 2);
  let R = R0;
  R = Math.min(R, depth / (1 / Math.cos(alpha / 2) - 1));
  R = Math.min(R, (0.45 * Math.min(l1, l2)) / tanH);
  if (R < 0.6) return null;
  const t = R * tanH;
  const ta: Vec2 = [v[0] - e1[0] * t, v[1] - e1[1] * t];
  // Inward normal of the incoming edge (inside is left of a CCW polygon).
  const c: Vec2 = [ta[0] - e1[1] * orient * R, ta[1] + e1[0] * orient * R];
  const pts: Vec2[] = [];
  const a0 = Math.atan2(ta[1] - c[1], ta[0] - c[0]);
  const sgn = cr > 0 ? 1 : -1;
  for (let k = 0; k <= 4; k++) {
    const a = a0 + (sgn * alpha * k) / 4;
    pts.push([c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R]);
  }
  return pts;
}

/** Convex hull (CCW) of points, as indices into the input. */
function hull(pts: Vec2[]): number[] {
  const idx = pts.map((_, i) => i);
  idx.sort((a, b) => pts[a][0] - pts[b][0] || pts[a][1] - pts[b][1]);
  const cross = (o: number, a: number, b: number) =>
    (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1]) -
    (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
  const half = (order: number[]) => {
    const h: number[] = [];
    for (const i of order) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], i) <= 0)
        h.pop();
      h.push(i);
    }
    h.pop();
    return h;
  };
  return half(idx).concat(half(idx.slice().reverse()));
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
  const corners: (Vec2 | null)[][] = [];
  const junctions: JunctionGeom[] = L.junctions.map((j, ji) => {
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
    // Kerb corner between arm i's left edge and arm i+1's right edge.
    const corner: (Vec2 | null)[] = arms.map(() => null);
    corners[ji] = corner;
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
        if (sa > 0 && sb > 0) corner[i] = [j.p[0] + q[0], j.p[1] + q[1]];
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
    return {
      arms,
      outline,
      plate: [],
      plateH: [],
      centerH: j.h + 0.02,
      low: false,
      cover: [],
      slivers: [],
      corners: [],
    };
  });
  const fillets = new Map<number, Map<number, CurbFillet>>();
  const nearCurb = curbGrid(L);
  const armH = (a: Arm) => {
    const ar = arc[a.chain];
    const total = ar[ar.length - 1];
    return (
      chainAt(L.chains[a.chain], ar, a.end ? total - a.setback : a.setback).h +
      0.02
    );
  };
  junctions.forEach((jg, ji) => {
    const j = L.junctions[ji];
    const {arms} = jg;
    const k = arms.length;
    if (k < 2) return;
    const hs = arms.map(armH);
    const plate: Vec2[] = [];
    const plateH: number[] = [];
    const push = (p: Vec2, h: number) => {
      plate.push(p);
      plateH.push(h);
    };
    const along = (p: Vec2, a: Arm) =>
      (p[0] - j.p[0]) * a.dir[0] + (p[1] - j.p[1]) * a.dir[1];
    for (let i = 0; i < k; i++) {
      const A = arms[i];
      const B = arms[(i + 1) % k];
      const hA = hs[i];
      const hB = hs[(i + 1) % k];
      const mAl = jg.outline[i * 2 + 1];
      const mBr = jg.outline[((i + 1) % k) * 2];
      push(jg.outline[i * 2], hA);
      push(mAl, hA);
      const q = corners[ji][i];
      if (!q || k < 3) continue;
      // Kerb return: round the block's curb corner here (when the block's
      // curb has that corner) and follow the same arc with the plate.
      const hit = nearCurb(q, 1.5);
      if (!hit) continue;
      const [bi, vi] = hit;
      const curb = L.blocks[bi].curb;
      if (fillets.get(bi)?.has(vi)) continue;
      const R0 = Math.max(
        3,
        Math.min(12, Math.min(A.setback, B.setback) - 0.5),
      );
      const depth =
        0.6 *
        Math.min(
          SIDEWALK[L.chains[A.chain].kind],
          SIDEWALK[L.chains[B.chain].kind],
          2.5,
        );
      let arcPts = filletArc(curb, vi, R0, depth);
      if (!arcPts) continue;
      const n = arcPts.length;
      // Order the arc from A's kerb to B's.
      const fwd = dist2(arcPts[0], mAl) <= dist2(arcPts[n - 1], mAl);
      if (!fwd) arcPts = arcPts.slice().reverse();
      // 0: beyond A's mouth, 1: inside the junction, 2: beyond B's mouth.
      const cls = arcPts.map(p =>
        along(p, A) > A.setback ? 0 : along(p, B) > B.setback ? 2 : 1,
      );
      if (cls.some((c, m) => m > 0 && c < cls[m - 1])) continue;
      const arcH = arcPts.map((_, m) => hA + ((hB - hA) * m) / (n - 1));
      const cross = (p: Vec2, r: Vec2, a: Arm): Vec2 => {
        const u = along(p, a);
        const t = (a.setback - u) / (along(r, a) - u || 1);
        return [p[0] + (r[0] - p[0]) * t, p[1] + (r[1] - p[1]) * t];
      };
      const sA: Vec2[] = [mAl];
      const sAH: number[] = [hA];
      const tail: Vec2[] = [];
      for (let m = 0; m < n; m++) {
        const p = arcPts[m];
        if (cls[m] === 0) {
          sA.push(p);
          sAH.push(hA);
        } else if (cls[m] === 1) push(p, arcH[m]);
        else tail.push(p);
        if (m + 1 < n && cls[m + 1] !== cls[m]) {
          const r = arcPts[m + 1];
          if (cls[m] === 0) {
            const x = cross(p, r, A);
            sA.push(x);
            sAH.push(hA);
            push(x, hA);
          }
          if (cls[m + 1] === 2) {
            const x = cross(p, r, B);
            push(x, hB);
            tail.unshift(x);
          }
        }
      }
      if (sA.length >= 3) jg.slivers.push({pts: sA, h: sAH});
      // B's sliver fans from B's right mouth corner, tangent point first.
      if (tail.length >= 2)
        jg.slivers.push({
          pts: [mBr, ...tail.reverse()],
          h: tail.map(() => hB).concat(hB),
        });
      jg.corners.push({pts: arcPts, block: bi});
      let fm = fillets.get(bi);
      if (!fm) fillets.set(bi, (fm = new Map()));
      // Stored in the curb's own order.
      fm.set(vi, {
        pts: fwd ? arcPts : arcPts.slice().reverse(),
        h: fwd ? arcH : arcH.slice().reverse(),
      });
    }
    jg.plate = plate;
    jg.plateH = plateH;
    jg.cover = plate.length >= 3 ? [plate] : [];
  });
  // Junctions joined by a chain too short to draw between its setbacks
  // share one plate, the hull of both: the gap between two separate plates
  // would show the terrain.
  const absorbed = L.chains.map(() => false);
  const parent = L.junctions.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  const ends = new Map<number, number[]>();
  L.junctions.forEach((j, ji) =>
    j.arms.forEach(a => {
      const l = ends.get(a.chain);
      if (l) l.push(ji);
      else ends.set(a.chain, [ji]);
    }),
  );
  for (const [ci, js] of ends) {
    if (js.length !== 2 || js[0] === js[1]) continue;
    const total = arc[ci][arc[ci].length - 1];
    const [s0, s1] = setbacks[ci];
    if (total - s0 - s1 >= 6 || total > 25) continue;
    if (junctions[js[0]].plate.length < 3 || junctions[js[1]].plate.length < 3)
      continue;
    absorbed[ci] = true;
    parent[find(js[0])] = find(js[1]);
  }
  const groups = new Map<number, number[]>();
  L.junctions.forEach((_, ji) => {
    const r = find(ji);
    const g = groups.get(r);
    if (g) g.push(ji);
    else groups.set(r, [ji]);
  });
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const pts: Vec2[] = [];
    const hs: number[] = [];
    let ch = 0;
    for (const ji of g) {
      pts.push(...junctions[ji].plate);
      hs.push(...junctions[ji].plateH);
      ch += junctions[ji].centerH;
    }
    const h = hull(pts);
    const lead = junctions[g[0]];
    lead.cover = g.flatMap(ji => junctions[ji].cover);
    lead.plate = h.map(i => pts[i]);
    lead.plateH = h.map(i => hs[i]);
    lead.centerH = ch / g.length;
    lead.low = true;
    lead.members = g;
    for (const ji of g.slice(1)) {
      // Partners keep their slivers but draw no plate of their own.
      lead.slivers.push(...junctions[ji].slivers);
      junctions[ji].slivers = [];
      junctions[ji].plate = [];
      junctions[ji].plateH = [];
      junctions[ji].cover = [];
    }
  }
  return {junctions, setbacks, arc, fillets, absorbed};
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
