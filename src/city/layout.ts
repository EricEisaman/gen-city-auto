// City layout: arterial network, patchwork minor street grids, blocks, lots,
// building specs, elevated rail lines and expressways.

import {Noise2D} from '../math/noise.ts';
import {Rng, hash2} from '../math/random.ts';
import {
  clamp,
  dist2,
  dot2,
  lerp,
  pointInPolygon,
  pointSegment,
  polygonArea,
  segmentIntersect,
  smoothstep,
  sub2,
  type Vec2,
} from '../math/vec.ts';
import type {CityParams} from './config.ts';
import {
  buildChains,
  extractFaces,
  insetPolygon,
  mergeCloseNodes,
  planarize,
  pruneDeadEnds,
  removeSlivers,
  type Chain,
  type Graph,
  type Polyline,
} from './graph.ts';
import {traceStreets, type Basis} from './streets.ts';
import {
  generateTerrain,
  Heightfield,
  SEA_LEVEL,
  type Terrain,
} from './terrain.ts';

/** Road classes. */
export const Road = {lane: 0, street: 1, avenue: 2, boulevard: 3} as const;
/** Full road width (curb to curb) per class. */
export const ROAD_WIDTH = [7, 10, 16, 24];
export const SIDEWALK = [1.6, 2.5, 3.5, 4.5];
export const LANES = [1, 2, 4, 6];

export interface Hub {
  p: Vec2;
  weight: number;
  radius: number;
}

export interface RoadChain {
  /** Centerline points (2D) and heights. */
  pts: Vec2[];
  heights: number[];
  kind: number;
  /** Graph node ids of the ends. */
  start: number;
  end: number;
  /** Per point: on a bridge over water. */
  bridge: boolean[];
}

export interface Junction {
  p: Vec2;
  h: number;
  /** Chain ids and which end (0 = start, 1 = end) meet here. */
  arms: {chain: number; end: 0 | 1}[];
  signal: boolean;
}

export interface Lot {
  poly: Vec2[];
  /** Which edges face the street. */
  frontage: boolean[];
}

export type BuildingKind =
  'tower' | 'glass' | 'midrise' | 'pencil' | 'house' | 'apartment' | 'station';

export interface Building {
  id: number;
  kind: BuildingKind;
  footprint: Vec2[];
  /** Ground floor elevation (highest terrain under the footprint). */
  base: number;
  /** Lowest terrain under the footprint (foundation goes this deep). */
  low: number;
  height: number;
  floorH: number;
  style: number;
  /** Edge index of the main street frontage (-1 if none). */
  front: number;
  frontage: boolean[];
  seed: number;
  /** Density 0..1 at this site (drives sign count, details). */
  density: number;
}

export interface Block {
  /** Polygon at the road edge (curb line). */
  curb: Vec2[];
  /** Polygon at the inner edge of the sidewalk. */
  inner: Vec2[];
  park: boolean;
  /** Road kind of each curb edge. */
  kinds: number[];
  /**
   * Made a park after lots were laid out (bare or leftover ground). Its trees
   * use their own random stream so older parks in the same tile keep theirs.
   */
  late?: boolean;
  /** Open ground between buildings given a use (lawn or surface car park). */
  fill?: BlockFill[];
}

/**
 * A patch of a block's open ground, as rectangles in a frame with origin `o`
 * and unit axis `u` (stall rows run along `u`; v = perp(u)). Rect corners are
 * [u0, v0, u1, v1] in metres from `o`, all non-negative.
 */
export interface BlockFill {
  kind: 'green' | 'parking';
  o: Vec2;
  u: Vec2;
  rects: [number, number, number, number][];
}

/** Grid cell of the open-ground search; also the parking stall width. */
export const FILL_CELL = 2.5;

export interface Elevated {
  pts: Vec2[];
  heights: number[];
  kind: 'rail' | 'expressway';
  loop: boolean;
  /** Station positions as indices into pts. */
  stations: number[];
}

export interface CityLayout {
  params: CityParams;
  seed: number;
  terrain: Terrain;
  hubs: Hub[];
  chains: RoadChain[];
  junctions: Junction[];
  blocks: Block[];
  buildings: Building[];
  elevated: Elevated[];
  /**
   * Asset lab only (see lab.ts): chains, junctions and blocks left out of the
   * geometry (1 = hidden). They stay in the arrays because tile props hash
   * their indices.
   */
  hidden?: LayoutMask;
}

export interface LayoutMask {
  chains: Uint8Array;
  junctions: Uint8Array;
  blocks: Uint8Array;
}

export function densityAt(hubs: Hub[], noise: Noise2D, x: number, z: number) {
  let d = 0;
  for (const h of hubs) {
    const r = Math.hypot(x - h.p[0], z - h.p[1]);
    d = Math.max(d, h.weight * Math.exp(-(r * r) / (h.radius * h.radius)));
  }
  return clamp(d * (0.85 + 0.3 * noise.fbm(x / 700, z / 700, 3)), 0, 1);
}

// ---------------------------------------------------------------------------
// Arterials

function catmull(pts: Vec2[], closed: boolean, step: number): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  const get = (i: number) =>
    closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1),
      p1 = get(i),
      p2 = get(i + 1),
      p3 = get(i + 2);
    const len = dist2(p1, p2);
    const k = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < k; s++) {
      const t = s / k;
      const t2 = t * t,
        t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (-a + c) * t +
          (2 * a - 5 * b + 4 * c - d) * t2 +
          (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  else out.push(out[0]);
  return out;
}

/** Split a polyline where it crosses water; allow bridges up to maxBridge meters. */
function clipToLand(pts: Vec2[], hf: Heightfield, maxBridge: number): Vec2[][] {
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  let wet: Vec2[] = [];
  let wetLen = 0;
  const flushWet = (bridgeOk: boolean) => {
    if (bridgeOk) cur.push(...wet);
    else if (cur.length > 1) {
      out.push(cur);
      cur = [];
    } else cur = [];
    wet = [];
    wetLen = 0;
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const water = hf.sample(p[0], p[1]) < SEA_LEVEL + 0.5;
    if (water) {
      if (wet.length) wetLen += dist2(wet[wet.length - 1], p);
      wet.push(p);
    } else {
      if (wet.length) flushWet(wetLen < maxBridge && cur.length > 0);
      cur.push(p);
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Lots

function clipHalf(poly: Vec2[], p: Vec2, n: Vec2): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = dot2(sub2(a, p), n);
    const db = dot2(sub2(b, p), n);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Oriented bounding box: [center, axis(unit), halfLen, halfWid]. */
export function obb(poly: Vec2[]): {c: Vec2; u: Vec2; hu: number; hv: number} {
  let best = {
    c: [0, 0] as Vec2,
    u: [1, 0] as Vec2,
    hu: 0,
    hv: 0,
    area: Infinity,
  };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const l = dist2(a, b);
    if (l < 1e-6) continue;
    const u: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    const v: Vec2 = [-u[1], u[0]];
    let u0 = Infinity,
      u1 = -Infinity,
      v0 = Infinity,
      v1 = -Infinity;
    for (const q of poly) {
      const pu = dot2(q, u);
      const pv = dot2(q, v);
      u0 = Math.min(u0, pu);
      u1 = Math.max(u1, pu);
      v0 = Math.min(v0, pv);
      v1 = Math.max(v1, pv);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      best = {
        c: [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv],
        u,
        hu: (u1 - u0) / 2,
        hv: (v1 - v0) / 2,
        area,
      };
    }
  }
  return best;
}

function cleanPolygon(poly: Vec2[], minEdge: number): Vec2[] {
  let out = poly.slice();
  for (let pass = 0; pass < 3; pass++) {
    const next: Vec2[] = [];
    for (let i = 0; i < out.length; i++) {
      const prev = next.length ? next[next.length - 1] : out[out.length - 1];
      const cur = out[i];
      const nxt = out[(i + 1) % out.length];
      if (dist2(prev, cur) < minEdge) continue;
      // Drop nearly collinear vertices.
      const a = sub2(cur, prev);
      const b = sub2(nxt, cur);
      const cr = a[0] * b[1] - a[1] * b[0];
      if (Math.abs(cr) < 0.02 * Math.hypot(...a) * Math.hypot(...b)) continue;
      next.push(cur);
    }
    out = next;
  }
  return out;
}

/**
 * The largest simple loop of a polygon that crosses or touches itself. Lot
 * cuts through a concave block leave a few plots pinched in two at a vertex
 * or with a sliver folded back across them; towers inset from such a plan
 * came out as broken, twisted shapes. Split at each crossing and keep the
 * loop with the most area (same winding); a simple polygon comes back as is.
 */
export function simplePolygon(poly: Vec2[], depth = 0): Vec2[] {
  const n = poly.length;
  if (n < 4 || depth > 16) return poly;
  const sign = polygonArea(poly) < 0 ? -1 : 1;
  const touch = (q: Vec2, a: Vec2, b: Vec2) => pointSegment(q, a, b)[0] < 0.25;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j];
      const d = poly[(j + 1) % n];
      let x: Vec2 | null = null;
      const hit = segmentIntersect(a, b, c, d);
      if (hit)
        x = [a[0] + (b[0] - a[0]) * hit[0], a[1] + (b[1] - a[1]) * hit[0]];
      else if (touch(c, a, b)) x = c;
      else if (touch(d, a, b)) x = d;
      else if (touch(a, c, d)) x = a;
      else if (touch(b, c, d)) x = b;
      if (!x) continue;
      const loops = [
        [x, ...poly.slice(i + 1, j + 1)],
        [x, ...poly.slice(j + 1), ...poly.slice(0, i + 1)],
      ].map(l => {
        const out: Vec2[] = [];
        for (const q of l)
          if (!out.length || dist2(out[out.length - 1], q) > 0.01) out.push(q);
        if (out.length > 1 && dist2(out[0], out[out.length - 1]) <= 0.01)
          out.pop();
        return out.length >= 3 ? simplePolygon(out, depth + 1) : out;
      });
      const score = (l: Vec2[]) => (l.length >= 3 ? polygonArea(l) * sign : 0);
      return score(loops[0]) >= score(loops[1]) ? loops[0] : loops[1];
    }
  }
  return poly;
}

