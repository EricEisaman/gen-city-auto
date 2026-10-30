// Game orchestration: city loading, simulation systems, cameras and the
// render loop.

import type {CityType} from '../city/config.ts';
import {reportError, resizeToCss, type Gpu} from '../gpu/device.ts';
import {Rng} from '../math/random.ts';
import type {Vec3} from '../math/vec.ts';
import {RainRenderer} from '../render/rain.ts';
import {LightSprites} from '../render/sprites.ts';
import {streetLightSpots} from '../city/gen-base.ts';
import type {CityLayout} from '../city/layout.ts';
import {GBUFFER_FORMATS, Renderer} from '../render/renderer.ts';
import {VehicleRenderer} from '../render/vehicles.ts';
import {UI} from '../ui/ui.ts';
import {City} from '../world/city.ts';
import {
  CameraSystem,
  CAMERA_MODES,
  FreeCamera,
  type CameraMode,
  type VehicleBox,
} from './camera.ts';
import {Input} from './input.ts';
import {Pedestrians} from './pedestrians.ts';
import {Player} from './player.ts';
import {RoadNet} from './roadnet.ts';
import {Traffic} from './traffic.ts';
import {AmbientHelis, Trains} from './trains.ts';
import {WEATHER_KINDS, WeatherSystem, type WeatherKind} from './weather.ts';

export interface GameOptions {
  cityType: CityType;
  seed: number;
  hour: number;
  timeSpeed: number;
  weather: WeatherKind;
  camera?: CameraMode;
  director: boolean;
  vehicle: string;
  spawn?: [number, number];
  shot?: string;
  debug: number;
  traffic: number;
  /** Fixed camera for tests: x, y, z, yaw, pitch. */
  freecam?: number[];
  quality: number;
}

export class Game {
  renderer!: Renderer;
  vehicles!: VehicleRenderer;
  rain!: RainRenderer;
  sprites!: LightSprites;
  city: City | null = null;
  net: RoadNet | null = null;
  traffic: Traffic | null = null;
  trains: Trains | null = null;
  helis: AmbientHelis | null = null;
  peds: Pedestrians | null = null;
  player!: Player;
  camera!: CameraSystem;
  weather = new WeatherSystem();
  input: Input;
  ui!: UI;
  cityType: CityType;
  seed: number;
  hour: number;
  timeSpeed: number;
  time = 0;
  private gpu: Gpu;
  private opts: GameOptions;
  private loading = false;
  private frames = 0;
  private fpsAvg = 60;
  private carLights = new Float32Array(64 * 8);
  /** Free-fly inspection camera (the vehicle keeps driving itself). */
  freeCam = new FreeCamera();
  freeMode = false;
  private noInput = {
    driveActive: () => false,
    axis: () => 0,
    down: () => false,
    hit: () => false,
    gamepadSteer: () => 0,
    gamepadThrottle: () => 0,
    mouseDX: 0,
    mouseDY: 0,
    wheel: 0,
    dragging: false,
    touchMove: [0, 0],
  } as unknown as Input;
  /** Last camera output (for tests). */
  lastCam: {eye: Vec3; target: Vec3; fov: number} | null = null;

  constructor(gpu: Gpu, opts: GameOptions) {
    this.gpu = gpu;
    this.opts = opts;
    this.cityType = opts.cityType;
    this.seed = opts.seed;
    this.hour = opts.hour;
    this.timeSpeed = opts.timeSpeed;
    this.weather.set(opts.weather, true);
    this.input = new Input(gpu.canvas);
  }

