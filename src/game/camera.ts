// Camera modes (chase, first person, hood, orbit) and the auto director that
// cuts between cinematic shots while the vehicle drives itself.

import {elevatedHalfWidth, type Elevated} from '../city/layout.ts';
import {SEA_LEVEL} from '../city/terrain.ts';
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
  /** Seconds actually on screen (t can be forced by tests). */
  shown?: number;
  framing?: Framing;
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
/** Shots that read alike; two of these in a row look like a repeat. */
const FAMILY: Record<string, string> = {
  aerial: 'far',
  telephoto: 'far',
  bumper: 'low',
  wheel: 'low',
  flyby: 'roadside',
  side: 'roadside',
};
/** Shots that frame the whole subject (others look along or out of it). */
const WIDE = new Set(['flyby', 'telephoto', 'aerial', 'train', 'orbit']);
/** Screenshots and the canvas are landscape; frustum tests assume 16:9. */
const ASPECT = 16 / 9;
/** Elevated deck slab, girders below and parapet above, relative to the line height. */
const DECK_BOTTOM = 3.1;
const DECK_TOP = 1.2;

/** A traffic vehicle, bus or train car as an oriented box (origin at its base). */
export interface VehicleBox {
  x: number;
  y: number;
  z: number;
  /** Unit forward (x, z). */
  fx: number;
  fz: number;
  /** Half length, half width, height. */
  hl: number;
  hw: number;
  h: number;
}

/** Where a shot looked from and in which direction, to avoid repeats. */
interface Framing {
  eye: Vec3;
  yaw: number;
  /** Under an overpass or viaduct. */
  covered: boolean;
}

interface DeckSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ha: number;
  hb: number;
  hw: number;
  /** Top of the structure above the line height (parapet, station canopy). */
  top: number;
}

function gridInsert(grid: Map<number, VehicleBox[]>, b: VehicleBox) {
  const rad = Math.hypot(b.hl, b.hw) + 1;
  const x0 = Math.floor((b.x - rad) / 16);
  const x1 = Math.floor((b.x + rad) / 16);
  const z0 = Math.floor((b.z - rad) / 16);
  const z1 = Math.floor((b.z + rad) / 16);
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++) {
      const k = (x + 8192) * 16384 + (z + 8192);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(b);
    }
}

function gridAt(
  grid: Map<number, VehicleBox[]>,
  p: Vec3,
  margin: number,
): VehicleBox | null {
  const k =
    (Math.floor(p[0] / 16) + 8192) * 16384 + (Math.floor(p[2] / 16) + 8192);
  for (const b of grid.get(k) ?? []) {
    if (p[1] < b.y - margin || p[1] > b.y + b.h + margin) continue;
    const dx = p[0] - b.x;
    const dz = p[2] - b.z;
    if (Math.abs(dx * b.fx + dz * b.fz) > b.hl + margin) continue;
    if (Math.abs(dz * b.fx - dx * b.fz) > b.hw + margin) continue;
    return b;
  }
  return null;
}

