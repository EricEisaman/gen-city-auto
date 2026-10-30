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

interface Turn {
  pts: Vec3[];
  cum: number[];
  len: number;
  t: number;
  next: LaneRef;
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
    const arrive: Vec2 = this.dir;
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

  private startTurn(net: RoadNet) {
    const next = this.pickExit(net);
    const a = net.lanePos(
      this.ref.chain,
      this.ref.dir,
      this.ref.lane,
      this.sEnd(net),
    );
    const [n0, n1] = net.geom.setbacks[next.chain];
    const sStart = next.dir === 1 ? n0 : n1;
    const b = net.lanePos(next.chain, next.dir, next.lane, sStart);
    const dist = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]);
    const k = Math.max(1, dist * 0.45);
    const c1: Vec3 = [a.p[0] + a.d[0] * k, a.p[1], a.p[2] + a.d[1] * k];
    const c2: Vec3 = [b.p[0] - b.d[0] * k, b.p[1], b.p[2] - b.d[1] * k];
    const pts: Vec3[] = [];
    const N = 24;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const u = 1 - t;
      pts.push(
        [0, 1, 2].map(
          m =>
            u * u * u * a.p[m] +
            3 * u * u * t * c1[m] +
            3 * u * t * t * c2[m] +
            t * t * t * b.p[m],
        ) as Vec3,
      );
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++)
      cum.push(
        cum[i - 1] +
          Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]),
      );
    // Indicator for turns.
    const cross = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    this.indicator = Math.abs(cross) > 0.4 ? (cross > 0 ? 1 : -1) : 0;
    this.turn = {pts, cum, len: cum[cum.length - 1], t: 0, next};
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
    const kind = net.chains[this.ref.chain].kind;
    const v0 = SPEED_LIMIT[kind] * this.cruise * (this.turn ? 0.55 : 1);
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
        const [n0, n1] = net.geom.setbacks[nx.chain];
        this.ref = nx;
        this.s = (nx.dir === 1 ? n0 : n1) + over;
        this.turn = null;
        this.indicator = 0;
      }
    } else {
      this.s += step;
      if (this.s >= this.sEnd(net)) this.startTurn(net);
    }
    this.place(net, dt);
  }

  /**
   * Position at path distance `ahead` from the current point. Past either end
   * of the current lane or turn it continues straight along the end tangent,
   * so points ahead/behind (axles, heading) move smoothly.
   */
  private pointAt(net: RoadNet, ahead: number): Vec3 {
    if (this.turn) {
      const tr = this.turn;
      const t = tr.t + ahead;
      let i = 1;
      while (i < tr.cum.length - 1 && tr.cum[i] < t) i++;
      const seg = tr.cum[i] - tr.cum[i - 1] || 1;
      const f = (t - tr.cum[i - 1]) / seg;
      const p = tr.pts[i - 1];
      const q = tr.pts[i];
      return [
        p[0] + (q[0] - p[0]) * f,
        p[1] + (q[1] - p[1]) * f,
        p[2] + (q[2] - p[2]) * f,
      ];
    }
    const len = net.length(this.ref.chain);
    const want = this.s + ahead;
    const s = Math.max(0, Math.min(len, want));
    const q = net.lanePos(this.ref.chain, this.ref.dir, this.ref.lane, s);
    const over = want - s;
    if (over === 0) return q.p;
    return [q.p[0] + q.d[0] * over, q.p[1], q.p[2] + q.d[1] * over];
  }

  place(net: RoadNet, dt = Infinity) {
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
    for (const l of lanes.values()) l.sort((a, b) => a.s - b.s);
    const leaderOf = (f: LaneFollower): [number, number] => {
      let gap = Infinity;
      let lv = 0;
      const k = f.laneKey();
      if (k >= 0) {
        const l = lanes.get(k)!;
        const i = l.indexOf(f);
        if (i + 1 < l.length) {
          const ld = l[i + 1];
          gap = ld.s - f.s - (ld.length + f.length) / 2;
          lv = ld.speed;
        }
      }
      // Anything directly ahead (junctions, merging cars, the player).
      for (const o of all) {
        if (o === f) continue;
        const dx = o.pos[0] - f.pos[0];
        const dz = o.pos[2] - f.pos[2];
        if (Math.abs(dx) > 30 || Math.abs(dz) > 30) continue;
        const ahead = dx * f.dir[0] + dz * f.dir[1];
        if (
          ahead > 0 &&
          ahead < 25 &&
          Math.abs(dx * f.dir[1] - dz * f.dir[0]) < 1.9 &&
          (o.dir[0] * f.dir[0] + o.dir[1] * f.dir[1] > 0.3 || f.turn || o.turn)
        ) {
          const g = ahead - (o.length + f.length) / 2;
          if (g < gap) {
            gap = g;
            lv = o.speed;
          }
        }
      }
      return [gap, lv];
    };
    for (const f of extra) [f.leaderGap, f.leaderSpeed] = leaderOf(f);
    for (const c of this.cars) {
      const f = c.f;
      let [gap, lv] = leaderOf(f);
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
