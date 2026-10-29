// Camera modes (chase, first person, hood, orbit) and the auto director that
// cuts between cinematic shots while the vehicle drives itself.

import {Rng} from '../math/random.ts';
import {clamp, lerp, type Vec3} from '../math/vec.ts';
import type {Input} from './input.ts';
import type {Player} from './player.ts';
import type {RoadNet} from './roadnet.ts';

export type CameraMode = 'chase' | 'first' | 'hood' | 'orbit';
export const CAMERA_MODES: CameraMode[] = ['chase', 'first', 'hood', 'orbit'];

export interface CamOut {
  eye: Vec3;
  target: Vec3;
  fov: number;
  near: number;
  interior: boolean;
}

interface ShotState {
  name: string;
  t: number;
  dur: number;
  eye: Vec3;
  a: number;
  r: number;
  h: number;
  side: number;
  fov: number;
  focus: 'player' | 'train';
}

const SHOTS = [
  'chase',
  'bumper',
  'flyby',
  'telephoto',
  'orbit',
  'aerial',
  'side',
  'interior',
  'train',
  'wheel',
] as const;
const WEIGHTS: Record<string, number> = {
  chase: 2,
  bumper: 1.2,
  flyby: 2.5,
  telephoto: 2,
  orbit: 1.5,
  aerial: 1.2,
  side: 1.5,
  interior: 0.8,
  train: 1.5,
  wheel: 0,
};

export class CameraSystem {
  mode: CameraMode = 'chase';
  directorEnabled = true;
  shot: ShotState | null = null;
  private eye: Vec3 = [0, 50, 0];
  private look: Vec3 = [0, 0, 0];
  private yawOff = 0;
  private pitchOff = 0.12;
  private dist = 7;
  private rng = new Rng(2024);
  private net: RoadNet;
  trainFocus: () => Vec3 | null = () => null;
  /** Nearby dynamic obstacles (pedestrians) the camera must not sit in or look through. */
  obstacles: () => [number, number, number, number][] = () => [];

  constructor(net: RoadNet) {
    this.net = net;
  }

  cycle() {
    this.mode =
      CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.yawOff = 0;
  }