/** Whether segment a-b lies on a frontage edge of `poly`. */
function onFrontage(a: Vec2, b: Vec2, poly: Vec2[], frontage: boolean[]) {
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (let k = 0; k < poly.length; k++) {
    if (pointSegment(mid, poly[k], poly[(k + 1) % poly.length])[0] < 0.05)
      return frontage[k];
  }
  return false;
}

/**
 * Frontage flags for `part`, a piece clipped out of `poly`: an edge faces the
 * street if it lies on a frontage edge of `poly`. Edges on cut lines don't.
 */
function inheritFrontage(
  part: Vec2[],
  poly: Vec2[],
  frontage: boolean[],
): boolean[] {
  return part.map((a, i) =>
    onFrontage(a, part[(i + 1) % part.length], poly, frontage),
  );
}

function frontageLength(poly: Vec2[], frontage: boolean[]) {
  let l = 0;
  poly.forEach((a, i) => {
    if (frontage[i]) l += dist2(a, poly[(i + 1) % poly.length]);
  });
  return l;
}

/** Extent of `poly` projected on unit axis `d`. */
function extent(poly: Vec2[], d: Vec2): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (const q of poly) {
    const s = dot2(q, d);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  return [lo, hi];
}

/** Lot dimensions for one block: street frontage width and depth. */
export interface LotRule {
  /** Frontage width range; lots are cut to a width in this range. */
  width: [number, number];
  /** Max depth from the street before the back becomes its own lot. */
  depth: number;
  /** Chance a leaf lot pulls back from its side/rear neighbours. */
  gap: number;
  /** Chance per split to stop early and keep a merged, wider lot. */
  merge: number;
}

/**
 * Tokyo-style lot subdivision. Lots are cut across the street frontage into
 * narrow plots (pencil buildings side by side) and cut off at a max depth so
 * deep blocks get back lots; every cut keeps street frontage on both pieces
 * where it can. Interior pieces with no frontage are split by their OBB.
 */
export function splitLots(
  rng: Rng,
  poly: Vec2[],
  frontage: boolean[],
  rule: LotRule,
  out: Lot[],
  depth = 0,
) {
  const area = polygonArea(poly);
  if (area < 30 || poly.length < 3) return;
  const [wLo, wHi] = rule.width;
  // Frontage direction (and midpoint) of the longest street edge.
  let f: Vec2 | undefined;
  let fm: Vec2 = poly[0];
  let best = 0;
  poly.forEach((a, i) => {
    if (!frontage[i]) return;
    const b = poly[(i + 1) % poly.length];
    const l = dist2(a, b);
    if (l > best) {
      best = l;
      f = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      fm = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
  });
  const cut = (d: Vec2, s: number, needFront: boolean) => {
    const p: Vec2 = [d[0] * s, d[1] * s];
    const parts: {poly: Vec2[]; fr: boolean[]}[] = [];
    for (const n of [d, [-d[0], -d[1]] as Vec2]) {
      const part = clipHalf(poly, p, n);
      if (part.length < 3 || polygonArea(part) < 35) return null;
      const fr = part.map((a, i) => {
        const b = part[(i + 1) % part.length];
        const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        return Math.abs(dot2(sub2(mid, p), n)) < 0.05
          ? false
          : onFrontage(a, b, poly, frontage);
      });
      // Narrow street frontage only counts if it's a usable shop front.
      if (needFront && frontageLength(part, fr) < 3) return null;
      parts.push({poly: part, fr});
    }
    return parts;
  };
  const recurse = (parts: {poly: Vec2[]; fr: boolean[]}[] | null) => {
    if (!parts) return false;
    for (const q of parts) splitLots(rng, q.poly, q.fr, rule, out, depth + 1);
    return true;
  };
  if (depth < 14 && f) {
    const n: Vec2 = [-f[1], f[0]];
    const [f0, f1] = extent(poly, f);
    const [n0, n1] = extent(poly, n);
    const w = f1 - f0;
    const d = n1 - n0;
    const early = depth > 1 && area < 900 && rng.chance(rule.merge);
    if (w > wHi && !early) {
      // Cut across the frontage. Long runs split near the middle (corner lots
      // keep both streets); short runs peel off one plot of a random width.
      const s =
        w > wHi * 2.5
          ? f0 + w * rng.range(0.38, 0.62)
          : rng.chance(0.5)
            ? f0 + rng.range(wLo, Math.min(wHi, w - wLo))
            : f1 - rng.range(wLo, Math.min(wHi, w - wLo));
      if (w - wLo >= wLo && recurse(cut(f, s, true))) return;
    }
    if (d > rule.depth * 1.35 && !early) {
      // Too deep: a through lot splits in the middle when both halves keep a
      // street (two lots back to back), otherwise the back becomes its own lot.
      if (recurse(cut(n, n0 + d * rng.range(0.42, 0.58), true))) return;
      // Measure the depth from whichever side the street is on.
      const atLo = dot2(fm, n) - n0 < n1 - dot2(fm, n);
      const dd = rule.depth * rng.range(0.7, 1);
      if (d - dd > 9 && recurse(cut(n, atLo ? n0 + dd : n1 - dd, false)))
        return;
    }
  }
  if (depth < 14 && (!f || area > rule.depth * wHi * 2)) {
    // Interior lot (or an awkward shape no frontage cut works on): halve by
    // the OBB while it's large.
    const box = obb(poly);
    const long = Math.max(box.hu, box.hv) * 2;
    if (long > rule.depth * 1.6 || area > rule.depth * wHi * 1.5) {
      const u: Vec2 = box.hu >= box.hv ? box.u : [-box.u[1], box.u[0]];
      const s = dot2(box.c, u) + long * rng.range(-0.1, 0.1);
      if (recurse(cut(u, s, false))) return;
    }
  }
  // Leaf. Some lots pull back from their side and rear neighbours so blocks
  // read as separate buildings with narrow gaps, not one mass.
  if (rng.chance(rule.gap)) {
    let q = poly;
    const g = rng.range(0.35, 0.8);
    for (let i = 0; i < poly.length && q.length >= 3; i++) {
      if (frontage[i]) continue;
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const l = dist2(a, b);
      if (l < 1e-6) continue;
      const nn: Vec2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
      q = clipHalf(q, [a[0] + nn[0] * g, a[1] + nn[1] * g], nn);
    }
    if (q.length >= 3 && polygonArea(q) > area * 0.6) {
      out.push({poly: q, frontage: inheritFrontage(q, poly, frontage)});
      return;
    }
  }
  out.push({poly, frontage});
}

// ---------------------------------------------------------------------------
// Bridges

/** Water crossings at least this long are thinned out (rivers keep theirs). */
const LONG_CROSSING = 200;
/** Least distance between the ends of two long crossings kept. */
const CROSSING_SPACING = 700;

/**
 * The street tracer runs every arterial on across open water, so a wide
 * harbour got a lattice of long bridges meeting at junctions in mid-water.
 * Keep the shortest crossings that are far enough apart and don't meet any
 * other, and drop the rest (their dead ends go with pruneDeadEnds); edges in
 * `keepEdges` stay regardless. Returns whether any edge was removed.
 */
function thinBridges(
  g: Graph,
  isLand: (q: Vec2) => boolean,
  keepEdges: Set<number>,
): boolean {
  const wet = g.edges.map(e => {
    if (e.dead) return false;
    const a = g.nodes[e.a].p;
    const b = g.nodes[e.b].p;
    return !isLand([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  });
  if (!wet.some(w => w)) return false;
  const len = (e: number) =>
    dist2(g.nodes[g.edges[e].a].p, g.nodes[g.edges[e].b].p);
  const shore = (n: number) => g.liveEdges(n).some(e => !wet[e]);
  const dir = (from: number, e: number): Vec2 => {
    const p = g.nodes[from].p;
    const q = g.nodes[g.other(e, from)].p;
    const l = dist2(p, q) || 1;
    return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
  };
  interface Crossing {
    edges: number[];
    nodes: number[];
    len: number;
    kind: number;
  }
  const crossings = new Map<string, Crossing>();
  for (let s = 0; s < g.nodes.length; s++) {
    if (!shore(s)) continue;
    for (const e0 of g.liveEdges(s)) {
      if (!wet[e0]) continue;
      // Straight on from node to node across the water to the far shore.
      const edges = [e0];
      const nodes = [s];
      let n = g.other(e0, s);
      let d = dir(s, e0);
      let ok = true;
      while (!shore(n)) {
        nodes.push(n);
        let best = -1;
        let bestDot = Math.cos((35 * Math.PI) / 180);
        for (const e of g.liveEdges(n)) {
          if (!wet[e] || edges.includes(e)) continue;
          const dd = dir(n, e);
          const dot = d[0] * dd[0] + d[1] * dd[1];
          if (dot > bestDot) {
            bestDot = dot;
            best = e;
          }
        }
        if (best < 0 || edges.length > 400) {
          ok = false;
          break;
        }
        d = dir(n, best);
        edges.push(best);
        n = g.other(best, n);
      }
      if (!ok || n === s) continue;
      nodes.push(n);
      const key = edges
        .slice()
        .sort((x, y) => x - y)
        .join(',');
      if (crossings.has(key)) continue;
      crossings.set(key, {
        edges,
        nodes,
        len: edges.reduce((t, e) => t + len(e), 0),
        kind: Math.min(...edges.map(e => g.edges[e].kind)),
      });
    }
  }
  const long = [...crossings.values()].filter(c => c.len >= LONG_CROSSING);
  if (!long.length) return false;
  // Shortest first (boulevards count a little shorter).
  long.sort(
    (a, b) =>
      a.len / (a.kind >= Road.boulevard ? 1.25 : 1) -
      b.len / (b.kind >= Road.boulevard ? 1.25 : 1),
  );
  const keep: Crossing[] = [];
  const used = new Set<number>();
  for (const c of long) {
    if (c.nodes.some(n => used.has(n))) continue;
    const ends = [c.nodes[0], c.nodes[c.nodes.length - 1]].map(
      n => g.nodes[n].p,
    );
    const crowded = keep.some(k =>
      [k.nodes[0], k.nodes[k.nodes.length - 1]].some(n =>
        ends.some(p => dist2(p, g.nodes[n].p) < CROSSING_SPACING),
      ),
    );
    if (crowded) continue;
    keep.push(c);
    for (const n of c.nodes) used.add(n);
  }
  keepEdges = new Set(keepEdges);
  for (const c of keep) for (const e of c.edges) keepEdges.add(e);
  for (const c of crossings.values())
    if (c.len < LONG_CROSSING) for (const e of c.edges) keepEdges.add(e);
  // Every other edge out over the water goes, including the bits of
  // lattice no straight crossing ran along.
  let removed = false;
  wet.forEach((w, e) => {
    if (w && !keepEdges.has(e)) {
      g.removeEdge(e);
      removed = true;
    }
  });
  return removed;
}

/**
 * `items` reordered so each whose key was at index i of `before` is at i
 * again where it can be; the rest fill the gaps in their own order.
 */
export function stableOrder<T>(
  items: T[],
  key: (t: T) => string,
  before: string[],
): T[] {
  const at = new Map(before.map((k, i) => [k, i]));
  const out: (T | undefined)[] = new Array(items.length);
  const rest: T[] = [];
  for (const t of items) {
    const i = at.get(key(t));
    if (i !== undefined && i < items.length) out[i] = t;
    else rest.push(t);
  }
  let r = 0;
  for (let i = 0; i < out.length; i++)
    if (out[i] === undefined) out[i] = rest[r++];
  return out as T[];
}

// ---------------------------------------------------------------------------
// Elevated lines

/**
 * Most a deck rises above its clearance profile (terrain plus clearance).
 * Holding the gentle grade off every hilltop left decks 90-130 m up in the
 * valleys of the hilly cities.
 */
export const MAX_DECK_RISE = 25;
/** Expressways past MAX_DECK_RISE come down on this grade instead. */
const STEEP_GRADE = 0.2;

/** Point i of an elevated line is under the ground (in a tunnel). */
export function inTunnel(e: Elevated, i: number, hf: Heightfield) {
  const q = e.pts[i];
  return e.heights[i] < hf.sample(q[0], q[1]);
}

/**
 * Lowest profile over `floor` whose grade is at most `grade` both ways (a
 * descent off a hilltop starts early enough to stay at or under it).
 * Entries of `floor` may be -Infinity (no constraint).
 */
function gradeEnvelope(pts: Vec2[], floor: number[], grade: number) {
  const n = pts.length;
  const h = floor.slice();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n; i++)
      h[i] = Math.max(h[i], h[i - 1] - grade * dist2(pts[i], pts[i - 1]));
    for (let i = n - 2; i >= 0; i--)
      h[i] = Math.max(h[i], h[i + 1] - grade * dist2(pts[i], pts[i + 1]));
  }
  return h;
}

/**
 * Deck heights along an elevated line: at least `clearance` over the ground
 * (or the water), at most `grade` steep, and at most MAX_DECK_RISE over that
 * clearance profile. Rail lines (`tunnels`) keep their grade and go through
 * the hills that would break that in tunnels (gen-base leaves out what is
 * buried and builds the portals); expressways steepen to STEEP_GRADE.
 */
export function elevateProfile(
  pts: Vec2[],
  hf: Heightfield,
  clearance: number,
  grade: number,
  tunnels = false,
): number[] {
  const n = pts.length;
  const floor = pts.map(
    q => Math.max(hf.sample(q[0], q[1]), SEA_LEVEL + 2) + clearance,
  );
  const top = floor.map(f => f + MAX_DECK_RISE);
  let need = floor;
  let ceil: number[];
  if (tunnels) {
    // The highest gentle profile under `top`. Where it runs below the
    // clearance profile the line is bored through the hill: the floor there
    // no longer holds the deck up, so it never rises past `top` anywhere.
    ceil = gradeEnvelope(
      pts,
      top.map(t => -t),
      grade,
    ).map(v => -v);
    const bored = floor.map((f, i) => ceil[i] < f);
    if (bored.some(b => !b))
      need = floor.map((f, i) => (bored[i] ? -Infinity : f));
    else ceil = gradeEnvelope(pts, top, grade);
  } else {
    ceil = gradeEnvelope(pts, top, Math.max(grade, STEEP_GRADE));
  }
  const h = gradeEnvelope(pts, need, grade).map((v, i) => Math.min(v, ceil[i]));
  // Smooth.
  for (let it = 0; it < 4; it++) {
    const c = h.slice();
    for (let i = 1; i + 1 < n; i++)
      h[i] = Math.min(
        Math.max(c[i], (c[i - 1] + c[i] * 2 + c[i + 1]) / 4),
        ceil[i],
      );
  }
  return h;
}

function resample(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [pts[0]];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const l = dist2(a, b);
    let t = step - carry;
    while (t <= l) {
      out.push([
        a[0] + ((b[0] - a[0]) * t) / l,
        a[1] + ((b[1] - a[1]) * t) / l,
      ]);
      t += step;
    }
    carry = l - (t - step);
  }
  const last = pts[pts.length - 1];
  if (dist2(out[out.length - 1], last) > step * 0.3) out.push(last);
  return out;
}

