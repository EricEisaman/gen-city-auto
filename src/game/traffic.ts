// Traffic: cars follow lanes (driving on the left), obey the same signal
// timing the shaders display, keep distance with IDM, and pick turns at
// junctions. The player's car uses the same LaneFollower on autopilot.

import {mat4, type Mat4} from '../math/mat4.ts';
import {Rng} from '../math/random.ts';
import type {Vec2, Vec3} from '../math/vec.ts';
import type {VehicleRenderer} from '../render/vehicles.ts';
import {RoadNet, SPEED_LIMIT} from './roadnet.ts';

export interface LaneRef {
  chain: number;
  dir: 1 | -1;
  lane: number;
}

/**
 * A junction crossing: a cubic Bezier from the end of one lane to the start
 * of the next, tangent to both, sampled by arc length (positions are taken
 * on the curve itself, not on a chord polyline, so headings derived from
 * points along it turn continuously).
 */
interface Turn {
  ctrl: [Vec3, Vec3, Vec3, Vec3];
  /** Curve parameter and arc length at each table entry. */
  us: number[];
  cum: number[];
  len: number;
  /** Distance traveled along the curve (while driving it). */
  t: number;
  from: LaneRef;
  next: LaneRef;
  /** Comfortable speed through the tightest part of the curve (m/s). */
  vmax: number;
  /** Indicator to show (-1 right, 0 none, 1 left). */
  indicator: number;
}

/** Lateral acceleration allowed through junction curves (m/s^2). */
const TURN_LAT_ACC = 3;
/** Deceleration used to ease into an upcoming turn (m/s^2). */
const TURN_EASE_DEC = 1.6;

function bezier(c: Turn['ctrl'], u: number, m: number) {
  const v = 1 - u;
  return (
    v * v * v * c[0][m] +
    3 * v * v * u * c[1][m] +
    3 * v * u * u * c[2][m] +
    u * u * u * c[3][m]
  );
}

function turnPoint(tr: Turn, t: number): Vec3 {
  let lo = 0;
  let hi = tr.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr.cum[mid] <= t) lo = mid;
    else hi = mid;
  }
  const seg = tr.cum[hi] - tr.cum[lo] || 1;
  const f = (t - tr.cum[lo]) / seg;
  const u = tr.us[lo] + (tr.us[hi] - tr.us[lo]) * f;
  return [bezier(tr.ctrl, u, 0), bezier(tr.ctrl, u, 1), bezier(tr.ctrl, u, 2)];
}

export function modelMatrix(
  out: Mat4,
  p: Vec3,
  d: Vec2,
  slope: number,
  roll = 0,
) {
  const fl = Math.hypot(d[0], slope, d[1]) || 1;
  const f: Vec3 = [d[0] / fl, slope / fl, d[1] / fl];
  let r: Vec3 = [-d[1], 0, d[0]];
  const rl = Math.hypot(r[0], r[2]) || 1;
  r = [r[0] / rl, 0, r[2] / rl];
  let u: Vec3 = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];
  if (roll) {
    const c = Math.cos(roll),
      s = Math.sin(roll);
    const r2: Vec3 = [
      r[0] * c + u[0] * s,
      r[1] * c + u[1] * s,
      r[2] * c + u[2] * s,
    ];
    u = [u[0] * c - r[0] * s, u[1] * c - r[1] * s, u[2] * c - r[2] * s];
    r = r2;
  }
  out.set([
    r[0],
    r[1],
    r[2],
    0,
    u[0],
    u[1],
    u[2],
    0,
    f[0],
    f[1],
    f[2],
    0,
    p[0],
    p[1],
    p[2],
    1,
  ]);
  return out;
}

export class LaneFollower {
  ref: LaneRef;
  s: number;
  speed = 0;
  cruise: number;
  turn: Turn | null = null;
  /** The crossing at the end of the current lane, chosen on entering it. */
  private plan: Turn | null = null;
  /** The crossing just completed (the rear of the car may still be on it). */
  private last: Turn | null = null;
  pos: Vec3 = [0, 0, 0];
  dir: Vec2 = [0, 1];
  slope = 0;
  braking = false;
  indicator = 0;
  length: number;
  /** Front and rear axle positions along the body (vehicle-space z). */
  axleFront: number;
  axleRear: number;
  /** Prefer big roads (player autopilot sightseeing). */
  preferBig = false;
  leaderGap = Infinity;
  /** Seconds spent stopped (for breaking junction deadlocks). */
  stuck = 0;
  leaderSpeed = 0;
  private rng: Rng;