  private blocked(a: Vec3, b: Vec3) {
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      const p: Vec3 = [
        lerp(a[0], b[0], t),
        lerp(a[1], b[1], t),
        lerp(a[2], b[2], t),
      ];
      if (p[1] < this.net.hf.sample(p[0], p[2]) + 0.3) return true;
      const push = this.net.collideBuildings(p, 0.01);
      if (push[0] || push[1]) return true;
    }
    return false;
  }

  private newShot(pl: Player): ShotState {
    const isHeli = pl.kind === 'heli';
    const names = SHOTS.filter(
      s =>
        s !== this.shot?.name &&
        !(isHeli && ['bumper', 'interior', 'wheel', 'side'].includes(s)) &&
        !(s === 'train' && !this.nearTrain(pl)),
    );
    for (let attempt = 0; attempt < 12; attempt++) {
      const slow = pl.speed < 2;
      const name = this.rng.weighted(
        names,
        names.map(
          n =>
            WEIGHTS[n] *
            (slow && ['flyby', 'side', 'bumper', 'wheel'].includes(n)
              ? 0.2
              : 1),
        ),
      );
      const s: ShotState = {
        name,
        t: 0,
        dur: this.rng.range(5, 9),
        eye: [0, 0, 0],
        a: this.rng.range(0, Math.PI * 2),
        r: 0,
        h: 0,
        side: this.rng.chance(0.5) ? 1 : -1,
        fov: 0.9,
        focus: 'player',
      };
      const p = pl.pos;
      const f = pl.forward;
      const r: Vec3 = [-f[1], 0, f[0]];
      const ground = (x: number, z: number) =>
        Math.max(this.net.surfaceHeight(x, z, p[1]), this.net.hf.sample(x, z));
      switch (name) {
        case 'flyby': {
          const ahead = Math.max(15, pl.speed * 3.5);
          const x = p[0] + f[0] * ahead + r[0] * s.side * this.rng.range(4, 7);
          const z = p[2] + f[1] * ahead + r[2] * s.side * this.rng.range(4, 7);
          s.eye = [
            x,
            (isHeli ? p[1] - 20 : ground(x, z)) + this.rng.range(0.8, 2.5),
            z,
          ];
          s.fov = 0.75;
          break;
        }
        case 'telephoto': {
          const d = this.rng.range(70, 150);
          const x = p[0] + Math.cos(s.a) * d;
          const z = p[2] + Math.sin(s.a) * d;
          s.eye = [x, ground(x, z) + this.rng.range(15, 50), z];
          s.fov = this.rng.range(0.22, 0.35);
          // Reject eyes perched just above a roof (parapets fill the frame).
          {
            const pr = this.net.collideBuildings(
              [s.eye[0], s.eye[1] - 7, s.eye[2]],
              12,
            );
            if (pr[0] !== 0 || pr[1] !== 0) continue;
          }
          break;
        }
        case 'aerial': {
          s.eye = [
            p[0] - f[0] * 90 + r[0] * 40,
            p[1] + this.rng.range(90, 160),
            p[2] - f[1] * 90 + r[2] * 40,
          ];
          s.fov = 0.8;
          break;
        }
        case 'train': {
          const tp = this.trainFocus();
          if (!tp) continue;
          // Under the viaduct looking up at the train.
          s.focus = 'train';
          const x = tp[0] + this.rng.range(-25, 25);
          const z = tp[2] + this.rng.range(-25, 25);
          s.eye = [x, ground(x, z) + 1.6, z];
          s.fov = 0.9;
          break;
        }
        default:
          s.eye = [...p];
      }
      if (['flyby', 'telephoto', 'aerial', 'train'].includes(name)) {
        const target =
          s.focus === 'train'
            ? this.trainFocus()!
            : ([p[0], p[1] + 1, p[2]] as Vec3);
        if (
          this.blocked(s.eye, target) ||
          this.obstructedByPeople(s.eye, target) ||
          this.badEye(s.eye)
        )
          continue;
      }
      return s;
    }
    return {
      name: 'chase',
      t: 0,
      dur: 6,
      eye: [...pl.pos],
      a: 0,
      r: 0,
      h: 0,
      side: 1,
      fov: 0.9,
      focus: 'player',
    };
  }

  private nearTrain(pl: Player) {
    const tp = this.trainFocus();
    return !!tp && Math.hypot(tp[0] - pl.pos[0], tp[2] - pl.pos[2]) < 350;
  }

  update(dt: number, pl: Player, input: Input): CamOut {
    const director = pl.autopilot && this.directorEnabled;
    if (director) return this.directed(dt, pl);
    this.shot = null;
    return this.manual(dt, pl, input);
  }

  private chase(
    dt: number,
    pl: Player,
    dist: number,
    height: number,
    lag: number,
  ): CamOut {
    const f = pl.forward;
    const isHeli = pl.kind === 'heli';
    const yaw = Math.atan2(f[0], -f[1]) + this.yawOff;
    const d = isHeli ? dist * 2.2 : dist;
    const want: Vec3 = [
      pl.pos[0] - Math.sin(yaw) * d * Math.cos(this.pitchOff),
      pl.pos[1] + height + Math.sin(this.pitchOff) * d,
      pl.pos[2] + Math.cos(yaw) * d * Math.cos(this.pitchOff),
    ];
    const k = 1 - Math.exp(-dt * lag);
    this.eye = [
      lerp(this.eye[0], want[0], k),
      lerp(this.eye[1], want[1], k),
      lerp(this.eye[2], want[2], k),
    ];
    // Never closer than ~4 m to the vehicle (no clipping into the body).
    {
      const dx = this.eye[0] - pl.pos[0];
      const dz = this.eye[2] - pl.pos[2];
      const dd = Math.hypot(dx, dz);
      const minD = isHeli ? 9 : 4;
      if (dd < minD) {
        const ux = dd > 1e-3 ? dx / dd : -f[0];
        const uz = dd > 1e-3 ? dz / dd : -f[1];
        this.eye = [pl.pos[0] + ux * minD, this.eye[1], pl.pos[2] + uz * minD];
      }
    }
    // Keep the camera out of the ground.
    const g = this.net.surfaceHeight(this.eye[0], this.eye[2], this.eye[1]);
    this.eye[1] = Math.max(this.eye[1], g + 0.6);
    const target: Vec3 = [
      pl.pos[0] + f[0] * 2,
      pl.pos[1] + (isHeli ? 1 : 1.3),
      pl.pos[2] + f[1] * 2,
    ];
    // Pull in if a building blocks the view.
    if (this.blocked(target, this.eye)) {
      for (let s = 0.9; s > 0.2; s -= 0.1) {
        const e: Vec3 = [
          lerp(target[0], this.eye[0], s),
          lerp(target[1], this.eye[1], s),
          lerp(target[2], this.eye[2], s),
        ];
        if (!this.blocked(target, e)) {
          this.eye = e;
          break;
        }
      }
    }
    return {
      eye: [...this.eye],
      target,
      fov: 1.05 + Math.min(pl.speed, 40) * 0.004,
      near: 0.1,
      interior: false,
    };
  }

  private manual(dt: number, pl: Player, input: Input): CamOut {
    if (input.dragging) {
      this.yawOff -= input.mouseDX * 0.004;
      this.pitchOff = clamp(this.pitchOff + input.mouseDY * 0.003, -0.2, 1.2);
    } else if (this.mode === 'chase') {
      this.yawOff *= Math.exp(-dt * 1.5);
    }
    this.dist = clamp(this.dist + input.wheel * 0.8, 3.5, 30);
    pl.hidden = false;
    const info = pl.info;
    switch (this.mode) {
      case 'first': {
        const e = info?.driverEye ?? [0, 1.2, 0];
        const eye = pl.toWorld([e[0], e[1] + 0.15, e[2]]);
        const look = pl.toWorld([
          e[0] + Math.sin(this.yawOff) * 10,
          e[1] - 0.6 + this.pitchOff * -5,
          e[2] + Math.cos(this.yawOff) * 10,
        ]);
        return {eye, target: look, fov: 1.25, near: 0.03, interior: true};
      }
      case 'hood': {
        const sz = info?.size ?? [1.8, 1.4, 4.5];
        const eye = pl.toWorld([0, sz[1] * 0.78, sz[2] * 0.22]);
        const look = pl.toWorld([
          Math.sin(this.yawOff) * 20,
          sz[1] * 0.6,
          sz[2] * 0.22 + 20,
        ]);
        return {eye, target: look, fov: 1.15, near: 0.05, interior: false};
      }
      case 'orbit': {
        this.yawOff += dt * 0.2;
        return this.chase(dt, pl, this.dist * 1.4, 2.5, 6);
      }
      default:
        return this.chase(dt, pl, this.dist, 2.2, 5);
    }
  }

  private badEye(e: Vec3) {
    if (e[1] < this.net.hf.sample(e[0], e[2]) + 0.25) return true;
    const push = this.net.collideBuildings(e, 1.2);
    if (push[0] !== 0 || push[1] !== 0) return true;
    for (const o of this.obstacles()) {
      if (Math.hypot(o[0] - e[0], o[2] - e[2]) < 1.8 && e[1] - o[1] < 2.2)
        return true;
    }
    return false;
  }

  /** True if a pedestrian stands close to the line of sight near the camera. */
  private obstructedByPeople(e: Vec3, t: Vec3) {
    const dx = t[0] - e[0];
    const dz = t[2] - e[2];
    const len = Math.hypot(dx, dz) || 1;
    for (const o of this.obstacles()) {
      const ox = o[0] - e[0];
      const oz = o[2] - e[2];
      const along = (ox * dx + oz * dz) / len;
      if (along < 0.3 || along > Math.min(len - 3, 20)) continue;
      // Near objects block a much larger part of the frame.
      const lateral = Math.abs(ox * dz - oz * dx) / len;
      if (lateral < o[3] + 0.15 + (along < 4 ? 0.4 : 0)) return true;
    }
    return false;
  }

  /** Forced shots (tests, URL ?shot=) skip the automatic cut-away checks. */
  locked = false;
  private losTimer = 0;
  private blockedFor = 0;

  private directed(dt: number, pl: Player): CamOut {
    let out = this.directedRaw(dt, pl);
    // Never below the local ground or sidewalk, even for locked shots.
    if (!out.interior) {
      const g = Math.max(
        this.net.hf.sample(out.eye[0], out.eye[2]),
        this.net.surfaceHeight(out.eye[0], out.eye[2], out.eye[1]),
      );
      if (out.eye[1] < g + 0.6) out.eye = [out.eye[0], g + 0.6, out.eye[2]];
    }
    if (this.locked) return out;
    // Periodically verify the subject is visible; cut if blocked for a while.
    this.losTimer += dt;
    if (this.shot && this.shot.name !== 'interior' && this.losTimer > 0.25) {
      this.losTimer = 0;
      const tgt =
        this.shot.focus === 'train'
          ? (this.trainFocus() ?? pl.pos)
          : ([pl.pos[0], pl.pos[1] + 0.8, pl.pos[2]] as Vec3);
      this.blockedFor =
        this.blocked(out.eye, tgt) ||
        this.obstructedByPeople(out.eye, tgt) ||
        this.badEye(out.eye)
          ? this.blockedFor + 0.25
          : 0;
      if (this.blockedFor > 0.5) {
        this.blockedFor = 0;
        this.shot = this.newShot(pl);
        out = this.directedRaw(0, pl);
      }
    }
    // Cut away from shots whose camera ends up inside or against geometry.
    for (
      let tries = 0;
      tries < 4 &&
      this.shot &&
      this.shot.name !== 'interior' &&
      this.badEye(out.eye);
      tries++
    ) {
      this.shot = this.newShot(pl);
      out = this.directedRaw(0, pl);
    }
    return out;
  }

  private directedRaw(dt: number, pl: Player): CamOut {
    if (!this.shot || this.shot.t > this.shot.dur) this.shot = this.newShot(pl);
    const s = this.shot;
    s.t += dt;
    pl.hidden = false;
    const p = pl.pos;
    const f = pl.forward;
    const r: Vec3 = [-f[1], 0, f[0]];
    const focus: Vec3 =
      s.focus === 'train' ? (this.trainFocus() ?? p) : [p[0], p[1] + 1.0, p[2]];
    switch (s.name) {
      case 'chase':
        return this.chase(dt, pl, 6.5, 1.8, 3);
      case 'bumper': {
        const len = pl.info?.size[2] ?? 4.5;
        const eye: Vec3 = [
          p[0] + f[0] * (len / 2 + 0.25) + r[0] * s.side * 0.5,
          p[1] + 0.8,
          p[2] + f[1] * (len / 2 + 0.25) + r[2] * s.side * 0.5,
        ];
        return {
          eye,
          target: [p[0] + f[0] * 20, p[1] + 2.6, p[2] + f[1] * 20],
          fov: 1.2,
          near: 0.05,
          interior: false,
        };
      }
      case 'wheel': {
        const sz = pl.info?.size ?? [1.8, 1.4, 4.5];
        const eye: Vec3 = [
          p[0] + r[0] * s.side * (sz[0] / 2 + 0.25) - f[0] * sz[2] * 0.15,
          p[1] + 0.35,
          p[2] + r[2] * s.side * (sz[0] / 2 + 0.25) - f[1] * sz[2] * 0.15,
        ];
        return {
          eye,
          target: [p[0] + f[0] * 25, p[1] + 0.6, p[2] + f[1] * 25],
          fov: 1.3,
          near: 0.05,
          interior: false,
        };
      }
      case 'orbit': {
        s.a += dt * 0.35 * s.side;
        const rad = pl.kind === 'heli' ? 22 : 8;
        const eye: Vec3 = [
          p[0] + Math.cos(s.a) * rad,
          p[1] + (pl.kind === 'heli' ? 4 : 1.8),
          p[2] + Math.sin(s.a) * rad,
        ];
        const g = this.net.surfaceHeight(eye[0], eye[2], eye[1]);
        eye[1] = Math.max(eye[1], g + 0.8);
        return {eye, target: focus, fov: 0.9, near: 0.1, interior: false};
      }
      case 'side': {
        const eye: Vec3 = [
          p[0] + r[0] * s.side * 5 + f[0] * 1.5,
          p[1] + 1.1,
          p[2] + r[2] * s.side * 5 + f[1] * 1.5,
        ];
        return {
          eye,
          target: [p[0] + f[0] * 0.5, p[1] + 0.9, p[2] + f[1] * 0.5],
          fov: 0.8,
          near: 0.1,
          interior: false,
        };
      }
      case 'interior': {
        const e = pl.info?.driverEye ?? [0, 1.2, 0];
        const eye = pl.toWorld([e[0] * 0.15, e[1] + 0.02, e[2] - 0.38]);
        const look = pl.toWorld([e[0] * 0.5, e[1] - 0.2, e[2] + 8]);
        return {eye, target: look, fov: 1.2, near: 0.03, interior: true};
      }
      case 'aerial': {
        s.eye = [
          s.eye[0] + f[0] * pl.speed * dt * 0.7,
          s.eye[1],
          s.eye[2] + f[1] * pl.speed * dt * 0.7,
        ];
        return {
          eye: [...s.eye],
          target: focus,
          fov: s.fov,
          near: 0.5,
          interior: false,
        };
      }
      default: {
        // Static shots: flyby, telephoto, train. Cut early if the view gets blocked.
        if (
          s.t > 0.5 &&
          Math.floor(s.t * 4) !== Math.floor((s.t - dt) * 4) &&
          this.blocked(s.eye, focus)
        )
          s.t = s.dur + 1;
        const fov = s.name === 'telephoto' ? s.fov : s.fov;
        return {
          eye: [...s.eye],
          target: focus,
          fov,
          near: 0.1,
          interior: false,
        };
      }
    }
  }
}
