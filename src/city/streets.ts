// Street network from a tensor field (after Chen et al. 2008, "Interactive
// Procedural Street Modeling"). A smooth orientation field is built from grid
// and radial basis fields plus terrain contours; roads are evenly spaced
// streamlines of its two orthogonal eigenvector fields. Streets therefore run
// continuously across the city, cross at sensible angles, follow hills and
// shorelines, and loose ends are joined to nearby roads instead of dangling.

import {Noise2D} from '../math/noise.ts';
import {Rng} from '../math/random.ts';
import {clamp, smoothstep, type Vec2} from '../math/vec.ts';
import type {Polyline} from './graph.ts';
import {SEA_LEVEL, type Heightfield} from './terrain.ts';

export interface Basis {
  kind: 'grid' | 'radial';
  center: Vec2;
  /** Influence radius (gaussian decay) in meters. */
  radius: number;
  weight: number;
  /** Grid orientation (radians), unused for radial. */
  theta: number;
}

export interface StreetParams {
  size: number;
  bases: Basis[];
  /** Weight of terrain-contour alignment on slopes. */
  terrainWeight: number;
  /** Spacing of major roads (m). */
  majorSep: number;
  /** Spacing of minor streets (m) as a function of density 0..1. */
  minorSep: (density: number) => number;
  density: (x: number, z: number) => number;
  /** Longest water crossing a major road may bridge (m). */
  maxBridge: number;
  majorKind: (index: number) => number;
  minorKind: (density: number, rng: Rng) => number;
  /** Areas streets may not enter (e.g. a central park at a radial center). */
  holes: {c: Vec2; r: number}[];
}

type Field = (p: Vec2) => [number, number];

/** Combined tensor (a, b) = r * (cos 2θ, sin 2θ). */
function makeField(sp: StreetParams, hf: Heightfield, noise: Noise2D): Field {
  return (p: Vec2) => {
    let a = 0;
    let b = 0;
    for (const B of sp.bases) {
      const dx = p[0] - B.center[0];
      const dz = p[1] - B.center[1];
      const w =
        B.weight * Math.exp(-(dx * dx + dz * dz) / (B.radius * B.radius));
      if (w < 1e-4) continue;
      let th = B.theta;
      if (B.kind === 'radial') th = Math.atan2(dz, dx);
      a += w * Math.cos(2 * th);
      b += w * Math.sin(2 * th);
    }
    // Terrain: align with height contours where it is steep (and along coasts,
    // where land rises out of the sea).
    // Large-scale gradient (60 m) so contours follow hills, not terrain noise.
    const e = 60;
    const gx =
      (hf.sample(p[0] + e, p[1]) - hf.sample(p[0] - e, p[1])) / (2 * e);
    const gz =
      (hf.sample(p[0], p[1] + e) - hf.sample(p[0], p[1] - e)) / (2 * e);
    const slope = Math.hypot(gx, gz);
    if (slope > 1e-4) {
      const wt = sp.terrainWeight * smoothstep(0.05, 0.18, slope);
      const th = Math.atan2(gz, gx) + Math.PI / 2;
      a += wt * Math.cos(2 * th);
      b += wt * Math.sin(2 * th);
    }
    // A little low-frequency rotation so grids are not perfectly rigid.
    const rot = noise.noise(p[0] / 1800, p[1] / 1800) * 0.18;
    const c = Math.cos(2 * rot);
    const s = Math.sin(2 * rot);
    return [a * c - b * s, a * s + b * c];
  };
}

/** Unit eigenvector of the field: family 0 = major, 1 = minor. */
function eigen(field: Field, p: Vec2, family: number): Vec2 | null {
  const [a, b] = field(p);
  if (Math.hypot(a, b) < 1e-6) return null;
  const th = 0.5 * Math.atan2(b, a) + (family ? Math.PI / 2 : 0);
  return [Math.cos(th), Math.sin(th)];
}

class PointGrid {
  private cells = new Map<number, {p: Vec2; line: number}[]>();
  private cell: number;

  constructor(cell: number) {
    this.cell = cell;
  }

  private key(x: number, z: number) {
    return (
      (Math.floor(z / this.cell) + 2000) * 4096 +
      Math.floor(x / this.cell) +
      2000
    );
  }

  add(p: Vec2, line: number) {
    const k = this.key(p[0], p[1]);
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push({p, line});
  }