  constructor(
    ref: LaneRef,
    s: number,
    length: number,
    cruiseFactor: number,
    seed: number,
  ) {
    this.ref = ref;
    this.s = s;
    this.length = length;
    this.axleFront = length * 0.32;
    this.axleRear = -length * 0.32;
    this.cruise = cruiseFactor;
    this.rng = new Rng(seed);
  }

  /** Take the axle positions from a design's wheels. */
  setAxles(wheels: {position: Vec3}[]) {
    if (!wheels.length) return;
    const zs = wheels.map(w => w.position[2]);
    const f = Math.max(...zs);
    const r = Math.min(...zs);
    if (f - r > 0.5) {
      this.axleFront = f;
      this.axleRear = r;
    }
  }

  laneKey() {
    return this.turn
      ? -1
      : (this.ref.chain * 2 + (this.ref.dir > 0 ? 1 : 0)) * 8 + this.ref.lane;
  }

  sEnd(net: RoadNet) {
    const [s0, s1] = net.geom.setbacks[this.ref.chain];
    return net.length(this.ref.chain) - (this.ref.dir === 1 ? s1 : s0);
  }

  private pickExit(net: RoadNet): LaneRef {
    const endAt: 0 | 1 = this.ref.dir === 1 ? 1 : 0;
    const j = net.junctionAt(this.ref.chain, endAt);
    const exits = j >= 0 ? net.exits(j, this.ref.chain, endAt) : [];
    if (!exits.length)
      return {chain: this.ref.chain, dir: this.ref.dir === 1 ? -1 : 1, lane: 0};
    // Weight: straight ahead preferred, big roads preferred for sightseeing.
    const arrive: Vec2 = net.lanePos(
      this.ref.chain,
      this.ref.dir,
      this.ref.lane,
      this.sEnd(net),
    ).d;
    const weights = exits.map(a => {
      const c = net.chains[a.chain];
      const n = c.pts.length;
      const p0 = a.end === 0 ? c.pts[0] : c.pts[n - 1];
      const p1 =
        a.end === 0 ? c.pts[Math.min(2, n - 1)] : c.pts[Math.max(0, n - 3)];
      const dx = p1[0] - p0[0],
        dz = p1[1] - p0[1];
      const l = Math.hypot(dx, dz) || 1;
      const straight = (dx * arrive[0] + dz * arrive[1]) / l;
      const len = net.length(a.chain);
      let w = 0.4 + Math.max(0, straight) * 2.5;
      if (len < 15) w *= 0.3;
      if (this.preferBig)
        w *= 1 + c.kind * 1.5 + (c.bridge.some(b => b) ? 4 : 0);
      return w;
    });
    const a = this.rng.weighted(exits, weights);
    const dir: 1 | -1 = a.end === 0 ? 1 : -1;
    const lane = Math.min(this.ref.lane, net.lanesPerDir(a.chain) - 1);
    return {chain: a.chain, dir, lane};
  }

  /** Lane start (just past the junction setback) for a lane ref. */
  private static sStartOf(net: RoadNet, ref: LaneRef) {
    const [s0, s1] = net.geom.setbacks[ref.chain];
    return ref.dir === 1 ? s0 : s1;
  }

  private static sEndOf(net: RoadNet, ref: LaneRef) {
    const [s0, s1] = net.geom.setbacks[ref.chain];
    return net.length(ref.chain) - (ref.dir === 1 ? s1 : s0);
  }

