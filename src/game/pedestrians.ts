// Pedestrians walking along the sidewalks near the camera, denser near the
// busy hubs.

import {ROAD_WIDTH, SIDEWALK} from '../city/layout.ts';
import {chainAt} from '../city/roadgeom.ts';
import {mat4, type Mat4} from '../math/mat4.ts';
import {Rng} from '../math/random.ts';
import type {Vec2, Vec3} from '../math/vec.ts';
import type {VehicleRenderer} from '../render/vehicles.ts';
import type {RoadNet} from './roadnet.ts';
import {modelMatrix} from './traffic.ts';

interface Ped {
  chain: number;
  side: number;
  s: number;
  dir: 1 | -1;
  speed: number;
  lateral: number;
  variant: number;
  color: Vec3;
  color2: Vec3;
  model: Mat4;
  prev: Mat4;
  phase: number;
}

export class Pedestrians {
  peds: Ped[] = [];
  target = 420;
  radius = 160;
  private rng = new Rng(808);
  private net: RoadNet;
  private vr: VehicleRenderer;
  private variants: number[];
  private hubs: Vec2[];

  constructor(net: RoadNet, vr: VehicleRenderer, hubs: Vec2[]) {
    this.net = net;
    this.vr = vr;
    this.hubs = hubs;
    this.variants = vr.variantsOf('person');
  }

  private density(x: number, z: number) {
    let d = 0.15;
    for (const h of this.hubs) d = Math.max(d, Math.exp(-((x - h[0]) ** 2 + (z - h[1]) ** 2) / (700 * 700)));
    return d;
  }

  private spawn(focus: Vec3) {
    const r = this.rng;
    const loc = this.net.randomLaneNear(focus[0], focus[2], this.radius, () => r.next());
    if (!loc) return;
    const c = this.net.chains[loc.chain];
    if (c.bridge.some(b => b)) return;
    const len = this.net.length(loc.chain);
    const p = chainAt(c, this.net.geom.arc[loc.chain], Math.min(len, loc.s));
    if (r.next() > this.density(p.p[0], p.p[1])) return;
    const variant = r.pick(this.variants);
    const info = this.vr.variants[variant].info;
    this.peds.push({
      chain: loc.chain,
      side: r.chance(0.5) ? 1 : -1,
      s: loc.s,
      dir: r.chance(0.5) ? 1 : -1,
      speed: r.range(1.0, 1.6),
      lateral: r.range(0.25, 0.75),
      variant,
      color: r.pick(info.palette),
      color2: r.pick([[0.05, 0.05, 0.07], [0.15, 0.17, 0.25], [0.35, 0.33, 0.3], [0.6, 0.58, 0.52]] as Vec3[]),
      model: mat4.create(),
      prev: mat4.create(),
      phase: r.range(0, 6),
    });
  }

  update(dt: number, focus: Vec3) {
    if (!this.variants.length) return;
    this.peds = this.peds.filter(p => {
      const m = p.model;
      return Math.hypot(m[12] - focus[0], m[14] - focus[2]) < this.radius + 40 || m[15] === 0;
    });
    for (let k = 0; k < 12 && this.peds.length < this.target; k++) this.spawn(focus);
    for (const p of this.peds) {
      const len = this.net.length(p.chain);
      p.s += p.dir * p.speed * dt;
      if (p.s < 2 || p.s > len - 2) {
        p.dir = p.dir === 1 ? -1 : 1;
        p.s = Math.max(2, Math.min(len - 2, p.s));
      }
      const c = this.net.chains[p.chain];
      const q = chainAt(c, this.net.geom.arc[p.chain], p.s);
      const off = (ROAD_WIDTH[c.kind] / 2 + SIDEWALK[c.kind] * p.lateral + 0.3) * p.side;
      const l: Vec2 = [-q.d[1], q.d[0]];
      const x = q.p[0] + l[0] * off;
      const z = q.p[1] + l[1] * off;
      const y = this.net.hf.sample(x, z) + 0.16;
      p.phase += dt * p.speed * 5.5;
      const bob = Math.abs(Math.sin(p.phase)) * 0.03;
      const d: Vec2 = [q.d[0] * p.dir, q.d[1] * p.dir];
      p.prev.set(p.model);
      modelMatrix(p.model, [x, y + bob, z], d, 0, Math.sin(p.phase) * 0.04);
      if (p.prev[15] === 0) p.prev.set(p.model);
    }
  }

  draw() {
    for (const p of this.peds) {
      this.vr.add({variant: p.variant, model: p.model, prevModel: p.prev, color: p.color, metallic: 0, color2: p.color2, lights: 0, brake: 0, indicator: 0, wheelSpin: 0, steer: 0, rotor: 0});
    }
  }
}
