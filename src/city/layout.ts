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
}

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
// Elevated lines

function elevateProfile(
  pts: Vec2[],
  hf: Heightfield,
  clearance: number,
  grade: number,
): number[] {
  const n = pts.length;
  const h = pts.map(
    q => Math.max(hf.sample(q[0], q[1]), SEA_LEVEL + 2) + clearance,
  );
  // Limit grade both ways while staying above the clearance profile.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n; i++)
      h[i] = Math.max(h[i], h[i - 1] - grade * dist2(pts[i], pts[i - 1]));
    for (let i = n - 2; i >= 0; i--)
      h[i] = Math.max(h[i], h[i + 1] - grade * dist2(pts[i], pts[i + 1]));
  }
  // Smooth.
  for (let it = 0; it < 4; it++) {
    const c = h.slice();
    for (let i = 1; i + 1 < n; i++)
      h[i] = Math.max(c[i], (c[i - 1] + c[i] * 2 + c[i + 1]) / 4);
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
        heights: elevateProfile(pts, hf, 9, 0.03),
        kind: 'rail',
        loop: true,
        stations: [],
      });
    } else {
      // The loop would cross open water: keep the longest stretch on land.
      const piece =
        clipToLand(pts, hf, 350).sort((a, b) => b.length - a.length)[0] ?? [];
      if (piece.length > 20)
        out.push({
          pts: piece,
          heights: elevateProfile(piece, hf, 9, 0.03),
          kind: 'rail',
          loop: false,
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
        heights: elevateProfile(pts, hf, 9 + k * 3, 0.03),
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
  }
  return out;
}

// ---------------------------------------------------------------------------

export function generateLayout(
  params: CityParams,
  seed: number,
  progress?: (msg: string, f: number) => void,
): CityLayout {
  const rng = new Rng(seed);
  const noise = new Noise2D(seed + 7);
  progress?.('Shaping terrain', 0.05);
  const terrain = generateTerrain(params, seed);
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

  progress?.('Tracing streets', 0.15);
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
  progress?.('Connecting streets', 0.25);
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

  progress?.('Grading roads', 0.35);
  // Smooth the road heights and carve the terrain so roads sit on it.
  const chainsG: Chain[] = buildChains(g);
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
  carveRoads(hf, chains);

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

  progress?.('Elevated rail and expressways', 0.45);
  const elevated = railLines(params, rng, noise, hubs, center, hf);
  elevated.push(...expressways(params, rng, chains, hf));
  separateCrossings(elevated);

  progress?.('Subdividing blocks', 0.5);
  const faces = extractFaces(g, 400000);
  const blocks: Block[] = [];
  const lots: {lot: Lot; park: boolean}[] = [];
  const nearRail = (q: Vec2, pad: number) => {
    for (const e of elevated) {
      if (e.kind !== 'rail') continue;
      for (let i = 0; i + 1 < e.pts.length; i++) {
        const a = e.pts[i];
        if (Math.abs(a[0] - q[0]) > 60 || Math.abs(a[1] - q[1]) > 60) continue;
        if (pointSegment(q, a, e.pts[i + 1])[0] < pad) return true;
      }
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
    if (!inner) continue;
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
    const lotsHere: Lot[] = [];
    splitLots(
      rng,
      clean,
      clean.map(() => true),
      rule,
      lotsHere,
    );
    for (const lot of lotsHere) lots.push({lot, park: false});
  }

  progress?.('Grading blocks', 0.55);
  gradeBlocks(hf, blocks);

  progress?.('Designing buildings', 0.6);
  const buildings: Building[] = [];
  for (const {lot} of lots) {
    const fp = cleanPolygon(lot.poly, 1.2);
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
  progress?.('Layout done', 0.7);
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
 * deck (train + overhead wires) with a gentle approach grade.
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
      const need: [number, number][] = [];
      for (let k = 0; k < B.pts.length; k++) {
        const own = a === b ? A.pts.slice(0, Math.max(0, k - SELF_GAP)) : A.pts;
        if (own.length < 2) continue;
        const c = closestOnPolyline(own, B.pts[k]);
        if (c.d < reach) {
          const h = lerp(A.heights[c.i], A.heights[c.i + 1], c.t);
          need.push([along[k], h + clearance]);
        }
      }
      if (!need.length) continue;
      for (let k = 0; k < B.pts.length; k++) {
        for (const [s, h] of need) {
          B.heights[k] = Math.max(
            B.heights[k],
            h - grade * Math.max(0, Math.abs(along[k] - s) - 30),
          );
        }
      }
    }
  }
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
          if (w > weight[k]) {
            weight[k] = w;
            target[k] = h;
          }
        }
      }
    }
  }
  for (let k = 0; k < n * n; k++) {
    if (weight[k] > 0)
      hf.data[k] = lerp(hf.data[k], target[k] - 0.05, weight[k]);
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
