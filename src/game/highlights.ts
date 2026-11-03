// Showcase highlights: the places in a generated city worth filming, found
// once after load from the layout summary, the land use raster and the
// resident sign lights (see game/showcase.ts). Read-only: nothing here
// changes the city.

import {Road, type Elevated} from '../city/layout.ts';
import {SEA_LEVEL} from '../city/terrain.ts';
import type {Vec2, Vec3} from '../math/vec.ts';
import type {RoadNet} from './roadnet.ts';

export type HighlightKind =
  | 'expressway'
  | 'bridge'
  | 'station'
  | 'park'
  | 'signs'
  | 'towers'
  | 'waterfront'
  | 'junction';

/** A point on a road chain (arc length from the chain's start). */
export interface RoadSpot {
  chain: number;
  arc: number;
  /** Travel direction that reaches the feature (else either). */
  dir?: 1 | -1;
}

export interface Place {
  kind: HighlightKind;
  /** Short description for logs. */
  name: string;
  /** Point of interest (ground or deck level). */
  p: Vec3;
  /** Where a filmed car starts (it drives toward `p`). */
  road?: RoadSpot;
  /** Relative merit (bigger is better). */
  score: number;
  /** Rail station: line index (Trains.lines) and the station's arc length. */
  line?: number;
  stationArc?: number;
  /** Tower cluster: the tallest roof height above the ground and the cluster radius. */
  top?: number;
  radius?: number;
  /** Expressway curve: the line's points around the curve (x, h, z). */
  curve?: Vec3[];
  /** Water direction from a waterfront road (unit x, z). */
  water?: Vec2;
  /** Park: its centroid (x, z). */
  center?: Vec2;
}

export type Highlights = Record<HighlightKind, Place[]>;

/** Sign light positions bucketed for "how many signs near here" queries. */
export class SignGrid {
  private cells = new Map<number, number[]>();
  readonly count: number;
  private static readonly CELL = 32;

  constructor(points: ArrayLike<number>) {
    const C = SignGrid.CELL;
    for (let i = 0; i + 2 < points.length; i += 3) {
      const k = this.key(
        Math.floor(points[i] / C),
        Math.floor(points[i + 2] / C),
      );
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(points[i], points[i + 1], points[i + 2]);
    }
    this.count = Math.floor(points.length / 3);
  }

  private key(cx: number, cz: number) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /** Signs within r (horizontally) of (x, z). */
  near(x: number, z: number, r: number): number {
    const C = SignGrid.CELL;
    let n = 0;
    for (let cz = Math.floor((z - r) / C); cz <= Math.floor((z + r) / C); cz++)
      for (
        let cx = Math.floor((x - r) / C);
        cx <= Math.floor((x + r) / C);
        cx++
      ) {
        const l = this.cells.get(this.key(cx, cz));
        if (!l) continue;
        for (let i = 0; i < l.length; i += 3)
          if (Math.hypot(l[i] - x, l[i + 2] - z) < r) n++;
      }
    return n;
  }
}

export interface HighlightInput {
  net: RoadNet;
  elevated: Elevated[];
  /** Rail lines as the trains run them (Trains.lines): station arcs exclude termini. */
  rail: {
    e: Elevated;
    arc: number[];
    stationArcs: number[];
    hasTrains: boolean;
  }[];
  signs: SignGrid;
  landUse: {data: Uint8Array; n: number; cell: number; size: number} | null;
}

/** Keep the best places at least `gap` metres apart, at most `max`. */
function spread(list: Place[], gap: number, max: number): Place[] {
  const out: Place[] = [];
  for (const p of [...list].sort((a, b) => b.score - a.score)) {
    if (out.length >= max) break;
    if (out.some(q => Math.hypot(q.p[0] - p.p[0], q.p[2] - p.p[2]) < gap))
      continue;
    out.push(p);
  }
  return out;
}

/** Samples along every road chain of at least `minKind`, every `step` metres. */
function roadSamples(net: RoadNet, minKind: number, step: number) {
  const out: {chain: number; arc: number; p: Vec2; d: Vec2}[] = [];
  net.chains.forEach((c, ci) => {
    if (c.kind < minKind) return;
    const arc = net.geom.arc[ci];
    const len = arc[arc.length - 1];
    const [s0, s1] = net.geom.setbacks[ci];
    for (let a = s0 + step / 2; a < len - s1; a += step) {
      const q = net.smoothAt(ci, a);
      out.push({chain: ci, arc: a, p: q.p, d: q.d});
    }
  });
  return out;
}