  /** Plan the crossing at the end of the current lane. */
  private planTurn(net: RoadNet): Turn {
    const from = {...this.ref};
    const next = this.pickExit(net);
    const a = net.lanePos(from.chain, from.dir, from.lane, this.sEnd(net));
    const b = net.lanePos(
      next.chain,
      next.dir,
      next.lane,
      LaneFollower.sStartOf(net, next),
    );
    const dist = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]);
    // Handle length of a circular arc through the turn angle (0.39 chord for
    // a right angle, 2/3 for a U-turn; at least 0.4 so straight crossings
    // with a lane shift stay gentle): a near-constant radius, no tight kink.
    const cos = Math.max(-1, Math.min(1, a.d[0] * b.d[0] + a.d[1] * b.d[1]));
    const th = Math.acos(cos);
    const ratio =
      th < 1e-3 ? 1 / 3 : ((4 / 3) * Math.tan(th / 4)) / (2 * Math.sin(th / 2));
    const k = Math.max(1, dist * Math.max(0.4, ratio));
    const ctrl: Turn['ctrl'] = [
      a.p,
      [a.p[0] + a.d[0] * k, a.p[1], a.p[2] + a.d[1] * k],
      [b.p[0] - b.d[0] * k, b.p[1], b.p[2] - b.d[1] * k],
      b.p,
    ];
    const N = 32;
    const us = [0];
    const cum = [0];
    let prev = a.p;
    for (let i = 1; i <= N; i++) {
      const u = i / N;
      const q: Vec3 = [
        bezier(ctrl, u, 0),
        bezier(ctrl, u, 1),
        bezier(ctrl, u, 2),
      ];
      us.push(u);
      cum.push(cum[i - 1] + Math.hypot(q[0] - prev[0], q[2] - prev[2]));
      prev = q;
    }
    // Peak curvature |B' x B''| / |B'|^3 (in plan) sets the turn speed.
    let kmax = 0;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const v = 1 - u;
      const d1 = [0, 2].map(
        m =>
          3 * v * v * (ctrl[1][m] - ctrl[0][m]) +
          6 * v * u * (ctrl[2][m] - ctrl[1][m]) +
          3 * u * u * (ctrl[3][m] - ctrl[2][m]),
      );
      const d2 = [0, 2].map(
        m =>
          6 * v * (ctrl[2][m] - 2 * ctrl[1][m] + ctrl[0][m]) +
          6 * u * (ctrl[3][m] - 2 * ctrl[2][m] + ctrl[1][m]),
      );
      const sp = Math.hypot(d1[0], d1[1]);
      if (sp > 1e-6)
        kmax = Math.max(
          kmax,
          Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) / (sp * sp * sp),
        );
    }
    const cross = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    return {
      ctrl,
      us,
      cum,
      len: cum[N],
      t: 0,
      from,
      next,
      vmax: Math.max(3, Math.sqrt(TURN_LAT_ACC / Math.max(kmax, 1e-4))),
      indicator: Math.abs(cross) > 0.4 ? (cross > 0 ? 1 : -1) : 0,
    };
  }

  private ensurePlan(net: RoadNet) {
    if (!this.turn && !this.plan) this.plan = this.planTurn(net);
  }

  private startTurn(net: RoadNet) {
    this.ensurePlan(net);
    this.turn = this.plan;
    this.plan = null;
    this.last = null;
    this.indicator = this.turn!.indicator;
  }

  /** Distance to the stop line ahead if the signal says stop, else Infinity. */
  private stopDistance(net: RoadNet, time: number) {
    if (this.turn) return Infinity;
    const endAt: 0 | 1 = this.ref.dir === 1 ? 1 : 0;
    const j = net.junctionAt(this.ref.chain, endAt);
    if (j < 0) return Infinity;
    const state = net.signalFor(j, this.ref.chain, endAt, time);
    if (state === 0) return Infinity;
    const d = this.sEnd(net) - 1.5 - this.s;
    // On yellow, go if we cannot stop comfortably.
    if (state === 1 && d < (this.speed * this.speed) / (2 * 3.5))
      return Infinity;
    return d < -1 ? Infinity : d;
  }

  update(
    dt: number,
    net: RoadNet,
    time: number,
    gapToLeader: number,
    leaderSpeed: number,
  ) {
    this.ensurePlan(net);
    const kind = net.chains[this.ref.chain].kind;
    const limit = SPEED_LIMIT[kind] * this.cruise;
    // Ease into junction curves: the speed target follows a braking envelope
    // down to the curve's comfortable speed (set by its tightest radius).
    let v0 = limit;
    if (this.turn) v0 = Math.min(limit * 0.85, this.turn.vmax);
    else if (this.plan) {
      const vt = Math.min(limit * 0.85, this.plan.vmax);
      const d = Math.max(0, this.sEnd(net) - this.s);
      v0 = Math.min(limit, Math.sqrt(vt * vt + 2 * TURN_EASE_DEC * d));
      if (d < 30) this.indicator = this.plan.indicator;
    }
    // Likewise for sharp bends along the lane (rounded polyline corners),
    // judged on this lane's radius (inside or outside of the bend alike).
    if (!this.turn) {
      const total = net.length(this.ref.chain);
      const off = net.laneOffset(this.ref.chain, this.ref.lane);
      for (const cn of net.corners(this.ref.chain)) {
        const d = (this.ref.dir === 1 ? cn.a : total - cn.a) - this.s;
        if (d < -cn.r || d > 80) continue;
        const R = Math.max(1.5, 1 / cn.k - off);
        const vc = Math.sqrt(TURN_LAT_ACC * R);
        const ahead = Math.max(0, d - cn.r);
        v0 = Math.min(v0, Math.sqrt(vc * vc + 2 * TURN_EASE_DEC * ahead));
      }
    }
    // Intelligent Driver Model.
    const a = 2.2;
    const b = 3.5;
    const T = 1.3;
    const s0 = 2.5;
    let gap = gapToLeader;
    let dv = this.speed - leaderSpeed;
    const stop = this.stopDistance(net, time);
    if (stop < gap) {
      gap = stop;
      dv = this.speed;
    }
    const sStar =
      s0 +
      Math.max(0, this.speed * T + (this.speed * dv) / (2 * Math.sqrt(a * b)));
    let acc = a * (1 - Math.pow(this.speed / Math.max(v0, 0.1), 4));
    if (gap < 200) acc -= a * Math.pow(sStar / Math.max(gap, 0.1), 2);
    acc = Math.max(acc, -9);
    this.braking = acc < -0.8 || (this.speed < 0.5 && gap < 20);
    this.speed = Math.max(0, this.speed + acc * dt);
    const step = this.speed * dt;
    if (this.turn) {
      this.turn.t += step;
      if (this.turn.t >= this.turn.len) {
        const over = this.turn.t - this.turn.len;
        const nx = this.turn.next;
        this.ref = nx;
        this.s = LaneFollower.sStartOf(net, nx) + over;
        this.last = this.turn;
        this.turn = null;
        this.indicator = 0;
        this.ensurePlan(net);
      }
    } else {
      this.s += step;
      if (this.s >= this.sEnd(net)) this.startTurn(net);
    }
    this.place(net, dt);
  }

  /**
   * Position on a lane at distance s, continuing straight along the end
   * tangent past either end of the chain.
   */
  private static laneAt(net: RoadNet, ref: LaneRef, want: number): Vec3 {
    const len = net.length(ref.chain);
    const s = Math.max(0, Math.min(len, want));
    const q = net.lanePos(ref.chain, ref.dir, ref.lane, s);
    const over = want - s;
    if (over === 0) return q.p;
    return [q.p[0] + q.d[0] * over, q.p[1], q.p[2] + q.d[1] * over];
  }

  /** Position at distance t along a crossing, continuing onto its lanes. */
  private static crossingAt(net: RoadNet, tr: Turn, t: number): Vec3 {
    if (t < 0)
      return LaneFollower.laneAt(
        net,
        tr.from,
        LaneFollower.sEndOf(net, tr.from) + t,
      );
    if (t > tr.len)
      return LaneFollower.laneAt(
        net,
        tr.next,
        LaneFollower.sStartOf(net, tr.next) + t - tr.len,
      );
    return turnPoint(tr, t);
  }

  /**
   * Position at path distance `ahead` from the current point along the whole
   * route: the previous crossing, the current lane, the planned crossing and
   * the lane after it. Points ahead/behind (axles, heading) therefore stay on
   * the path the car will actually drive and never jump when a turn starts
   * or ends.
   */
  private pointAt(net: RoadNet, ahead: number): Vec3 {
    if (this.turn)
      return LaneFollower.crossingAt(net, this.turn, this.turn.t + ahead);
    const want = this.s + ahead;
    const sEnd = this.sEnd(net);
    if (this.plan && want > sEnd)
      return LaneFollower.crossingAt(net, this.plan, want - sEnd);
    const sStart = LaneFollower.sStartOf(net, this.ref);
    if (this.last && want < sStart)
      return LaneFollower.crossingAt(
        net,
        this.last,
        this.last.len + want - sStart,
      );
    return LaneFollower.laneAt(net, this.ref, want);
  }

  place(net: RoadNet, dt = Infinity) {
    this.ensurePlan(net);
    this.pos = this.pointAt(net, 0);
    // Both axles' points on the path (they stay on the lane through turns).
    const zf = this.axleFront;
    const zr = this.axleRear;
    const qf = this.pointAt(net, zf);
    const qr = this.pointAt(net, zr);
    // Heading from rear to front axle: smooth through vertices and around
    // junction curves.
    const dx = qf[0] - qr[0];
    const dz = qf[2] - qr[2];
    if (Math.hypot(dx, dz) > 1e-3) {
      // Rate-limit heading changes so tight junction curves never pop.
      const want = Math.atan2(dx, dz);
      const cur = Math.atan2(this.dir[0], this.dir[1]);
      let delta = want - cur;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      const maxStep = 5 * dt;
      const yaw = cur + Math.max(-maxStep, Math.min(maxStep, delta));
      this.dir = [Math.sin(yaw), Math.cos(yaw)];
    }
    // Sit on the rendered surface at both axles: pitch is the line between
    // the front and rear contact heights and the body origin lies on it, so
    // cars ease over grade changes, junction plates and bridge ends instead
    // of snapping to the grade under their center.
    // Between the junction setbacks the lane height is the road mesh's own
    // grade; near and in junctions (flat plates) ask the surface, falling
    // back to the path when that lands on another road (a bridge over this
    // one, an overlapping chain) or off the asphalt.
    const [s0, s1] = net.geom.setbacks[this.ref.chain];
    const sLo = this.ref.dir === 1 ? s0 : s1;
    const sHi = this.sEnd(net);
    const contact = (q: Vec3, k: number) => {
      const s = this.s + k;
      if (!this.turn && s > sLo && s < sHi) return q[1] - 0.01;
      const h = net.surfaceHeight(q[0], q[2], q[1]);
      return Math.abs(h - q[1]) < 0.5 ? h : q[1];
    };
    const hf = contact(qf, zf);
    const hr = contact(qr, zr);
    const want = (hf - hr) / (zf - zr);
    if (dt === Infinity) this.slope = want;
    else {
      // Suspension-like easing with a rate cap (steep junction plates and
      // bridge ends meet the road grade with a kink or a small step).
      const step = (want - this.slope) * (1 - Math.exp(-dt * 12));
      const cap = 1.5 * dt;
      this.slope += Math.max(-cap, Math.min(cap, step));
    }
    // Origin on the axle line, using the eased pitch through their midpoint.
    const zm = (zf + zr) / 2;
    this.pos[1] = (hf + hr) / 2 - this.slope * zm + 0.01;
  }
}

