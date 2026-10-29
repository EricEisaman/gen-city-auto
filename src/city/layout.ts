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
import {generateTerrain, Heightfield, SEA_LEVEL, type Terrain} from './terrain.ts';

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

export type BuildingKind = 'tower' | 'glass' | 'midrise' | 'pencil' | 'house' | 'apartment' | 'station';

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
  const get = (i: number) => (closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const len = dist2(p1, p2);
    const k = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < k; s++) {
      const t = s / k;
      const t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
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

function arterials(p: CityParams, rng: Rng, noise: Noise2D, center: Vec2, hubs: Hub[]): Polyline[] {
  const S = p.size / 2;
  const lines: Polyline[] = [];
  if (p.arterials === 'radial') {
    const R = S * 1.05;
    for (let k = 1; k <= p.ringCount; k++) {
      const r = (R * k) / (p.ringCount + 0.6);
      const ctrl: Vec2[] = [];
      const m = 10 + k * 4;
      for (let i = 0; i < m; i++) {
        const a = (i / m) * Math.PI * 2;
        const rr = r * (1 + 0.16 * noise.noise(Math.cos(a) * 1.3 + k * 7, Math.sin(a) * 1.3));
        ctrl.push([center[0] + Math.cos(a) * rr, center[1] + Math.sin(a) * rr]);
      }
      lines.push({pts: catmull(ctrl, true, 20), kind: k === p.ringCount ? Road.avenue : Road.boulevard});
    }
    const a0 = rng.range(0, Math.PI * 2);
    for (let i = 0; i < p.radialCount; i++) {
      const a = a0 + (i / p.radialCount) * Math.PI * 2 + rng.range(-0.15, 0.15);
      const ctrl: Vec2[] = [];
      const steps = 8;
      for (let s = 0; s <= steps; s++) {
        const r = 40 + (S * 1.5 * s) / steps;
        const wob = noise.noise(i * 3.3, s * 0.5) * 0.18;
        ctrl.push([center[0] + Math.cos(a + wob) * r, center[1] + Math.sin(a + wob) * r]);
      }
      lines.push({pts: catmull(ctrl, false, 20), kind: i % 2 === 0 ? Road.boulevard : Road.avenue});
    }
  } else {
    // Manhattan-like: a rotated main grid of avenues.
    const ang = rng.range(0.35, 0.55);
    const c = Math.cos(ang), s = Math.sin(ang);
    const avenueGap = 260;
    for (let k = -14; k <= 14; k++) {
      const off = k * avenueGap;
      const pts: Vec2[] = [];
      for (let t = -S * 1.5; t <= S * 1.5; t += 40) {
        const x = off + noise.noise(k, t / 2000) * 30;
        pts.push([center[0] + x * c - t * s, center[1] + x * s + t * c]);
      }
      lines.push({pts, kind: k % 3 === 0 ? Road.boulevard : Road.avenue});
    }
    for (let k = -8; k <= 8; k++) {
      const off = k * avenueGap * 3;
      const pts: Vec2[] = [];
      for (let t = -S * 1.5; t <= S * 1.5; t += 40) pts.push([center[0] + t * c - off * s, center[1] + t * s + off * c]);
      lines.push({pts, kind: Road.avenue});
    }
  }
  // Connect hubs to their nearest neighbors with avenues (sub-center links).
  for (let i = 0; i < hubs.length; i++) {
    const a = hubs[i].p;
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < hubs.length; j++) {
      if (j === i) continue;
      const d = dist2(a, hubs[j].p);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    if (best >= 0 && best > i) {
      const b = hubs[best].p;
      const mid: Vec2 = [(a[0] + b[0]) / 2 + rng.range(-150, 150), (a[1] + b[1]) / 2 + rng.range(-150, 150)];
      lines.push({pts: catmull([a, mid, b], false, 20), kind: Road.avenue});
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Minor streets: each arterial region gets its own rotated, irregular grid.

function clipLineToPolygon(o: Vec2, d: Vec2, poly: Vec2[]): [number, number][] {
  const ts: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const e = sub2(b, a);
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-9) continue;
    const ao = sub2(a, o);
    const t = (ao[0] * e[1] - ao[1] * e[0]) / den;
    const u = (ao[0] * d[1] - ao[1] * d[0]) / den;
    if (u >= 0 && u < 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) out.push([ts[i], ts[i + 1]]);
  return out;
}

function minorStreets(p: CityParams, rng: Rng, noise: Noise2D, region: Vec2[], hubs: Hub[]): Polyline[] {
  const out: Polyline[] = [];
  // Orientation from the longest region edge.
  let best = 0;
  let ang = 0;
  for (let i = 0; i < region.length; i++) {
    const a = region[i];
    const b = region[(i + 1) % region.length];
    const l = dist2(a, b);
    if (l > best) {
      best = l;
      ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  if (!rng.chance(p.gridRegularity)) ang += rng.range(-0.5, 0.5);
  let cx = 0, cz = 0;
  for (const q of region) {
    cx += q[0];
    cz += q[1];
  }
  cx /= region.length;
  cz /= region.length;
  const dens = densityAt(hubs, noise, cx, cz);
  const [lo, hi] = p.blockSize;
  // Dense areas get smaller blocks (Tokyo backstreets) except at the very core.
  const sx = lerp(hi, lo, dens * 0.8) * rng.range(0.85, 1.2);
  const sy = sx * rng.range(0.55, 0.95);
  const u: Vec2 = [Math.cos(ang), Math.sin(ang)];
  const v: Vec2 = [-u[1], u[0]];
  let R = 0;
  for (const q of region) R = Math.max(R, Math.hypot(q[0] - cx, q[1] - cz));
  const ox = rng.range(0, sx);
  const oy = rng.range(0, sy);
  const dropP = 0.18 + (1 - p.gridRegularity) * 0.2;
  const bend = (1 - p.gridRegularity) * 10;
  // Lines along u (spaced by sy), split into pieces between crossings of v lines.
  const emit = (dir: Vec2, side: Vec2, spacing: number, cross: number, off: number, crossOff: number, drop: number) => {
    for (let k = -Math.ceil(R / spacing) - 1; k <= Math.ceil(R / spacing) + 1; k++) {
      const s = k * spacing + off;
      const o: Vec2 = [cx + side[0] * s, cz + side[1] * s];
      for (const [t0, t1] of clipLineToPolygon(o, dir, region)) {
        if (t1 - t0 < 20) continue;
        // Break at crossing positions, dropping some pieces for irregularity.
        const first = Math.ceil((t0 - crossOff) / cross);
        const cuts = [t0];
        for (let c = first; c * cross + crossOff < t1; c++) cuts.push(c * cross + crossOff);
        cuts.push(t1);
        for (let c = 0; c + 1 < cuts.length; c++) {
          const a = cuts[c];
          const b = cuts[c + 1];
          if (b - a < 6) continue;
          const isEdge = c === 0 || c === cuts.length - 2;
          if (!isEdge && rng.chance(drop)) continue;
          const pts: Vec2[] = [];
          const nseg = Math.max(1, Math.ceil((b - a) / 30));
          for (let q = 0; q <= nseg; q++) {
            const t = lerp(a, b, q / nseg);
            const w = q === 0 || q === nseg ? 0 : noise.noise((o[0] + dir[0] * t) / 150, (o[1] + dir[1] * t) / 150) * bend;
            pts.push([o[0] + dir[0] * t + side[0] * w, o[1] + dir[1] * t + side[1] * w]);
          }
          out.push({pts, kind: rng.chance(0.25 + dens * 0.3) ? Road.street : Road.lane});
        }
      }
    }
  };
  emit(u, v, sy, sx, oy, ox, dropP);
  emit(v, u, sx, sy, ox, oy, dropP * 1.6);
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
  let best = {c: [0, 0] as Vec2, u: [1, 0] as Vec2, hu: 0, hv: 0, area: Infinity};
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const l = dist2(a, b);
    if (l < 1e-6) continue;
    const u: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    const v: Vec2 = [-u[1], u[0]];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
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
      best = {c: [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv], u, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2, area};
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

function splitLots(rng: Rng, poly: Vec2[], frontage: boolean[], maxArea: number, minArea: number, out: Lot[], depth = 0) {
  const area = polygonArea(poly);
  if (area < minArea * 0.5 || poly.length < 3) return;
  if (area <= maxArea || depth > 12) {
    out.push({poly, frontage});
    return;
  }
  const box = obb(poly);
  // Split across the long axis near the middle.
  const t = rng.range(-0.18, 0.18) * box.hu;
  const p: Vec2 = [box.c[0] + box.u[0] * t, box.c[1] + box.u[1] * t];
  const halves: [Vec2, Vec2][] = [
    [p, box.u],
    [p, [-box.u[0], -box.u[1]]],
  ];
  for (const [pp, n] of halves) {
    const part = clipHalf(poly, pp, n);
    if (part.length < 3) continue;
    // Edges on the split line have no frontage; others inherit from the original
    // edge they lie on.
    const fr = part.map((a, i) => {
      const b = part[(i + 1) % part.length];
      const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (Math.abs(dot2(sub2(mid, pp), n)) < 0.05) return false;
      for (let k = 0; k < poly.length; k++) {
        if (pointSegment(mid, poly[k], poly[(k + 1) % poly.length])[0] < 0.05) return frontage[k];
      }
      return false;
    });
    splitLots(rng, part, fr, maxArea, minArea, out, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Elevated lines

function elevateProfile(pts: Vec2[], hf: Heightfield, clearance: number, grade: number): number[] {
  const n = pts.length;
  const h = pts.map(q => Math.max(hf.sample(q[0], q[1]), SEA_LEVEL + 2) + clearance);
  // Limit grade both ways while staying above the clearance profile.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n; i++) h[i] = Math.max(h[i], h[i - 1] - grade * dist2(pts[i], pts[i - 1]));
    for (let i = n - 2; i >= 0; i--) h[i] = Math.max(h[i], h[i + 1] - grade * dist2(pts[i], pts[i + 1]));
  }
  // Smooth.
  for (let it = 0; it < 4; it++) {
    const c = h.slice();
    for (let i = 1; i + 1 < n; i++) h[i] = Math.max(c[i], (c[i - 1] + c[i] * 2 + c[i + 1]) / 4);
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
      out.push([a[0] + ((b[0] - a[0]) * t) / l, a[1] + ((b[1] - a[1]) * t) / l]);
      t += step;
    }
    carry = l - (t - step);
  }
  const last = pts[pts.length - 1];
  if (dist2(out[out.length - 1], last) > step * 0.3) out.push(last);
  return out;
}

function railLines(p: CityParams, rng: Rng, noise: Noise2D, hubs: Hub[], center: Vec2, hf: Heightfield): Elevated[] {
  const out: Elevated[] = [];
  if (p.railLines <= 0) return out;
  const S = p.size / 2;
  // Loop line through the hubs sorted by angle around the center.
  const loopHubs = hubs
    .filter(h => Math.max(Math.abs(h.p[0]), Math.abs(h.p[1])) < S * 0.8)
    .map(h => ({h, a: Math.atan2(h.p[1] - center[1], h.p[0] - center[0])}))
    .sort((a, b) => a.a - b.a)
    .map(x => x.h.p);
  if (loopHubs.length >= 3) {
    const pts = resample(catmull(loopHubs, true, 15), 12);
    out.push({pts, heights: elevateProfile(pts, hf, 9, 0.03), kind: 'rail', loop: true, stations: []});
  }
  // Cross-town lines from edge to edge through the center.
  for (let k = 1; k < p.railLines; k++) {
    const a = rng.range(0, Math.PI);
    const ctrl: Vec2[] = [];
    for (let s = -4; s <= 4; s++) {
      const r = (S * 1.3 * s) / 4;
      const wob = noise.noise(k * 5.1, s * 0.4) * 200;
      ctrl.push([center[0] + Math.cos(a) * r - Math.sin(a) * wob, center[1] + Math.sin(a) * r + Math.cos(a) * wob]);
    }
    const inBox = resample(catmull(ctrl, false, 15), 12).filter(q => Math.max(Math.abs(q[0]), Math.abs(q[1])) < S - 60);
    const pieces = clipToLand(inBox, hf, 500).sort((x, y) => y.length - x.length);
    const pts = pieces[0] ?? [];
    if (pts.length > 10) out.push({pts, heights: elevateProfile(pts, hf, 9 + k * 3, 0.03), kind: 'rail', loop: false, stations: []});
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

export function generateLayout(params: CityParams, seed: number, progress?: (msg: string, f: number) => void): CityLayout {
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
    const q: Vec2 = [rng.range(-S * 0.75, S * 0.75), rng.range(-S * 0.75, S * 0.75)];
    if (!isLand(q) || hubs.some(h => dist2(h.p, q) < 1300)) continue;
    hubs.push({p: q, weight: rng.range(0.6, 0.95), radius: rng.range(450, 750)});
  }

  progress?.('Laying arterials', 0.15);
  const majorLines: Polyline[] = [];
  for (const l of arterials(params, rng, noise, center, hubs)) {
    for (const piece of clipToLand(l.pts, hf, 700)) {
      const inside = piece.filter(q => Math.abs(q[0]) < S - 40 && Math.abs(q[1]) < S - 40);
      if (inside.length > 1) majorLines.push({pts: inside, kind: l.kind});
    }
  }
  // A frame road around the map keeps regions closed.
  const frame: Vec2[] = [
    [-S + 60, -S + 60],
    [S - 60, -S + 60],
    [S - 60, S - 60],
    [-S + 60, S - 60],
    [-S + 60, -S + 60],
  ];
  majorLines.push({pts: resample(frame, 40), kind: Road.avenue});
  let major = planarize(majorLines, 3);
  major = mergeCloseNodes(major, 20);

  progress?.('Filling streets', 0.25);
  const regions = extractFaces(major, params.size * params.size * 0.5);
  const allLines: Polyline[] = [];
  for (const e of major.edges) {
    if (e.dead) continue;
    allLines.push({pts: [major.nodes[e.a].p, major.nodes[e.b].p], kind: e.kind});
  }
  for (const f of regions) {
    const poly = f.nodes.map(n => major.nodes[n].p);
    for (const l of minorStreets(params, rng, noise, poly, hubs)) {
      for (const piece of clipToLand(l.pts, hf, 0)) allLines.push({pts: piece, kind: l.kind});
    }
  }
  let g: Graph = planarize(allLines, 2.5);
  g = mergeCloseNodes(g, 9);
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
  const nodeH = g.nodes.map(n => Math.max(hf.sample(n.p[0], n.p[1]), SEA_LEVEL + 1.2));
  const chains: RoadChain[] = [];
  for (const c of chainsG) {
    const raw = c.nodes.map(n => g.nodes[n].p);
    const pts = resample(raw, 8);
    // Keep exact endpoints so junctions line up.
    pts[0] = raw[0];
    pts[pts.length - 1] = raw[raw.length - 1];
    const L: number[] = [0];
    for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + dist2(pts[i - 1], pts[i]));
    const total = L[L.length - 1];
    const h0 = nodeH[c.nodes[0]];
    const h1 = nodeH[c.nodes[c.nodes.length - 1]];
    const bridge = pts.map(q => !isLand(q));
    let heights = pts.map((q, i) => {
      const t = total > 0 ? L[i] / total : 0;
      const terrainH = Math.max(hf.sample(q[0], q[1]), SEA_LEVEL + 1.2);
      // Bridges span between the banks with a gentle arch.
      if (bridge[i]) return lerp(h0, h1, t) + Math.sin(Math.PI * t) * Math.min(12, total * 0.03) + 2;
      const blend = smoothstep(0, 40, Math.min(L[i], total - L[i]));
      return lerp(lerp(h0, h1, t), terrainH, blend);
    });
    for (let it = 0; it < 6; it++) {
      const h = heights.slice();
      for (let i = 1; i + 1 < pts.length; i++) heights[i] = (h[i - 1] + 2 * h[i] + h[i + 1]) / 4;
    }
    heights[0] = h0;
    heights[heights.length - 1] = h1;
    if (bridge.some(b => b)) {
      // Raise the bridge deck clear of the water.
      heights = heights.map((h, i) => (bridge[i] ? Math.max(h, SEA_LEVEL + 7) : h));
      for (let it = 0; it < 8; it++) {
        const h = heights.slice();
        for (let i = 1; i + 1 < pts.length; i++) heights[i] = Math.max(h[i], (h[i - 1] + 2 * h[i] + h[i + 1]) / 4 - 0.02);
      }
    }
    chains.push({pts, heights, kind: c.kind, start: c.nodes[0], end: c.nodes[c.nodes.length - 1], bridge});
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
  for (const f of faces) {
    const kinds = f.edges.map(e => g.edges[e].kind);
    const poly = f.nodes.map(n => g.nodes[n].p);
    const curb = insetPolygon(poly, kinds.map(k => ROAD_WIDTH[k] / 2));
    if (!curb) continue;
    const inner = insetPolygon(poly, kinds.map(k => ROAD_WIDTH[k] / 2 + SIDEWALK[k]));
    if (!inner) continue;
    let cx = 0, cz = 0;
    for (const q of inner) {
      cx += q[0];
      cz += q[1];
    }
    cx /= inner.length;
    cz /= inner.length;
    if (!isLand([cx, cz])) continue;
    if (wetFraction(curb, hf) > 0.02) continue;
    const dens = densityAt(hubs, noise, cx, cz);
    const area = polygonArea(inner);
    const park = area > 1500 && hash2(Math.round(cx), Math.round(cz)) % 1000 < params.parkFraction * 1000 * (1.4 - dens);
    blocks.push({curb, inner, park, kinds});
    if (park) continue;
    const clean = cleanPolygon(inner, 1.5);
    if (clean.length < 3) continue;
    const maxLot = lerp(320, 2600, dens * dens) * rng.range(0.8, 1.3);
    const lotsHere: Lot[] = [];
    splitLots(rng, clean, clean.map(() => true), maxLot, 60, lotsHere);
    for (const lot of lotsHere) lots.push({lot, park: false});
  }

  progress?.('Designing buildings', 0.6);
  const buildings: Building[] = [];
  for (const {lot} of lots) {
    const fp = cleanPolygon(lot.poly, 1.2);
    if (fp.length < 3) continue;
    const area = polygonArea(fp);
    if (area < 40) continue;
    let cx = 0, cz = 0;
    for (const q of fp) {
      cx += q[0];
      cz += q[1];
    }
    cx /= fp.length;
    cz /= fp.length;
    if (nearRail([cx, cz], 14) || fp.some(q => nearRail(q, 7))) continue;
    if (fp.some(q => !isLand(q))) continue;
    const brng = new Rng(hash2(Math.round(cx * 10), Math.round(cz * 10)) ^ seed);
    const dens = densityAt(hubs, noise, cx, cz);
    let lo = Infinity, hi = -Infinity;
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
      floors = Math.round(lerp(params.suburbFloors * 2, params.downtownFloors * 2.2, tall * brng.range(0.5, 1.1)));
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
      floors = Math.round(lerp(params.suburbFloors, params.downtownFloors * 0.6, dens) * brng.range(0.6, 1.4));
    }
    floors = clamp(floors, 1, 75);
    const floorH = kind === 'house' ? 2.9 : kind === 'glass' || kind === 'tower' ? 3.9 : 3.3;
    const frontage = lot.frontage.slice(0, fp.length);
    while (frontage.length < fp.length) frontage.push(false);
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
      base: hi,
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
  return {params, seed, terrain, hubs, chains, junctions, blocks, buildings, elevated};
}

/** Fraction of sample points inside the polygon that are water. */
function wetFraction(poly: Vec2[], hf: Heightfield) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
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
    if (weight[k] > 0) hf.data[k] = lerp(hf.data[k], target[k] - 0.05, weight[k]);
  }
}

function expressways(p: CityParams, rng: Rng, chains: RoadChain[], hf: Heightfield): Elevated[] {
  const out: Elevated[] = [];
  // Follow the longest boulevard chains: elevated decks above the arterial.
  const candidates = chains
    .map((c, i) => ({i, len: c.pts.length, c}))
    .filter(x => x.c.kind === Road.boulevard && x.len > 40)
    .sort((a, b) => b.len - a.len);
  for (let k = 0; k < Math.min(p.expressways, candidates.length); k++) {
    const c = candidates[k].c;
    // Trim the ends so ramps don't land inside junctions.
    const pts = c.pts.slice(4, -4);
    if (pts.length < 20) continue;
    const base = pts.map((q, i) => c.heights[i + 4]);
    const heights = elevateProfile(pts, hf, 0, 0.04).map((h, i) => Math.max(h, base[i] + 11));
    out.push({pts, heights, kind: 'expressway', loop: false, stations: []});
  }
  void rng;
  return out;
}
