// Road network queries for gameplay: lanes, junction lookup, nearest road,
// driving surface height and building collision.

import {
  Road,
  LANES,
  ROAD_WIDTH,
  type RoadChain,
  type Junction,
  type Building,
  chainMedians,
} from '../city/layout.ts';
import {chainAt, type RoadGeom} from '../city/roadgeom.ts';
import type {Heightfield} from '../city/terrain.ts';
import {hash2} from '../math/random.ts';
import {pointSegment, type Vec2, type Vec3} from '../math/vec.ts';
import type {LayoutSummary} from '../workers/city-worker.ts';
import {streetLightSpots} from '../city/gen-base.ts';
import type {CityLayout} from '../city/layout.ts';
import {keepLeft} from '../city/config.ts';

export const SPEED_LIMIT = [8.5, 11.5, 15, 18];

/** Same function as signalState() in shaders/common.wgsl. */
export function signalState(t: number, phase: number, group: number): number {
  const cycle = 44;
  let x = (((t + phase * 0.17) / cycle) % 1) * cycle;
  if (x < 0) x += cycle;
  if (group === 1) x = (((x + 22) / cycle) % 1) * cycle;
  if (x < 17) return 0;
  if (x < 20) return 1;
  return 2;
}

/** A rounded polyline vertex of a road chain (see RoadNet.smoothAt). */
export interface Corner {
  /** Arc position of the vertex along the chain. */
  a: number;
  /** Fillet half-length: the curve spans a - r .. a + r. */
  r: number;
  /** Peak centerline curvature of the fillet (1/m). */
  k: number;
}

/** Most a fillet may cut inside a polyline vertex (m). */
const FILLET_CUT = 1.5;

export interface LanePos {
  p: Vec3;
  /** Travel direction (x, z). */
  d: Vec2;
  slope: number;
}

export class RoadNet {
  readonly chains: RoadChain[];
  readonly junctions: Junction[];
  readonly geom: RoadGeom;
  readonly buildings: Building[];
  readonly hf: Heightfield;
  /** Junction index for each graph node id. */
  private nodeJunction = new Map<number, number>();
  private segGrid = new Map<number, number[]>();
  private bldGrid = new Map<number, number[]>();
  private readonly cell = 32;
  readonly size: number;
  /** +1: traffic keeps left (lanes on the left of travel); -1: keeps right. */
  readonly side: 1 | -1;
  private poleGrid = new Map<number, Vec3[]>();
  private junctionGrid = new Map<number, number[]>();
  /** Fillet half-length per chain vertex (lazily built). */
  private fillets = new Map<number, Float64Array>();
  private cornerList = new Map<number, Corner[]>();
  /** Per chain: half width of the pier median (layout chainMedians). */
  readonly medians: Float32Array;

