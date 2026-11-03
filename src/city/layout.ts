// City layout: arterial network, patchwork minor street grids, blocks, lots,
// building specs, elevated rail lines and expressways.

import {Noise2D} from '../math/noise.ts';
import {release} from '../mem.ts';
import {Rng, hash2} from '../math/random.ts';
import {
  clamp,
  dist2,
  dot2,
  lerp,
  pointInPolygon,
  pointSegment,
  polygonArea,
  rowCrossings,
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
  mergeJunctionClusters,
  planarize,
  pruneDeadEnds,
  removeSlivers,
  type Chain,
  type Face,
  type Graph,
  type Polyline,
} from './graph.ts';
import {fitPath, fitRises} from './grade.ts';
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
/**
 * Least length of road between two junctions beyond what their side roads
 * take up along it (half a carriageway and a sidewalk each:
 * mergeJunctionClusters).
 */
const JUNCTION_GAP = 1;

/**
 * Least distance between the centrelines of roads of kinds a and b that run
 * alongside each other without meeting: both carriageways and sidewalks,
 * and a little more.
 */
export function roadClearance(a: number, b: number) {
  return (ROAD_WIDTH[a] + ROAD_WIDTH[b]) / 2 + SIDEWALK[a] + SIDEWALK[b] + 3;
}

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

/** Steepest grade of a rail line. */
const RAIL_GRADE = 0.03;
/** Ground over a buried rail deck (buryRail). */
const RAIL_COVER = 1;

/**
 * Lower a rail deck to RAIL_COVER under the ground at the points marked
 * `bored`, and its approaches to keep RAIL_GRADE.
 */
function buryRail(e: Elevated, bored: Uint8Array, hf: Heightfield) {
  const cap = e.pts.map((q, i) =>
    bored[i] ? -(hf.sample(q[0], q[1]) - RAIL_COVER) : -Infinity,
  );
  const ceil = gradeEnvelope(e.pts, cap, RAIL_GRADE);
  e.heights = e.heights.map((h, i) => Math.min(h, -ceil[i]));
}

/**
 * Raise the ground to RAIL_COVER over a rail deck at the points marked
 * `bored` where it is not (blending back over 12 m).
 */
function coverRail(e: Elevated, bored: Uint8Array, hf: Heightfield) {
  const {n, cell} = hf;
  const S = hf.size / 2;
  const R = 8;
  const F = R + 12;
  e.pts.forEach((q, i) => {
    const top = e.heights[i] + RAIL_COVER + 0.5;
    if (!bored[i] || hf.sample(q[0], q[1]) >= top - 0.5) return;
    const x0 = Math.max(0, Math.floor((q[0] - F + S) / cell));
    const x1 = Math.min(n - 1, Math.ceil((q[0] + F + S) / cell));
    const z0 = Math.max(0, Math.floor((q[1] - F + S) / cell));
    const z1 = Math.min(n - 1, Math.ceil((q[1] + F + S) / cell));
    for (let gz = z0; gz <= z1; gz++)
      for (let gx = x0; gx <= x1; gx++) {
        const d = Math.hypot(gx * cell - S - q[0], gz * cell - S - q[1]);
        const w = 1 - smoothstep(R, F, d);
        const k = gz * n + gx;
        if (w > 0 && hf.data[k] < top) hf.data[k] = lerp(hf.data[k], top, w);
      }
  });
}

