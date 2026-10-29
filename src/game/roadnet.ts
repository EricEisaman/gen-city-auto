// Road network queries for gameplay: lanes, junction lookup, nearest road,
// driving surface height and building collision.

import {
  Road,
  LANES,
  ROAD_WIDTH,
  type RoadChain,
  type Junction,
  type Building,
} from '../city/layout.ts';
import {chainAt, type RoadGeom} from '../city/roadgeom.ts';
import type {Heightfield} from '../city/terrain.ts';
import {hash2} from '../math/random.ts';
import {pointSegment, type Vec2, type Vec3} from '../math/vec.ts';
import type {LayoutSummary} from '../workers/city-worker.ts';

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

  constructor(summary: LayoutSummary, hf: Heightfield) {
    const L = summary.layout;
    this.chains = L.chains;
    this.junctions = L.junctions;
    this.geom = summary.geom;
    this.buildings = L.buildings;
    this.hf = hf;
    this.size = L.params.size;
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
    const w = (half - 0.4) / n;
    return (lane + 0.5) * w + 0.2;
  }

  /** Position on a lane: s is the distance traveled in the travel direction. */
  lanePos(chain: number, dir: 1 | -1, lane: number, s: number): LanePos {
    const c = this.chains[chain];
    const arc = this.geom.arc[chain];
    const total = arc[arc.length - 1];
    const a = dir === 1 ? s : total - s;
    const q = chainAt(c, arc, a);
    const d: Vec2 = dir === 1 ? q.d : [-q.d[0], -q.d[1]];
    const off = this.laneOffset(chain, lane);
    // Drive on the left (Japan): left of travel direction is (dz, -dx).
    const left: Vec2 = [d[1], -d[0]];
    const q2 = chainAt(c, arc, a + dir * 2);
    const slope = (q2.h - q.h) / 2;
    return {
      p: [q.p[0] + left[0] * off, q.h + 0.03, q.p[1] + left[1] * off],
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
    const nr = this.nearestRoad(x, z, 1);
    const ground = this.hf.sample(x, z);
    if (nr) {
      const c = this.chains[nr.chain];
      const half = ROAD_WIDTH[c.kind] / 2;
      if (nr.dist < half + 0.3) {
        const h =
          c.heights[nr.seg] +
          (c.heights[nr.seg + 1] - c.heights[nr.seg]) * nr.t +
          0.02;
        if (
          nearHint === undefined ||
          Math.abs(h - nearHint) < 4 ||
          h > ground + 3
        )
          return h;
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