function railLines(
  p: CityParams,
  rng: Rng,
  noise: Noise2D,
  hubs: Hub[],
  center: Vec2,
  hf: Heightfield,
): Elevated[] {
  const out: Elevated[] = [];
  if (p.railLines <= 0) return out;
  const S = p.size / 2;
  // Loop line through the hubs sorted by angle around the center.
  const loopHubs = hubs
    .filter(h => Math.max(Math.abs(h.p[0]), Math.abs(h.p[1])) < S * 0.8)
    .map(h => ({h, a: Math.atan2(h.p[1] - center[1], h.p[0] - center[0])}))
    .sort((a, b) => a.a - b.a)
    .map(x => x.h.p);
  // A loop through irregular hubs can fold back over itself; drop the hub
  // nearest each fold until the line is clean.
  let pts = resample(catmull(loopHubs, true, 15), 12);
  for (let fold = selfOverlap(pts); fold && loopHubs.length > 3;) {
    const q = fold;
    let bi = 0;
    loopHubs.forEach((h, i) => {
      if (dist2(h, q) < dist2(loopHubs[bi], q)) bi = i;
    });
    loopHubs.splice(bi, 1);
    pts = resample(catmull(loopHubs, true, 15), 12);
    fold = selfOverlap(pts);
  }
  if (loopHubs.length >= 3) {
    const wet = pts.some(q => hf.sample(q[0], q[1]) < SEA_LEVEL + 0.5);
    if (!wet) {
      out.push({
        pts,
        heights: elevateProfile(pts, hf, 9, 0.03, true),
        kind: 'rail',
        loop: true,
        stations: [],
      });
    } else {
      // The loop would cross open water: keep the longest stretch on land.
      const piece =
        clipToLand(pts, hf, 350).sort((a, b) => b.length - a.length)[0] ?? [];
      // Bridges over narrow water (rivers) keep it in one piece: then it is
      // still a loop, not a line with two dead ends side by side.
      if (piece.length > 20)
        out.push({
          pts: piece,
          heights: elevateProfile(piece, hf, 9, 0.03, true),
          kind: 'rail',
          loop: piece.length === pts.length,
          stations: [],
        });
    }
  }
  // Cross-town lines from edge to edge through the center.
  for (let k = 1; k < p.railLines; k++) {
    const a = rng.range(0, Math.PI);
    const ctrl: Vec2[] = [];
    for (let s = -4; s <= 4; s++) {
      const r = (S * 1.3 * s) / 4;
      const wob = noise.noise(k * 5.1, s * 0.4) * 200;
      ctrl.push([
        center[0] + Math.cos(a) * r - Math.sin(a) * wob,
        center[1] + Math.sin(a) * r + Math.cos(a) * wob,
      ]);
    }
    const inBox = resample(catmull(ctrl, false, 15), 12).filter(
      q => Math.max(Math.abs(q[0]), Math.abs(q[1])) < S - 60,
    );
    const pieces = clipToLand(inBox, hf, 500).sort(
      (x, y) => y.length - x.length,
    );
    const pts = pieces[0] ?? [];
    if (pts.length > 10)
      out.push({
        pts,
        heights: elevateProfile(pts, hf, 9 + k * 3, 0.03, true),
        kind: 'rail',
        loop: false,
        stations: [],
      });
  }
  // Stations near hubs.
  for (const line of out) {
    for (const h of hubs) {
      let bi = -1;
      let bd = 250;
      line.pts.forEach((q, i) => {
        const d = dist2(q, h.p);
        if (d < bd && i > 8 && i < line.pts.length - 8) {
          bd = d;
          bi = i;
        }
      });
      if (bi >= 0) line.stations.push(bi);
    }
    if (!line.loop) addTermini(line);
  }
  return out;
}

/**
 * Stations' platforms cover segments si - 7 .. si + 6 (railViaduct), so a
 * terminus at index 7 / n - 8 runs right up to the deck end.
 */
export const TERMINUS_OFFSET = 7;

/**
 * An open line ends at a terminus at each end (platforms up to the buffer
 * stop) instead of a bare viaduct stopping in mid-air; hub stations that
 * would overlap one give way to it.
 */
function addTermini(line: Elevated) {
  const n = line.pts.length;
  const a = TERMINUS_OFFSET;
  const b = n - 1 - TERMINUS_OFFSET;
  if (b - a < 30) return;
  line.stations = line.stations.filter(
    si =>
      si - a >= 2 * TERMINUS_OFFSET + 4 && b - si >= 2 * TERMINUS_OFFSET + 4,
  );
  line.stations.push(a, b);
}

// ---------------------------------------------------------------------------

/**
 * What generateLayout has finished so far, handed to its progress callback
 * (the loading screen's map). Read only: nothing here may draw from the
 * random streams.
 */
export interface LayoutPartial {
  terrain?: Terrain;
  streets?: Polyline[];
  chains?: RoadChain[];
  elevated?: Elevated[];
  blocks?: Block[];
  buildings?: Building[];
}

