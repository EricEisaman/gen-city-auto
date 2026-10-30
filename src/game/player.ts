// The player's vehicle: a car or helicopter that drives/flies itself until the
// user takes the controls, and resumes autopilot after a few idle seconds.

import {mat4, type Mat4} from '../math/mat4.ts';
import {Rng} from '../math/random.ts';
import {clamp, lerp, type Vec2, type Vec3} from '../math/vec.ts';
import type {VehicleRenderer} from '../render/vehicles.ts';
import type {Input} from './input.ts';
import {RoadNet} from './roadnet.ts';
import {LaneFollower, modelMatrix} from './traffic.ts';

export type PlayerKind = 'car' | 'heli';

export class Player {
  kind: PlayerKind = 'car';
  variant = 0;
  color: Vec3 = [0.6, 0.05, 0.05];
  color2: Vec3 = [0.9, 0.9, 0.9];
  pos: Vec3 = [0, 0, 0];
  yaw = 0;
  pitch = 0;
  roll = 0;
  speed = 0;
  vel: Vec3 = [0, 0, 0];
  steer = 0;
  spin = 0;
  rotor = 0;
  braking = false;
  autopilot = true;
  idle = 0;
  model: Mat4 = mat4.create();
  prev: Mat4 = mat4.create();
  follower: LaneFollower | null = null;
  hidden = false;
  private net: RoadNet;
  private vr: VehicleRenderer;
  private rng = new Rng(31337);
  private heliTarget: Vec3 = [0, 200, 0];
  private hubs: Vec2[];

  constructor(net: RoadNet, vr: VehicleRenderer, hubs: Vec2[]) {
    this.net = net;
    this.vr = vr;
    this.hubs = hubs;
  }

  get info() {
    return this.vr.variants[this.variant]?.info;
  }

  get forward(): Vec2 {
    return [Math.sin(this.yaw), -Math.cos(this.yaw)];
  }

  /** Put a car on the nearest lane to (x, z). */
  spawnCar(x: number, z: number, variant: number) {
    this.kind = 'car';
    this.variant = variant;
    const info = this.info;
    if (info) {
      this.color = info.palette[0];
      this.color2 =
        info.kind === 'taxi' ? (info.palette[1] ?? this.color) : this.color;
    }
    this.attachToLane(x, z);
    this.autopilot = true;
    if (this.follower) {
      this.follower.place(this.net);
      this.pos = [...this.follower.pos];
      this.yaw = Math.atan2(this.follower.dir[0], -this.follower.dir[1]);
    }
    modelMatrix(this.model, this.pos, this.forward, 0);
    this.prev.set(this.model);
  }

  spawnHeli(variant: number) {
    this.kind = 'heli';
    this.variant = variant;
    const info = this.info;
    if (info) this.color = info.palette[0];
    this.pos = [
      this.pos[0],
      this.net.hf.sample(this.pos[0], this.pos[2]) + 120,
      this.pos[2],
    ];
    this.vel = [0, 0, 0];
    this.follower = null;
    this.autopilot = true;
    this.pickHeliTarget();
  }

  private attachToLane(x: number, z: number) {
    const nr = this.net.nearestRoad(x, z, 6);
    if (!nr) return;
    const c = this.net.chains[nr.chain];
    const a = c.pts[nr.seg];
    const b = c.pts[nr.seg + 1];
    const along: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const fwd = this.forward;
    const dir: 1 | -1 = along[0] * fwd[0] + along[1] * fwd[1] >= 0 ? 1 : -1;
    const len = this.net.length(nr.chain);
    const arcAt =
      this.net.geom.arc[nr.chain][nr.seg] +
      Math.hypot(along[0], along[1]) * nr.t;
    const s = dir === 1 ? arcAt : len - arcAt;
    const [s0, s1] = this.net.geom.setbacks[nr.chain];
    const sMin = dir === 1 ? s0 : s1;
    const sMax = len - (dir === 1 ? s1 : s0);
    const f = new LaneFollower(
      {chain: nr.chain, dir, lane: 0},
      clamp(s, sMin, Math.max(sMin, sMax - 1)),
      this.info?.size[2] ?? 4.5,
      1.05,
      this.rng.nextU32(),
    );
    if (this.info) f.setAxles(this.info.wheels);
    f.preferBig = true;
    f.speed = this.speed;
    this.follower = f;
  }