  async init() {
    this.renderer = await Renderer.create(this.gpu);
    this.vehicles = new VehicleRenderer(
      this.renderer,
      this.renderer.frameBuffer,
      this.renderer.shadowViewBuffers,
    );
    this.rain = new RainRenderer(
      this.renderer.device,
      this.renderer.frameBuffer,
      'rgba16float',
    );
    this.sprites = new LightSprites(
      this.renderer.device,
      this.renderer.frameBuffer,
      'rgba16float',
    );
    this.renderer.hooks.push(this.vehicles, this.rain, this.sprites);
    const progress = this.progress.bind(this);
    progress('Building vehicles from NURBS', 0.02);
    await Promise.all([
      this.vehicles.init(GBUFFER_FORMATS, 'rgba16float'),
      this.loadCity(this.cityType, this.seed),
    ]);
    this.setupWorld();
    this.ui = new UI(this);
    if (this.opts.camera) {
      this.camera.mode = this.opts.camera;
      this.camera.directorEnabled = this.opts.director;
    }
  }

  private progress(msg: string, f: number) {
    const m = document.getElementById('loadmsg');
    const b = document.getElementById('loadbar');
    if (m) m.textContent = msg;
    if (b) b.style.width = `${Math.round(f * 100)}%`;
  }

  private spawnPoint(): Vec3 {
    if (this.opts.spawn) return [this.opts.spawn[0], 0, this.opts.spawn[1]];
    const L = this.city!.summary.layout;
    // Start in a dense district (a sub-center), not beside the central park.
    const hub = (L.hubs[1] ?? L.hubs[0]).p;
    return [hub[0] + 60, 0, hub[1] + 40];
  }

  private async loadCity(type: CityType, seed: number) {
    this.loading = true;
    document.getElementById('loading')!.style.display = '';
    this.city?.dispose();
    this.city = new City(this.renderer, type, seed);
    let focus: Vec3 = [0, 0, 0];
    const city = this.city;
    await city.load(this.progress.bind(this), () => focus);
    // Focus streaming on the spawn point before revealing.
    focus = this.spawnPoint();
    city.updateStreaming(focus);
    this.net = new RoadNet(city.summary, city.heights);
    this.loading = false;
  }

