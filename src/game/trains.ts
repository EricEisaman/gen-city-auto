// Commuter trains on the elevated viaducts (running over the streets), and
// ambient helicopters circling the skyline.

import type {Elevated} from '../city/layout.ts';
import {mat4, type Mat4} from '../math/mat4.ts';
import {Rng} from '../math/random.ts';
import type {Vec2, Vec3} from '../math/vec.ts';
import type {VehicleRenderer} from '../render/vehicles.ts';
import {modelMatrix} from './traffic.ts';

interface Line {
  e: Elevated;
  arc: number[];
  total: number;
  stationArcs: number[];
}

interface Train {
  line: number;
  dir: 1 | -1;
  s: number;
  speed: number;
  dwell: number;
  cars: {model: Mat4; prev: Mat4}[];
  variant: number;
  color2: Vec3;
}

export class Trains {
  lines: Line[] = [];
  trains: Train[] = [];
  private vr: VehicleRenderer;
  carLen = 20;
  /** Distance from a car's center to each bogie pivot (6.9 m on the 20 m design). */
  bogie = 6.9;

  constructor(elevated: Elevated[], vr: VehicleRenderer) {
    this.vr = vr;
    const variants = vr.variantsOf('train');
    const rng = new Rng(77);
    if (variants.length) {
      this.carLen = vr.variants[variants[0]].info.size[2] + 0.6;
      this.bogie = Math.min(6.9, this.carLen * 0.35);
    }
    const bands: Vec3[] = [
      [0.55, 0.8, 0.12],
      [0.9, 0.45, 0.05],
      [0.1, 0.45, 0.85],
      [0.85, 0.2, 0.25],
    ];
    for (const e of elevated) {
      if (e.kind !== 'rail') continue;
      const arc = [0];
      for (let i = 1; i < e.pts.length; i++)
        arc.push(
          arc[i - 1] +
            Math.hypot(
              e.pts[i][0] - e.pts[i - 1][0],
              e.pts[i][1] - e.pts[i - 1][1],
            ),
        );
      const total = arc[arc.length - 1];
      const li = this.lines.length;
      this.lines.push({
        e,
        arc,
        total,
        stationArcs: e.stations.map(s => arc[s]).sort((a, b) => a - b),
      });
      if (!variants.length || total < 400) continue;
      const count = e.loop ? 4 : 2;
      for (let k = 0; k < count; k++) {
        const ncars = e.loop ? 10 : 8;
        this.trains.push({
          line: li,
          dir: k % 2 === 0 ? 1 : -1,
          s: (total * (k + 0.3)) / count,
          speed: 15,
          dwell: 0,
          cars: Array.from({length: ncars}, () => ({
            model: mat4.create(),
            prev: mat4.create(),
          })),
          variant: rng.pick(variants),
          color2: bands[li % bands.length],
        });
      }
    }
  }

  /**
   * Asset lab: keep one train, standing still with its front at arc length
   * `s` of line 0 (for scale in the screenshots).
   */
  park(s: number) {
    this.trains = this.trains.filter(t => t.line === 0).slice(0, 1);
    for (const tr of this.trains) {
      tr.s = s;
      tr.dir = 1;
      tr.speed = 0;
      tr.dwell = 1e9;
    }
    // Twice, so the previous-frame matrices match (no motion vectors).
    this.update(0);
    this.update(0);
  }