  private pickHeliTarget() {
    const h = this.rng.pick(this.hubs);
    const ground = this.net.hf.sample(h[0], h[1]);
    this.heliTarget = [
      h[0] + this.rng.range(-300, 300),
      Math.max(ground, 0) + this.rng.range(140, 260),
      h[1] + this.rng.range(-300, 300),
    ];
  }

  update(dt: number, input: Input, time: number) {
    const active = input.driveActive();
    if (active) {
      this.idle = 0;
      if (this.autopilot) {
        this.autopilot = false;
        this.follower = null;
      }
    } else {
      this.idle += dt;
      if (!this.autopilot && this.idle > 6) {
        this.autopilot = true;
        if (this.kind === 'car') this.attachToLane(this.pos[0], this.pos[2]);
        else this.pickHeliTarget();
      }
    }
    this.prev.set(this.model);
    if (this.kind === 'car') this.updateCar(dt, input, time);
    else this.updateHeli(dt, input);
  }

  private updateCar(dt: number, input: Input, time: number) {
    const info = this.info;
    const wheelR = info?.wheels[0]?.radius ?? 0.33;
    if (this.autopilot && this.follower) {
      const f = this.follower;
      f.update(dt, this.net, time, f.leaderGap, f.leaderSpeed);
      this.pos = [...f.pos];
      const targetYaw = Math.atan2(f.dir[0], -f.dir[1]);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      this.steer = lerp(this.steer, clamp(dy * 4, -0.5, 0.5), 0.1);
      this.yaw = targetYaw;
      this.speed = f.speed;
      this.braking = f.braking;
      modelMatrix(this.model, this.pos, f.dir, f.slope);
    } else {
      // Arcade car physics with a bicycle steering model.
      const throttle =
        input.axis('KeyW', 'ArrowUp') -
        input.axis('KeyS', 'ArrowDown') +
        input.gamepadThrottle();
      const steerIn =
        input.axis('KeyA', 'ArrowLeft') -
        input.axis('KeyD', 'ArrowRight') +
        input.gamepadSteer();
      const handbrake = input.down('Space');
      const maxSteer = 0.55 / (1 + Math.abs(this.speed) * 0.05);
      this.steer = lerp(
        this.steer,
        clamp(steerIn, -1, 1) * maxSteer,
        1 - Math.exp(-dt * 8),
      );
      let acc = 0;
      if (throttle > 0) acc = this.speed < -0.5 ? 14 : 7.5 * throttle;
      else if (throttle < 0) acc = this.speed > 0.5 ? -14 : 4 * throttle;
      acc -= this.speed * 0.02 + Math.sign(this.speed) * 0.25;
      if (handbrake) acc -= Math.sign(this.speed) * 12;
      this.braking = throttle < 0 && this.speed > 0.5;
      this.speed = clamp(this.speed + acc * dt, -12, 62);
      const wheelbase = info
        ? Math.abs(info.wheels[0]?.position[2] - info.wheels[2]?.position[2]) ||
          2.7
        : 2.7;
      this.yaw -=
        ((this.speed * Math.tan(this.steer)) / wheelbase) *
        dt *
        (handbrake ? 1.6 : 1);
      const f = this.forward;
      let nx = this.pos[0] + f[0] * this.speed * dt;
      let nz = this.pos[2] + f[1] * this.speed * dt;
      const push = this.net.collideBuildings([nx, this.pos[1], nz], 1.2);
      if (push[0] || push[1]) {
        nx += push[0];
        nz += push[1];
        this.speed *= 0.6;
      }
      const lim = this.net.size / 2 - 20;
      nx = clamp(nx, -lim, lim);
      nz = clamp(nz, -lim, lim);
      const h = this.net.surfaceHeight(nx, nz, this.pos[1]);
      const hf = this.net.surfaceHeight(nx + f[0] * 1.5, nz + f[1] * 1.5, h);
      const hb = this.net.surfaceHeight(nx - f[0] * 1.5, nz - f[1] * 1.5, h);
      this.pos = [nx, h, nz];
      const slope = (hf - hb) / 3;
      this.roll = lerp(
        this.roll,
        clamp(-this.steer * this.speed * 0.01, -0.06, 0.06),
        0.1,
      );
      modelMatrix(this.model, this.pos, f, slope, this.roll);
    }
    this.spin += (this.speed * dt) / wheelR;
  }