function railLines(
  p: CityParams,
  rng: Rng,
  noise: Noise2D,
  hubs: Hub[],
  center: Vec2,
  hf: Heightfield,
  /** Receives each line's deck clearance. */
  clearances: number[] = [],
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
        heights: elevateProfile(pts, hf, 9, RAIL_GRADE, true),
        kind: 'rail',
        loop: true,
        stations: [],
      });
      clearances.push(9);
    } else {
      // The loop would cross open water: keep the longest stretch on land.
      const piece =
        clipToLand(pts, hf, 350).sort((a, b) => b.length - a.length)[0] ?? [];
      // Bridges over narrow water (rivers) keep it in one piece: then it is
      // still a loop, not a line with two dead ends side by side.
      if (piece.length > 20) {
        out.push({
          pts: piece,
          heights: elevateProfile(piece, hf, 9, RAIL_GRADE, true),
          kind: 'rail',
          loop: piece.length === pts.length,
          stations: [],
        });
        clearances.push(9);
      }
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
    if (pts.length > 10) {
      out.push({
        pts,
        heights: elevateProfile(pts, hf, 9 + k * 3, RAIL_GRADE, true),
        kind: 'rail',
        loop: false,
        stations: [],
      });
      clearances.push(9 + k * 3);
    }
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

/**
 * generateLayout's progress callback: a step starting (`msg`, the overall
 * estimate `f`, any finished `partial`), or with `sub` (0..1) how far the
 * current step `msg` has got (the long ones report as they go).
 */
export type LayoutProgress = (
  msg: string,
  f: number,
  partial?: LayoutPartial,
  sub?: number,
) => void;

export function generateLayout(
  params: CityParams,
  seed: number,
  progress?: LayoutProgress,
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
  // Ring road around the central park (the streets keep clear of it).
  let ring: Polyline | undefined;
  if (params.arterials !== 'grid') {
    const pts: Vec2[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push([center[0] + Math.cos(a) * 236, center[1] + Math.sin(a) * 236]);
    }
    ring = {pts, kind: Road.boulevard};
  }
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
      clearance: roadClearance,
      fixed: ring ? [ring] : [],
    },
    hf,
    seed,
  );
  if (ring) allLines.push(ring);
  progress?.('Connecting streets', 0.25, {streets: allLines});
  let g: Graph = planarize(allLines, 2.5);
  g = mergeCloseNodes(g, 5);
  g = mergeJunctionClusters(
    g,
    ROAD_WIDTH.map((w, k) => w / 2 + SIDEWALK[k]),
    JUNCTION_GAP,
  );
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
  const gradingRoads = (sub: number) =>
    progress?.('Grading roads', 0.35, undefined, sub);
  const {chains, nodeH} = gradeRoads(g, chainsG, hf, isLand, gradingRoads);
  // Every seeded choice from here on (what is land, which rail runs in a
  // tunnel and so which lots stay) is made on the ground as the old
  // per-chain grading carved it, so saved views keep their roads and lots;
  // the real ground is carved to the graded network.
  const hfSeed = new Heightfield(hf.size, hf.cell, hf.data.slice());
  const heightsSeed = seedHeights(chains, hfSeed);
  gradingRoads(0.5);
  const flooded = carveGraded(
    hf,
    chains,
    {hf: hfSeed, heights: heightsSeed},
    f => gradingRoads(0.5 + f * 0.5),
  );
  const isLandSeed = (q: Vec2) => hfSeed.sample(q[0], q[1]) > SEA_LEVEL + 0.5;

  // Junctions.
  const nodeOf = new Map<Junction, number>();
  const makeJunctions = () => {
    const junctionOf = new Map<number, number>();
    const out: Junction[] = [];
    chains.forEach((c, ci) => {
      for (const end of [0, 1] as const) {
        const n = end === 0 ? c.start : c.end;
        let j = junctionOf.get(n);
        if (j === undefined) {
          j = out.length;
          junctionOf.set(n, j);
          out.push({p: g.nodes[n].p, h: nodeH[n], arms: [], signal: false});
          nodeOf.set(out[j], n);
        }
        out[j].arms.push({chain: ci, end});
      }
    });
    for (const j of out) {
      const maxKind = Math.max(...j.arms.map(a => chains[a.chain].kind));
      j.signal = j.arms.length >= 3 && maxKind >= Road.street;
    }
    return out;
  };
  const junctions = makeJunctions();
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
    const order = stableOrder(junctions, j => String(nodeOf.get(j)), before);
    junctions.splice(0, junctions.length, ...order);
  }

  progress?.('Elevated rail and expressways', 0.45, {chains});
  // Rail lines are laid out on the seed terrain (where they run, and which
  // lots stay clear of them), then their decks are graded again over the
  // real ground; the stations are those that fit there.
  const clearances: number[] = [];
  const seedRails = railLines(
    params,
    rng,
    noise,
    hubs,
    center,
    hfSeed,
    clearances,
  );
  const candidates = seedRails.map(e => e.stations.slice());
  separateCrossings(seedRails);
  const elevated: Elevated[] = seedRails.map((e, i) => ({
    ...e,
    heights: elevateProfile(e.pts, hf, clearances[i], RAIL_GRADE, true),
    stations: candidates[i],
  }));
  elevated.push(...expressways(params, rng, chains, hf));
  separateCrossings(elevated);
  for (const e of elevated) e.stations = clearStations(e, hf);

  progress?.('Subdividing blocks', 0.5, {elevated});
  const faces = extractFaces(g, 400000);
  // Rail segments binned by their first point (60 m cells): nearRail tests
  // the same segments as a scan of every rail line (those whose first point
  // is within 60 m on both axes), only without visiting the rest. Segments
  // in a tunnel are left out.
  const railGrid = new Map<number, [Vec2, Vec2][]>();
  const railKey = (cx: number, cz: number) => (cz + 2048) * 4096 + cx + 2048;
  // Which rail points the seed has in a tunnel (buildings may stand over).
  const bored = seedRails.map(e =>
    Uint8Array.from(e.pts, (_, i) => (inTunnel(e, i, hfSeed) ? 1 : 0)),
  );
  seedRails.forEach((e, li) => {
    for (let i = 0; i + 1 < e.pts.length; i++) {
      // Buildings may stand over a tunnel.
      if (bored[li][i] && bored[li][i + 1]) continue;
      const a = e.pts[i];
      const k = railKey(Math.floor(a[0] / 60), Math.floor(a[1] / 60));
      let l = railGrid.get(k);
      if (!l) railGrid.set(k, (l = []));
      l.push([a, e.pts[i + 1]]);
    }
  });
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
  const roadOverlap = (list: RoadChain[]) => {
    const roadGrid = new Map<number, Vec2[]>();
    const rkey = (x: number, z: number) =>
      (Math.floor(z / 50) + 500) * 1000 + Math.floor(x / 50) + 500;
    for (const c of list) {
      for (const q of c.pts) {
        const k = rkey(q[0], q[1]);
        let l = roadGrid.get(k);
        if (!l) roadGrid.set(k, (l = []));
        l.push(q);
      }
    }
    return (poly: Vec2[]) => {
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
  };
  const overlapsRoad = roadOverlap(chains);
  /**
   * A face's block (or sliver: between converging roads too thin for a
   * sidewalk ring and lots, a pocket park) and lots.
   */
  const faceBlock = (f: Face): {block?: Block; sliver?: Block; lots: Lot[]} => {
    const none = {lots: []};
    const kinds = f.edges.map(e => g.edges[e].kind);
    const poly = f.nodes.map(n => g.nodes[n].p);
    const curb = insetPolygon(
      poly,
      kinds.map(k => ROAD_WIDTH[k] / 2),
    );
    if (!curb) return none;
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
        isLandSeed([cx, cz]) &&
        wetFraction(curb, hfSeed) <= 0.02 &&
        !overlapsRoad(curb)
      ) {
        const thin = insetPolygon(
          curb,
          curb.map(() => 0.6),
        );
        if (thin)
          return {
            sliver: {curb, inner: thin, park: true, kinds, late: true},
            lots: [],
          };
      }
      return none;
    }
    let cx = 0,
      cz = 0;
    for (const q of inner) {
      cx += q[0];
      cz += q[1];
    }
    cx /= inner.length;
    cz /= inner.length;
    if (!isLandSeed([cx, cz])) return none;
    if (wetFraction(curb, hfSeed) > 0.02) return none;
    if (overlapsRoad(curb)) return none;
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
    const block: Block = {curb, inner, park, kinds};
    if (park) return {block, lots: []};
    const clean = cleanPolygon(inner, 1.5);
    if (clean.length < 3) return {block, lots: []};
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
    return {block, lots: lotsHere};
  };
  const blocks: Block[] = [];
  // Slivers become pocket parks appended after the real blocks.
  const slivers: Block[] = [];
  const lots: {lot: Lot; block: number}[] = [];
  for (const f of faces) {
    const o = faceBlock(f);
    if (o.block) {
      blocks.push(o.block);
      for (const lot of o.lots) lots.push({lot, block: blocks.length - 1});
    }
    if (o.sliver) slivers.push(o.sliver);
  }

  progress?.('Grading blocks', 0.55);
  const gradingBlocks = (sub: number) =>
    progress?.('Grading blocks', 0.55, undefined, sub);
  blocks.push(...slivers);
  gradeBlocks(hf, blocks, undefined, f => gradingBlocks(f * 0.72));
  // Rail lines stay underground wherever the seed had them in a tunnel (the
  // lots over them were kept), however far the graded ground came down.
  seedRails.forEach((_, li) => buryRail(elevated[li], bored[li], hf));
  gradingBlocks(0.74);
  separateCrossings(elevated);
  gradingBlocks(0.86);
  // Where one line lifted over another came up, heap the ground over it.
  seedRails.forEach((_, li) => coverRail(elevated[li], bored[li], hf));
  for (const e of elevated) e.stations = clearStations(e, hf);
  gradingBlocks(0.87);
  // The seed ground too, where the choices below read it (they were made on
  // graded blocks): blocks that may grade down to the water line, and those
  // under a rail line (which runs in a tunnel where the ground is over it).
  const railPts: Vec2[] = [];
  for (const e of seedRails) railPts.push(...e.pts);
  const pad = hf.cell * 2;
  gradeBlocks(
    hfSeed,
    blocks,
    (box, low) =>
      low <= SEA_LEVEL + 0.6 ||
      railPts.some(
        q =>
          q[0] > box[0] - pad &&
          q[0] < box[2] + pad &&
          q[1] > box[1] - pad &&
          q[1] < box[3] + pad,
      ),
    f => gradingBlocks(0.87 + f * 0.13),
  );

  progress?.('Designing buildings', 0.6, {blocks});
  const railSegs = binRailSegments(seedRails, hfSeed);
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
    if (fp.some(q => !isLandSeed(q))) continue;
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
    const cut = clipToRail(fp, [cx, cz], railSegs, 7);
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
  fillOpenGround(blocks, onBlock, buildings, seedRails, hfSeed);
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
function gradeBlocks(
  hf: Heightfield,
  blocks: Block[],
  /**
   * Grade only the blocks this keeps, given the block's bounds (x0, z0, x1,
   * z1) and the lowest height its grading can leave (the least of its
   * plane at the corners and the ground around it).
   */
  keep?: (box: number[], low: number) => boolean,
  /** Fraction of the blocks done, now and then (progress). */
  tick?: (f: number) => void,
) {
  const n = hf.n;
  const cell = hf.cell;
  const S = hf.size / 2;
  const data = hf.data;
  let inside = new Int32Array(4096);
  let rowAt = new Int32Array(256);
  const xs: number[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    if (tick && (bi & 63) === 0) tick(bi / blocks.length);
    const b = blocks[bi];
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
    if (keep) {
      // Relaxing averages, so nothing ends below the start values (the
      // plane, least at a corner) or the cells around the block.
      let low = Infinity;
      for (const q of poly) low = Math.min(low, plane(q[0], q[1]));
      const bx0 = Math.max(0, Math.floor((x0 + S) / cell) - 1);
      const bx1 = Math.min(n - 1, Math.ceil((x1 + S) / cell) + 1);
      const bz0 = Math.max(0, Math.floor((z0 + S) / cell) - 1);
      const bz1 = Math.min(n - 1, Math.ceil((z1 + S) / cell) + 1);
      for (let gz = bz0; gz <= bz1; gz++)
        for (let gx = bx0; gx <= bx1; gx++)
          low = Math.min(low, data[gz * n + gx]);
      if (!keep([x0, z0, x1, z1], low)) continue;
    }
    // Interior cells start on the plane, then relax as a membrane whose edge is
    // held by the surrounding road heights, so the block meets every road.
    const gx0 = Math.max(1, Math.floor((x0 + S) / cell));
    const gx1 = Math.min(n - 2, Math.ceil((x1 + S) / cell));
    const gz0 = Math.max(1, Math.floor((z0 + S) / cell));
    const gz1 = Math.min(n - 2, Math.ceil((z1 + S) / cell));
    // Interior cell indices in scan order, and where each grid row's start.
    const rows = gz1 - gz0 + 1;
    const cells = (gx1 - gx0 + 1) * rows;
    if (cells > inside.length) inside = new Int32Array(cells * 2);
    if (rows + 1 > rowAt.length) rowAt = new Int32Array((rows + 1) * 2);
    let ni = 0;
    for (let gz = gz0; gz <= gz1; gz++) {
      rowAt[gz - gz0] = ni;
      const z = gz * cell - S;
      // pointInPolygon([x, z], poly) for the row: inside where an odd
      // number of the edge crossings lie right of x.
      const nx = rowCrossings(poly, z, xs);
      let c = 0;
      for (let gx = gx0; gx <= gx1; gx++) {
        const x = gx * cell - S;
        while (c < nx && xs[c] <= x) c++;
        if ((nx - c) & 1) {
          const k = gz * n + gx;
          data[k] = plane(x, z);
          inside[ni++] = k;
        }
      }
    }
    rowAt[rows] = ni;
    const iters = Math.min(160, 20 + 4 * Math.max(gx1 - gx0, gz1 - gz0));
    relaxBlock(data, n, inside, rowAt, rows, iters);
  }
}