const groundAt = (net: RoadNet, x: number, z: number): Vec3 => [
  x,
  Math.max(net.hf.sample(x, z), SEA_LEVEL),
  z,
];

/**
 * Every kind of highlight in the city. `between(label)` runs before each
 * kind (the loading screen names it and paints; slow phones spend seconds
 * here); the kinds don't depend on each other, so the result is the same.
 */
export async function findHighlights(
  inp: HighlightInput,
  between: (label: string) => Promise<void> = async () => {},
): Promise<Highlights> {
  const {net} = inp;
  const samples = roadSamples(net, Road.street, 12);
  const find = async <T>(label: string, fn: () => T): Promise<T> => {
    await between(label);
    return fn();
  };
  const what = 'Finding showcase scenes';
  return {
    expressway: await find(`${what}: expressways`, () =>
      expresswayCurves(inp, samples),
    ),
    bridge: await find(`${what}: bridges`, () => bridges(net)),
    station: await find(`${what}: stations`, () => stations(inp)),
    park: await find(`${what}: parks`, () => parks(inp, samples)),
    signs: await find(`${what}: sign streets`, () => signStreets(inp, samples)),
    towers: await find(`${what}: towers`, () => towerClusters(net)),
    waterfront: await find(`${what}: waterfront`, () =>
      waterfront(net, samples),
    ),
    junction: await find(`${what}: junctions`, () => junctions(inp)),
  };
}

/** Bends and interchanges of the elevated expressways, with a road beside them. */
function expresswayCurves(
  inp: HighlightInput,
  samples: ReturnType<typeof roadSamples>,
): Place[] {
  // Distance from a point to the nearest expressway deck.
  const decks = inp.elevated.filter(e => e.kind === 'expressway');
  const deckDist = (x: number, z: number) => {
    let d = Infinity;
    for (const e of decks)
      for (const q of e.pts) d = Math.min(d, Math.hypot(q[0] - x, q[1] - z));
    return d;
  };
  const out: Place[] = [];
  inp.elevated.forEach((e, ei) => {
    if (e.kind !== 'expressway') return;
    const n = e.pts.length;
    const W = 4;
    const scores = new Float64Array(n);
    for (let i = W; i + W < n; i++) {
      const a = e.pts[i - W];
      const b = e.pts[i];
      const c = e.pts[i + W];
      const h0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const h1 = Math.atan2(c[1] - b[1], c[0] - b[0]);
      let turn = Math.abs(h1 - h0);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      // Crossing another expressway: an interchange.
      let cross = 0;
      for (const o of decks)
        if (o !== e)
          for (const q of o.pts)
            if (Math.hypot(q[0] - b[0], q[1] - b[1]) < 30) cross = 1;
      scores[i] = turn + cross * 0.8;
    }
    for (let i = W; i + W < n; i++) {
      const score = scores[i];
      if (score < 0.2) continue;
      // Only the peak of each bend.
      let peak = true;
      for (let k = Math.max(0, i - 6); k <= Math.min(n - 1, i + 6); k++)
        if (scores[k] > score || (scores[k] === score && k < i)) peak = false;
      if (!peak) continue;
      const b = e.pts[i];
      // The road the car drives: a street out in the open 40-140 m from the
      // bend heading toward it, so the deck sweeps across the view ahead
      // (the boulevard under the deck is in its shadow).
      let road: RoadSpot | null = null;
      let rs = -Infinity;
      for (const s of samples) {
        const dx = b[0] - s.p[0];
        const dz = b[1] - s.p[1];
        const d = Math.hypot(dx, dz);
        if (d < 40 || d > 140) continue;
        const toward = (dx * s.d[0] + dz * s.d[1]) / d;
        if (Math.abs(toward) < 0.6) continue;
        if (deckDist(s.p[0], s.p[1]) < 28) continue;
        const sc = Math.abs(toward) - d / 400;
        if (sc > rs) {
          rs = sc;
          road = {chain: s.chain, arc: s.arc, dir: toward > 0 ? 1 : -1};
        }
      }
      if (!road) continue;
      const curve: Vec3[] = [];
      for (let k = Math.max(0, i - 12); k < Math.min(n, i + 13); k += 2)
        curve.push([e.pts[k][0], e.heights[k], e.pts[k][1]]);
      out.push({
        kind: 'expressway',
        name: `expressway ${ei} bend ${i}`,
        p: [b[0], e.heights[i], b[1]],
        road,
        score,
        curve,
      });
    }
  });
  return spread(out, 400, 8);
}