  private updateHeli(dt: number, input: Input) {
    this.rotor += dt * 28;
    const f = this.forward;
    if (this.autopilot) {
      const to: Vec3 = [
        this.heliTarget[0] - this.pos[0],
        this.heliTarget[1] - this.pos[1],
        this.heliTarget[2] - this.pos[2],
      ];
      const dist = Math.hypot(to[0], to[2]);
      if (dist < 80) this.pickHeliTarget();
      const want = Math.atan2(to[0], -to[2]);
      let dy = want - this.yaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      this.yaw += clamp(dy, -0.4 * dt, 0.4 * dt);
      const sp = Math.min(38, dist * 0.3);
      this.vel = [
        lerp(this.vel[0], f[0] * sp, dt * 0.5),
        lerp(this.vel[1], clamp(to[1] * 0.3, -6, 6), dt),
        lerp(this.vel[2], f[1] * sp, dt * 0.5),
      ];
      this.roll = lerp(this.roll, clamp(-dy * 0.8, -0.35, 0.35), dt * 2);
    } else {
      const fwd =
        input.axis('KeyW', 'ArrowUp') -
        input.axis('KeyS', 'ArrowDown') +
        input.gamepadThrottle();
      const side =
        input.axis('KeyD', 'ArrowRight') -
        input.axis('KeyA', 'ArrowLeft') -
        input.gamepadSteer();
      const lift = input.axis('Space') - input.axis('ShiftLeft', 'ControlLeft');
      const yawIn = input.axis('KeyE') - input.axis('KeyQ');
      this.yaw += (yawIn * 1.2 + side * 0.6) * dt;
      const r: Vec2 = [-f[1], f[0]];
      const target: Vec3 = [
        f[0] * fwd * 45 + r[0] * side * 15,
        lift * 10,
        f[1] * fwd * 45 + r[1] * side * 15,
      ];
      this.vel = [
        lerp(this.vel[0], target[0], dt * 0.8),
        lerp(this.vel[1], target[1], dt * 1.5),
        lerp(this.vel[2], target[2], dt * 0.8),
      ];
      this.roll = lerp(this.roll, side * 0.3, dt * 3);
    }
    this.pos = [
      this.pos[0] + this.vel[0] * dt,
      this.pos[1] + this.vel[1] * dt,
      this.pos[2] + this.vel[2] * dt,
    ];
    // Stay above terrain and rooftops.
    const ground =
      Math.max(this.net.hf.sample(this.pos[0], this.pos[2]), 0) + 2;
    if (this.pos[1] < ground) {
      this.pos[1] = ground;
      this.vel[1] = Math.max(0, this.vel[1]);
    }
    const push = this.net.collideBuildings(this.pos, 8);
    this.pos[0] += push[0];
    this.pos[2] += push[1];
    const lim = this.net.size / 2;
    this.pos[0] = clamp(this.pos[0], -lim, lim);
    this.pos[2] = clamp(this.pos[2], -lim, lim);
    this.speed = Math.hypot(this.vel[0], this.vel[2]);
    const fwdSpeed = this.vel[0] * f[0] + this.vel[2] * f[1];
    this.pitch = lerp(
      this.pitch,
      clamp(-fwdSpeed * 0.006, -0.25, 0.15),
      dt * 2,
    );
    modelMatrix(this.model, this.pos, f, this.pitch, this.roll);
  }

  draw(lights: number) {
    this.vr.add({
      variant: this.variant,
      model: this.model,
      prevModel: this.prev,
      color: this.color,
      metallic: 0.6,
      color2: this.color2,
      lights,
      brake: this.braking ? 1 : 0,
      indicator: this.follower?.indicator ?? 0,
      wheelSpin: this.spin,
      steer: this.steer,
      rotor: this.rotor,
      lod: 0,
      hidden: this.hidden,
    });
  }

  /** World position of a point in vehicle space. */
  toWorld(p: Vec3): Vec3 {
    return mat4.transformPoint(this.model, p);
  }
}