export function generateLayout(
  params: CityParams,
  seed: number,
  progress?: (msg: string, f: number, partial?: LayoutPartial) => void,
  /** generateTerrain(params, seed), already made (by several workers). */
  pregenerated?: Terrain,
): CityLayout {
  const rng = new Rng(seed);
  const noise = new Noise2D(seed + 7);
  if (!pregenerated) progress?.('Shaping terrain', 0.05);
  const terrain = pregenerated ?? generateTerrain(params, seed);
  const hf = terrain.heights;
  const S = params.size / 2;
  const center = terrain.center;
  const isLand = (q: Vec2) => hf.sample(q[0], q[1]) > SEA_LEVEL + 0.5;

  // Hubs: the main center plus sub-centers on land.
  const hubs: Hub[] = [{p: center, weight: 1, radius: 900}];
  for (let tries = 0; hubs.length < 6 && tries < 200; tries++) {
    const q: Vec2 = [
      rng.range(-S * 0.75, S * 0.75),
      rng.range(-S * 0.75, S * 0.75),
    ];
    if (!isLand(q) || hubs.some(h => dist2(h.p, q) < 1300)) continue;
    hubs.push({
      p: q,
      weight: rng.range(0.6, 0.95),
      radius: rng.range(450, 750),
    });
  }

  progress?.('Tracing streets', 0.15, {terrain});
  // Tensor field street network: grids around each hub, a radial pattern at
  // the center (rings and radials), and terrain contours on slopes.
  const bases: Basis[] = [];
  if (params.arterials === 'grid') {
    bases.push({
      kind: 'grid',
      center,
      radius: params.size * 4,
      weight: 1,
      theta: rng.range(0.35, 0.55),
    });
  } else {
    bases.push({kind: 'radial', center, radius: 1500, weight: 1.3, theta: 0});
    for (const h of hubs.slice(1)) {
      bases.push({
        kind: 'grid',
        center: h.p,
        radius: rng.range(900, 1300),
        weight: 1.2,
        theta: rng.range(0, Math.PI),
      });
    }
    // Background grids so every part of the map has a coherent orientation.
    for (let k = 0; k < 10; k++) {
      bases.push({
        kind: 'grid',
        center: [rng.range(-S, S), rng.range(-S, S)],
        radius: rng.range(1600, 2400),
        weight: 0.9,
        theta: rng.range(0, Math.PI),
      });
    }
  }
  const [sepLo, sepHi] = params.blockSize;
  const allLines: Polyline[] = traceStreets(
    {
      size: params.size,
      bases,
      terrainWeight:
        params.arterials === 'grid' ? 0.4 : 0.8 + params.relief / 200,
      majorSep: params.arterials === 'grid' ? 270 : 400,
      minorSep: d => lerp(sepHi * 1.15, sepLo * 1.1, d),
      density: (x, z) => densityAt(hubs, noise, x, z),
      maxBridge: 2600,
      majorKind: i => (i % 3 === 0 ? Road.boulevard : Road.avenue),
      minorKind: (d, r) => (r.chance(0.2 + d * 0.35) ? Road.street : Road.lane),
      holes: params.arterials === 'grid' ? [] : [{c: center, r: 230}],
    },
    hf,
    seed,
  );
  if (params.arterials !== 'grid') {
    // Ring road around the central park.
    const ring: Vec2[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      ring.push([center[0] + Math.cos(a) * 236, center[1] + Math.sin(a) * 236]);
    }
    allLines.push({pts: ring, kind: Road.boulevard});
  }
  progress?.('Connecting streets', 0.25, {streets: allLines});
  let g: Graph = planarize(allLines, 2.5);
  g = mergeCloseNodes(g, 5);
  removeSlivers(g, 0.35);
  // Drop edges that cross open water for long stretches unless they are arterials.
  for (const e of g.edges) {
    if (e.dead) continue;
    const a = g.nodes[e.a].p;
    const b = g.nodes[e.b].p;
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!isLand(mid) && e.kind < Road.avenue) e.dead = true;
    if (Math.max(Math.abs(mid[0]), Math.abs(mid[1])) > S - 30) e.dead = true;
  }
  pruneDeadEnds(g);
  g = g.compact();
  // Thin out the arterials crossing open water (no random draws, and the
  // graph is not compacted again, so every other edge, block and lot stays
  // as it was). Chains and junctions untouched by it keep their indices:
  // street furniture is hashed from them.
  const chainKey = (c: Chain) => c.edges.join(',');
  const chainsBefore = buildChains(g);
  // Edges round a face that may become a block stay (a merged face would
  // change the blocks, so the lots and every random draw after them).
  const landEdges = new Set<number>();
  for (const f of extractFaces(g, 400000)) {
    // The block test below, with some margin.
    const curb = insetPolygon(
      f.nodes.map(n => g.nodes[n].p),
      f.edges.map(e => ROAD_WIDTH[g.edges[e].kind] / 2),
    );
    if (curb && wetFraction(curb, hf) <= 0.3)
      for (const e of f.edges) landEdges.add(e);
  }
  const thinned = thinBridges(g, isLand, landEdges);
  if (thinned) pruneDeadEnds(g);
  const chainsG: Chain[] = thinned
    ? stableOrder(buildChains(g), chainKey, chainsBefore.map(chainKey))
    : chainsBefore;

  progress?.('Grading roads', 0.35);
  // Smooth the road heights and carve the terrain so roads sit on it.
  const nodeH = g.nodes.map(n =>
    Math.max(hf.sample(n.p[0], n.p[1]), SEA_LEVEL + 1.2),
  );
  const chains: RoadChain[] = [];
  for (const c of chainsG) {
    const raw = c.nodes.map(n => g.nodes[n].p);
    const pts = resample(raw, 8);
    // Keep exact endpoints so junctions line up.
    pts[0] = raw[0];
    pts[pts.length - 1] = raw[raw.length - 1];
    const L: number[] = [0];
    for (let i = 1; i < pts.length; i++)
      L.push(L[i - 1] + dist2(pts[i - 1], pts[i]));
    const total = L[L.length - 1];
    const h0 = nodeH[c.nodes[0]];
    const h1 = nodeH[c.nodes[c.nodes.length - 1]];
    const bridge = pts.map(q => !isLand(q));
    let heights = pts.map((q, i) => {
      const t = total > 0 ? L[i] / total : 0;
      const terrainH = Math.max(hf.sample(q[0], q[1]), SEA_LEVEL + 1.2);
      // Bridges span between the banks with a gentle arch.
      if (bridge[i])
        return (
          lerp(h0, h1, t) +
          Math.sin(Math.PI * t) * Math.min(12, total * 0.03) +
          2
        );
      const blend = smoothstep(0, 40, Math.min(L[i], total - L[i]));
      return lerp(lerp(h0, h1, t), terrainH, blend);
    });
    for (let it = 0; it < 6; it++) {
      const h = heights.slice();
      for (let i = 1; i + 1 < pts.length; i++)
        heights[i] = (h[i - 1] + 2 * h[i] + h[i + 1]) / 4;
    }
    heights[0] = h0;
    heights[heights.length - 1] = h1;
    if (bridge.some(b => b)) {
      // Raise the bridge deck clear of the water.
      const wetLen = bridge.filter(b => b).length * 8;
      const clearance = wetLen > 500 ? 28 : 7;
      heights = heights.map((h, i) =>
        bridge[i] ? Math.max(h, SEA_LEVEL + clearance) : h,
      );
      for (let it = 0; it < (wetLen > 500 ? 60 : 8); it++) {
        const h = heights.slice();
        for (let i = 1; i + 1 < pts.length; i++)
          heights[i] = Math.max(
            h[i],
            (h[i - 1] + 2 * h[i] + h[i + 1]) / 4 - 0.02,
          );
      }
    }
    chains.push({
      pts,
      heights,
      kind: c.kind,
      start: c.nodes[0],
      end: c.nodes[c.nodes.length - 1],
      bridge,
    });
  }
  const flooded = carveRoads(hf, chains);

  // Junctions.
  const junctionOf = new Map<number, number>();
  const junctions: Junction[] = [];
  chains.forEach((c, ci) => {
    for (const end of [0, 1] as const) {
      const n = end === 0 ? c.start : c.end;
      let j = junctionOf.get(n);
      if (j === undefined) {
        j = junctions.length;
        junctionOf.set(n, j);
        junctions.push({p: g.nodes[n].p, h: nodeH[n], arms: [], signal: false});
      }
      junctions[j].arms.push({chain: ci, end});
    }
  });
  for (const j of junctions) {
    const maxKind = Math.max(...j.arms.map(a => chains[a.chain].kind));
    j.signal = j.arms.length >= 3 && maxKind >= Road.street;
  }
  if (thinned) {
    // Junction order as it was before thinning (first chain end at each).
    const before: string[] = [];
    const seen = new Set<number>();
    for (const c of chainsBefore)
      for (const n of [c.nodes[0], c.nodes[c.nodes.length - 1]])
        if (!seen.has(n)) {
          seen.add(n);
          before.push(String(n));
        }
    const nodeOf = new Map<Junction, number>();
    junctionOf.forEach((j, n) => nodeOf.set(junctions[j], n));
    const order = stableOrder(junctions, j => String(nodeOf.get(j)), before);
    junctions.splice(0, junctions.length, ...order);
  }

  progress?.('Elevated rail and expressways', 0.45, {chains});
  const elevated = railLines(params, rng, noise, hubs, center, hf);
  elevated.push(...expressways(params, rng, chains, hf));
  separateCrossings(elevated);
  for (const e of elevated) e.stations = clearStations(e, hf);

  progress?.('Subdividing blocks', 0.5, {elevated});
  const faces = extractFaces(g, 400000);
  const blocks: Block[] = [];
  const lots: {lot: Lot; block: number}[] = [];
  // Rail segments binned by their first point (60 m cells): nearRail tests
  // the same segments as a scan of every rail line (those whose first point
  // is within 60 m on both axes), only without visiting the rest. Segments
  // in a tunnel are left out.
  const railGrid = new Map<number, [Vec2, Vec2][]>();
  const railKey = (cx: number, cz: number) => (cz + 2048) * 4096 + cx + 2048;
  for (const e of elevated) {
    if (e.kind !== 'rail') continue;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      // Buildings may stand over a tunnel.
      if (inTunnel(e, i, hf) && inTunnel(e, i + 1, hf)) continue;
      const a = e.pts[i];
      const k = railKey(Math.floor(a[0] / 60), Math.floor(a[1] / 60));
      let l = railGrid.get(k);
      if (!l) railGrid.set(k, (l = []));
      l.push([a, e.pts[i + 1]]);
    }
  }
  const nearRail = (q: Vec2, pad: number) => {
    const x0 = Math.floor((q[0] - 60) / 60);
    const x1 = Math.floor((q[0] + 60) / 60);
    const z0 = Math.floor((q[1] - 60) / 60);
    const z1 = Math.floor((q[1] + 60) / 60);
    for (let cz = z0; cz <= z1; cz++)
      for (let cx = x0; cx <= x1; cx++)
        for (const [a, b] of railGrid.get(railKey(cx, cz)) ?? []) {
          if (Math.abs(a[0] - q[0]) > 60 || Math.abs(a[1] - q[1]) > 60)
            continue;
          if (pointSegment(q, a, b)[0] < pad) return true;
        }
    return false;
  };
  // Road sample points for rejecting blocks that overlap roads.
  const roadGrid = new Map<number, Vec2[]>();
  const rkey = (x: number, z: number) =>
    (Math.floor(z / 50) + 500) * 1000 + Math.floor(x / 50) + 500;
  for (const c of chains) {
    for (const q of c.pts) {
      const k = rkey(q[0], q[1]);
      let l = roadGrid.get(k);
      if (!l) roadGrid.set(k, (l = []));
      l.push(q);
    }
  }
  const overlapsRoad = (poly: Vec2[]) => {
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const q of poly) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      z0 = Math.min(z0, q[1]);
      z1 = Math.max(z1, q[1]);
    }
    for (let z = Math.floor(z0 / 50); z <= Math.floor(z1 / 50); z++) {
      for (let x = Math.floor(x0 / 50); x <= Math.floor(x1 / 50); x++) {
        for (const q of roadGrid.get((z + 500) * 1000 + x + 500) ?? [])
          if (pointInPolygon(q, poly)) return true;
      }
    }
    return false;
  };
  // Slivers between converging roads too thin for a sidewalk ring and lots;
  // they become pocket parks (appended after the real blocks).
  const slivers: Block[] = [];
  for (const f of faces) {
    const kinds = f.edges.map(e => g.edges[e].kind);
    const poly = f.nodes.map(n => g.nodes[n].p);
    const curb = insetPolygon(
      poly,
      kinds.map(k => ROAD_WIDTH[k] / 2),
    );
    if (!curb) continue;
    const inner = insetPolygon(
      poly,
      kinds.map(k => ROAD_WIDTH[k] / 2 + SIDEWALK[k]),
    );
    if (!inner) {
      const a = polygonArea(curb);
      let cx = 0,
        cz = 0;
      for (const q of curb) {
        cx += q[0];
        cz += q[1];
      }
      cx /= curb.length;
      cz /= curb.length;
      if (
        a > 60 &&
        isLand([cx, cz]) &&
        wetFraction(curb, hf) <= 0.02 &&
        !overlapsRoad(curb)
      ) {
        const thin = insetPolygon(
          curb,
          curb.map(() => 0.6),
        );
        if (thin)
          slivers.push({curb, inner: thin, park: true, kinds, late: true});
      }
      continue;
    }
    let cx = 0,
      cz = 0;
    for (const q of inner) {
      cx += q[0];
      cz += q[1];
    }
    cx /= inner.length;
    cz /= inner.length;
    if (!isLand([cx, cz])) continue;
    if (wetFraction(curb, hf) > 0.02) continue;
    if (overlapsRoad(curb)) continue;
    const dens = densityAt(hubs, noise, cx, cz);
    const area = polygonArea(inner);
    const centralPark =
      params.arterials !== 'grid' &&
      Math.hypot(cx - center[0], cz - center[1]) < 230;
    const park =
      centralPark ||
      (area > 1500 &&
        hash2(Math.round(cx), Math.round(cz)) % 1000 <
          params.parkFraction * 1000 * (1.4 - dens));
    blocks.push({curb, inner, park, kinds});
    if (park) continue;
    const clean = cleanPolygon(inner, 1.5);
    if (clean.length < 3) continue;
    // Most blocks are finely divided into narrow street-front plots (narrower
    // and deeper downtown, wider with gaps in the suburbs); some core blocks
    // stay as a few big lots for towers.
    const big =
      area > 1500 && rng.chance(Math.pow(dens, 1.6) * params.modernity * 1.6);
    const rule: LotRule = big
      ? {width: [30, 70], depth: 60, gap: 0, merge: 0.3}
      : {
          width: [
            lerp(9, 5.5, dens),
            lerp(20, 11, dens) * rng.range(0.85, 1.25),
          ],
          depth: lerp(25, 22, dens) * rng.range(0.85, 1.2),
          gap: lerp(0.6, 0.15, dens),
          merge: lerp(0.1, 0.12, dens),
        };
    let lotsHere: Lot[] = [];
    splitLots(
      rng,
      clean,
      clean.map(() => true),
      rule,
      lotsHere,
    );
    // Buildings too close to a viaduct are dropped later; a big tower lot
    // touching one would leave the whole block bare, so split it finely.
    if (big && lotsHere.some(l => l.poly.some(q => nearRail(q, 7)))) {
      lotsHere = [];
      splitLots(
        new Rng(hash2(Math.round(cx), Math.round(cz)) ^ seed),
        clean,
        clean.map(() => true),
        {width: [6, 12], depth: 22, gap: 0.2, merge: 0.1},
        lotsHere,
      );
    }
    for (const lot of lotsHere) lots.push({lot, block: blocks.length - 1});
  }

  progress?.('Grading blocks', 0.55);
  blocks.push(...slivers);
  gradeBlocks(hf, blocks);

  progress?.('Designing buildings', 0.6, {blocks});
  const buildings: Building[] = [];
  // Buildings standing on each block, for the open-ground pass.
  const onBlock: number[][] = blocks.map(() => []);
  for (const {lot, block} of lots) {
    let fp = cleanPolygon(lot.poly, 1.2);
    if (fp.length < 3) continue;
    const area = polygonArea(fp);
    if (area < 40) continue;
    let cx = 0,
      cz = 0;
    for (const q of fp) {
      cx += q[0];
      cz += q[1];
    }
    cx /= fp.length;
    cz /= fp.length;
    if (nearRail([cx, cz], 14) || fp.some(q => nearRail(q, 7))) continue;
    if (fp.some(q => !isLand(q))) continue;
    const brng = new Rng(
      hash2(Math.round(cx * 10), Math.round(cz * 10)) ^ seed,
    );
    const dens = densityAt(hubs, noise, cx, cz);
    let lo = Infinity,
      hi = -Infinity;
    for (const q of fp) {
      const h = hf.sample(q[0], q[1]);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const box = obb(fp);
    const minSide = Math.min(box.hu, box.hv) * 2;
    let kind: BuildingKind;
    let floors: number;
    const tall = Math.pow(dens, 1.6);
    const r = brng.next();
    if (area > 900 && r < tall * params.modernity) {
      kind = brng.chance(0.6) ? 'glass' : 'tower';
      floors = Math.round(
        lerp(
          params.suburbFloors * 2,
          params.downtownFloors * 2.2,
          tall * brng.range(0.5, 1.1),
        ),
      );
    } else if (minSide < 9 && dens > 0.25) {
      kind = 'pencil';
      floors = Math.round(lerp(4, 11, brng.next()) + dens * 4);
    } else if (dens < 0.18 && area < 260) {
      kind = 'house';
      floors = brng.int(2, 4);
    } else if (dens < 0.4 && brng.chance(0.4)) {
      kind = 'apartment';
      floors = brng.int(4, 12);
    } else {
      kind = 'midrise';
      floors = Math.round(
        lerp(params.suburbFloors, params.downtownFloors * 0.6, dens) *
          brng.range(0.6, 1.4),
      );
    }
    // Old two-to-four storey shops survive between newer midrises, so street
    // walls step up and down from lot to lot.
    if (
      (kind === 'midrise' || kind === 'pencil') &&
      dens > 0.3 &&
      brng.chance(0.15)
    )
      floors = brng.int(2, 5);
    floors = clamp(floors, 1, 75);
    const floorH =
      kind === 'house' ? 2.9 : kind === 'glass' || kind === 'tower' ? 3.9 : 3.3;
    // Trim any edge that cuts through a viaduct (the checks above only look
    // at corners); the design above is unchanged, only the plan shrinks.
    const cut = clipToRail(fp, [cx, cz], elevated, 7, hf);
    if (cut !== fp) {
      const clean = cleanPolygon(cut, 1.2);
      if (clean.length >= 3 && polygonArea(clean) > 25) fp = clean;
    }
    // Likewise a plan that crosses or touches itself keeps its main loop.
    const loop = simplePolygon(fp);
    if (loop !== fp) {
      const clean = cleanPolygon(loop, 1.2);
      if (clean.length >= 3 && polygonArea(clean) > 25) fp = clean;
    }
    // Cleaning may drop vertices, so match edges back to the lot's.
    const frontage = inheritFrontage(fp, lot.poly, lot.frontage);
    let front = -1;
    let bestLen = 0;
    fp.forEach((a, i) => {
      if (!frontage[i]) return;
      const l = dist2(a, fp[(i + 1) % fp.length]);
      if (l > bestLen) {
        bestLen = l;
        front = i;
      }
    });
    onBlock[block].push(buildings.length);
    buildings.push({
      id: buildings.length,
      kind,
      footprint: fp,
      // Ground floor at the street frontage; downhill sides show lower floors.
      base:
        front >= 0
          ? clamp(
              hf.sample(
                (fp[front][0] + fp[(front + 1) % fp.length][0]) / 2,
                (fp[front][1] + fp[(front + 1) % fp.length][1]) / 2,
              ),
              lo,
              hi,
            )
          : hi,
      low: lo - 1,
      height: floors * floorH + (kind === 'house' ? 1.5 : 0),
      floorH,
      style: brng.int(0, 1 << 16),
      front,
      frontage,
      seed: brng.nextU32(),
      density: dens,
    });
  }
  progress?.('Open ground', 0.68);
  fillOpenGround(blocks, onBlock, buildings, elevated, hf);
  // Every seeded decision is made: give the river back the cells the road
  // carve heaped up around bridge ends (see carveRoads).
  restoreChannels(hf, flooded, buildings);
  progress?.('Layout done', 0.7, {buildings});
  return {
    params,
    seed,
    terrain,
    hubs,
    chains,
    junctions,
    blocks,
    buildings,
    elevated,
  };
}