/** Road bridges over water, longest first; the car starts short of them. */
function bridges(net: RoadNet): Place[] {
  const out: Place[] = [];
  net.chains.forEach((c, ci) => {
    const arc = net.geom.arc[ci];
    let i = 0;
    while (i < c.bridge.length) {
      if (!c.bridge[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < c.bridge.length && c.bridge[j + 1]) j++;
      const len = arc[j] - arc[i];
      if (len > 40) {
        const m = (i + j) >> 1;
        // Approach from whichever end leaves more road before the bridge.
        const total = arc[arc.length - 1];
        const dir: 1 | -1 = arc[i] >= total - arc[j] ? 1 : -1;
        out.push({
          kind: 'bridge',
          name: `bridge chain ${ci} (${len.toFixed(0)} m)`,
          p: [c.pts[m][0], c.heights[m], c.pts[m][1]],
          road: {chain: ci, arc: dir === 1 ? arc[i] : arc[j], dir},
          score: len * (1 + c.kind * 0.3),
        });
      }
      i = j + 1;
    }
  });
  return spread(out, 300, 8);
}

/** Rail stations trains stop at (not the termini). */
function stations(inp: HighlightInput): Place[] {
  const out: Place[] = [];
  inp.rail.forEach((l, li) => {
    if (!l.hasTrains) return;
    for (const sa of l.stationArcs) {
      // Station point by arc length.
      let k = 0;
      while (k + 1 < l.arc.length && l.arc[k + 1] < sa) k++;
      const q = l.e.pts[k];
      out.push({
        kind: 'station',
        name: `line ${li} station @${sa.toFixed(0)}`,
        p: [q[0], l.e.heights[k], q[1]],
        score: 1 + inp.signs.near(q[0], q[1], 120) * 0.02,
        line: li,
        stationArc: sa,
      });
    }
  });
  return spread(out, 200, 12);
}

/** Parks (land use 2) of some size, with the road along their longest edge. */
function parks(
  inp: HighlightInput,
  samples: ReturnType<typeof roadSamples>,
): Place[] {
  const lu = inp.landUse;
  if (!lu) return [];
  const {data, n, cell, size} = lu;
  const comp = new Int32Array(n * n).fill(-1);
  const area: number[] = [];
  const sx: number[] = [];
  const sz: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n * n; i++) {
    if (data[i] !== 2 || comp[i] >= 0) continue;
    const id = area.length;
    area.push(0);
    sx.push(0);
    sz.push(0);
    comp[i] = id;
    stack.push(i);
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % n;
      const z = (k / n) | 0;
      area[id]++;
      sx[id] += x;
      sz[id] += z;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const X = x + dx;
        const Z = z + dz;
        if (X < 0 || Z < 0 || X >= n || Z >= n) continue;
        const kk = Z * n + X;
        if (data[kk] === 2 && comp[kk] < 0) {
          comp[kk] = id;
          stack.push(kk);
        }
      }
    }
  }
  const S = size / 2;
  const cellOf = (x: number, z: number) => {
    const X = Math.round((x + S) / cell);
    const Z = Math.round((z + S) / cell);
    return X < 0 || Z < 0 || X >= n || Z >= n ? -1 : Z * n + X;
  };
  // Road samples beside each big park: the one with the most park on
  // either side (a road along the park, not one crossing a corner).
  const minCells = 9000 / (cell * cell);
  const best = new Map<number, {score: number; s: (typeof samples)[0]}>();
  for (const s of samples) {
    const side: Vec2 = [-s.d[1], s.d[0]];
    const cnt = new Map<number, number>();
    for (const off of [10, 18, 26, 34])
      for (const sg of [-1, 1]) {
        const k = cellOf(
          s.p[0] + side[0] * off * sg,
          s.p[1] + side[1] * off * sg,
        );
        const c = k >= 0 ? comp[k] : -1;
        if (c >= 0 && area[c] >= minCells) cnt.set(c, (cnt.get(c) ?? 0) + 1);
      }
    for (const [c, v] of cnt) {
      const b = best.get(c);
      if (!b || v > b.score) best.set(c, {score: v, s});
    }
  }
  const out: Place[] = [];
  for (const [c, b] of best) {
    if (b.score < 3) continue;
    const x = (sx[c] / area[c]) * cell - S;
    const z = (sz[c] / area[c]) * cell - S;
    out.push({
      kind: 'park',
      name: `park ${c} (${Math.round(area[c] * cell * cell)} m2)`,
      p: groundAt(inp.net, b.s.p[0], b.s.p[1]),
      road: {chain: b.s.chain, arc: b.s.arc},
      score: Math.sqrt(area[c] * cell * cell) * (b.score / 8),
      radius: Math.sqrt((area[c] * cell * cell) / Math.PI),
      center: [x, z],
    });
  }
  return spread(out, 300, 8);
}