/** Neighbour grid cell size (m). */
const CELL = 32;

interface Car {
  f: LaneFollower;
  variant: number;
  color: Vec3;
  metallic: number;
  color2: Vec3;
  model: Mat4;
  prev: Mat4;
  spin: number;
  radius: number;
}

export class Traffic {
  cars: Car[] = [];
  target = 240;
  radius = 360;
  private rng = new Rng(4242);
  private net: RoadNet;
  private vr: VehicleRenderer;
  private pools: {variants: number[]; weight: number; cruise: number}[] = [];
  /** Neighbour grid (cell key -> indices into update()'s `all`). */
  private grid = new Map<number, number[]>();

  constructor(net: RoadNet, vr: VehicleRenderer) {
    this.net = net;
    this.vr = vr;
    const kinds: [string, number, number][] = [
      ['car', 6, 1],
      ['taxi', 3, 1],
      ['van', 1.4, 0.92],
      ['truck', 1.0, 0.8],
      ['bus', 0.7, 0.75],
    ];
    for (const [k, w, c] of kinds) {
      const v = vr.variantsOf(k);
      if (v.length) this.pools.push({variants: v, weight: w, cruise: c});
    }
    if (!this.pools.length) {
      const any = vr.variants
        .map((_, i) => i)
        .filter(
          i =>
            !['helicopter', 'train', 'person'].includes(
              vr.variants[i].info.kind,
            ),
        );
      if (any.length) this.pools.push({variants: any, weight: 1, cruise: 1});
    }
  }