/** Largest patch of bare sidewalk paving left inside a block, m². */
const MAX_BARE = 400;

/**
 * Give large open ground inside blocks a use, so aerial views don't show
 * acres of plain paving. A block whose lots were all dropped (e.g. beside a
 * viaduct) becomes a park; otherwise free cells (inside the sidewalk ring and
 * clear of buildings) are flood-filled and every patch over MAX_BARE becomes a
 * lawn or a striped surface car park (mostly car parks under a viaduct).
 * Decisions hash positions, so the layout RNG stream is untouched.
 */
function fillOpenGround(
  blocks: Block[],
  onBlock: number[][],
  buildings: Building[],
  elevated: Elevated[],
  hf: Heightfield,
) {
  const C = FILL_CELL;
  const bkey = (x: number, z: number) => (z + 1000) * 2000 + x + 1000;
  // Ground under elevated decks, on an 8 m grid.
  const DK = 8;
  const deck = new Set<number>();
  for (const e of elevated) {
    const r = elevatedHalfWidth(e);
    for (let i = 0; i + 1 < e.pts.length; i++) {
      if (inTunnel(e, i, hf) && inTunnel(e, i + 1, hf)) continue;
      const a = e.pts[i],
        b = e.pts[i + 1];
      const steps = Math.ceil(dist2(a, b) / 3);
      for (let k = 0; k <= steps; k++) {
        const x = lerp(a[0], b[0], k / steps);
        const z = lerp(a[1], b[1], k / steps);
        for (let dz = -r; dz <= r; dz += DK / 2)
          for (let dx = -r; dx <= r; dx += DK / 2)
            if (dx * dx + dz * dz <= r * r)
              deck.add(
                bkey(Math.floor((x + dx) / DK), Math.floor((z + dz) / DK)),
              );
      }
    }
  }
  // Scanline crossings of an interleaved (u, v) polygon with the line at v,
  // sorted into xs; returns the count.
  const xs = new Float64Array(256);
  const crossings = (poly: Float64Array, v: number) => {
    const n = poly.length / 2;
    let c = 0;
    for (let e = 0, f = n - 1; e < n && c < xs.length; f = e++) {
      const av = poly[e * 2 + 1],
        bv = poly[f * 2 + 1];
      if (av > v !== bv > v) {
        const au = poly[e * 2];
        const x = au + ((v - av) * (poly[f * 2] - au)) / (bv - av);
        // Insertion sort: crossings per line are few.
        let k = c++;
        for (; k > 0 && xs[k - 1] > x; k--) xs[k] = xs[k - 1];
        xs[k] = x;
      }
    }
    return c;
  };
  const underDeck = (q: Vec2) =>
    deck.has(bkey(Math.floor(q[0] / DK), Math.floor(q[1] / DK)));

  for (let bi = 0; bi < blocks.length; bi++) {
    const blk = blocks[bi];
    if (blk.park) continue;
    const area = polygonArea(blk.inner);
    if (area < MAX_BARE) continue;
    let covered = 0;
    const own = onBlock[bi] ?? [];
    for (const i of own) covered += polygonArea(buildings[i].footprint);
    if (area - covered < MAX_BARE) continue;
    let cx = 0,
      cz = 0;
    for (const q of blk.inner) {
      cx += q[0];
      cz += q[1];
    }
    cx /= blk.inner.length;
    cz /= blk.inner.length;
    const h = hash2(Math.round(cx * 3), Math.round(cz * 3) ^ 0x7a11);
    if (own.length === 0 && area > 800 && h % 3 !== 0) {
      blk.park = true;
      blk.late = true;
      continue;
    }
    // Free cells on a grid aligned with the block.
    const box = obb(blk.inner);
    const U = box.u;
    const V: Vec2 = [-U[1], U[0]];
    const ni = Math.ceil((box.hu * 2) / C);
    const nj = Math.ceil((box.hv * 2) / C);
    const o0: Vec2 = [
      box.c[0] - (U[0] * ni * C) / 2 - (V[0] * nj * C) / 2,
      box.c[1] - (U[1] * ni * C) / 2 - (V[1] * nj * C) / 2,
    ];
    const at = (u: number, v: number): Vec2 => [
      o0[0] + U[0] * u + V[0] * v,
      o0[1] + U[1] * u + V[1] * v,
    ];
    // Polygons in grid coordinates (u, v interleaved).
    const local = (poly: Vec2[]) => {
      const out = new Float64Array(poly.length * 2);
      poly.forEach((q, k) => {
        out[k * 2] = (q[0] - o0[0]) * U[0] + (q[1] - o0[1]) * U[1];
        out[k * 2 + 1] = (q[0] - o0[0]) * V[0] + (q[1] - o0[1]) * V[1];
      });
      return out;
    };
    // Corner inside-ness by scanlines, then cells with all corners inside.
    const inner = local(blk.inner);
    const corner = new Uint8Array((ni + 1) * (nj + 1));
    for (let j = 0; j <= nj; j++) {
      const n = crossings(inner, j * C);
      for (let i = 0, c = 0; i <= ni; i++) {
        while (c < n && xs[c] <= i * C) c++;
        corner[j * (ni + 1) + i] = c & 1;
      }
    }
    const free = new Uint8Array(ni * nj);
    let nFree = 0;
    for (let j = 0; j < nj; j++)
      for (let i = 0; i < ni; i++) {
        const k = j * (ni + 1) + i;
        if (
          corner[k] &&
          corner[k + 1] &&
          corner[k + ni + 1] &&
          corner[k + ni + 2]
        ) {
          free[j * ni + i] = 1;
          nFree++;
        }
      }
    if (nFree * C * C <= MAX_BARE) continue;
    // Clear cells near buildings (keep a ~1.5 m apron of paving).
    const margin = 1.6;
    for (const bi of own) {
      const fp = local(buildings[bi].footprint);
      const nf = fp.length / 2;
      let u0 = Infinity,
        u1 = -Infinity,
        v0 = Infinity,
        v1 = -Infinity;
      for (let k = 0; k < nf; k++) {
        u0 = Math.min(u0, fp[k * 2]);
        u1 = Math.max(u1, fp[k * 2]);
        v0 = Math.min(v0, fp[k * 2 + 1]);
        v1 = Math.max(v1, fp[k * 2 + 1]);
      }
      const i0 = Math.max(0, Math.floor((u0 - margin) / C));
      const i1 = Math.min(ni - 1, Math.floor((u1 + margin) / C));
      const j0 = Math.max(0, Math.floor((v0 - margin) / C));
      const j1 = Math.min(nj - 1, Math.floor((v1 + margin) / C));
      // Scanline the footprint at the cell-centre row and a margin above
      // and below; the extent of those crossings, grown by the margin,
      // clears the cells it covers (lots are near-convex).
      for (let j = j0; j <= j1; j++) {
        const pv = (j + 0.5) * C;
        let lo = Infinity,
          hi = -Infinity;
        for (let sv = -1; sv <= 1; sv++) {
          const n = crossings(fp, pv + sv * margin);
          if (n < 2) continue;
          lo = Math.min(lo, xs[0]);
          hi = Math.max(hi, xs[n - 1]);
        }
        const a0 = Math.max(i0, Math.ceil((lo - margin) / C - 0.5));
        const a1 = Math.min(i1, Math.floor((hi + margin) / C - 0.5));
        for (let i = a0; i <= a1; i++) free[j * ni + i] = 0;
      }
    }
    // Flood-fill patches.
    const comp = new Int32Array(ni * nj).fill(-1);
    for (let s = 0; s < ni * nj; s++) {
      if (!free[s] || comp[s] >= 0) continue;
      const cells: number[] = [s];
      comp[s] = s;
      for (let q = 0; q < cells.length; q++) {
        const c = cells[q];
        const i = c % ni,
          j = (c - i) / ni;
        const visit = (t: number) => {
          if (free[t] && comp[t] < 0) {
            comp[t] = s;
            cells.push(t);
          }
        };
        if (i > 0) visit(c - 1);
        if (i + 1 < ni) visit(c + 1);
        if (j > 0) visit(c - ni);
        if (j + 1 < nj) visit(c + ni);
      }
      if (cells.length * C * C <= MAX_BARE) continue;
      let ci0 = ni,
        ci1 = 0,
        cj0 = nj,
        cj1 = 0,
        deckCells = 0;
      for (const c of cells) {
        const i = c % ni,
          j = (c - i) / ni;
        ci0 = Math.min(ci0, i);
        ci1 = Math.max(ci1, i);
        cj0 = Math.min(cj0, j);
        cj1 = Math.max(cj1, j);
        if (underDeck(at((i + 0.5) * C, (j + 0.5) * C))) deckCells++;
      }
      const wu = ci1 - ci0 + 1,
        wv = cj1 - cj0 + 1;
      const compact = cells.length / (wu * wv);
      const p0 = at(ci0 * C, cj0 * C);
      const ph = hash2(Math.round(p0[0] * 4), Math.round(p0[1] * 4) ^ 0x9a3);
      const roomy = Math.min(wu, wv) >= 4 && compact > 0.45;
      const parking =
        roomy &&
        (deckCells > cells.length * 0.25 ? ph % 4 !== 0 : ph % 3 === 0);
      // Merge cells into rectangles: runs per row, extended down while equal.
      const rects: [number, number, number, number][] = [];
      let open = new Map<string, [number, number, number, number]>();
      for (let j = cj0; j <= cj1 + 1; j++) {
        const next = new Map<string, [number, number, number, number]>();
        for (let i = ci0; i <= ci1 && j <= cj1; i++) {
          if (comp[j * ni + i] !== s) continue;
          let e = i;
          while (e + 1 <= ci1 && comp[j * ni + e + 1] === s) e++;
          const k = `${i},${e}`;
          const r = open.get(k);
          if (r) {
            r[3] = j + 1;
            open.delete(k);
            next.set(k, r);
          } else {
            next.set(k, [i, j, e + 1, j + 1]);
          }
          i = e;
        }
        for (const r of open.values()) rects.push(r);
        open = next;
      }
      // Stall rows run along the patch's long side.
      const alongU = wu >= wv;
      const fu: Vec2 = alongU ? U : V;
      const fv: Vec2 = [-fu[1], fu[0]];
      const toFrame = (r: [number, number, number, number]) => {
        let a0 = Infinity,
          a1 = -Infinity,
          b0 = Infinity,
          b1 = -Infinity;
        for (const [i, j] of [
          [r[0], r[1]],
          [r[2], r[3]],
        ]) {
          const q = at(i * C, j * C);
          const a = q[0] * fu[0] + q[1] * fu[1];
          const b = q[0] * fv[0] + q[1] * fv[1];
          a0 = Math.min(a0, a);
          a1 = Math.max(a1, a);
          b0 = Math.min(b0, b);
          b1 = Math.max(b1, b);
        }
        return [a0, b0, a1, b1] as [number, number, number, number];
      };
      const fr = rects.map(toFrame);
      let ma = Infinity,
        mb = Infinity;
      for (const r of fr) {
        ma = Math.min(ma, r[0]);
        mb = Math.min(mb, r[1]);
      }
      const o: Vec2 = [fu[0] * ma + fv[0] * mb, fu[1] * ma + fv[1] * mb];
      (blk.fill ??= []).push({
        kind: parking ? 'parking' : 'green',
        o,
        u: fu,
        rects: fr.map(r => [r[0] - ma, r[1] - mb, r[2] - ma, r[3] - mb]),
      });
    }
  }
}

