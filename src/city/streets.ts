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
  /**
   * Least distance between the centrelines of two roads of these kinds
   * running alongside each other (carriageways, sidewalks and a margin).
   */
  clearance: (a: number, b: number) => number;
  /** Roads laid out before (the ring road), which every line keeps clear of. */
  fixed?: Polyline[];
}

/** Highest road kind (boulevard). */
const MAX_KIND = 3;
/**
 * A road within this angle of another (either way) runs alongside it, or
 * merges into it, rather than crossing it.
 */
const PARALLEL = (35 * Math.PI) / 180;
/**
 * A line that turns back by more than acos(-HAIRPIN_TURN) within
 * HAIRPIN_RUN clearances of road, coming within HAIRPIN_GAP clearances of
 * itself, is a hairpin: it stops where the turn began.
 */
const HAIRPIN_RUN = 3;
const HAIRPIN_TURN = -0.5;
const HAIRPIN_GAP = 1.5;
/** Candidate road points a loose end tries to join, nearest first. */
const JOIN_TRIES = 6;
/** Least angle at which a loose end is joined into another road. */
const JOIN_ANGLE = (40 * Math.PI) / 180;

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

interface GridPoint {
  p: Vec2;
  line: number;
  /** Unit direction of the road through p. */
  d: Vec2;
  kind: number;
}

class PointGrid {
  private cells = new Map<number, GridPoint[]>();
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

  add(q: GridPoint) {
    const k = this.key(q.p[0], q.p[1]);
    let l = this.cells.get(k);
    if (!l) this.cells.set(k, (l = []));
    l.push(q);
  }

  /** Nearest point within r, optionally ignoring one line. */
  nearest(p: Vec2, r: number, ignore = -1): (GridPoint & {d2: number}) | null {
    return this.find(p, r, q => q.line !== ignore);
  }

  /** Every point within r that passes `ok`, nearest first. */
  within(p: Vec2, r: number, ok: (q: GridPoint) => boolean): GridPoint[] {
    const n = Math.ceil(r / this.cell);
    const cx = Math.floor(p[0] / this.cell);
    const cz = Math.floor(p[1] / this.cell);
    const out: {q: GridPoint; d: number}[] = [];
    for (let dz = -n; dz <= n; dz++)
      for (let dx = -n; dx <= n; dx++)
        for (const q of this.cells.get(
          (cz + dz + 2000) * 4096 + cx + dx + 2000,
        ) ?? []) {
          const d = Math.hypot(q.p[0] - p[0], q.p[1] - p[1]);
          if (d < r && ok(q)) out.push({q, d});
        }
    // Ties by position, so the order does not depend on the grid's.
    out.sort((a, b) => a.d - b.d || a.q.p[0] - b.q.p[0] || a.q.p[1] - b.q.p[1]);
    return out.map(o => o.q);
  }