  private spawn(focus: Vec3, minDist: number) {
    if (!this.pools.length) return;
    const r = this.rng;
    const loc = this.net.randomLaneNear(focus[0], focus[2], this.radius, () =>
      r.next(),
    );
    if (!loc) return;
    const pool = r.weighted(
      this.pools,
      this.pools.map(p => p.weight),
    );
    const variant = r.pick(pool.variants);
    const info = this.vr.variants[variant].info;
    const f = new LaneFollower(
      {chain: loc.chain, dir: loc.dir, lane: loc.lane},
      loc.s,
      info.size[2],
      pool.cruise * r.range(0.85, 1.1),
      r.nextU32(),
    );
    f.setAxles(info.wheels);
    f.place(this.net);
    if (Math.hypot(f.pos[0] - focus[0], f.pos[2] - focus[2]) < minDist) return;
    // Don't spawn on top of another car.
    for (const c of this.cars)
      if (Math.hypot(c.f.pos[0] - f.pos[0], c.f.pos[2] - f.pos[2]) < 8) return;
    f.speed = SPEED_LIMIT[this.net.chains[loc.chain].kind] * 0.6;
    const color = r.pick(info.palette);
    const model = modelMatrix(mat4.create(), f.pos, f.dir, f.slope);
    this.cars.push({
      f,
      variant,
      color,
      metallic: r.chance(0.55) ? 0.6 : 0.0,
      color2:
        info.kind === 'taxi' || info.kind === 'bus'
          ? info.palette[
              (info.palette.indexOf(color) + 1) % info.palette.length
            ]
          : color,
      model,
      prev: mat4.copy(mat4.create(), model),
      spin: 0,
      radius: info.wheels[0]?.radius ?? 0.33,
    });
  }