/**
 * Grade each block to a plane fitted through the road heights at its curb, so
 * sidewalks meet the roads with a constant curb instead of sloping wedges.
 */
function gradeBlocks(hf: Heightfield, blocks: Block[]) {
  const n = hf.n;
  const cell = hf.cell;
  const S = hf.size / 2;
  for (const b of blocks) {
    const poly = b.curb;
    // Least-squares plane h = a x + c z + d through curb samples.
    let sxx = 0,
      sxz = 0,
      szz = 0,
      sx = 0,
      sz = 0,
      sh = 0,
      sxh = 0,
      szh = 0,
      cnt = 0;
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const steps = Math.max(1, Math.ceil(dist2(p, q) / 8));
      for (let k = 0; k < steps; k++) {
        const x = lerp(p[0], q[0], k / steps);
        const z = lerp(p[1], q[1], k / steps);
        const h = hf.sample(x, z);
        sxx += x * x;
        sxz += x * z;
        szz += z * z;
        sx += x;
        sz += z;
        sh += h;
        sxh += x * h;
        szh += z * h;
        cnt++;
      }
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      z0 = Math.min(z0, p[1]);
      z1 = Math.max(z1, p[1]);
    }
    if (cnt < 3) continue;
    // Center the system for numerical stability.
    const mx = sx / cnt,
      mz = sz / cnt,
      mh = sh / cnt;
    const cxx = sxx / cnt - mx * mx,
      cxz = sxz / cnt - mx * mz,
      czz = szz / cnt - mz * mz;
    const cxh = sxh / cnt - mx * mh,
      czh = szh / cnt - mz * mh;
    const det = cxx * czz - cxz * cxz;
    let a = 0,
      c = 0;
    if (Math.abs(det) > 1e-6) {
      a = (cxh * czz - czh * cxz) / det;
      c = (czh * cxx - cxh * cxz) / det;
    }
    const plane = (x: number, z: number) => mh + a * (x - mx) + c * (z - mz);
    // Interior cells start on the plane, then relax as a membrane whose edge is
    // held by the surrounding road heights, so the block meets every road.
    const gx0 = Math.max(1, Math.floor((x0 + S) / cell));
    const gx1 = Math.min(n - 2, Math.ceil((x1 + S) / cell));
    const gz0 = Math.max(1, Math.floor((z0 + S) / cell));
    const gz1 = Math.min(n - 2, Math.ceil((z1 + S) / cell));
    const inside: number[] = [];
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = gx * cell - S;
        const z = gz * cell - S;
        if (pointInPolygon([x, z], poly)) {
          const k = gz * n + gx;
          hf.data[k] = plane(x, z);
          inside.push(k);
        }
      }
    }
    const iters = Math.min(160, 20 + 4 * Math.max(gx1 - gx0, gz1 - gz0));
    for (let it = 0; it < iters; it++) {
      for (const k of inside) {
        hf.data[k] =
          (hf.data[k - 1] + hf.data[k + 1] + hf.data[k - n] + hf.data[k + n]) *
          0.25;
      }
    }
  }
}