  /** Nearest point within r that passes `ok` (d2: its distance). */
  find(
    p: Vec2,
    r: number,
    ok: (q: GridPoint, dist: number) => boolean,
  ): (GridPoint & {d2: number}) | null {
    const n = Math.ceil(r / this.cell);
    const cx = Math.floor(p[0] / this.cell);
    const cz = Math.floor(p[1] / this.cell);
    let best: GridPoint | null = null;
    let bd = r;
    // Squared distance clearly beyond bd: skip the exact distance.
    let far2 = r * r * (1 + 1e-9);
    for (let dz = -n; dz <= n; dz++) {
      for (let dx = -n; dx <= n; dx++) {
        for (const q of this.cells.get(
          (cz + dz + 2000) * 4096 + cx + dx + 2000,
        ) ?? []) {
          const ex = q.p[0] - p[0];
          const ez = q.p[1] - p[1];
          if (ex * ex + ez * ez > far2) continue;
          const d = Math.hypot(ex, ez);
          if (d < bd && ok(q, d)) {
            best = q;
            bd = d;
            far2 = d * d * (1 + 1e-9);
          }
        }
      }
    }
    return best && {...best, d2: bd};
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

  const unit = (v: Vec2): Vec2 => {
    const l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
  };
  /** Roads already laid out (the ring road): every line keeps clear. */
  for (const f of sp.fixed ?? []) {
    const id = lineId++;
    f.pts.forEach((q, i) => {
      const a = f.pts[Math.max(0, i - 1)];
      const b = f.pts[Math.min(f.pts.length - 1, i + 1)];
      allGrid.add({
        p: q,
        line: id,
        d: unit([b[0] - a[0], b[1] - a[1]]),
        kind: f.kind,
      });
    });
  }
  const cosParallel = Math.cos(PARALLEL);
  /**
   * The nearest road point (not of line `id`) within the clearance of a
   * road of `kind` at p running within PARALLEL of `d`: one this road would
   * run alongside or merge into.
   */
  const alongside = (p: Vec2, d: Vec2, kind: number, id: number) =>
    allGrid.find(
      p,
      sp.clearance(kind, MAX_KIND),
      (q, dist) =>
        q.line !== id &&
        dist < sp.clearance(kind, q.kind) &&
        Math.abs(q.d[0] * d[0] + q.d[1] * d[1]) > cosParallel,
    );

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
    const ends: {p: Vec2; d: Vec2; s: number}[] = [];
    // This line's own points so far, by distance along it from the start
    // (`line`: negative on the second half).
    const own = new PointGrid(40);
    const selfClear = sp.clearance(kind, kind);
    // How far each half reaches (a hairpin cut off shortens it): own points
    // beyond are gone.
    const reach = [Infinity, Infinity];
    const live = (o: GridPoint) =>
      o.line >= 0 ? o.line <= reach[0] : -o.line <= reach[1];
    for (const sign of [1, -1]) {
      const pts: Vec2[] = [];
      let p = start;
      const d0 = eigen(field, p, family);
      if (!d0) return false;
      const d1: Vec2 = [d0[0] * sign, d0[1] * sign];
      let dir = d1;
      if (sign > 0) own.add({p: start, line: 0, d: dir, kind});
      let s = 0;
      // Distance along and direction at each of pts.
      const at: number[] = [];
      const dirs: Vec2[] = [];
      const push = (q: Vec2, d: Vec2) => {
        s += Math.hypot(q[0] - p[0], q[1] - p[1]);
        pts.push(q);
        at.push(s);
        dirs.push(d);
        own.add({p: q, line: s * sign, d, kind});
        p = q;
        dir = d;
      };
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
          const p0 = p;
          for (let k = 1; k <= landAt; k++)
            push([p0[0] + k2[0] * step * k, p0[1] + k2[1] * step * k], k2);
          continue;
        }
        // Too close to a parallel road of the same family: stop (and join).
        const sp0 = sep(np);
        if (i > 0 && famGrid[family].nearest(np, sp0 * 0.5, id)) break;
        // A hairpin round a spur (turned back within HAIRPIN_RUN
        // clearances, its legs closer than HAIRPIN_GAP) goes, from where it
        // began to turn.
        const sNew = s + step;
        let m = pts.length - 1;
        while (m >= 0 && at[m] > sNew - HAIRPIN_RUN * selfClear) m--;
        const pm = m >= 0 ? pts[m] : start;
        const dm = m >= 0 ? dirs[m] : d1;
        if (
          (m >= 0 || sNew >= HAIRPIN_RUN * selfClear) &&
          dm[0] * k2[0] + dm[1] * k2[1] < HAIRPIN_TURN &&
          Math.hypot(np[0] - pm[0], np[1] - pm[1]) < HAIRPIN_GAP * selfClear
        ) {
          pts.length = at.length = dirs.length = m + 1;
          s = m >= 0 ? at[m] : 0;
          p = pm;
          dir = dm;
          reach[sign > 0 ? 0 : 1] = s;
          break;
        }
        // Nor does it come back alongside its own earlier part (a contour
        // round a hill): any point closer than a third of the way back along
        // the line, within the family spacing.
        if (
          own.find(
            np,
            sp0 * 0.5,
            (q, dist) =>
              live(q) &&
              Math.abs(q.line - sNew * sign) > 3 * Math.max(dist, selfClear),
          )
        )
          break;
        // Or running alongside (or merging into) any other road.
        if (alongside(np, k2, kind, id)) break;
        // Self-intersection / loop guard.
        if (
          i > 20 &&
          Math.hypot(np[0] - start[0], np[1] - start[1]) < step * 1.5
        )
          break;
        push(np, k2);
      }
      halves.push(pts);
      ends.push({p, d: dir, s: s * sign});
    }
    const line: Vec2[] = [...halves[1].slice().reverse(), start, ...halves[0]];
    let len = 0;
    for (let i = 1; i < line.length; i++)
      len += Math.hypot(
        line[i][0] - line[i - 1][0],
        line[i][1] - line[i - 1][1],
      );
    if (len < (major ? 200 : 40)) return false;
    // Join loose ends to the nearest road ahead so streets don't dead-end:
    // at a junction (not a shallow merge, JOIN_ANGLE or more off the other
    // road), along a link that runs alongside no other road.
    const joinR = major ? sp.majorSep * 0.6 : 60;
    const cosJoin = Math.cos(JOIN_ANGLE);
    const tryJoin = (end: {p: Vec2; d: Vec2; s: number}, atStart: boolean) => {
      const probe: Vec2 = [
        end.p[0] + end.d[0] * joinR * 0.5,
        end.p[1] + end.d[1] * joinR * 0.5,
      ];
      const cands = allGrid.within(probe, joinR, q => {
        if (q.line === id) return false;
        const v = unit([q.p[0] - end.p[0], q.p[1] - end.p[1]]);
        return (
          v[0] * end.d[0] + v[1] * end.d[1] >= 0.3 &&
          Math.abs(v[0] * q.d[0] + v[1] * q.d[1]) < cosJoin
        );
      });
      const ok = (cand: Vec2) => {
        const v: Vec2 = [cand[0] - end.p[0], cand[1] - end.p[1]];
        const vl = Math.hypot(v[0], v[1]) || 1;
        const vd: Vec2 = [v[0] / vl, v[1] / vl];
        // Don't join across water.
        for (let t = 0.25; t < 1; t += 0.25)
          if (!isLand([end.p[0] + v[0] * t, end.p[1] + v[1] * t])) return false;
        for (let t = 0; t < vl; t += step) {
          const q: Vec2 = [end.p[0] + vd[0] * t, end.p[1] + vd[1] * t];
          if (alongside(q, vd, kind, id)) return false;
          // Nor back alongside this line.
          if (
            own.find(
              q,
              selfClear,
              o =>
                live(o) &&
                Math.abs(o.line - end.s) > 3 * selfClear &&
                Math.abs(o.d[0] * vd[0] + o.d[1] * vd[1]) > cosParallel,
            )
          )
            return false;
        }
        return true;
      };
      // The nearest few (some way apart) in turn.
      const tried: Vec2[] = [];
      for (const c of cands) {
        if (tried.length >= JOIN_TRIES) return;
        if (
          tried.some(t => Math.hypot(t[0] - c.p[0], t[1] - c.p[1]) < step * 2)
        )
          continue;
        tried.push(c.p);
        if (!ok(c.p)) continue;
        const v: Vec2 = [c.p[0] - end.p[0], c.p[1] - end.p[1]];
        const vl = Math.hypot(v[0], v[1]) || 1;
        const vd: Vec2 = [v[0] / vl, v[1] / vl];
        // Overshoot a little so the joint is an actual crossing for
        // planarize. Points every step along the link, so later lines keep
        // clear of it.
        const link: Vec2[] = [];
        const n = Math.ceil((vl + 2) / step);
        for (let k = 1; k <= n; k++) {
          const t = ((vl + 2) * k) / n;
          link.push([end.p[0] + vd[0] * t, end.p[1] + vd[1] * t]);
        }
        if (atStart) line.unshift(...link.reverse());
        else line.push(...link);
        return;
      }
    };
    tryJoin(ends[0], false);
    tryJoin(ends[1], true);
    line.forEach((q, i) => {
      const a = line[Math.max(0, i - 1)];
      const b = line[Math.min(line.length - 1, i + 1)];
      const g = {p: q, line: id, d: unit([b[0] - a[0], b[1] - a[1]]), kind};
      famGrid[family].add(g);
      allGrid.add(g);
    });
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