  update(dt: number, time: number, focus: Vec3, extra: LaneFollower[] = []) {
    // Despawn far cars, spawn new ones (out of the camera's immediate area).
    this.cars = this.cars
      .filter(c => c.f.stuck < 1e8)
      .filter(
        c =>
          Math.hypot(c.f.pos[0] - focus[0], c.f.pos[2] - focus[2]) <
          this.radius + 100,
      );
    for (let k = 0; k < 6 && this.cars.length < this.target; k++)
      this.spawn(focus, this.cars.length < this.target * 0.5 ? 30 : 120);
    // Group by lane for leader lookup.
    const lanes = new Map<number, LaneFollower[]>();
    const all = [...this.cars.map(c => c.f), ...extra];
    for (const f of all) {
      const k = f.laneKey();
      if (k < 0) continue;
      let l = lanes.get(k);
      if (!l) lanes.set(k, (l = []));
      l.push(f);
    }
    const laneIndex = new Map<LaneFollower, number>();
    for (const l of lanes.values()) {
      l.sort((a, b) => a.s - b.s);
      l.forEach((f, i) => laneIndex.set(f, i));
    }
    // Uniform grid over the followers' positions for the "anything directly
    // ahead" test (was a scan over every car for every car). Cells are kept
    // current as cars move during the update loop below, so the candidates
    // are exactly those of the full scan; ties keep the full scan's
    // winner (the lane leader, then the lowest index in `all`).
    const grid = this.grid;
    grid.clear();
    const cellOf = (f: LaneFollower) =>
      (Math.floor(f.pos[0] / CELL) + 4096) * 8192 +
      (Math.floor(f.pos[2] / CELL) + 4096);
    const cells = all.map(cellOf);
    cells.forEach((k, i) => {
      let c = grid.get(k);
      if (!c) grid.set(k, (c = []));
      c.push(i);
    });
    const leaderOf = (f: LaneFollower, fi: number): [number, number] => {
      let gap = Infinity;
      let lv = 0;
      let best = -1;
      const k = f.laneKey();
      if (k >= 0) {
        const l = lanes.get(k)!;
        const i = laneIndex.get(f)!;
        if (i + 1 < l.length) {
          const ld = l[i + 1];
          gap = ld.s - f.s - (ld.length + f.length) / 2;
          lv = ld.speed;
        }
      }
      // Anything directly ahead (junctions, merging cars, the player).
      const fx = f.pos[0];
      const fz = f.pos[2];
      const x0 = Math.floor((fx - 30) / CELL) + 4096;
      const x1 = Math.floor((fx + 30) / CELL) + 4096;
      const z0 = Math.floor((fz - 30) / CELL) + 4096;
      const z1 = Math.floor((fz + 30) / CELL) + 4096;
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const cell = grid.get(cx * 8192 + cz);
          if (!cell) continue;
          for (const oi of cell) {
            if (oi === fi) continue;
            const o = all[oi];
            const dx = o.pos[0] - fx;
            const dz = o.pos[2] - fz;
            if (Math.abs(dx) > 30 || Math.abs(dz) > 30) continue;
            const ahead = dx * f.dir[0] + dz * f.dir[1];
            if (
              ahead > 0 &&
              ahead < 25 &&
              Math.abs(dx * f.dir[1] - dz * f.dir[0]) < 1.9 &&
              (o.dir[0] * f.dir[0] + o.dir[1] * f.dir[1] > 0.3 ||
                f.turn ||
                o.turn)
            ) {
              const g = ahead - (o.length + f.length) / 2;
              if (g < gap || (g === gap && best >= 0 && oi < best)) {
                gap = g;
                lv = o.speed;
                best = oi;
              }
            }
          }
        }
      return [gap, lv];
    };
    const nCars = this.cars.length;
    extra.forEach(
      (f, i) => ([f.leaderGap, f.leaderSpeed] = leaderOf(f, nCars + i)),
    );
    for (let ci = 0; ci < nCars; ci++) {
      const c = this.cars[ci];
      const f = c.f;
      let [gap, lv] = leaderOf(f, ci);
      // Deadlock breaker: after waiting a while at a junction, creep forward
      // ignoring crossing traffic (lane leaders and signals still apply).
      f.stuck = f.speed < 0.3 ? f.stuck + dt : 0;
      if (f.stuck > 4 && (f.turn || gap < 6)) {
        const k = f.laneKey();
        if (f.turn || k < 0) {
          gap = Infinity;
          lv = 0;
        }
      }
      if (f.stuck > 40) {
        // Hopelessly stuck: despawn next frame.
        f.stuck = 1e9;
        continue;
      }
      f.update(dt, this.net, time, gap, lv);
      // Keep the grid current.
      const cell = cellOf(f);
      if (cell !== cells[ci]) {
        const from = grid.get(cells[ci])!;
        from.splice(from.indexOf(ci), 1);
        let to = grid.get(cell);
        if (!to) grid.set(cell, (to = []));
        to.push(ci);
        cells[ci] = cell;
      }
      c.prev.set(c.model);
      modelMatrix(c.model, f.pos, f.dir, f.slope);
      c.spin += (f.speed * dt) / c.radius;
    }
  }

  draw(lights: number) {
    for (const c of this.cars) {
      this.vr.add({
        variant: c.variant,
        model: c.model,
        prevModel: c.prev,
        color: c.color,
        metallic: c.metallic,
        color2: c.color2,
        lights,
        brake: c.f.braking ? 1 : 0,
        indicator: c.f.indicator,
        wheelSpin: c.spin,
        steer: c.f.turn ? c.f.indicator * 0.3 : 0,
        rotor: 0,
      });
    }
  }
}