  private setupWorld() {
    const city = this.city!;
    const net = this.net!;
    this.traffic = new Traffic(net, this.vehicles);
    this.buildLightSprites();
    this.traffic.target = this.opts.traffic;
    this.trains = new Trains(city.summary.layout.elevated, this.vehicles);
    this.helis = new AmbientHelis(
      city.summary.layout.hubs,
      this.vehicles,
      (x, z) => city.groundHeight(x, z),
    );
    this.peds = new Pedestrians(
      net,
      this.vehicles,
      city.summary.layout.hubs.map(h => h.p),
    );
    this.player = new Player(
      net,
      this.vehicles,
      city.summary.layout.hubs.map(h => h.p),
    );
    this.camera = new CameraSystem(net);
    this.camera.obstacles = () => {
      const out: [number, number, number, number][] = [];
      const e = this.player.pos;
      for (const p of this.peds?.peds ?? []) {
        const m = p.model;
        if (Math.abs(m[12] - e[0]) < 40 && Math.abs(m[14] - e[2]) < 40)
          out.push([m[12], m[13], m[14], 0.4]);
      }
      for (const c of this.traffic?.cars ?? []) {
        const m = c.model;
        if (Math.abs(m[12] - e[0]) < 40 && Math.abs(m[14] - e[2]) < 40)
          out.push([
            m[12],
            m[13],
            m[14],
            Math.max(
              2.0,
              (this.vehicles.variants[c.variant]?.info.size[2] ?? 4) / 2,
            ),
          ]);
      }
      for (const p of this.net?.polesNear(e[0], e[2], 40) ?? [])
        out.push([p[0], p[1], p[2], 0.25]);
      return out;
    };
    this.camera.setElevated(city.summary.layout.elevated);
    this.camera.setSolids(city.summary.solids ?? []);
    this.camera.vehicles = () => {
      // Traffic (cars, buses, trucks) and train cars as oriented boxes.
      const out: VehicleBox[] = [];
      const e = this.player.pos;
      const add = (m: Float32Array | number[], size: Vec3) => {
        if (Math.abs(m[12] - e[0]) > 260 || Math.abs(m[14] - e[2]) > 260)
          return;
        const fl = Math.hypot(m[8], m[10]) || 1;
        out.push({
          x: m[12],
          y: m[13],
          z: m[14],
          fx: m[8] / fl,
          fz: m[10] / fl,
          hl: size[2] / 2,
          hw: size[0] / 2,
          h: size[1],
        });
      };
      const vs = this.vehicles.variants;
      for (const c of this.traffic?.cars ?? [])
        add(c.model, vs[c.variant]?.info.size ?? [1.8, 1.5, 4.5]);
      for (const tr of this.trains?.trains ?? [])
        for (const c of tr.cars)
          add(c.model, vs[tr.variant]?.info.size ?? [3, 4, 20]);
      return out;
    };
    this.camera.trainCars = () => {
      // Car positions of the train nearest the player.
      const t = this.trains!;
      let best: Vec3[] = [];
      let bd = Infinity;
      for (const tr of t.trains) {
        const m = tr.cars[Math.floor(tr.cars.length / 2)]?.model;
        if (!m) continue;
        const d = Math.hypot(
          m[12] - this.player.pos[0],
          m[14] - this.player.pos[2],
        );
        if (d < bd) {
          bd = d;
          best = tr.cars.map(c => [c.model[12], c.model[13], c.model[14]]);
        }
      }
      return best;
    };
    this.camera.trainFocus = () => {
      // Nearest train car to the player.
      const t = this.trains!;
      let best: Vec3 | null = null;
      let bd = Infinity;
      for (let i = 0; i < t.trains.length; i++) {
        const p = t.focusPoint(i);
        if (!p) continue;
        const d = Math.hypot(
          p[0] - this.player.pos[0],
          p[2] - this.player.pos[2],
        );
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      return best;
    };
    const sp = this.spawnPoint();
    const vname = this.opts.vehicle;
    if (vname === 'heli' || vname === 'helicopter') {
      this.player.pos = [sp[0], 0, sp[2]];
      this.player.spawnHeli(this.pickVariant('helicopter'));
    } else {
      const named = this.vehicles.variants.findIndex(
        v => v.info.name === vname,
      );
      this.player.spawnCar(
        sp[0],
        sp[2],
        named >= 0 ? named : this.pickVariant('car', 'sports'),
      );
    }
    const fc = this.opts.freecam;
    if (fc) {
      this.freeCam.setPose(
        [fc[0], fc[1], fc[2]],
        fc[3] ?? 0,
        fc[4] ?? 0,
        fc[5] || 1.0,
      );
      this.freeMode = true;
    }
    if (this.opts.shot) this.forceShot(this.opts.shot);
    // Warm up traffic so the streets are busy immediately.
    for (let i = 0; i < 40; i++)
      this.traffic.update(
        0.25,
        this.time + i * 0.25,
        this.player.pos,
        this.player.follower ? [this.player.follower] : [],
      );
    document.getElementById('loading')!.style.display = 'none';
  }

  private pickVariant(kind: string, prefer?: string): number {
    const v = this.vehicles.variants;
    if (prefer) {
      const i = v.findIndex(x => x.info.name === prefer);
      if (i >= 0) return i;
    }
    const list = this.vehicles.variantsOf(kind);
    if (list.length) return list[0];
    const any = v.findIndex(
      x => !['train', 'helicopter', 'person'].includes(x.info.kind),
    );
    return Math.max(0, any);
  }

  forceShot(name: string, lock = true) {
    this.camera.directorEnabled = true;
    const pl = this.player;
    const cam = this.camera as unknown as {
      shot: {name: string; t: number; dur: number} | null;
      newShotNamed?: (n: string) => void;
    };
    cam.shot = null;
    this.camera.locked = false;
    // Ask the director repeatedly until it picks the requested shot.
    for (let i = 0; i < 200; i++) {
      this.camera.update(0.01, pl, this.input);
      if (this.camera.shot?.name === name) {
        this.camera.shot.dur = 1e9;
        this.camera.locked = lock;
        return;
      }
      if (this.camera.shot) this.camera.shot.t = 1e9;
    }
  }

  selectVehicle(i: number) {
    const info = this.vehicles.variants[i]?.info;
    if (!info) return;
    if (info.kind === 'helicopter') this.player.spawnHeli(i);
    else this.player.spawnCar(this.player.pos[0], this.player.pos[2], i);
  }

  async regenerate(type: CityType, seed: number) {
    if (this.loading) return;
    this.cityType = type;
    this.seed = seed;
    this.opts.spawn = undefined;
    const url = new URL(location.href);
    url.searchParams.set('city', type);
    url.searchParams.set('seed', String(seed));
    history.replaceState(null, '', url);
    try {
      await this.loadCity(type, seed);
      this.setupWorld();
    } catch (e) {
      reportError(`[regenerate] ${e instanceof Error ? e.stack : e}`);
    }
  }

  /** Lane segments and lamp heads for the distant night light sprites. */
  private buildLightSprites() {
    const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
    const net = this.net!;
    const L = this.city!.summary.layout;
    const segs: number[] = [];
    let lanes = 0;
    // One continuous stream of cars per lane: segments carry their distance
    // along the lane so cars flow across segment boundaries.
    const stream = (pts: Vec3[], off: number, speed: number, gap: number) => {
      const id = (lanes++ * 0.6180339) % 1000;
      const v = speed * (0.85 + ((id * 7.13) % 1) * 0.3);
      let s = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
        // Each segment shows at most 4 cars (CARS_PER_SEG).
        const parts = Math.ceil(len / (gap * 1.5));
        for (let k = 0; k < parts; k++) {
          const a = lerp3(p, q, k / parts);
          const b = lerp3(p, q, (k + 1) / parts);
          segs.push(...a, off, ...b, id, s + (len * k) / parts, v, gap, 0);
        }
        s += len;
      }
    };
    const both = (pts: Vec3[], offs: number[], speed: number, gap: number) => {
      const rev = [...pts].reverse();
      for (const off of offs) {
        stream(pts, off, speed, gap);
        stream(rev, off, speed, gap);
      }
    };
    net.chains.forEach((c, ci) => {
      if (c.kind < 1) return;
      const pts = c.pts.map((q, i): Vec3 => [q[0], c.heights[i], q[1]]);
      const offs = [...Array(net.lanesPerDir(ci)).keys()].map(k =>
        net.laneOffset(ci, k),
      );
      // City traffic: 30-50 km/h.
      both(pts, offs, c.kind >= 2 ? 12 : 10, 30);
    });
    for (const e of L.elevated) {
      if (e.kind !== 'expressway') continue;
      const pts = e.pts.map((q, i): Vec3 => [q[0], e.heights[i], q[1]]);
      // Shuto expressway: ~70 km/h.
      both(pts, [2.2, 5.6], 19, 40);
    }
    const lamps: number[] = [];
    streetLightSpots(
      L as unknown as CityLayout,
      net.geom,
      net.hf,
      (p, dir, kind, sodium) => {
        const reach = kind >= 2 ? 2.2 : 1.2;
        const h = kind >= 2 ? 9 : 6.5;
        lamps.push(
          p[0] + dir[0] * reach,
          p[1] + h - 0.4,
          p[2] + dir[1] * reach,
          sodium ? 1 : 0,
        );
      },
    );
    this.sprites.setData(new Float32Array(segs), new Float32Array(lamps));
  }