  constructor(summary: LayoutSummary, hf: Heightfield) {
    const L = summary.layout;
    this.chains = L.chains;
    this.junctions = L.junctions;
    this.geom = summary.geom;
    this.buildings = L.buildings;
    this.hf = hf;
    this.size = L.params.size;
    this.side = keepLeft(L.params);
    this.medians = chainMedians(L);
    L.junctions.forEach((j, ji) => {
      for (const a of j.arms) {
        const c = L.chains[a.chain];
        this.nodeJunction.set(a.end === 0 ? c.start : c.end, ji);
      }
    });
    L.chains.forEach((c, ci) => {
      for (let i = 0; i + 1 < c.pts.length; i++) {
        const a = c.pts[i];
        const b = c.pts[i + 1];
        const keys = new Set([
          this.key(a[0], a[1]),
          this.key(b[0], b[1]),
          this.key((a[0] + b[0]) / 2, (a[1] + b[1]) / 2),
        ]);
        for (const k of keys) {
          let l = this.segGrid.get(k);
          if (!l) this.segGrid.set(k, (l = []));
          l.push(ci * 65536 + i);
        }
      }
    });
    // Junction surfaces (flat polygons at the junction height).
    this.geom.junctions.forEach((jg, ji) => {
      if (jg.outline.length < 3) return;
      let x0 = Infinity,
        x1 = -Infinity,
        z0 = Infinity,
        z1 = -Infinity;
      for (const q of jg.outline) {
        x0 = Math.min(x0, q[0]);
        x1 = Math.max(x1, q[0]);
        z0 = Math.min(z0, q[1]);
        z1 = Math.max(z1, q[1]);
      }
      for (
        let z = Math.floor(z0 / this.cell);
        z <= Math.floor(z1 / this.cell);
        z++
      )
        for (
          let x = Math.floor(x0 / this.cell);
          x <= Math.floor(x1 / this.cell);
          x++
        ) {
          const k = this.key(x * this.cell, z * this.cell);
          let l = this.junctionGrid.get(k);
          if (!l) this.junctionGrid.set(k, (l = []));
          l.push(ji);
        }
    });
    // Street light poles (thin obstacles for camera framing).
    streetLightSpots(L as unknown as CityLayout, this.geom, hf, p => {
      const k = this.key(p[0], p[2]);
      let l = this.poleGrid.get(k);
      if (!l) this.poleGrid.set(k, (l = []));
      l.push(p);
    });
    L.buildings.forEach((b, bi) => {
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
        let z = Math.floor(z0 / this.cell);
        z <= Math.floor(z1 / this.cell);
        z++
      ) {
        for (
          let x = Math.floor(x0 / this.cell);
          x <= Math.floor(x1 / this.cell);
          x++
        ) {
          const k = (z + 1000) * 4096 + (x + 1000);
          let l = this.bldGrid.get(k);
          if (!l) this.bldGrid.set(k, (l = []));
          l.push(bi);
        }
      }
    });
  }

  private key(x: number, z: number) {
    return (
      (Math.floor(z / this.cell) + 1000) * 4096 +
      (Math.floor(x / this.cell) + 1000)
    );
  }

  junctionAt(chain: number, end: 0 | 1) {
    const c = this.chains[chain];
    return this.nodeJunction.get(end === 0 ? c.start : c.end) ?? -1;
  }

  length(chain: number) {
    const a = this.geom.arc[chain];
    return a[a.length - 1];
  }

  lanesPerDir(chain: number) {
    return Math.max(1, Math.floor(LANES[this.chains[chain].kind] / 2));
  }

  laneOffset(chain: number, lane: number) {
    const c = this.chains[chain];
    const half = ROAD_WIDTH[c.kind] / 2;
    const n = this.lanesPerDir(chain);
    if (c.kind === Road.lane) return half * 0.35;
    // Lanes start past the pier median (under an expressway), as painted.
    const med = this.medians[chain];
    const w = (half - med - 0.4) / n;
    return med + (lane + 0.5) * w + 0.2;
  }

  /**
   * Fillet half-length at each vertex of a chain: half the shorter adjacent
   * segment, less at sharp corners so the curve never cuts more than
   * FILLET_CUT inside the vertex.
   */
  private filletsOf(chain: number): Float64Array {
    let r = this.fillets.get(chain);
    if (r) return r;
    const pts = this.chains[chain].pts;
    const n = pts.length;
    r = new Float64Array(n);
    for (let i = 1; i + 1 < n; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const l0 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const l1 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (l0 < 1e-6 || l1 < 1e-6) continue;
      const cos =
        ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) /
        (l0 * l1);
      const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
      // The quadratic fillet's apex sits r sin(half) / 2 inside the vertex.
      const cap = half > 1e-4 ? (2 * FILLET_CUT) / Math.sin(half) : Infinity;
      r[i] = Math.min(l0 / 2, l1 / 2, cap);
    }
    this.fillets.set(chain, r);
    return r;
  }

  /**
   * Sharp-ish rounded vertices of a chain (turning more than ~6 degrees),
   * for slowing down ahead of them.
   */
  corners(chain: number): Corner[] {
    let list = this.cornerList.get(chain);
    if (list) return list;
    list = [];
    const r = this.filletsOf(chain);
    const pts = this.chains[chain].pts;
    const arc = this.geom.arc[chain];
    for (let i = 1; i + 1 < pts.length; i++) {
      if (r[i] <= 0) continue;
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const l0 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const l1 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const cos =
        ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) /
        (l0 * l1);
      const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
      if (half < 0.05) continue;
      // Apex curvature of a symmetric quadratic Bezier with legs r.
      const ch = Math.cos(half);
      const k = Math.sin(half) / (r[i] * Math.max(ch * ch, 1e-3));
      list.push({a: arc[i], r: r[i], k});
    }
    this.cornerList.set(chain, list);
    return list;
  }

  /**
   * Point and tangent on a chain's centerline at arc position a, with every
   * polyline vertex rounded by a quadratic fillet (see filletsOf). The plain
   * polyline turns its whole vertex angle in an instant; this curve has a
   * continuous tangent, so headings measured along it change smoothly.
   */
  smoothAt(chain: number, a: number): {p: Vec2; d: Vec2} {
    const pts = this.chains[chain].pts;
    const arc = this.geom.arc[chain];
    const n = pts.length;
    const total = arc[n - 1];
    a = Math.max(0, Math.min(total, a));
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arc[mid] <= a) lo = mid;
      else hi = mid;
    }
    const segDir = (i: number): Vec2 => {
      const p = pts[i];
      const q = pts[i + 1];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
    };
    const r = this.filletsOf(chain);
    let v = -1;
    if (lo > 0 && a - arc[lo] < r[lo]) v = lo;
    else if (hi < n - 1 && arc[hi] - a < r[hi]) v = hi;
    if (v < 0) {
      const seg = arc[hi] - arc[lo] || 1;
      const t = (a - arc[lo]) / seg;
      const p0 = pts[lo];
      const p1 = pts[hi];
      return {
        p: [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t],
        d: segDir(lo),
      };
    }
    const din = segDir(v - 1);
    const dout = segDir(v);
    const rv = r[v];
    const u = (a - (arc[v] - rv)) / (2 * rv);
    const V = pts[v];
    const w0 = (1 - u) * (1 - u);
    const w1 = 2 * u * (1 - u);
    const w2 = u * u;
    const p: Vec2 = [
      w0 * (V[0] - din[0] * rv) + w1 * V[0] + w2 * (V[0] + dout[0] * rv),
      w0 * (V[1] - din[1] * rv) + w1 * V[1] + w2 * (V[1] + dout[1] * rv),
    ];
    const dx = (1 - u) * din[0] + u * dout[0];
    const dz = (1 - u) * din[1] + u * dout[1];
    const dl = Math.hypot(dx, dz);
    return {p, d: dl > 1e-6 ? [dx / dl, dz / dl] : din};
  }

  /** Position on a lane: s is the distance traveled in the travel direction. */
  lanePos(chain: number, dir: 1 | -1, lane: number, s: number): LanePos {
    const c = this.chains[chain];
    const arc = this.geom.arc[chain];
    const total = arc[arc.length - 1];
    const a = dir === 1 ? s : total - s;
    const q = chainAt(c, arc, a);
    // Lanes follow the rounded centerline (heights from the road's grade).
    const sm = this.smoothAt(chain, a);
    const d: Vec2 = dir === 1 ? sm.d : [-sm.d[0], -sm.d[1]];
    // Lanes are on the kerb side: the left of the travel direction (dz,
    // -dx) where traffic keeps left (Tokyo), the right where it keeps right.
    const off = this.laneOffset(chain, lane) * this.side;
    const left: Vec2 = [d[1], -d[0]];
    const q2 = chainAt(c, arc, a + dir * 2);
    const slope = (q2.h - q.h) / 2;
    return {
      p: [sm.p[0] + left[0] * off, q.h + 0.03, sm.p[1] + left[1] * off],
      d,
      slope,
    };
  }

  /** Arms leaving a junction (excluding the one we arrived on). */
  exits(junction: number, fromChain: number, fromEnd: number) {
    const j = this.junctions[junction];
    return j.arms.filter(a => !(a.chain === fromChain && a.end === fromEnd));
  }

  signalFor(
    junction: number,
    chain: number,
    end: number,
    time: number,
  ): number {
    const j = this.junctions[junction];
    if (!j?.signal) return 0;
    const jg = this.geom.junctions[junction];
    const arm = jg.arms.find(a => a.chain === chain && a.end === end);
    if (!arm) return 0;
    const phase = hash2(junction, 17) & 0xff;
    const group = Math.round((arm.angle / Math.PI) * 2) & 1;
    return signalState(time, phase, group);
  }

  /** Nearest point on any road centerline. */
  nearestRoad(
    x: number,
    z: number,
    maxCells = 3,
  ): {chain: number; seg: number; t: number; dist: number} | null {
    let best = null as {
      chain: number;
      seg: number;
      t: number;
      dist: number;
    } | null;
    for (let r = 0; r <= maxCells; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const v of this.segGrid.get(
            this.key(x + dx * this.cell, z + dz * this.cell),
          ) ?? []) {
            const ci = Math.floor(v / 65536);
            const si = v % 65536;
            const c = this.chains[ci];
            const [d, t] = pointSegment([x, z], c.pts[si], c.pts[si + 1]);
            if (!best || d < best.dist) best = {chain: ci, seg: si, t, dist: d};
          }
        }
      }
      if (best && best.dist < r * this.cell) break;
    }
    return best;
  }

  /** Driving surface height: road deck if on a road, else terrain (+ curb). */
  surfaceHeight(x: number, z: number, nearHint?: number): number {
    const ground = this.hf.sample(x, z);
    const ok = (h: number) =>
      nearHint === undefined || Math.abs(h - nearHint) < 4 || h > ground + 3;
    // Junction polygons are flat (same as the rendered junction surface).
    for (const ji of this.junctionGrid.get(this.key(x, z)) ?? []) {
      if (!pointInPoly(x, z, this.geom.junctions[ji].outline)) continue;
      const h = this.junctions[ji].h + 0.02;
      if (ok(h)) return h;
    }
    const nr = this.nearestRoad(x, z, 1);
    if (nr) {
      const c = this.chains[nr.chain];
      const half = ROAD_WIDTH[c.kind] / 2;
      if (nr.dist < half + 0.3) {
        // Same grade blend as chainAt(), which the road mesh is built from.
        const t = nr.t;
        const st = t * t * (3 - 2 * t);
        const h =
          c.heights[nr.seg] +
          (c.heights[nr.seg + 1] - c.heights[nr.seg]) * (t * 0.5 + st * 0.5) +
          0.02;
        if (ok(h)) return h;
      }
    }
    return ground + 0.16;
  }

  /** Push a circle out of building footprints. Returns the push vector. */
  collideBuildings(p: Vec3, radius: number): Vec2 {
    let push: Vec2 = [0, 0];
    for (const bi of this.bldGrid.get(this.key(p[0], p[2])) ?? []) {
      const b = this.buildings[bi];
      if (p[1] > b.base + b.height + 1) continue;
      const fp = b.footprint;
      let inside = false;
      let best = Infinity;
      let bn: Vec2 = [0, 0];
      for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
        const a = fp[i];
        const c = fp[j];
        if (
          a[1] > p[2] !== c[1] > p[2] &&
          p[0] < ((c[0] - a[0]) * (p[2] - a[1])) / (c[1] - a[1]) + a[0]
        )
          inside = !inside;
        const [d, t] = pointSegment([p[0], p[2]], c, a);
        if (d < best) {
          best = d;
          const qx = c[0] + (a[0] - c[0]) * t;
          const qz = c[1] + (a[1] - c[1]) * t;
          const l = Math.hypot(p[0] - qx, p[2] - qz) || 1;
          bn = [(p[0] - qx) / l, (p[2] - qz) / l];
        }
      }
      if (inside)
        push = [
          push[0] - bn[0] * (best + radius),
          push[1] - bn[1] * (best + radius),
        ];
      else if (best < radius)
        push = [
          push[0] + bn[0] * (radius - best),
          push[1] + bn[1] * (radius - best),
        ];
    }
    return push;
  }

  /** The building whose footprint contains (x, z), if any. */
  buildingAt(x: number, z: number): Building | null {
    for (const bi of this.bldGrid.get(this.key(x, z)) ?? []) {
      const b = this.buildings[bi];
      if (pointInPoly(x, z, b.footprint)) return b;
    }
    return null;
  }

  /** Poles within r of a point. */
  polesNear(x: number, z: number, r: number): Vec3[] {
    const out: Vec3[] = [];
    const n = Math.ceil(r / this.cell);
    for (let dz = -n; dz <= n; dz++) {
      for (let dx = -n; dx <= n; dx++) {
        for (const p of this.poleGrid.get(
          this.key(x + dx * this.cell, z + dz * this.cell),
        ) ?? []) {
          if (Math.hypot(p[0] - x, p[2] - z) < r) out.push(p);
        }
      }
    }
    return out;
  }

  /** Random lane location near a point (for spawning). */
  randomLaneNear(x: number, z: number, r: number, rand: () => number) {
    for (let tries = 0; tries < 20; tries++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * r;
      const nr = this.nearestRoad(x + Math.cos(a) * d, z + Math.sin(a) * d, 2);
      if (!nr) continue;
      const c = this.chains[nr.chain];
      if (c.bridge.some(b => b) && rand() < 0.5) continue;
      const len = this.length(nr.chain);
      const [s0, s1] = this.geom.setbacks[nr.chain];
      if (len - s0 - s1 < 10) continue;
      const dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
      const lane = Math.floor(rand() * this.lanesPerDir(nr.chain));
      const arcAt = this.geom.arc[nr.chain][nr.seg];
      const sAlong = dir === 1 ? arcAt : len - arcAt;
      const sStart = dir === 1 ? s0 : s1;
      const sEnd = len - (dir === 1 ? s1 : s0);
      if (sAlong < sStart + 2 || sAlong > sEnd - 5) continue;
      return {chain: nr.chain, dir, lane, s: sAlong};
    }
    return null;
  }
}

function pointInPoly(x: number, z: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a[1] > z !== b[1] > z &&
      x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