/**
 * Where two elevated lines cross, lift the later one so it clears the other's
 * deck (train + overhead wires) with a gentle approach grade, unless it
 * already runs that far below it.
 */
function separateCrossings(lines: Elevated[]) {
  const clearance = 8.5;
  const grade = 0.03;
  for (let b = 0; b < lines.length; b++) {
    const B = lines[b];
    const along = [0];
    for (let k = 1; k < B.pts.length; k++)
      along.push(along[k - 1] + dist2(B.pts[k - 1], B.pts[k]));
    for (let a = 0; a <= b; a++) {
      const A = lines[a];
      // Wherever the decks overlap in plan (a shallow crossing overlaps for
      // hundreds of metres, not just at the centreline intersection), B must
      // clear A's deck. A line that folds over itself clears its earlier part.
      const reach = elevatedHalfWidth(A) + elevatedHalfWidth(B) + 2;
      // [arc length, lift over B's own deck there].
      const need: [number, number][] = [];
      for (let k = 0; k < B.pts.length; k++) {
        const own = a === b ? A.pts.slice(0, Math.max(0, k - SELF_GAP)) : A.pts;
        if (own.length < 2) continue;
        const c = closestOnPolyline(own, B.pts[k]);
        if (c.d < reach) {
          const h = lerp(A.heights[c.i], A.heights[c.i + 1], c.t);
          // B already passes under A (out of a hill, or in a tunnel below
          // it) with room to spare: leave it there.
          if (h + clearance > B.heights[k] && B.heights[k] + clearance > h)
            need.push([along[k], h + clearance - B.heights[k]]);
        }
      }
      if (!need.length) continue;
      // The lift eases off along B's own profile, not as an absolute height:
      // a crossing on a hilltop used to hold B up at the hilltop height for
      // a kilometre and more down into the valleys on either side.
      const own = B.heights.slice();
      for (let k = 0; k < B.pts.length; k++) {
        for (const [s, lift] of need) {
          B.heights[k] = Math.max(
            B.heights[k],
            own[k] + lift - grade * Math.max(0, Math.abs(along[k] - s) - 30),
          );
        }
      }
    }
  }
}

/**
 * Stations whose platforms (si - 7 .. si + 7) stand clear of the ground, or
 * lie wholly in a tunnel (an underground station: trains still stop there).
 * One at the mouth of a tunnel, cut through by the portal, is left out.
 */
function clearStations(e: Elevated, hf: Heightfield) {
  const n = e.pts.length;
  return e.stations.filter(si => {
    let open = true;
    let deep = true;
    for (let k = si - 7; k <= si + 7; k++) {
      const i = e.loop ? (k + n) % n : clamp(k, 0, n - 1);
      if (e.heights[i] < hf.sample(e.pts[i][0], e.pts[i][1]) + 5) open = false;
      if (!inTunnel(e, i, hf)) deep = false;
    }
    return open || deep;
  });
}

/** Points (12 m apart) that must separate two parts of one line to count as a fold. */
const SELF_GAP = 40;

/** A point where a resampled line passes within a deck width of itself. */
function selfOverlap(pts: Vec2[]): Vec2 | undefined {
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + SELF_GAP; j < pts.length; j++) {
      // Closed loops: indices near both ends are neighbours too.
      if (pts.length - j + i < SELF_GAP) break;
      if (dist2(pts[i], pts[j]) < 14) return pts[i];
    }
  }
  return undefined;
}

export function elevatedHalfWidth(e: Elevated) {
  return e.kind === 'rail' ? 5.2 : 9;
}

/** Closest point on an open polyline: segment index, parameter, distance. */
export function closestOnPolyline(pts: Vec2[], q: Vec2) {
  let best = {i: 0, t: 0, d: Infinity};
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1;
    const t = clamp(((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / l2, 0, 1);
    const d = Math.hypot(a[0] + dx * t - q[0], a[1] + dz * t - q[1]);
    if (d < best.d) best = {i, t, d};
  }
  return best;
}

/** Fraction of sample points inside the polygon that are water. */
function wetFraction(poly: Vec2[], hf: Heightfield) {
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const q of poly) {
    x0 = Math.min(x0, q[0]);
    x1 = Math.max(x1, q[0]);
    z0 = Math.min(z0, q[1]);
    z1 = Math.max(z1, q[1]);
  }
  const step = Math.max(6, Math.max(x1 - x0, z1 - z0) / 24);
  let wet = 0;
  let total = 0;
  for (let z = z0; z <= z1; z += step) {
    for (let x = x0; x <= x1; x += step) {
      if (!pointInPolygon([x, z], poly)) continue;
      total++;
      if (hf.sample(x, z) < SEA_LEVEL + 0.5) wet++;
    }
  }
  return total ? wet / total : 0;
}