  /** Motion blur and depth of field per camera shot. */
  private cinematics(eye: Vec3) {
    const shot =
      this.camera.shot?.name ?? (this.camera.mode === 'chase' ? 'chase' : '');
    const focus = Math.hypot(
      this.player.pos[0] - eye[0],
      this.player.pos[1] - eye[1],
      this.player.pos[2] - eye[2],
    );
    const blur: Record<string, number> = {
      chase: 0.8,
      bumper: 1,
      side: 1,
      wheel: 1,
      flyby: 0.9,
      orbit: 0.6,
    };
    const dof: Record<string, number> = {
      // Shallow focus only where it reads as a lens choice (long lens,
      // close-ups); everyday angles stay sharp.
      telephoto: 0.35,
      side: 0.15,
      wheel: 0.5,
    };
    if (this.freeMode) return {motionBlur: 0, dofAperture: 0, focus};
    const moving = Math.min(1, Math.abs(this.player.speed) / 3);
    return {
      motionBlur: (blur[shot] ?? 0.3) * moving,
      dofAperture: dof[shot] ?? 0,
      focus,
    };
  }

  /** Vehicle button / B key: next variant of the same family (car or heli). */
  nextVehicle() {
    const v = this.vehicles.variants;
    const kinds =
      this.player.kind === 'heli'
        ? ['helicopter']
        : ['car', 'taxi', 'van', 'truck', 'bus'];
    for (let k = 1; k <= v.length; k++) {
      const idx = (this.player.variant + k) % v.length;
      if (kinds.includes(v[idx].info.kind)) {
        this.selectVehicle(idx);
        break;
      }
    }
  }