/** View basis for an eye looking at a target. */
function viewBasis(eye: Vec3, target: Vec3) {
  let fx = target[0] - eye[0];
  let fy = target[1] - eye[1];
  let fz = target[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = f x up
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  // up = right x f
  const u: Vec3 = [-rz * fy, rz * fx - rx * fz, rx * fy];
  return {f: [fx, fy, fz] as Vec3, r: [rx, 0, rz] as Vec3, u};
}

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
  /** Car positions (rail height) of the train nearest the player, in order. */
  trainCars: () => Vec3[] = () => [];
  private decks: DeckSeg[] = [];
  private deckGrid = new Map<number, number[]>();
  /** Most recent shots first, so the director can avoid repeating itself. */
  private recent: string[] = [];
  /** Framings of the most recent cuts, newest first. */
  private framings: Framing[] = [];
  /** Moving vehicles near the player (traffic, buses, trains); set by the game. */
  vehicles: () => VehicleBox[] = () => [];
  private vehGrid = new Map<number, VehicleBox[]>();
  /** Static structures that are not buildings: piers, portal frames, stairs. */
  private solidGrid = new Map<number, VehicleBox[]>();
  /** Nearby dynamic obstacles (pedestrians) the camera must not sit in or look through. */
  obstacles: () => [number, number, number, number][] = () => [];

  constructor(net: RoadNet) {
    this.net = net;
  }

  /** Rail viaducts and expressways: the camera must not sit in or look through them. */
  setElevated(list: Elevated[]) {
    this.decks = [];
    this.deckGrid.clear();
    for (const e of list) {
      const n = e.pts.length;
      const segs = e.loop ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        // Stations (gen-base railViaduct): 4.5 m side platforms each side
        // with canopies up to 4.6 m above the rails, over 14 segments.
        const station = e.stations.some(si => i >= si - 7 && i < si + 7);
        const hw = elevatedHalfWidth(e) + (station ? 4.8 : 0);
        const d: DeckSeg = {
          ax: e.pts[i][0],
          az: e.pts[i][1],
          bx: e.pts[j][0],
          bz: e.pts[j][1],
          ha: e.heights[i],
          hb: e.heights[j],
          hw,
          top: station ? 4.9 : DECK_TOP,
        };
        const di = this.decks.push(d) - 1;
        const pad = hw + 3;
        const x0 = Math.floor((Math.min(d.ax, d.bx) - pad) / 32);
        const x1 = Math.floor((Math.max(d.ax, d.bx) + pad) / 32);
        const z0 = Math.floor((Math.min(d.az, d.bz) - pad) / 32);
        const z1 = Math.floor((Math.max(d.az, d.bz) + pad) / 32);
        for (let z = z0; z <= z1; z++)
          for (let x = x0; x <= x1; x++) {
            const k = (x + 4096) * 8192 + (z + 4096);
            let l = this.deckGrid.get(k);
            if (!l) this.deckGrid.set(k, (l = []));
            l.push(di);
          }
      }
    }
  }

  /** True if p is inside (or within margin of) an elevated deck. */
  private inDeck(p: Vec3, margin: number) {
    const k =
      (Math.floor(p[0] / 32) + 4096) * 8192 + (Math.floor(p[2] / 32) + 4096);
    for (const di of this.deckGrid.get(k) ?? []) {
      const d = this.decks[di];
      const dx = d.bx - d.ax;
      const dz = d.bz - d.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = clamp(((p[0] - d.ax) * dx + (p[2] - d.az) * dz) / l2, 0, 1);
      const dist = Math.hypot(d.ax + dx * t - p[0], d.az + dz * t - p[2]);
      if (dist > d.hw + margin) continue;
      const h = lerp(d.ha, d.hb, t);
      if (p[1] > h - DECK_BOTTOM - margin && p[1] < h + d.top + margin)
        return true;
    }
    return false;
  }

  /** Rebuild the vehicle lookup (once per directed frame). */
  private refreshVehicles(pl: Player) {
    this.vehGrid.clear();
    for (const b of this.vehicles()) {
      // Never the player's own vehicle.
      if (Math.hypot(b.x - pl.pos[0], b.z - pl.pos[2]) < 1) continue;
      gridInsert(this.vehGrid, b);
    }
  }

  /** Bridge and viaduct solids from the base generator (cx, cy, cz, hx, hy,
   * hz, yaw per box; hx along (cos, -sin), hz along (sin, cos)). */
  setSolids(a: ArrayLike<number>) {
    this.solidGrid.clear();
    for (let i = 0; i + 6 < a.length; i += 7) {
      const yaw = a[i + 6];
      gridInsert(this.solidGrid, {
        x: a[i],
        y: a[i + 1] - a[i + 4],
        z: a[i + 2],
        fx: Math.sin(yaw),
        fz: Math.cos(yaw),
        hl: a[i + 5],
        hw: a[i + 3],
        h: a[i + 4] * 2,
      });
    }
  }

  /** The vehicle or solid structure containing p (grown by margin), if any. */
  private vehicleAt(p: Vec3, margin = 0): VehicleBox | null {
    return gridAt(this.vehGrid, p, margin) ?? gridAt(this.solidGrid, p, margin);
  }

  /** True under an elevated deck (overpass, viaduct). */
  private covered(p: Vec3) {
    for (let y = 3; y <= 24; y += 3)
      if (this.inDeck([p[0], p[1] + y, p[2]], 0)) return true;
    return false;
  }

  /** True if this framing is much like one of the last two cuts. */
  private repeatsFraming(eye: Vec3, look: Vec3) {
    const yaw = Math.atan2(look[0] - eye[0], look[2] - eye[2]);
    const cov = this.covered(eye);
    for (const f of this.framings) {
      const d = Math.hypot(eye[0] - f.eye[0], eye[2] - f.eye[2]);
      let dy = Math.abs(yaw - f.yaw) % (Math.PI * 2);
      if (dy > Math.PI) dy = Math.PI * 2 - dy;
      if (d < 30 && dy < 0.6) return true;
      // Two cuts in a row under the same overpass read as one shot.
      if (cov && f.covered && d < 80) return true;
    }
    return false;
  }

  /** Approximate eye and look point a shot will start with. */
  private shotFraming(s: ShotState, pl: Player): [Vec3, Vec3] {
    const p = pl.pos;
    const f = pl.forward;
    const r: Vec3 = [-f[1], 0, f[0]];
    const at = (fw: number, rt: number, up: number): Vec3 => [
      p[0] + f[0] * fw + r[0] * rt,
      p[1] + up,
      p[2] + f[1] * fw + r[2] * rt,
    ];
    switch (s.name) {
      case 'chase':
        return [at(-6.5, 0, 2), at(2, 0, 1)];
      case 'bumper':
      case 'wheel':
      case 'interior':
        return [at(2, 0, 0.8), at(20, 0, 1.5)];
      case 'side':
        return [at(1.5, s.side * 5, 1.1), at(0.5, 0, 0.9)];
      case 'orbit':
        return [this.orbitEye(p, s.a, pl.kind === 'heli'), at(0, 0, 1)];
      default:
        return [
          s.eye,
          s.focus === 'train'
            ? (this.trainTarget() ?? at(0, 0, 1))
            : at(0, 0, 1),
        ];
    }
  }

  /** Last-resort guard: something within ~3 m at the centre of the frame. */
  private centreHit(eye: Vec3, target: Vec3, fov: number) {
    const {f, r, u} = viewBasis(eye, target);
    const tv = Math.tan(fov / 2) * 0.35;
    const th = tv * ASPECT;
    // People and poles (vehicles are tested as boxes).
    const near = this.obstacles().filter(
      o => o[3] < 1 && Math.hypot(o[0] - eye[0], o[2] - eye[2]) < 3 + o[3],
    );
    // The centre and four points around it.
    for (const [x, y] of [
      [0, 0],
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      const d: Vec3 = [
        f[0] + r[0] * x * th + u[0] * y * tv,
        f[1] + u[1] * y * tv,
        f[2] + r[2] * x * th + u[2] * y * tv,
      ];
      const dl = Math.hypot(d[0], d[1], d[2]);
      for (let t = 0.4; t <= 3; t += 0.4) {
        const p: Vec3 = [
          eye[0] + (d[0] / dl) * t,
          eye[1] + (d[1] / dl) * t,
          eye[2] + (d[2] / dl) * t,
        ];
        const push = this.net.collideBuildings(p, 0.01);
        if (push[0] || push[1] || this.inDeck(p, 0) || this.vehicleAt(p))
          return true;
        if (
          x === 0 &&
          y === 0 &&
          p[1] < this.renderedGround(p[0], p[2], p[1]) + 0.05
        )
          return true;
        for (const o of near)
          if (
            Math.hypot(p[0] - o[0], p[2] - o[2]) < o[3] &&
            p[1] > o[1] &&
            p[1] < o[1] + 2
          )
            return true;
      }
    }
    return false;
  }

  /** Height of what is actually drawn at (x, z): terrain, road or junction
   * surface, or the water plane. */
  private renderedGround(x: number, z: number, hint?: number) {
    return Math.max(
      this.net.hf.sample(x, z),
      this.net.surfaceHeight(x, z, hint),
      SEA_LEVEL,
    );
  }

  /** True if near geometry (walls, decks) would fill much of the frame. */
  private crowded(eye: Vec3, target: Vec3, fov: number) {
    // A few metres at a normal lens; much further for long lenses, where
    // anything in the foreground is blown up and hides the subject.
    // At a normal lens, up to most of the way to the subject (a corner 6 m
    // away with the car at 8 m swamps the frame).
    const toSubject = Math.hypot(
      target[0] - eye[0],
      target[1] - eye[1],
      target[2] - eye[2],
    );
    const reach =
      fov < 0.5
        ? clamp(Math.max(7.2 / fov, toSubject * 0.6), 8, 90)
        : clamp(toSubject * 0.7, 4, 8);
    const {f, r, u} = viewBasis(eye, target);
    const tv = Math.tan(fov / 2);
    const th = tv * ASPECT;
    const cols = 6;
    const rows = 4;
    let hits = 0;
    for (let j = 0; j < rows; j++) {
      const y = ((j + 0.5) / rows) * 2 - 1;
      for (let i = 0; i < cols; i++) {
        const x = ((i + 0.5) / cols) * 2 - 1;
        const d: Vec3 = [
          f[0] + r[0] * x * th + u[0] * y * tv,
          f[1] + r[1] * x * th + u[1] * y * tv,
          f[2] + r[2] * x * th + u[2] * y * tv,
        ];
        const dl = Math.hypot(d[0], d[1], d[2]);
        for (let t = 0.5; t <= reach; t += reach > 8 ? reach / 40 : 0.5) {
          const p: Vec3 = [
            eye[0] + (d[0] / dl) * t,
            eye[1] + (d[1] / dl) * t,
            eye[2] + (d[2] / dl) * t,
          ];
          const push = this.net.collideBuildings(p, 0.01);
          if (push[0] || push[1] || this.inDeck(p, 0) || this.vehicleAt(p)) {
            hits++;
            break;
          }
        }
      }
    }
    return hits > cols * rows * 0.3;
  }

  /** Points on the subject that should be on screen. */
  private subjectPoints(pl: Player, focus: 'player' | 'train'): Vec3[] {
    if (focus === 'train') {
      const cars = this.trainCars();
      const m = Math.floor(cars.length / 2);
      return cars
        .slice(Math.max(0, m - 1), m + 2)
        .map(c => [c[0], c[1] + 2.2, c[2]] as Vec3);
    }
    const p = pl.pos;
    const f = pl.forward;
    const half = pl.kind === 'heli' ? 4 : (pl.info?.size[2] ?? 4.5) * 0.4;
    return [
      [p[0], p[1] + 1.1, p[2]],
      [p[0] + f[0] * half, p[1] + 0.8, p[2] + f[1] * half],
      [p[0] - f[0] * half, p[1] + 0.8, p[2] - f[1] * half],
    ];
  }

  /** Most of the subject points are inside the frustum and unoccluded. */
  private subjectVisible(eye: Vec3, target: Vec3, fov: number, pts: Vec3[]) {
    if (!pts.length) return false;
    const {f, r, u} = viewBasis(eye, target);
    const tv = Math.tan(fov / 2);
    const th = tv * ASPECT;
    let seen = 0;
    for (const q of pts) {
      const d: Vec3 = [q[0] - eye[0], q[1] - eye[1], q[2] - eye[2]];
      const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
      if (z < 1) continue;
      const x = (d[0] * r[0] + d[2] * r[2]) / (z * th);
      const y = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * tv);
      if (Math.abs(x) > 0.92 || Math.abs(y) > 0.92) continue;
      if (this.blocked(eye, q)) continue;
      seen++;
    }
    return seen >= Math.ceil(pts.length * 0.6);
  }

  /** A static or starting framing worth cutting to. */
  private frameOk(
    eye: Vec3,
    target: Vec3,
    fov: number,
    pl: Player,
    focus: 'player' | 'train',
  ) {
    return (
      !this.badEye(eye) &&
      !this.blocked(eye, target) &&
      !this.obstructedByPeople(eye, target) &&
      !this.crowded(eye, target, fov) &&
      this.subjectVisible(eye, target, fov, this.subjectPoints(pl, focus))
    );
  }

  private orbitEye(p: Vec3, a: number, heli: boolean): Vec3 {
    const rad = heli ? 26 : 8;
    const eye: Vec3 = [
      p[0] + Math.cos(a) * rad,
      p[1] + (heli ? 13 : 1.8),
      p[2] + Math.sin(a) * rad,
    ];
    eye[1] = Math.max(
      eye[1],
      this.renderedGround(eye[0], eye[2], eye[1]) + 0.8,
    );
    return eye;
  }

  private trainTarget(): Vec3 | null {
    const t = this.trainFocus();
    return t ? [t[0], t[1] + 2.2, t[2]] : null;
  }

  cycle() {
    this.mode =
      CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.yawOff = 0;
  }

  private blocked(a: Vec3, b: Vec3) {
    // The subject's own box (a train car being filmed) doesn't hide it.
    const endBox = this.vehicleAt(b, 0.3);
    // At least every ~2.5 m so long lenses don't step over a deck or a wall.
    const n = Math.max(
      12,
      Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 2.5),
    );
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const p: Vec3 = [
        lerp(a[0], b[0], t),
        lerp(a[1], b[1], t),
        lerp(a[2], b[2], t),
      ];
      if (p[1] < Math.max(this.net.hf.sample(p[0], p[2]), SEA_LEVEL) + 0.3)
        return true;
      const push = this.net.collideBuildings(p, 0.01);
      if (push[0] || push[1]) return true;
      if (this.inDeck(p, 0)) return true;
      const v = this.vehicleAt(p);
      if (v && v !== endBox) return true;
    }
    return false;
  }

  private newShot(pl: Player): ShotState {
    const old = this.shot;
    if (old?.framing && (old.shown ?? 0) > 0.5) {
      this.framings.unshift(old.framing);
      this.framings.length = Math.min(this.framings.length, 2);
    }
    const s = this.pickShot(pl);
    this.recent.unshift(s.name);
    this.recent.length = Math.min(this.recent.length, 3);
    return s;
  }

  private pickShot(pl: Player): ShotState {
    const isHeli = pl.kind === 'heli';
    const names = SHOTS.filter(
      s =>
        s !== this.shot?.name &&
        !(isHeli && ['bumper', 'interior', 'wheel', 'side'].includes(s)) &&
        !(s === 'train' && !this.nearTrain(pl)),
    );
    const last = this.recent[0];
    for (let attempt = 0; attempt < 16; attempt++) {
      const slow = pl.speed < 2;
      const name = this.rng.weighted(
        names,
        names.map(n => {
          let w = WEIGHTS[n];
          if (slow && ['flyby', 'side', 'bumper', 'wheel'].includes(n))
            w *= 0.2;
          // Don't keep coming back to the same kind of framing.
          const ago = this.recent.indexOf(n);
          if (ago >= 0) w *= ago === 0 ? 0.15 : ago === 1 ? 0.4 : 0.7;
          if (last && FAMILY[n] && FAMILY[n] === FAMILY[last]) w *= 0.3;
          return w;
        }),
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
      const ground = (x: number, z: number) => this.renderedGround(x, z, p[1]);
      switch (name) {
        case 'flyby': {
          const ahead = Math.max(15, pl.speed * 3.5);
          const x = p[0] + f[0] * ahead + r[0] * s.side * this.rng.range(4, 7);
          const z = p[2] + f[1] * ahead + r[2] * s.side * this.rng.range(4, 7);
          s.eye = [
            x,
            // Helicopters are filmed from above so the city fills the frame.
            (isHeli ? p[1] + 12 : ground(x, z)) + this.rng.range(0.8, 2.5),
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
            // Nor near a viaduct: at this focal length it becomes a wall.
            if (this.inDeck(s.eye, 25)) continue;
          }
          break;
        }
        case 'aerial': {
          // Somewhere behind the vehicle (within 60 degrees), from a steep
          // overhead down to a shallow pass that shows the skyline and horizon.
          const yaw = Math.atan2(-f[1], -f[0]) + this.rng.range(-1, 1) * 1.05;
          const shallow = this.rng.chance(0.4);
          const pitch = shallow
            ? this.rng.range(0.14, 0.3)
            : this.rng.range(0.4, 0.95);
          const d = shallow ? this.rng.range(70, 130) : this.rng.range(90, 180);
          const x = p[0] + Math.cos(yaw) * d * Math.cos(pitch);
          const z = p[2] + Math.sin(yaw) * d * Math.cos(pitch);
          const y = Math.max(p[1] + Math.sin(pitch) * d, ground(x, z) + 12);
          s.eye = [x, y, z];
          s.fov = this.rng.range(0.65, 0.85);
          break;
        }
        case 'train': {
          const tp = this.trainTarget();
          const cars = this.trainCars();
          if (!tp || !cars.length) continue;
          s.focus = 'train';
          // Beside the line, across the street: from the pavement looking up
          // at the viaduct, or level with the deck from further back.
          const a = cars[0];
          const b = cars[cars.length - 1];
          let dx = b[0] - a[0];
          let dz = b[2] - a[2];
          let l = Math.hypot(dx, dz);
          if (l < 1) {
            dx = Math.cos(s.a);
            dz = Math.sin(s.a);
            l = 1;
          }
          dx /= l;
          dz /= l;
          const high = this.rng.chance(0.7);
          const lat = this.rng.range(high ? 25 : 35, high ? 55 : 60) * s.side;
          const along = this.rng.range(-30, 30);
          const x = tp[0] - dz * lat + dx * along;
          const z = tp[2] + dx * lat + dz * along;
          const g = this.renderedGround(x, z, this.net.hf.sample(x, z));
          // Level with or above the deck the whole train clears the parapet
          // and the street trees; from street level it is seen from afar.
          const y = high
            ? Math.max(g + 1.6, tp[1] + this.rng.range(0, 8))
            : g + this.rng.range(1.6, 4);
          s.eye = [x, y, z];
          s.fov = this.rng.range(0.6, 0.85);
          break;
        }
        case 'orbit': {
          // Check the arc the orbit will sweep; shorten the shot where it
          // would swing into a wall, reject it if that is almost at once.
          let clear = s.dur;
          for (let k = 0; k <= 6; k++) {
            const tt = (s.dur * k) / 6;
            const pk: Vec3 = [
              p[0] + f[0] * pl.speed * tt,
              p[1],
              p[2] + f[1] * pl.speed * tt,
            ];
            const eye = this.orbitEye(pk, s.a + tt * 0.35 * s.side, isHeli);
            const tgt: Vec3 = [pk[0], pk[1] + (isHeli ? -5 : 1), pk[2]];
            const ok =
              k === 0
                ? this.frameOk(eye, tgt, 0.9, pl, 'player')
                : !this.badEye(eye) &&
                  !this.blocked(eye, tgt) &&
                  !this.crowded(eye, tgt, 0.9);
            if (!ok) {
              clear = (s.dur * (k - 1)) / 6;
              break;
            }
          }
          if (clear < 3) continue;
          s.dur = clear;
          s.eye = [...p];
          break;
        }
        default:
          s.eye = [...p];
      }
      if (['flyby', 'telephoto', 'aerial', 'train'].includes(name)) {
        const target =
          s.focus === 'train'
            ? this.trainTarget()!
            : ([p[0], p[1] + 1, p[2]] as Vec3);
        if (!this.frameOk(s.eye, target, s.fov, pl, s.focus)) continue;
        // Static cameras: follow the car's path ahead and end the shot
        // before it drives behind something.
        if (s.focus === 'player' && name !== 'aerial' && pl.speed > 1) {
          let clear = s.dur;
          for (let tt = 0.5; tt <= s.dur; tt += 0.5) {
            const q: Vec3 = [
              p[0] + f[0] * pl.speed * tt,
              p[1] + 1,
              p[2] + f[1] * pl.speed * tt,
            ];
            if (this.blocked(s.eye, q)) {
              clear = tt - 0.5;
              break;
            }
          }
          if (clear < 2.5) continue;
          s.dur = clear;
        }
      }
      // Same spot, same direction, or the same overpass as a recent cut.
      const [fe, fl] = this.shotFraming(s, pl);
      if (attempt < 10 && this.repeatsFraming(fe, fl)) continue;
      s.framing = {
        eye: fe,
        yaw: Math.atan2(fl[0] - fe[0], fl[2] - fe[2]),
        covered: this.covered(fe),
      };
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
    snap = false,
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
    // A cut into a chase starts at its framing instead of sliding over from
    // wherever the previous shot left the camera.
    const k = snap ? 1 : 1 - Math.exp(-dt * lag);
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
          // Close to level by default (pitchOff rests at 0.12): the road
          // and city fill the frame, the dashboard only its lower edge.
          e[1] + 0.05 - (this.pitchOff - 0.12) * 5,
          e[2] + Math.cos(this.yawOff) * 10,
        ]);
        // Natural lens: the road and city fill the windscreen, not the dash.
        // Slightly long lens: less headliner and dash, more street.
        return {eye, target: look, fov: 0.88, near: 0.03, interior: true};
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
    if (e[1] < this.renderedGround(e[0], e[2], e[1]) + 0.25) return true;
    const push = this.net.collideBuildings(e, 1.2);
    if (push[0] !== 0 || push[1] !== 0) return true;
    if (this.inDeck(e, 1.5)) return true;
    if (this.vehicleAt(e, 0.8)) return true;
    for (const o of this.obstacles()) {
      // Radius-aware: buses and trucks are long, poles thin.
      if (
        Math.hypot(o[0] - e[0], o[2] - e[2]) < o[3] + 0.8 &&
        e[1] - o[1] < 3.6
      )
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
    this.refreshVehicles(pl);
    let out = this.directedRaw(dt, pl);
    // Never below the local ground or sidewalk, even for locked shots.
    if (!out.interior) {
      const g = this.renderedGround(out.eye[0], out.eye[2], out.eye[1]);
      if (out.eye[1] < g + 0.6) out.eye = [out.eye[0], g + 0.6, out.eye[2]];
    }
    if (this.locked) return out;
    // Periodically verify the subject is visible; cut if blocked for a while.
    this.losTimer += dt;
    if (this.shot && this.shot.name !== 'interior' && this.losTimer > 0.1) {
      this.losTimer = 0;
      const tgt =
        this.shot.focus === 'train'
          ? (this.trainTarget() ?? pl.pos)
          : ([pl.pos[0], pl.pos[1] + 0.8, pl.pos[2]] as Vec3);
      const hidden = this.blocked(out.eye, tgt);
      const lost =
        WIDE.has(this.shot.name) &&
        !this.subjectVisible(
          out.eye,
          out.target,
          out.fov,
          this.subjectPoints(pl, this.shot.focus),
        );
      // A wall in the lens or a subject gone from view: cut at once. A brief
      // partial occlusion (a pole, a pedestrian) may pass, so wait for it.
      const severe =
        this.badEye(out.eye) ||
        this.crowded(out.eye, out.target, out.fov) ||
        (hidden && lost);
      this.blockedFor = severe
        ? 1
        : hidden || lost || this.obstructedByPeople(out.eye, tgt)
          ? this.blockedFor + 0.1
          : 0;
      if (this.blockedFor > 0.5) {
        this.blockedFor = 0;
        this.shot = this.newShot(pl);
        out = this.directedRaw(0, pl);
      }
    }
    // Cut away from shots whose camera ends up inside or against geometry,
    // or that have anything (a wall, a bus, a train) right in front of the lens.
    for (
      let tries = 0;
      tries < 4 &&
      this.shot &&
      this.shot.name !== 'interior' &&
      (this.badEye(out.eye) || this.centreHit(out.eye, out.target, out.fov));
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
    s.shown = (s.shown ?? 0) + dt;
    pl.hidden = false;
    const p = pl.pos;
    const f = pl.forward;
    const r: Vec3 = [-f[1], 0, f[0]];
    const focus: Vec3 =
      s.focus === 'train'
        ? (this.trainTarget() ?? p)
        : [p[0], p[1] + 1.0, p[2]];
    switch (s.name) {
      case 'chase':
        return this.chase(dt, pl, 6.5, 1.8, 3, s.t <= dt + 1e-6);
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
        const heli = pl.kind === 'heli';
        const eye = this.orbitEye(p, s.a, heli);
        // Aim a little below a helicopter: it sits against the city, not the sky.
        const tgt: Vec3 = heli ? [focus[0], focus[1] - 6, focus[2]] : focus;
        return {eye, target: tgt, fov: 0.9, near: 0.1, interior: false};
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
        const look = pl.toWorld([e[0] * 0.5, e[1] + 0.02, e[2] + 8]);
        return {eye, target: look, fov: 1.05, near: 0.03, interior: true};
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

/** Fly-anywhere camera: WASD / arrows move, Space/E up, Shift/Q down,
 * mouse drag (or right-half touch) looks, left-half touch moves, wheel = speed. */
export class FreeCamera {
  pos: Vec3 = [0, 100, 0];
  yaw = 0;
  pitch = -0.2;
  speed = 30;
  fov = 1.0;

  setPose(p: Vec3, yaw: number, pitch: number, fov = 1.0) {
    this.pos = [...p];
    this.yaw = yaw;
    this.pitch = pitch;
    this.fov = fov;
  }

  update(dt: number, input: Input): CamOut {
    this.yaw += input.mouseDX * 0.003;
    this.pitch = clamp(this.pitch - input.mouseDY * 0.003, -1.5, 1.5);
    this.speed = clamp(this.speed * Math.pow(1.15, -input.wheel), 2, 600);
    const f: Vec3 = [
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    ];
    const r: Vec3 = [Math.cos(this.yaw), 0, Math.sin(this.yaw)];
    const fwd =
      input.axis('KeyW', 'ArrowUp') -
      input.axis('KeyS', 'ArrowDown') -
      input.touchMove[1];
    const side =
      input.axis('KeyD', 'ArrowRight') -
      input.axis('KeyA', 'ArrowLeft') +
      input.touchMove[0];
    const up = input.axis('Space', 'KeyE') - input.axis('ShiftLeft', 'KeyQ');
    const sp = this.speed * (input.down('ShiftRight') ? 4 : 1) * dt;
    this.pos = [
      this.pos[0] + (f[0] * fwd + r[0] * side) * sp,
      this.pos[1] + (f[1] * fwd + up) * sp,
      this.pos[2] + (f[2] * fwd + r[2] * side) * sp,
    ];
    return {
      eye: [...this.pos],
      target: [this.pos[0] + f[0], this.pos[1] + f[1], this.pos[2] + f[2]],
      fov: this.fov,
      near: 0.3,
      interior: false,
    };
  }
}