/** The streets with the most signs along them. */
function signStreets(
  inp: HighlightInput,
  samples: ReturnType<typeof roadSamples>,
): Place[] {
  const out: Place[] = [];
  for (const s of samples) {
    const n = inp.signs.near(s.p[0], s.p[1], 35);
    if (n < 6) continue;
    out.push({
      kind: 'signs',
      name: `signs x${n} chain ${s.chain}`,
      p: groundAt(inp.net, s.p[0], s.p[1]),
      road: {chain: s.chain, arc: s.arc},
      score: n,
    });
  }
  return spread(out, 250, 10);
}

/** Clusters of the tallest buildings. */
function towerClusters(net: RoadNet): Place[] {
  const tall = net.buildings
    .filter(b => b.height > 45)
    .map(b => {
      let x = 0;
      let z = 0;
      for (const q of b.footprint) {
        x += q[0];
        z += q[1];
      }
      return {
        x: x / b.footprint.length,
        z: z / b.footprint.length,
        h: b.height,
        base: b.base,
      };
    });
  const out: Place[] = [];
  for (const t of tall) {
    let w = 0;
    let cx = 0;
    let cz = 0;
    let top = 0;
    let rad = 0;
    for (const o of tall) {
      const d = Math.hypot(o.x - t.x, o.z - t.z);
      if (d > 250) continue;
      const k = o.h * o.h;
      w += k;
      cx += o.x * k;
      cz += o.z * k;
      top = Math.max(top, o.h);
    }
    cx /= w;
    cz /= w;
    for (const o of tall) {
      const d = Math.hypot(o.x - cx, o.z - cz);
      if (d < 250) rad = Math.max(rad, d);
    }
    out.push({
      kind: 'towers',
      name: `towers top ${top.toFixed(0)} m`,
      p: groundAt(net, cx, cz),
      score: Math.sqrt(w),
      top,
      radius: Math.max(60, rad),
    });
  }
  return spread(out, 600, 4);
}

/** Roads along the water. */
function waterfront(
  net: RoadNet,
  samples: ReturnType<typeof roadSamples>,
): Place[] {
  const out: Place[] = [];
  for (let i = 0; i < samples.length; i += 2) {
    const s = samples[i];
    if (net.chains[s.chain].bridge.some(b => b)) continue;
    const side: Vec2 = [-s.d[1], s.d[0]];
    for (const sg of [-1, 1]) {
      let wet = 0;
      for (const off of [25, 45, 70, 100, 140]) {
        const x = s.p[0] + side[0] * off * sg;
        const z = s.p[1] + side[1] * off * sg;
        if (net.hf.sample(x, z) < SEA_LEVEL - 0.5) wet++;
      }
      // The road itself on land, open water beyond it.
      if (wet >= 4 && net.hf.sample(s.p[0], s.p[1]) > SEA_LEVEL + 0.5)
        out.push({
          kind: 'waterfront',
          name: `waterfront chain ${s.chain}`,
          p: groundAt(net, s.p[0], s.p[1]),
          road: {chain: s.chain, arc: s.arc},
          score: wet + net.chains[s.chain].kind,
          water: [side[0] * sg, side[1] * sg],
        });
    }
  }
  return spread(out, 400, 8);
}

/** Signalled junctions of big roads, busiest (most signs) first. */
function junctions(inp: HighlightInput): Place[] {
  const {net} = inp;
  const out: Place[] = [];
  net.junctions.forEach((j, ji) => {
    if (!j.signal || j.arms.length < 3) return;
    const kinds = j.arms.map(a => net.chains[a.chain].kind);
    if (Math.max(...kinds) < Road.avenue) return;
    // Approach along the biggest arm with room to brake.
    let arm = -1;
    for (let k = 0; k < j.arms.length; k++) {
      const a = j.arms[k];
      if (net.length(a.chain) < 90) continue;
      if (arm < 0 || kinds[k] > kinds[arm]) arm = k;
    }
    if (arm < 0) return;
    const a = j.arms[arm];
    out.push({
      kind: 'junction',
      name: `junction ${ji}`,
      p: [j.p[0], j.h, j.p[1]],
      road: {
        chain: a.chain,
        arc: a.end === 0 ? 0 : net.length(a.chain),
        dir: a.end === 0 ? -1 : 1,
      },
      score: 1 + inp.signs.near(j.p[0], j.p[1], 60) * 0.1 + j.arms.length,
    });
  });
  return spread(out, 250, 12);
}