  /** Nearest point within r, optionally ignoring one line. */
  nearest(
    p: Vec2,
    r: number,
    ignore = -1,
  ): {p: Vec2; line: number; d: number} | null {
    const n = Math.ceil(r / this.cell);
    const cx = Math.floor(p[0] / this.cell);
    const cz = Math.floor(p[1] / this.cell);
    let best: {p: Vec2; line: number} | null = null;
    let bd = r;
    // Squared distance clearly beyond bd: skip the exact distance.
    let far2 = r * r * (1 + 1e-9);
    for (let dz = -n; dz <= n; dz++) {
      for (let dx = -n; dx <= n; dx++) {
        for (const q of this.cells.get(
          (cz + dz + 2000) * 4096 + cx + dx + 2000,
        ) ?? []) {
          if (q.line === ignore) continue;
          const ex = q.p[0] - p[0];
          const ez = q.p[1] - p[1];
          if (ex * ex + ez * ez > far2) continue;
          const d = Math.hypot(ex, ez);
          if (d < bd) {
            best = q;
            bd = d;
            far2 = d * d * (1 + 1e-9);
          }
        }
      }
    }
    return best && {p: best.p, line: best.line, d: bd};
  }
}

/** Douglas-Peucker simplification. */
function simplify(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a];
    const B = pts[b];
    const dx = B[0] - A[0];
    const dz = B[1] - A[1];
    const l = Math.hypot(dx, dz) || 1;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - A[0]) * dz - (pts[i][1] - A[1]) * dx) / l;
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function traceStreets(
  sp: StreetParams,
  hf: Heightfield,
  seed: number,
): Polyline[] {
  const rng = new Rng(seed ^ 0x57ee7);
  const noise = new Noise2D(seed + 911);
  const field = makeField(sp, hf, noise);
  const S = sp.size / 2 - 50;
  const isLand = (p: Vec2) => hf.sample(p[0], p[1]) > SEA_LEVEL + 0.5;
  const inBounds = (p: Vec2) =>
    Math.abs(p[0]) < S &&
    Math.abs(p[1]) < S &&
    !sp.holes.some(h => Math.hypot(p[0] - h.c[0], p[1] - h.c[1]) < h.r);
  // Collision grids per family; every road (major and minor) is in both "all".
  const famGrid = [new PointGrid(40), new PointGrid(40)];
  const allGrid = new PointGrid(40);
  const out: Polyline[] = [];
  let lineId = 0;

  const trace = (
    start: Vec2,
    family: number,
    sep: (p: Vec2) => number,
    major: boolean,
    kind: number,
  ): boolean => {
    const id = lineId++;
    const step = major ? 12 : 8;
    const halves: Vec2[][] = [];
    const ends: {p: Vec2; d: Vec2; stoppedByRoad: boolean}[] = [];
    for (const sign of [1, -1]) {
      const pts: Vec2[] = [];
      let p = start;
      const d0 = eigen(field, p, family);
      if (!d0) return false;
      let dir: Vec2 = [d0[0] * sign, d0[1] * sign];
      let stoppedByRoad = false;
      const maxSteps = Math.ceil((sp.size * 1.5) / step);
      for (let i = 0; i < maxSteps; i++) {
        // RK2 integration with eigenvector sign kept consistent.
        const align = (v: Vec2 | null, ref: Vec2): Vec2 | null =>
          v ? (v[0] * ref[0] + v[1] * ref[1] < 0 ? [-v[0], -v[1]] : v) : null;
        const k1 = align(eigen(field, p, family), dir);
        if (!k1) break;
        const mid: Vec2 = [
          p[0] + (k1[0] * step) / 2,
          p[1] + (k1[1] * step) / 2,
        ];
        const k2 = align(eigen(field, mid, family), k1) ?? k1;
        const np: Vec2 = [p[0] + k2[0] * step, p[1] + k2[1] * step];
        if (!inBounds(np)) break;
        if (!isLand(np)) {
          // Major roads may bridge water if land is reached within maxBridge.
          if (!major) break;
          let landAt = -1;
          for (let k = 1; k * step <= sp.maxBridge; k++) {
            const q: Vec2 = [p[0] + k2[0] * step * k, p[1] + k2[1] * step * k];
            if (!inBounds(q)) break;
            if (isLand(q)) {
              landAt = k;
              break;
            }
          }
          if (landAt < 0) break;
          for (let k = 1; k <= landAt; k++)
            pts.push([p[0] + k2[0] * step * k, p[1] + k2[1] * step * k]);
          p = pts[pts.length - 1];
          dir = k2;
          continue;
        }
        // Too close to a parallel road of the same family: stop (and join).
        const s = sep(np);
        const near = famGrid[family].nearest(np, s * 0.5, id);
        if (near && i > 0) {
          stoppedByRoad = true;
          break;
        }
        // Self-intersection / loop guard.
        if (
          i > 20 &&
          Math.hypot(np[0] - start[0], np[1] - start[1]) < step * 1.5
        )
          break;
        pts.push(np);
        p = np;
        dir = k2;
      }
      halves.push(pts);
      ends.push({p, d: dir, stoppedByRoad});
    }
    const line: Vec2[] = [...halves[1].slice().reverse(), start, ...halves[0]];
    let len = 0;
    for (let i = 1; i < line.length; i++)
      len += Math.hypot(
        line[i][0] - line[i - 1][0],
        line[i][1] - line[i - 1][1],
      );
    if (len < (major ? 200 : 40)) return false;
    // Join loose ends to the nearest road ahead so streets don't dead-end.
    const joinR = major ? sp.majorSep * 0.6 : 60;
    const tryJoin = (end: {p: Vec2; d: Vec2}, atStart: boolean) => {
      const cand = allGrid.nearest(
        [end.p[0] + end.d[0] * joinR * 0.5, end.p[1] + end.d[1] * joinR * 0.5],
        joinR,
        id,
      );
      if (!cand) return;
      const v: Vec2 = [cand.p[0] - end.p[0], cand.p[1] - end.p[1]];
      const vl = Math.hypot(v[0], v[1]) || 1;
      if ((v[0] * end.d[0] + v[1] * end.d[1]) / vl < 0.3) return;
      // Don't join across water.
      for (let t = 0.25; t < 1; t += 0.25)
        if (!isLand([end.p[0] + v[0] * t, end.p[1] + v[1] * t])) return;
      // Overshoot a little so the joint is an actual crossing for planarize.
      const tip: Vec2 = [
        cand.p[0] + (v[0] / vl) * 2,
        cand.p[1] + (v[1] / vl) * 2,
      ];
      if (atStart) line.unshift(tip);
      else line.push(tip);
    };
    tryJoin(ends[0], false);
    tryJoin(ends[1], true);
    for (const q of line) {
      famGrid[family].add(q, id);
      allGrid.add(q, id);
    }
    out.push({
      pts: simplify(line, 0.4),
      kind,
      maxBridge: major ? sp.maxBridge : undefined,
    });
    return true;
  };

  // Major roads: seeds on a jittered grid (plus basis centers), both families.
  const seeds: Vec2[] = sp.bases.map(b => b.center);
  for (let z = -S; z < S; z += sp.majorSep * 0.7) {
    for (let x = -S; x < S; x += sp.majorSep * 0.7) {
      seeds.push([
        x + rng.range(0, sp.majorSep * 0.7),
        z + rng.range(0, sp.majorSep * 0.7),
      ]);
    }
  }
  for (let i = seeds.length - 1; i > sp.bases.length; i--) {
    const j = sp.bases.length + rng.int(0, i - sp.bases.length + 1);
    [seeds[i], seeds[j]] = [seeds[j], seeds[i]];
  }
  let majorIndex = 0;
  for (const s of seeds) {
    if (!isLand(s) || !inBounds(s)) continue;
    for (const family of [0, 1]) {
      if (famGrid[family].nearest(s, sp.majorSep * 0.8)) continue;
      if (trace(s, family, () => sp.majorSep, true, sp.majorKind(majorIndex)))
        majorIndex++;
    }
  }
  // Minor streets: denser seeding, spacing from local density.
  const minorSep = (p: Vec2) => sp.minorSep(sp.density(p[0], p[1]));
  const mseeds: Vec2[] = [];
  for (let z = -S; z < S; z += 30) {
    for (let x = -S; x < S; x += 30)
      mseeds.push([x + rng.range(0, 30), z + rng.range(0, 30)]);
  }
  for (let i = mseeds.length - 1; i > 0; i--) {
    const j = rng.int(0, i + 1);
    [mseeds[i], mseeds[j]] = [mseeds[j], mseeds[i]];
  }
  for (const s of mseeds) {
    if (!isLand(s)) continue;
    const sep = minorSep(s);
    for (const family of [0, 1]) {
      if (famGrid[family].nearest(s, sep * 0.9)) continue;
      if (allGrid.nearest(s, sep * 0.3)) continue;
      trace(
        s,
        family,
        minorSep,
        false,
        sp.minorKind(sp.density(s[0], s[1]), rng),
      );
    }
  }
  void clamp;
  return out;
}