/**
 * Gauss-Seidel sweeps in scan order: a cell reads its left and upper
 * neighbours from this sweep and its right and lower ones from the last.
 * Sweep t runs two rows behind sweep t - 1, so at each step the rows in
 * flight (one per sweep) see exactly what the sweeps one after another
 * would; two of those rows at a time go cell by cell, so the CPU
 * overlaps their (otherwise serial) dependency chains. Cells are the
 * indices inside[rowAt[r] .. rowAt[r + 1]) of each of the block's rows.
 */
function relaxBlock(
  data: Float32Array,
  n: number,
  inside: Int32Array,
  rowAt: Int32Array,
  rows: number,
  iters: number,
) {
  for (let s = 0; s < rows + 2 * (iters - 1); s++) {
    const t0 = Math.max(0, (s - rows + 2) >> 1);
    let t = Math.min(iters - 1, s >> 1);
    for (; t >= t0; t -= 2) {
      const r = s - 2 * t;
      let i = rowAt[r];
      const e = rowAt[r + 1];
      // The pair's other row (sweep t - 1, two rows down), if any.
      let j = 0;
      let f = 0;
      if (t - 1 >= t0) {
        j = rowAt[r + 2];
        f = rowAt[r + 3];
      }
      for (; i < e && j < f; i++, j++) {
        const k = inside[i];
        const m = inside[j];
        data[k] =
          (data[k - 1] + data[k + 1] + data[k - n] + data[k + n]) * 0.25;
        data[m] =
          (data[m - 1] + data[m + 1] + data[m - n] + data[m + n]) * 0.25;
      }
      for (; i < e; i++) {
        const k = inside[i];
        data[k] =
          (data[k - 1] + data[k + 1] + data[k - n] + data[k + n]) * 0.25;
      }
      for (; j < f; j++) {
        const m = inside[j];
        data[m] =
          (data[m - 1] + data[m + 1] + data[m - n] + data[m + n]) * 0.25;
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

/** Radius of an expressway pier column (gen-base expressway). */
export const PIER_RADIUS = 1.5;
/**
 * Half width of the pier median on a boulevard under an expressway: the
 * pier plus 0.5 m of clearance each side. The lanes move out by it (same
 * curb-to-curb width: three 3.17 m lanes a side instead of 3.83 m).
 */
export const PIER_MEDIAN = PIER_RADIUS + 0.5;

const medianCache = new WeakMap<object, Float32Array>();

/**
 * Per chain: half width of the painted median down its middle (0 = none).
 * Expressways run down the centerlines of boulevard strokes (expressways()
 * builds them from the chains' own points) with their piers on the
 * centerline, so every boulevard chain the deck runs along gets a median
 * wide enough for the piers, and its lanes (RoadNet.laneOffset, the road
 * shader, junction markings) are laid out either side of it. Derived from
 * the chains and expressways alone: the layout itself is unchanged.
 */
export function chainMedians(
  L: Pick<CityLayout, 'chains' | 'elevated'>,
): Float32Array {
  const hit = medianCache.get(L.chains);
  if (hit) return hit;
  const out = new Float32Array(L.chains.length);
  const ways = L.elevated.filter(e => e.kind === 'expressway');
  if (ways.length) {
    const boxes = ways.map(e => {
      let x0 = Infinity,
        x1 = -Infinity,
        z0 = Infinity,
        z1 = -Infinity;
      for (const q of e.pts) {
        x0 = Math.min(x0, q[0]);
        x1 = Math.max(x1, q[0]);
        z0 = Math.min(z0, q[1]);
        z1 = Math.max(z1, q[1]);
      }
      return [x0 - 2, x1 + 2, z0 - 2, z1 + 2];
    });
    L.chains.forEach((c, ci) => {
      if (c.kind !== Road.boulevard) return;
      // A segment midpoint on the deck's centerline: the chain runs along it
      // (a chain crossing under it touches it at most at an end).
      for (let i = 0; i + 1 < c.pts.length; i++) {
        const q: Vec2 = [
          (c.pts[i][0] + c.pts[i + 1][0]) / 2,
          (c.pts[i][1] + c.pts[i + 1][1]) / 2,
        ];
        const on = ways.some((e, k) => {
          const b = boxes[k];
          if (q[0] < b[0] || q[0] > b[1] || q[1] < b[2] || q[1] > b[3])
            return false;
          return closestOnPolyline(e.pts, q).d < 1;
        });
        if (on) {
          out[ci] = PIER_MEDIAN;
          return;
        }
      }
    });
  }
  medianCache.set(L.chains, out);
  return out;
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

/** Steepest grade per road class (lane, street, avenue, boulevard). */
export const MAX_GRADE = [0.15, 0.13, 0.1, 0.08];
/** Grade over a junction's pad: the first metres of each of its arms. */
export const PAD_GRADE = 0.03;
/** Pad length past half the widest road at a junction. */
const PAD_MARGIN = 8;
/** Roads whose sidewalks come this close are graded together. */
const NEIGHBOUR_GAP = 12;
/**
 * Roads near a river or the sea stay within this grade of the water line
 * (measured from the edge of their sidewalks) unless the terrain there is
 * higher: filling a valley for the grade would leave its river at the
 * bottom of a trench.
 */
const WATER_BANK = 0.5;

/**
 * Distance (m) to the nearest water from each cell of a grid of `cell`
 * metres laid over the heightfield, up to `reach` (chamfer distance).
 */
function waterDistance(hf: Heightfield, cell: number, reach: number) {
  const m = Math.ceil(hf.size / cell) + 1;
  const S = hf.size / 2;
  const d = new Float32Array(m * m);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < m; i++)
      d[j * m + i] =
        hf.sample(i * cell - S, j * cell - S) < SEA_LEVEL + 0.5 ? 0 : reach;
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < m; i++) {
      const k = j * m + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + a);
      if (j > 0) {
        v = Math.min(v, d[k - m] + a);
        if (i > 0) v = Math.min(v, d[k - m - 1] + b);
        if (i + 1 < m) v = Math.min(v, d[k - m + 1] + b);
      }
      d[k] = v;
    }
  for (let j = m - 1; j >= 0; j--)
    for (let i = m - 1; i >= 0; i--) {
      const k = j * m + i;
      let v = d[k];
      if (i + 1 < m) v = Math.min(v, d[k + 1] + a);
      if (j + 1 < m) {
        v = Math.min(v, d[k + m] + a);
        if (i + 1 < m) v = Math.min(v, d[k + m + 1] + b);
        if (i > 0) v = Math.min(v, d[k + m - 1] + b);
      }
      d[k] = v;
    }
  // Bilinear.
  return (x: number, z: number) => {
    const gx = clamp((x + S) / cell, 0, m - 1.001);
    const gz = clamp((z + S) / cell, 0, m - 1.001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const k = j * m + i;
    return lerp(
      lerp(d[k], d[k + 1], gx - i),
      lerp(d[k + m], d[k + m + 1], gx - i),
      gz - j,
    );
  };
}

/**
 * Road heights for the whole network at once: every segment within its
 * class's MAX_GRADE, junctions on near-flat pads (PAD_GRADE), as close to the
 * terrain as that allows (least squares: hills cut and valleys filled), and
 * bridge decks clear of the water. Grading each chain on its own from
 * terrain samples left roads on 50-80% grades in the hilly cities, and
 * neighbouring roads and junction arms at different heights. carveGraded
 * and gradeBlocks then shape the ground to these heights.
 *
 * In three steps: the junctions first, as a graph whose edges are the
 * chains (each node standing for itself and the near half of its chains),
 * so the earth moves across whole hills in few sweeps; then each chain
 * between its graded ends; then everything at once with roads that run side
 * by side held together (a short local correction).
 */
function gradeRoads(
  g: Graph,
  chainsG: Chain[],
  hf: Heightfield,
  isLand: (q: Vec2) => boolean,
  /** How far it has got (0..0.48 of the Grading roads step). */
  tick?: (f: number) => void,
): {chains: RoadChain[]; nodeH: number[]} {
  const nn = g.nodes.length;
  const ground = (q: Vec2) => Math.max(hf.sample(q[0], q[1]), SEA_LEVEL + 1.2);
  const toWater = waterDistance(hf, 8, 200);

  const band = (kind: number) => ROAD_WIDTH[kind] / 2 + SIDEWALK[kind];
  const nearWater = (q: Vec2, kind: number) =>
    Math.max(
      ground(q),
      SEA_LEVEL +
        1.2 +
        WATER_BANK * Math.max(0, toWater(q[0], q[1]) - band(kind)),
    );
  const arms = new Int32Array(nn);
  const wide = new Float32Array(nn);
  for (const c of chainsG)
    for (const n of [c.nodes[0], c.nodes[c.nodes.length - 1]]) {
      arms[n]++;
      wide[n] = Math.max(wide[n], ROAD_WIDTH[c.kind]);
    }
  const geo = chainsG.map(c => {
    const raw = c.nodes.map(n => g.nodes[n].p);
    const pts = resample(raw, 8);
    // Keep exact endpoints so junctions line up.
    pts[0] = raw[0];
    pts[pts.length - 1] = raw[raw.length - 1];
    const n = pts.length;
    const L: number[] = [0];
    for (let i = 1; i < n; i++) L.push(L[i - 1] + dist2(pts[i - 1], pts[i]));
    const bridge = pts.map(q => !isLand(q));
    // Target: the terrain along the road, smoothed over ~25 m.
    let t = pts.map((q, i) => (bridge[i] ? NaN : ground(q)));
    for (let it = 0; it < 6; it++) {
      const h = t.slice();
      for (let i = 1; i + 1 < n; i++)
        if (!bridge[i - 1] && !bridge[i] && !bridge[i + 1])
          t[i] = (h[i - 1] + 2 * h[i] + h[i + 1]) / 4;
    }
    t = t.map((v, i) => (i === 0 || i === n - 1 ? ground(pts[i]) : v));
    // Over a bridge, the straight line between its banks, weighted lightly:
    // the deck is set by its clearance and approach grades.
    const weight = new Float64Array(n).fill(1);
    for (let i = 1; i + 1 < n; i++) {
      if (!Number.isNaN(t[i])) continue;
      let j = i;
      while (Number.isNaN(t[j])) j++;
      for (let k = i; k < j; k++) {
        t[k] = lerp(t[i - 1], t[j], (L[k] - L[i - 1]) / (L[j] - L[i - 1]));
        weight[k] = 0.01;
      }
      i = j;
    }
    const wetLen = bridge.filter(w => w).length * 8;
    const clearance = wetLen > 500 ? 28 : 7;
    const floor = Float64Array.from(
      bridge,
      w => SEA_LEVEL + (w ? clearance : 1.2),
    );
    // (A bridge's own approaches climb from the bank to its deck.)
    const wet = wetLen > 0;
    const ceil = Float64Array.from(pts, q =>
      wet ? NaN : nearWater(q, c.kind),
    );
    const a = c.nodes[0];
    const b = c.nodes[c.nodes.length - 1];
    const padA = arms[a] >= 3 ? wide[a] / 2 + PAD_MARGIN : 0;
    const padB = arms[b] >= 3 ? wide[b] / 2 + PAD_MARGIN : 0;
    const rise = new Float32Array(n - 1);
    for (let i = 0; i + 1 < n; i++) {
      const mid = (L[i] + L[i + 1]) / 2;
      const pad = mid < padA || L[n - 1] - mid < padB;
      rise[i] = (pad ? PAD_GRADE : MAX_GRADE[c.kind]) * (L[i + 1] - L[i]);
    }
    return {pts, L, bridge, t: Float64Array.from(t), weight, floor, ceil, rise};
  });

  // Junction level.
  const nodeT = new Float64Array(nn);
  const nodeW = new Float64Array(nn);
  for (let k = 0; k < nn; k++) {
    nodeT[k] = ground(g.nodes[k].p);
    nodeW[k] = 1;
  }
  const ea: number[] = [];
  const eb: number[] = [];
  const er: number[] = [];
  chainsG.forEach((c, ci) => {
    const {L, t, weight, rise} = geo[ci];
    const n = L.length;
    const a = c.nodes[0];
    const b = c.nodes[c.nodes.length - 1];
    for (let i = 1; i + 1 < n; i++) {
      const k = L[i] * 2 < L[n - 1] ? a : b;
      nodeT[k] += t[i] * weight[i];
      nodeW[k] += weight[i];
    }
    if (a === b) return;
    let r = 0;
    for (const v of rise) r += v;
    ea.push(a);
    eb.push(b);
    er.push(r);
  });
  for (let k = 0; k < nn; k++) nodeT[k] /= nodeW[k];
  // A junction high enough for each of its chains to reach its floor (a
  // bridge deck's clearance) within the grade.
  // Likewise low enough for each to reach its ceiling (near the water).
  const nodeFloor = new Float64Array(nn).fill(SEA_LEVEL + 1.2);
  const nodeCeil = new Float64Array(nn).fill(NaN);
  chainsG.forEach((c, ci) => {
    const {floor, ceil, rise} = geo[ci];
    const n = floor.length;
    for (const [end, k, step] of [
      [c.nodes[0], 0, 1],
      [c.nodes[c.nodes.length - 1], n - 1, -1],
    ]) {
      let r = 0;
      let need = -Infinity;
      let cap = Infinity;
      for (let i = k; i >= 0 && i < n; i += step) {
        if (i !== k) r += rise[step > 0 ? i - 1 : i];
        need = Math.max(need, floor[i] - r);
        if (!Number.isNaN(ceil[i])) cap = Math.min(cap, ceil[i] + r);
      }
      nodeFloor[end] = Math.max(nodeFloor[end], need);
      if (cap < Infinity)
        nodeCeil[end] = Number.isNaN(nodeCeil[end])
          ? cap
          : Math.min(nodeCeil[end], cap);
    }
  });
  const nodeH = fitRises(
    {
      n: nn,
      a: Int32Array.from(ea),
      b: Int32Array.from(eb),
      rise: Float32Array.from(er),
    },
    nodeT,
    nodeW,
    {floor: nodeFloor, ceil: nodeCeil},
    200,
  );
  tick?.(0.14);

  // Each chain between its graded ends.
  const first = chainsG.map((c, ci) => {
    const {t, weight, floor, ceil, rise} = geo[ci];
    const n = t.length;
    const tt = Float64Array.from(t);
    const w = Float64Array.from(weight);
    tt[0] = nodeH[c.nodes[0]];
    tt[n - 1] = nodeH[c.nodes[c.nodes.length - 1]];
    w[0] = w[n - 1] = 1e6;
    if (tick && (ci & 127) === 0) tick(0.14 + (0.09 * ci) / chainsG.length);
    return fitPath(tt, w, {floor, ceil}, rise, Math.min(200, 2 * n + 20));
  });
  tick?.(0.23);

  // Then all together with roads that run side by side: where their carved
  // bands (road and sidewalks) come within NEIGHBOUR_GAP of each other they
  // may differ by at most BANK_SLOPE times the gap between them, or the
  // ground between them would be a cliff. Each fitted from the heights so
  // far (only near such pairs does anything move).
  let nv = nn;
  const idx = geo.map(({pts}) => {
    const ix = new Int32Array(pts.length);
    for (let i = 1; i + 1 < pts.length; i++) ix[i] = nv++;
    return ix;
  });
  const target = new Float64Array(nv);
  const weight = new Float64Array(nv).fill(1);
  const floor = new Float64Array(nv);
  const ceil = new Float64Array(nv).fill(NaN);
  const ga: number[] = [];
  const gb: number[] = [];
  const gr: number[] = [];
  target.set(nodeH.subarray(0, nn));
  floor.set(nodeFloor);
  ceil.set(nodeCeil);
  chainsG.forEach((c, ci) => {
    const ix = idx[ci];
    const n = ix.length;
    ix[0] = c.nodes[0];
    ix[n - 1] = c.nodes[c.nodes.length - 1];
    for (let i = 1; i + 1 < n; i++) {
      target[ix[i]] = first[ci][i];
      weight[ix[i]] = geo[ci].weight[i];
      floor[ix[i]] = geo[ci].floor[i];
      ceil[ix[i]] = geo[ci].ceil[i];
    }
    for (let i = 0; i + 1 < n; i++) {
      ga.push(ix[i]);
      gb.push(ix[i + 1]);
      gr.push(geo[ci].rise[i]);
    }
  });
  // Chain points (not on bridges) binned in CELL m cells: the chain and
  // point index of each, cell by cell (CSR).
  const CELL = 16;
  const G = Math.ceil(hf.size / CELL) + 1;
  const half = hf.size / 2;
  const cellOf = (x: number, z: number) =>
    clamp(Math.floor((z + half) / CELL), 0, G - 1) * G +
    clamp(Math.floor((x + half) / CELL), 0, G - 1);
  const binAt = new Int32Array(G * G + 1);
  for (const {pts, bridge} of geo)
    pts.forEach((q, i) => {
      if (!bridge[i]) binAt[cellOf(q[0], q[1]) + 1]++;
    });
  for (let k = 0; k < G * G; k++) binAt[k + 1] += binAt[k];
  const binFill = binAt.slice(0, G * G);
  const binC = new Int32Array(binAt[G * G]);
  const binI = new Int32Array(binAt[G * G]);
  geo.forEach(({pts, bridge}, ci) =>
    pts.forEach((q, i) => {
      if (bridge[i]) return;
      const k = binFill[cellOf(q[0], q[1])]++;
      binC[k] = ci;
      binI[k] = i;
    }),
  );
  const nearest = new Map<number, [number, number]>();
  chainsG.forEach((c, ci) => {
    const {pts, bridge} = geo[ci];
    const reach = band(c.kind) + band(Road.boulevard) + NEIGHBOUR_GAP;
    const r = Math.ceil(reach / CELL);
    pts.forEach((q, i) => {
      if (bridge[i]) return;
      const v = idx[ci][i];
      // The nearest point of each other chain in reach.
      nearest.clear();
      const cx = clamp(Math.floor((q[0] + half) / CELL), 0, G - 1);
      const cz = clamp(Math.floor((q[1] + half) / CELL), 0, G - 1);
      for (let gz = Math.max(0, cz - r); gz <= Math.min(G - 1, cz + r); gz++)
        for (
          let gx = Math.max(0, cx - r);
          gx <= Math.min(G - 1, cx + r);
          gx++
        ) {
          const cell = gz * G + gx;
          for (let k = binAt[cell]; k < binAt[cell + 1]; k++) {
            const cj = binC[k];
            if (cj === ci) continue;
            const u = idx[cj][binI[k]];
            if (u <= v) continue;
            const p = geo[cj].pts[binI[k]];
            const lim = band(c.kind) + band(chainsG[cj].kind) + NEIGHBOUR_GAP;
            const ex = Math.abs(p[0] - q[0]);
            const ez = Math.abs(p[1] - q[1]);
            if (ex > lim || ez > lim) continue;
            const d = Math.hypot(ex, ez);
            if (d > lim) continue;
            const was = nearest.get(cj);
            if (!was || d < was[1]) nearest.set(cj, [u, d]);
          }
        }
      for (const [cj, [u, d]] of nearest) {
        const gap = d - band(c.kind) - band(chainsG[cj].kind);
        ga.push(v);
        gb.push(u);
        gr.push(Math.max(PAD_GRADE * d, BANK_SLOPE * gap));
      }
    });
  });
  const h = fitRises(
    {
      n: nv,
      a: Int32Array.from(ga),
      b: Int32Array.from(gb),
      rise: Float32Array.from(gr),
    },
    target,
    weight,
    {floor, ceil},
    40,
  );
  tick?.(0.48);
  const chains: RoadChain[] = chainsG.map((c, ci) => ({
    pts: geo[ci].pts,
    heights: Array.from(idx[ci], v => h[v]),
    kind: c.kind,
    start: c.nodes[0],
    end: c.nodes[c.nodes.length - 1],
    bridge: geo[ci].bridge,
  }));
  return {chains, nodeH: Array.from(h.subarray(0, nn))};
}

/**
 * The road heights of the old per-chain grading (terrain samples smoothed
 * along each chain, ends at the terrain under the junction). Only for the
 * seed terrain (see generateLayout): every seeded choice after grading was
 * tuned on the ground this carved, so saved views keep their lots.
 */
function seedHeights(chains: RoadChain[], hf: Heightfield): number[][] {
  const ground = (q: Vec2) => Math.max(hf.sample(q[0], q[1]), SEA_LEVEL + 1.2);
  return chains.map(({pts, bridge}) => {
    const L: number[] = [0];
    for (let i = 1; i < pts.length; i++)
      L.push(L[i - 1] + dist2(pts[i - 1], pts[i]));
    const total = L[L.length - 1];
    const h0 = ground(pts[0]);
    const h1 = ground(pts[pts.length - 1]);
    let heights = pts.map((q, i) => {
      const t = total > 0 ? L[i] / total : 0;
      const terrainH = ground(q);
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
    return heights;
  });
}

/** Steepest the cut and fill banks beside a road may be (rise / run). */
const BANK_SLOPE = 0.7;
/** How far from a road its banks may reach (they fade out over the last 20 m). */
const BANK_REACH = 120;

/**
 * Carve the terrain to the graded roads: carveRoads (the road's height under
 * it and its sidewalks, blended back to the terrain over 10 m), then banks:
 * near a road (up to BANK_REACH) no ground stands higher above, or lower
 * below, any road surface than BANK_SLOPE times its distance from it, and no
 * higher above the water than that either. Cut and fill of tens of metres
 * on the hills would otherwise leave walls beside the roads. Returns the
 * water cells it raised (see restoreChannels).
 */
function carveGraded(
  hf: Heightfield,
  chains: RoadChain[],
  seed: SeedCarve,
  /** Progress: 0..1 of the way through. */
  tick?: (f: number) => void,
) {
  const n = hf.n;
  const N = n * n;
  const data = hf.data;
  const road = new Uint8Array(N);
  const flooded = carveRoads(hf, chains, road, seed);
  tick?.(0.6);

  // Distance-weighted envelopes on the grid (two-pass chamfer): the least
  // of source + step * distance over the sources (sign 1), or the most of
  // source - step * distance (sign -1).
  const chamfer = (v: Float32Array, step: number, sign: 1 | -1) => {
    const a = step;
    const b = step * Math.SQRT2;
    if (sign < 0) for (let k = 0; k < N; k++) v[k] = -v[k];
    // Forward: left, and the row above; the edge cells of each row apart.
    for (let j = 0; j < n; j++) {
      const r = j * n;
      for (let i = 0; i < n; i++) {
        const k = r + i;
        let x = v[k];
        if (i > 0) x = Math.min(x, v[k - 1] + a);
        if (j > 0) {
          x = Math.min(x, v[k - n] + a);
          if (i > 0) x = Math.min(x, v[k - n - 1] + b);
          if (i < n - 1) x = Math.min(x, v[k - n + 1] + b);
        }
        v[k] = x;
      }
    }
    // Backward: right, and the row below.
    for (let j = n - 1; j >= 0; j--) {
      const r = j * n;
      for (let i = n - 1; i >= 0; i--) {
        const k = r + i;
        let x = v[k];
        if (i < n - 1) x = Math.min(x, v[k + 1] + a);
        if (j < n - 1) {
          x = Math.min(x, v[k + n] + a);
          if (i < n - 1) x = Math.min(x, v[k + n + 1] + b);
          if (i > 0) x = Math.min(x, v[k + n - 1] + b);
        }
        v[k] = x;
      }
    }
    if (sign < 0) for (let k = 0; k < N; k++) v[k] = -v[k];
    return v;
  };
  const wet = (k: number) => data[k] < SEA_LEVEL + 0.5;
  // Distance to the nearest road surface, for the reach.
  const far = chamfer(
    Float32Array.from(road, r => (r ? 0 : Infinity)),
    hf.cell,
    1,
  );
  const fade = (k: number) =>
    1 - smoothstep(BANK_REACH - 20, BANK_REACH, far[k]);
  const step = BANK_SLOPE * hf.cell;
  tick?.(0.7);
  // Ceiling: roads and the water line.
  const env = new Float32Array(N);
  for (let k = 0; k < N; k++)
    env[k] = road[k] ? data[k] : wet(k) ? SEA_LEVEL + 0.5 : Infinity;
  chamfer(env, step, 1);
  for (let k = 0; k < N; k++) {
    if (road[k] || wet(k) || far[k] >= BANK_REACH) continue;
    if (data[k] > env[k]) data[k] = lerp(data[k], env[k], fade(k));
  }
  tick?.(0.85);
  // Floor: roads.
  for (let k = 0; k < N; k++) env[k] = road[k] ? data[k] : -Infinity;
  chamfer(env, step, -1);
  for (let k = 0; k < N; k++) {
    if (road[k] || wet(k) || far[k] >= BANK_REACH) continue;
    if (data[k] < env[k]) data[k] = lerp(data[k], env[k], fade(k));
  }
  // (Grid scratch, ~10 MB a grid: freed now, not at the next GC.)
  release(road, far, env);
  return flooded;
}

/**
 * A second terrain (a copy of the first) carved in the same pass to other
 * road heights (per chain and point): the seed terrain (see generateLayout).
 */
interface SeedCarve {
  hf: Heightfield;
  heights: number[][];
}

/**
 * Carve the terrain to match road surfaces so roads never float or sink:
 * their heights under them and their sidewalks, blended back to the
 * terrain over 10 m. Marks the cells under a road in `under`, and carves
 * `seed` too.
 */
function carveRoads(
  hf: Heightfield,
  chains: RoadChain[],
  under: Uint8Array,
  seed: SeedCarve,
) {
  const n = hf.n;
  const cell = hf.cell;
  const S = hf.size / 2;
  const target = new Float32Array(n * n).fill(NaN);
  const weight = new Float32Array(n * n);
  const dist = new Float32Array(n * n).fill(Infinity);
  const seedTarget = new Float32Array(n * n);
  chains.forEach((c, ci) => {
    const sh = seed.heights[ci];
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
      // pointSegment, inlined (the same operations), with cells clearly
      // beyond the falloff dropped before the exact distance.
      const abx = b[0] - a[0];
      const abz = b[1] - a[1];
      const l2 = abx * abx + abz * abz;
      const far2 = falloff * falloff * (1 + 1e-9);
      for (let gz = Math.max(0, z0); gz <= Math.min(n - 1, z1); gz++) {
        for (let gx = Math.max(0, x0); gx <= Math.min(n - 1, x1); gx++) {
          const qx = gx * cell - S;
          const qz = gz * cell - S;
          const t =
            l2 > 0
              ? clamp(((qx - a[0]) * abx + (qz - a[1]) * abz) / l2, 0, 1)
              : 0;
          const ex = qx - (a[0] + abx * t);
          const ez = qz - (a[1] + abz * t);
          if (ex * ex + ez * ez > far2) continue;
          const d = Math.hypot(ex, ez);
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
            seedTarget[k] = lerp(sh[i], sh[i + 1], t);
          }
        }
      }
    }
  });
  // Original heights of river/sea cells the carve raised. Bridge approaches
  // climb to deck height over the last stretch of bank, and their falloff
  // band would heap an earth mound out into the water (clipping piers). The
  // layout still sees the carved field so its seeded choices don't move;
  // restoreChannels() digs these cells back out once layout is done, and the
  // road deck builder spans them as bridge.
  const flooded = new Map<number, number>();
  const sd = seed.hf.data;
  for (let k = 0; k < n * n; k++) {
    if (weight[k] > 0) {
      sd[k] = lerp(sd[k], seedTarget[k] - 0.05, weight[k]);
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
      if (weight[k] === 1) under[k] = 1;
    }
  }
  release(target, weight, dist, seedTarget);
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
    // A deck takes no sharp corner (a boulevard joined into another end
    // on): the stroke is cut there, its piers would stand in the lanes.
    let from = 0;
    const cut = (to: number) => {
      let len = 0;
      for (let k = from + 1; k < to; k++)
        len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (to - from >= 2)
        strokes.push({pts: pts.slice(from, to), hs: hs.slice(from, to), len});
    };
    for (let k = 2; k + 2 < pts.length; k++) {
      const a = pts[k - 2];
      const b = pts[k];
      const d = pts[k + 2];
      const ux = b[0] - a[0];
      const uz = b[1] - a[1];
      const vx = d[0] - b[0];
      const vz = d[1] - b[1];
      const cos =
        (ux * vx + uz * vz) / (Math.hypot(ux, uz) * Math.hypot(vx, vz) || 1);
      if (cos < DECK_CORNER) {
        cut(k);
        from = k + 1;
      }
    }
    cut(pts.length);
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
    // Nor on top of one another, or of its own earlier part (a stroke right
    // round the ring road and on along it): the longest run clear of both
    // is kept.
    const [k0, k1] = clearRun(
      pts,
      out.map(e => e.pts),
    );
    if (k1 - k0 < 20) continue;
    const run = k0 > 0 || k1 < pts.length ? pts.slice(k0, k1) : pts;
    const heights = elevateProfile(run, hf, 0, 0.04).map((h, i) =>
      Math.max(h, base[k0 + i] + 11),
    );
    out.push({
      pts: run,
      heights,
      kind: 'expressway',
      loop: false,
      stations: [],
    });
  }
  void rng;
  return out;
}

/**
 * Cosine of the sharpest turn an expressway stroke takes over 16 m either
 * side of a point (60 degrees).
 */
const DECK_CORNER = Math.cos((60 * Math.PI) / 180);

/** How far along a deck its own earlier part counts as another deck (m). */
const DECK_SELF_GAP = 300;

/**
 * The longest run [first, end) of a deck's points that runs on top of none
 * of `others` (centrelines within a deck width, running the same way) nor
 * of its own part DECK_SELF_GAP or more back along it, with three points to
 * spare at each end. All of it where there is no such stretch.
 */
export function clearRun(pts: Vec2[], others: Vec2[][]): [number, number] {
  const n = pts.length;
  const W = 2 * elevatedHalfWidth({kind: 'expressway'} as Elevated);
  const cos30 = Math.cos(Math.PI / 6);
  const along = [0];
  for (let k = 1; k < n; k++)
    along.push(along[k - 1] + dist2(pts[k - 1], pts[k]));
  const onTop = (q: Vec2, d: Vec2, line: Vec2[], end: number) => {
    for (let i = 0; i + 1 < end; i++) {
      const a = line[i];
      const b = line[i + 1];
      if (
        Math.min(a[0], b[0]) > q[0] + W ||
        Math.max(a[0], b[0]) < q[0] - W ||
        Math.min(a[1], b[1]) > q[1] + W ||
        Math.max(a[1], b[1]) < q[1] - W
      )
        continue;
      const l = dist2(a, b);
      if (l < 1e-6) continue;
      const c = Math.abs(((b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1]) / l);
      if (c > cos30 && pointSegment(q, a, b)[0] < W) return true;
    }
    return false;
  };
  const bad = new Uint8Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    while (j + 1 < k && along[j + 1] <= along[k] - DECK_SELF_GAP) j++;
    const a = pts[Math.max(0, k - 1)];
    const b = pts[Math.min(n - 1, k + 1)];
    const l = dist2(a, b) || 1;
    const d: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    const self =
      along[k] - along[0] > DECK_SELF_GAP && onTop(pts[k], d, pts, j + 1);
    if (self || others.some(o => onTop(pts[k], d, o, o.length)))
      for (let m = Math.max(0, k - 3); m <= Math.min(n - 1, k + 3); m++)
        bad[m] = 1;
  }
  let best: [number, number] = [0, 0];
  for (let k = 0; k < n;) {
    if (bad[k]) {
      k++;
      continue;
    }
    let e = k;
    while (e < n && !bad[e]) e++;
    if (
      along[e - 1] - along[k] >
        along[Math.max(best[1] - 1, 0)] - along[best[0]] ||
      best[1] === 0
    )
      best = [k, e];
    k = e;
  }
  return best;
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
 * The rail segments clipToRail considers (every one not in a tunnel at both
 * ends), in line order, binned by their first point (CLIP_REACH cells).
 */
interface RailSegments {
  segs: [Vec2, Vec2][];
  grid: Map<number, number[]>;
}

const CLIP_REACH = 150;
const clipCell = (x: number, z: number) =>
  (Math.floor(z / CLIP_REACH) + 1024) * 2048 +
  Math.floor(x / CLIP_REACH) +
  1024;

function binRailSegments(elevated: Elevated[], hf: Heightfield): RailSegments {
  const segs: [Vec2, Vec2][] = [];
  const grid = new Map<number, number[]>();
  for (const e of elevated) {
    if (e.kind !== 'rail') continue;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      if (inTunnel(e, i, hf) && inTunnel(e, i + 1, hf)) continue;
      const a = e.pts[i];
      const k = clipCell(a[0], a[1]);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(segs.push([a, e.pts[i + 1]]) - 1);
    }
  }
  return {segs, grid};
}

/**
 * Trim a building footprint off an elevated rail line's clearance band. Lots
 * are rejected by their corners and centre only, so a long plot can still
 * have an edge that crosses the viaduct between two far-off corners; this cuts
 * it back along the deck, on the side its centre `c` lies, `pad` metres clear.
 * Pure geometry (no random draws), applied after the building is designed.
 * Segments whose first point is within CLIP_REACH of `c` (on both axes) are
 * tried in line order.
 */
function clipToRail(
  fp: Vec2[],
  c: Vec2,
  rail: RailSegments,
  pad: number,
): Vec2[] {
  const near: number[] = [];
  const x0 = Math.floor((c[0] - CLIP_REACH) / CLIP_REACH);
  const x1 = Math.floor((c[0] + CLIP_REACH) / CLIP_REACH);
  const z0 = Math.floor((c[1] - CLIP_REACH) / CLIP_REACH);
  const z1 = Math.floor((c[1] + CLIP_REACH) / CLIP_REACH);
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++)
      for (const si of rail.grid.get(
        clipCell(x * CLIP_REACH, z * CLIP_REACH),
      ) ?? []) {
        const a = rail.segs[si][0];
        if (
          Math.abs(a[0] - c[0]) > CLIP_REACH ||
          Math.abs(a[1] - c[1]) > CLIP_REACH
        )
          continue;
        near.push(si);
      }
  near.sort((p, q) => p - q);
  let poly = fp;
  for (const si of near) {
    const [a, b] = rail.segs[si];
    let close = false;
    for (let j = 0; j < poly.length && !close; j++)
      close = segmentGap(poly[j], poly[(j + 1) % poly.length], a, b) < pad;
    if (!close) continue;
    const d = sub2(b, a);
    const l = Math.hypot(d[0], d[1]);
    if (l < 1e-6) continue;
    let n: Vec2 = [-d[1] / l, d[0] / l];
    if (dot2(sub2(c, a), n) < 0) n = [-n[0], -n[1]];
    poly = clipHalfPlane(poly, [a[0] + n[0] * pad, a[1] + n[1] * pad], n);
    if (poly.length < 3) return poly;
  }
  return poly;
}