  /** Camera button / C key: director -> chase -> first -> hood -> orbit -> free. */
  cycleCamera() {
    if (this.freeMode) {
      this.freeMode = false;
      this.camera.directorEnabled = true;
      return;
    }
    if (this.camera.directorEnabled && this.player.autopilot) {
      this.camera.directorEnabled = false;
      this.camera.mode = CAMERA_MODES[0];
      return;
    }
    if (this.camera.mode === CAMERA_MODES[CAMERA_MODES.length - 1]) {
      const c = this.lastCam;
      if (c) {
        const [yaw, pitch] = yawPitch(c.eye, c.target);
        this.freeCam.setPose(c.eye, yaw, pitch);
      }
      this.freeMode = true;
      return;
    }
    this.camera.cycle();
  }

  /** Link that reproduces the current view (camera pose, time, weather, city). */
  shareUrl(): string {
    const u = new URL(location.href);
    const c = this.lastCam;
    if (c) {
      const [yaw, pitch] = yawPitch(c.eye, c.target);
      u.searchParams.set(
        'freecam',
        // Field of view only when it isn't the free camera's default, so
        // telephoto shots reproduce at their focal length.
        [...c.eye, yaw, pitch, ...(Math.abs(c.fov - 1) > 0.005 ? [c.fov] : [])]
          .map(v => v.toFixed(2))
          .join(','),
      );
    }
    u.searchParams.set('city', this.cityType);
    u.searchParams.set('seed', String(this.seed));
    u.searchParams.set('time', this.hour.toFixed(2));
    u.searchParams.set('timespeed', '0');
    u.searchParams.set('weather', this.weather.kind);
    u.searchParams.delete('shot');
    return u.toString().replace(/%2C/g, ',');
  }

  private handleKeys() {
    const i = this.input;
    if (i.hit('KeyC')) this.cycleCamera();
    if (i.hit('KeyL')) void navigator.clipboard?.writeText(this.shareUrl());
    if (i.hit('KeyK'))
      this.camera.directorEnabled = !this.camera.directorEnabled;
    if (i.hit('KeyT')) this.hour = (this.hour + 1) % 24;
    if (i.hit('KeyY'))
      this.weather.set(
        WEATHER_KINDS[
          (WEATHER_KINDS.indexOf(this.weather.kind) + 1) % WEATHER_KINDS.length
        ],
      );
    if (i.hit('KeyN'))
      void this.regenerate(this.cityType, Math.floor(Math.random() * 100000));
    if (i.hit('KeyM')) this.ui.toggleMenu();
    if (i.hit('KeyH')) this.ui.toggleHelp();
    if (i.hit('KeyF')) this.ui.showStats = !this.ui.showStats;
    if (i.hit('KeyV')) {
      if (this.player.kind === 'car')
        this.player.spawnHeli(this.pickVariant('helicopter'));
      else
        this.player.spawnCar(
          this.player.pos[0],
          this.player.pos[2],
          this.pickVariant('car', 'sports'),
        );
    }
    if (i.hit('KeyB')) this.nextVehicle();
  }