  /** Track centerline point at arc length `s`. */
  private at(line: Line, s: number): Vec3 {
    const {e, arc, total} = line;
    if (e.loop) s = ((s % total) + total) % total;
    else s = Math.max(0, Math.min(total, s));
    let lo = 0;
    let hi = arc.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (arc[m] <= s) lo = m;
      else hi = m;
    }
    const t = (s - arc[lo]) / (arc[hi] - arc[lo] || 1);
    const a = e.pts[lo];
    const b = e.pts[hi];
    const h = e.heights[lo] + (e.heights[hi] - e.heights[lo]) * t;
    return [a[0] + (b[0] - a[0]) * t, h, a[1] + (b[1] - a[1]) * t];
  }

  update(dt: number) {
    for (const tr of this.trains) {
      const line = this.lines[tr.line];
      const vmax = 20;
      // Next station ahead.
      let distToStation = Infinity;
      for (const st of line.stationArcs) {
        let d = (st - tr.s) * tr.dir;
        if (line.e.loop) d = ((d % line.total) + line.total) % line.total;
        if (d > 0.5 && d < distToStation) distToStation = d;
      }
      if (!line.e.loop) {
        const endDist =
          tr.dir === 1
            ? line.total - 30 - tr.s
            : tr.s - 30 - this.carLen * tr.cars.length;
        if (endDist < distToStation) distToStation = endDist;
      }
      if (tr.dwell > 0) {
        tr.dwell -= dt;
        tr.speed = 0;
        if (tr.dwell <= 0) {
          tr.s += tr.dir * 1.0;
          if (
            !line.e.loop &&
            (tr.s > line.total - 40 || tr.s < this.carLen * tr.cars.length + 40)
          )
            tr.dir = tr.dir === 1 ? -1 : 1;
        }
      } else {
        const brake = Math.sqrt(Math.max(0, 2 * 0.9 * distToStation));
        tr.speed = Math.min(vmax, tr.speed + 0.8 * dt, brake);
        if (distToStation < 0.6 && tr.speed < 0.6) tr.dwell = 18;
        tr.s += tr.dir * Math.max(tr.speed, 0.3) * dt;
      }
      tr.cars.forEach((c, k) => {
        // The body rests on its two bogies: sample the track under each and
        // take heading, pitch and height from the line between them, so the
        // car eases through grade changes and curves instead of snapping to
        // the slope of whichever track segment its center is on.
        const s = tr.s - tr.dir * (k * this.carLen + this.carLen / 2);
        const qf = this.at(line, s + tr.dir * this.bogie);
        const qr = this.at(line, s - tr.dir * this.bogie);
        const dx = qf[0] - qr[0];
        const dz = qf[2] - qr[2];
        const l = Math.hypot(dx, dz) || 1;
        const d: Vec2 = [dx / l, dz / l];
        // Run on the left-hand track.
        const left: Vec2 = [d[1], -d[0]];
        const p: Vec3 = [
          (qf[0] + qr[0]) / 2 + left[0] * 2.1,
          (qf[1] + qr[1]) / 2 + 0.37, // RAIL_TOP (gen-base.ts)
          (qf[2] + qr[2]) / 2 + left[1] * 2.1,
        ];
        c.prev.set(c.model);
        modelMatrix(c.model, p, d, (qf[1] - qr[1]) / l);
      });
    }
  }

  draw(lights: number) {
    for (const tr of this.trains) {
      for (const c of tr.cars) {
        this.vr.add({
          variant: tr.variant,
          model: c.model,
          prevModel: c.prev,
          color: [0.72, 0.73, 0.75],
          metallic: 0.9,
          color2: tr.color2,
          lights: Math.max(lights, 0.3),
          brake: tr.speed < 2 ? 1 : 0,
          indicator: 0,
          wheelSpin: 0,
          steer: 0,
          rotor: 0,
        });
      }
    }
  }

  /** Position of a train for the auto director. */
  focusPoint(i: number): Vec3 | null {
    const tr = this.trains[i % Math.max(1, this.trains.length)];
    if (!tr) return null;
    const m = tr.cars[Math.floor(tr.cars.length / 2)].model;
    return [m[12], m[13], m[14]];
  }
}

export class AmbientHelis {
  helis: {
    center: Vec3;
    radius: number;
    speed: number;
    a: number;
    model: Mat4;
    prev: Mat4;
    variant: number;
    color: Vec3;
  }[] = [];
  private vr: VehicleRenderer;

  constructor(
    hubs: {p: Vec2}[],
    vr: VehicleRenderer,
    groundAt: (x: number, z: number) => number,
  ) {
    this.vr = vr;
    const v = vr.variantsOf('helicopter');
    const rng = new Rng(9);
    if (!v.length) return;
    for (let i = 0; i < Math.min(4, hubs.length); i++) {
      const h = hubs[i];
      this.helis.push({
        center: [
          h.p[0],
          groundAt(h.p[0], h.p[1]) + rng.range(180, 280),
          h.p[1],
        ],
        radius: rng.range(250, 500),
        speed: rng.range(25, 40) * (rng.chance(0.5) ? 1 : -1),
        a: rng.range(0, 6.28),
        model: mat4.create(),
        prev: mat4.create(),
        variant: rng.pick(v),
        color: rng.pick(vr.variants[v[0]].info.palette),
      });
    }
  }

  update(dt: number) {
    for (const h of this.helis) {
      h.a += (h.speed / h.radius) * dt;
      const p: Vec3 = [
        h.center[0] + Math.cos(h.a) * h.radius,
        h.center[1] + Math.sin(h.a * 0.5) * 15,
        h.center[2] + Math.sin(h.a) * h.radius,
      ];
      const s = Math.sign(h.speed);
      const d: Vec2 = [-Math.sin(h.a) * s, Math.cos(h.a) * s];
      h.prev.set(h.model);
      modelMatrix(h.model, p, d, -0.08, 0.25 * s);
    }
  }

  draw(time: number, lights: number) {
    for (const h of this.helis) {
      this.vr.add({
        variant: h.variant,
        model: h.model,
        prevModel: h.prev,
        color: h.color,
        metallic: 0.3,
        color2: [0.9, 0.9, 0.9],
        lights: Math.max(lights, 0.4),
        brake: 0,
        indicator: 0,
        wheelSpin: 0,
        steer: 0,
        rotor: time * 30,
      });
    }
  }
}