/** Carve the terrain to match road surfaces so roads never float or sink. */
function carveRoads(hf: Heightfield, chains: RoadChain[]) {
  const n = hf.n;
  const cell = hf.cell;
  const S = hf.size / 2;
  const target = new Float32Array(n * n).fill(NaN);
  const weight = new Float32Array(n * n);
  const dist = new Float32Array(n * n).fill(Infinity);
  for (const c of chains) {
    const half = ROAD_WIDTH[c.kind] / 2 + SIDEWALK[c.kind] + 1;
    const falloff = half + 10;
    for (let i = 0; i + 1 < c.pts.length; i++) {
      if (c.bridge[i] && c.bridge[i + 1]) continue;
      const a = c.pts[i];
      const b = c.pts[i + 1];
      const x0 = Math.floor((Math.min(a[0], b[0]) - falloff + S) / cell);
      const x1 = Math.ceil((Math.max(a[0], b[0]) + falloff + S) / cell);
      const z0 = Math.floor((Math.min(a[1], b[1]) - falloff + S) / cell);
      const z1 = Math.ceil((Math.max(a[1], b[1]) + falloff + S) / cell);
      for (let gz = Math.max(0, z0); gz <= Math.min(n - 1, z1); gz++) {
        for (let gx = Math.max(0, x0); gx <= Math.min(n - 1, x1); gx++) {
          const q: Vec2 = [gx * cell - S, gz * cell - S];
          const [d, t] = pointSegment(q, a, b);
          if (d > falloff) continue;
          const h = lerp(c.heights[i], c.heights[i + 1], t);
          const w = d < half ? 1 : 1 - smoothstep(half, falloff, d);
          const k = gz * n + gx;
          // Where two roads' full-weight bands overlap (acute junctions,
          // boulevards whose wide carve band reaches the next road), the
          // nearer road sets the height; first-come would bury the other
          // road under up to 3 m of terrain.
          if (w > weight[k] || (w === weight[k] && d < dist[k])) {
            weight[k] = w;
            target[k] = h;
            dist[k] = d;
          }
        }
      }
    }
  }
  // Original heights of river/sea cells the carve raised. Bridge approaches
  // climb to deck height over the last stretch of bank, and their falloff
  // band would heap an earth mound out into the water (clipping piers). The
  // layout still sees the carved field so its seeded choices don't move;
  // restoreChannels() digs these cells back out once layout is done, and the
  // road deck builder spans them as bridge.
  const flooded = new Map<number, number>();
  for (let k = 0; k < n * n; k++) {
    if (weight[k] > 0) {
      const h = lerp(hf.data[k], target[k] - 0.05, weight[k]);
      // Only where the road stands high enough for gen-base to give it a
      // deck (> 2.5 m above the water); low riverside roads keep their bank.
      if (
        hf.data[k] < SEA_LEVEL + 0.5 &&
        h > hf.data[k] &&
        target[k] > SEA_LEVEL + 2.7
      )
        flooded.set(k, hf.data[k]);
      hf.data[k] = h;
    }
  }
  return flooded;
}

/** Undo carveRoads' fill in the water, except under buildings. */
function restoreChannels(
  hf: Heightfield,
  flooded: Map<number, number>,
  buildings: Building[],
) {
  if (!flooded.size) return;
  const n = hf.n;
  const cell = hf.cell;
  const S = hf.size / 2;
  const keep = new Set<number>();
  for (const b of buildings) {
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const q of b.footprint) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      z0 = Math.min(z0, q[1]);
      z1 = Math.max(z1, q[1]);
    }
    for (
      let gz = Math.floor((z0 + S) / cell) - 1;
      gz <= (z1 + S) / cell + 1;
      gz++
    )
      for (
        let gx = Math.floor((x0 + S) / cell) - 1;
        gx <= (x1 + S) / cell + 1;
        gx++
      )
        if (gx >= 0 && gz >= 0 && gx < n && gz < n) keep.add(gz * n + gx);
  }
  for (const [k, h] of flooded) {
    if (!keep.has(k)) hf.data[k] = Math.min(hf.data[k], h);
  }
}

function expressways(
  p: CityParams,
  rng: Rng,
  chains: RoadChain[],
  hf: Heightfield,
): Elevated[] {
  const out: Elevated[] = [];
  // Boulevard chains break at every junction, so first join them into long
  // "strokes": at each node continue along the straightest boulevard.
  const blvd = chains
    .map((c, i) => i)
    .filter(
      i => chains[i].kind === Road.boulevard && !chains[i].bridge.some(b => b),
    );
  const atNode = new Map<number, number[]>();
  for (const i of blvd) {
    for (const nd of [chains[i].start, chains[i].end]) {
      let l = atNode.get(nd);
      if (!l) atNode.set(nd, (l = []));
      l.push(i);
    }
  }
  const used = new Set<number>();
  // Oriented copy of chain i leaving node `from`.
  const oriented = (i: number, from: number) => {
    const c = chains[i];
    const fwd = c.start === from;
    return {
      pts: fwd ? c.pts.slice() : c.pts.slice().reverse(),
      hs: fwd ? c.heights.slice() : c.heights.slice().reverse(),
      to: fwd ? c.end : c.start,
    };
  };
  const dirAt = (pts: Vec2[], end: boolean): Vec2 => {
    const n = pts.length;
    const a = end ? pts[Math.max(0, n - 3)] : pts[0];
    const b = end ? pts[n - 1] : pts[Math.min(n - 1, 2)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const extend = (pts: Vec2[], hs: number[], node: number) => {
    for (;;) {
      const d = dirAt(pts, true);
      let best = -1;
      let bestDot = Math.cos((30 * Math.PI) / 180);
      for (const j of atNode.get(node) ?? []) {
        if (used.has(j)) continue;
        const o = oriented(j, node);
        const dj = dirAt(o.pts, false);
        const dot = d[0] * dj[0] + d[1] * dj[1];
        if (dot > bestDot) {
          bestDot = dot;
          best = j;
        }
      }
      if (best < 0) return;
      used.add(best);
      const o = oriented(best, node);
      pts.push(...o.pts.slice(1));
      hs.push(...o.hs.slice(1));
      node = o.to;
    }
  };
  const strokes: {pts: Vec2[]; hs: number[]; len: number}[] = [];
  for (const i of blvd) {
    if (used.has(i)) continue;
    used.add(i);
    const c = chains[i];
    const pts = c.pts.slice();
    const hs = c.heights.slice();
    extend(pts, hs, c.end);
    pts.reverse();
    hs.reverse();
    extend(pts, hs, c.start);
    let len = 0;
    for (let k = 1; k < pts.length; k++)
      len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    strokes.push({pts, hs, len});
  }
  strokes.sort((a, b) => b.len - a.len);
  for (const st of strokes) {
    if (out.length >= p.expressways || st.len < 1400) break;
    // Trim the ends so the decks don't end on top of junctions.
    const pts = st.pts.slice(4, -4);
    const base = st.hs.slice(4, -4);
    if (pts.length < 20) continue;
    // Keep expressways apart from each other (no parallel stacks).
    const tooClose = out.some(e => {
      let near = 0;
      for (let k = 0; k < pts.length; k += 5) {
        for (let m = 0; m < e.pts.length; m += 3) {
          if (
            Math.hypot(pts[k][0] - e.pts[m][0], pts[k][1] - e.pts[m][1]) < 40
          ) {
            near++;
            break;
          }
        }
      }
      return near > pts.length / 5 / 4;
    });
    if (tooClose) continue;
    const heights = elevateProfile(pts, hf, 0, 0.04).map((h, i) =>
      Math.max(h, base[i] + 11),
    );
    out.push({pts, heights, kind: 'expressway', loop: false, stations: []});
  }
  void rng;
  return out;
}

/** Keep the part of `poly` on the side of line (o, n) where dot(q - o, n) >= 0. */
function clipHalfPlane(poly: Vec2[], o: Vec2, n: Vec2): Vec2[] {
  const out: Vec2[] = [];
  const s = (q: Vec2) => (q[0] - o[0]) * n[0] + (q[1] - o[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = s(a);
    const sb = s(b);
    if (sa >= 0) out.push(a);
    if (sa >= 0 !== sb >= 0) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Shortest distance between segments ab and cd (0 if they cross). */
function segmentGap(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const cr = (p: Vec2, q: Vec2, r: Vec2) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (cr(a, b, c) * cr(a, b, d) < 0 && cr(c, d, a) * cr(c, d, b) < 0) return 0;
  return Math.min(
    pointSegment(a, c, d)[0],
    pointSegment(b, c, d)[0],
    pointSegment(c, a, b)[0],
    pointSegment(d, a, b)[0],
  );
}

/**
 * Trim a building footprint off an elevated rail line's clearance band. Lots
 * are rejected by their corners and centre only, so a long plot can still
 * have an edge that crosses the viaduct between two far-off corners; this cuts
 * it back along the deck, on the side its centre `c` lies, `pad` metres clear.
 * Pure geometry (no random draws), applied after the building is designed.
 */
function clipToRail(
  fp: Vec2[],
  c: Vec2,
  elevated: Elevated[],
  pad: number,
  hf: Heightfield,
): Vec2[] {
  let poly = fp;
  for (const e of elevated) {
    if (e.kind !== 'rail') continue;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const a = e.pts[i];
      const b = e.pts[i + 1];
      if (Math.abs(a[0] - c[0]) > 150 || Math.abs(a[1] - c[1]) > 150) continue;
      if (inTunnel(e, i, hf) && inTunnel(e, i + 1, hf)) continue;
      let near = false;
      for (let j = 0; j < poly.length && !near; j++)
        near = segmentGap(poly[j], poly[(j + 1) % poly.length], a, b) < pad;
      if (!near) continue;
      const d = sub2(b, a);
      const l = Math.hypot(d[0], d[1]);
      if (l < 1e-6) continue;
      let n: Vec2 = [-d[1] / l, d[0] / l];
      if (dot2(sub2(c, a), n) < 0) n = [-n[0], -n[1]];
      poly = clipHalfPlane(poly, [a[0] + n[0] * pad, a[1] + n[1] * pad], n);
      if (poly.length < 3) return poly;
    }
  }
  return poly;
}