  frame(dt: number) {
    if (this.loading || !this.city || !this.traffic) return;
    resizeToCss(this.gpu.canvas);
    this.handleKeys();
    this.time += dt;
    this.hour = (this.hour + dt * this.timeSpeed + 24) % 24;
    this.weather.update(dt);
    this.player.update(
      dt,
      this.freeMode ? this.noInput : this.input,
      this.time,
    );
    const cam = this.freeMode
      ? this.freeCam.update(dt, this.input)
      : this.camera.update(dt, this.player, this.input);
    const focus = this.player.pos;
    this.traffic.update(
      dt,
      this.time,
      focus,
      this.player.follower && this.player.autopilot
        ? [this.player.follower]
        : [],
    );
    this.trains!.update(dt);
    this.helis!.update(dt);
    this.peds!.update(dt, cam.eye);
    this.city.updateStreaming(cam.eye);
    const night = this.renderer.sky.night;
    const lightsOn = night > 0.3 || this.weather.state.rain > 0.3 ? 1 : 0;
    // Headlights of the player and nearby traffic become dynamic lights.
    let n = 0;
    const addHeadlights = (model: Float32Array, len: number) => {
      if (n >= 64 || !lightsOn) return;
      // Spotlight at the front bumper; kind 5 + yaw/2pi encodes its direction.
      const p: Vec3 = [
        model[12] + model[8] * (len / 2 + 0.3),
        model[13] + 0.75,
        model[14] + model[10] * (len / 2 + 0.3),
      ];
      const yaw = (Math.atan2(model[8], model[10]) / (Math.PI * 2) + 1) % 1;
      this.carLights.set(
        [p[0], p[1], p[2], 24, 0.8, 0.77, 0.7, 5 + Math.min(yaw, 0.999)],
        n * 8,
      );
      n++;
    };
    addHeadlights(this.player.model, this.player.info?.size[2] ?? 4.5);
    const near = this.traffic.cars
      .map(c => ({
        c,
        d: Math.hypot(c.model[12] - cam.eye[0], c.model[14] - cam.eye[2]),
      }))
      .filter(x => x.d < 120)
      .sort((a, b) => a.d - b.d)
      .slice(0, 40);
    for (const {c} of near) addHeadlights(c.model, 4.5);
    this.city.updateLights(
      cam.eye,
      night,
      1,
      this.carLights.subarray(0, n * 8),
    );
    // Vehicles.
    this.vehicles.begin(cam.eye);
    this.player.draw(lightsOn);
    this.traffic.draw(lightsOn);
    this.trains!.draw(lightsOn);
    this.helis!.draw(this.time, lightsOn);
    this.peds!.draw();
    this.vehicles.finish();
    this.lastCam = cam;
    this.rain.intensity = this.weather.state.rain;
    this.renderer.render({
      eye: cam.eye,
      target: cam.target,
      fov: cam.fov,
      near: cam.near,
      time: this.time,
      dt,
      hour: this.hour,
      weather: this.weather.state,
      debug: this.opts.debug,
      quality: this.opts.quality,
      ...this.cinematics(cam.eye),
      // Lens rain drops read as floating rings; leave them off.
      lensDrops: false,
    });
    this.input.endFrame();
    this.fpsAvg = this.fpsAvg * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this.frames++;
    if (this.frames % 10 === 0) this.ui.update(this.fpsAvg);
    window.__stats = {
      ...this.renderer.stats,
      ...this.city.stats,
      fps: Math.round(this.fpsAvg),
      cars: this.traffic.cars.length,
      shot: this.camera.shot?.name ?? this.camera.mode,
      eye: cam.eye.map(v => Math.round(v)),
    };
    if (this.frames === 20) window.__ready = true;
  }

  get rngSeed() {
    return new Rng(this.seed);
  }
}

function yawPitch(eye: Vec3, target: Vec3): [number, number] {
  const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [Math.atan2(d[0], -d[2]), Math.asin(d[1] / l)];
}
