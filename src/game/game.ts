// Game orchestration: city loading, simulation systems, cameras and the
// render loop.

import {lowMemory} from '../caps.ts';
import {PRESETS as PRESETS_CITY, type CityType} from '../city/config.ts';
import {signLocaleOf} from '../city/signs.ts';
import {reportError, resizeToCss, type Gpu} from '../gpu/device.ts';
import {Rng} from '../math/random.ts';
import type {Vec3} from '../math/vec.ts';
import {RainRenderer} from '../render/rain.ts';
import {LightSprites} from '../render/sprites.ts';
import {streetLightSpots} from '../city/gen-base.ts';
import type {LabSpec} from '../city/lab.ts';
import type {CityLayout} from '../city/layout.ts';
import {GBUFFER_FORMATS, Renderer} from '../render/renderer.ts';
import {VehicleRenderer} from '../render/vehicles.ts';
import {CpuProfiler} from '../render/profiler.ts';
import {OFF_BITS, parseOff} from '../render/ablation.ts';
import {UI} from '../ui/ui.ts';
import {loading as loadScreen, nextPaint} from '../ui/loading.ts';
import {begin, finish, mark, timed, timedAsync} from '../ui/timeline.ts';
import {
  deviceDefaults,
  DynamicScale,
  FIELDS,
  PRESETS,
  autoScale,
  clearStored,
  loadStored,
  saveStored,
  type Settings,
} from '../ui/settings.ts';
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
  /** The director swaps the filmed vehicle between shots (off with ?vehicle=, ?shot=, ?swap=0). */
  swap?: boolean;
  vehicle: string;
  spawn?: [number, number];
  shot?: string;
  debug: number;
  traffic: number;
  /** Fixed camera for tests: x, y, z, yaw, pitch. */
  freecam?: number[];
  quality: number;
  /** Asset lab: show one asset alone, no traffic, fixed camera presets. */
  lab?: LabSpec;
  /** Asset lab camera preset (see LabInfo.views). */
  view?: string;
  /**
   * GPU and CPU timing into window.__stats: 'pass' = every pass segment
   * timed separately (?prof=1), 'frame' = whole passes only (?prof=frame).
   */
  prof?: 'pass' | 'frame';
  /** Ablation bits (?off=..., see render/ablation.ts). */
  off?: number;
  /** LOD2 distance in metres (?lod2=, 0 = LOD1 shells everywhere; else the setting). */
  lod2?: number;
  /** Traffic count fixed by the URL (?traffic=; else the density setting). */
  fixedTraffic?: boolean;
  /** Graphics settings from the URL (on top of the stored ones, not saved). */
  gfx?: Partial<Settings>;
}

/** Traffic count at 100% density. */
const TRAFFIC = 380;

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
  /** Car variant to return to from the helicopter. */
  private lastCar = -1;
  /** Director vehicle swaps: shots left before the next one. */
  private swapIn = 3;
  private swapRng = new Rng(9137);
  /** Seconds the player's car has been (nearly) stopped. */
  private stoppedFor = 0;
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
  lastCam: {eye: Vec3; target: Vec3; fov: number; near: number} | null = null;
  /** Asset lab: current camera preset, and the orbit preset's angle. */
  labView = '';
  private orbitAngle = 0.3;
  /** CPU timing per subsystem (?prof=1). */
  cpuProf: CpuProfiler | null = null;
  /**
   * Profiling: hold the simulation and camera still (the same image every
   * frame) while rendering continues.
   */
  freeze = false;
  /** Per-frame CPU ms of frame() while profiling (for medians). */
  cpuFrames: number[] = [];
  /** Effective graphics settings (stored + URL overrides) and the stored part. */
  settings: Settings;
  private stored: Partial<Settings>;
  private dynScale = new DynamicScale();

  /** Settings defaults on this device (the low preset on phones). */
  private readonly defaults = deviceDefaults(lowMemory());

  constructor(gpu: Gpu, opts: GameOptions) {
    this.gpu = gpu;
    this.opts = opts;
    this.cityType = opts.cityType;
    this.seed = opts.seed;
    this.hour = opts.hour;
    this.timeSpeed = opts.timeSpeed;
    this.weather.set(opts.weather, true);
    this.input = new Input(gpu.canvas);
    this.stored = loadStored();
    this.settings = {...this.defaults, ...this.stored, ...opts.gfx};
  }

  /** Change one graphics setting (from the menu): applied live and saved. */
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    const set = (k: keyof Settings, v: unknown) => {
      (this.settings as unknown as Record<string, unknown>)[k] = v;
      (this.stored as Record<string, unknown>)[k] = v;
    };
    set(key, value);
    if (key === 'preset' && value !== 'custom')
      for (const [k, v] of Object.entries(
        PRESETS[value as keyof typeof PRESETS],
      ))
        set(k as keyof Settings, v);
    // A preset-controlled setting off its preset's value: custom.
    const pr = this.settings.preset;
    if (
      key !== 'preset' &&
      pr !== 'custom' &&
      FIELDS.find(f => f.key === key)?.preset &&
      PRESETS[pr][key as keyof (typeof PRESETS)['high']] !== value
    )
      set('preset', 'custom');
    saveStored(this.stored);
    this.applySettings();
  }

  /** Back to the defaults (URL overrides still apply). */
  resetSettings() {
    clearStored();
    this.stored = {};
    this.settings = {...this.defaults, ...this.opts.gfx};
    this.applySettings();
  }

  /** Push the settings into the renderer and simulation (cheap; idempotent). */
  applySettings() {
    const s = this.settings;
    const r = this.renderer;
    if (!r) return;
    r.cloudQuality = s.clouds;
    if (s.shadows > 0) r.setShadowSize(s.shadows);
    const off: string[] = [];
    if (!s.shadows) off.push('shadows');
    if (s.reflections === 'off') off.push('ssr', 'cityrefl');
    if (s.reflections === 'full') off.push('hrefl');
    if (!s.ao) off.push('gtao');
    if (!s.contact) off.push('contact');
    if (!s.godrays) off.push('godrays');
    if (!s.taa) off.push('taa');
    if (s.lean) off.push('c3');
    r.userOff = parseOff(off.join(','));
    r.bloom = s.bloom;
    r.sharpen = s.sharpen;
    r.farCullScale = s.detail;
    r.measureGpu = s.readout || s.scale === 'dynamic';
    if (this.rain) this.rain.density = s.rain;
    if (this.city && this.opts.lod2 === undefined)
      this.city.lod2Dist = s.drawDist > 0 ? s.drawDist : Infinity;
    if (this.traffic) this.traffic.target = this.trafficTarget();
    this.applyBudget(s.lean);
  }

  /**
   * The mobile geometry budget (settings.lean), measured with ?probe=1 at
   * 852x393: the frame's triangles were mostly vehicles (5k-triangle LOD2
   * cars out to 900 m, drawn again into three shadow cascades) and the
   * terrain. Off restores the default look exactly.
   */
  private applyBudget(lean: boolean) {
    const r = this.renderer;
    const v = this.vehicles;
    // Terrain: 128 m patches near the eye still sample every 4 m height
    // cell; far patches grow sooner.
    r.terrainSplit = lean ? 0.8 : 1.4;
    r.terrainMinPatch = lean ? 128 : 64;
    if (v) {
      // A ~400-triangle far LOD past ~60 m (a car is ~20 px tall there at
      // phone resolution), LOD switches 40% nearer, no traffic beyond 600 m,
      // and vehicle shadows in the two nearest cascades only.
      v.farLod = lean ? 60 : Infinity;
      v.lodScale = lean ? 0.6 : 1;
      v.maxDist = lean ? 600 : 900;
      v.shadowCascades = lean ? 2 : 3;
    }
    if (this.peds) this.peds.target = lean ? 200 : 420;
  }

  private trafficTarget() {
    if (this.opts.lab) return 0;
    return this.opts.fixedTraffic
      ? this.opts.traffic
      : Math.round(TRAFFIC * this.settings.traffic);
  }

  /** Internal render scale for this frame (render scale setting). */
  private renderScale(): number {
    const s = this.settings.scale;
    if (s === 'dynamic')
      return this.dynScale.update(this.renderer.gpuMs, this.settings.targetFps);
    this.dynScale.scale = 1;
    if (s === 'auto')
      return autoScale(this.gpu.canvas.width, this.gpu.canvas.height);
    return s / 100;
  }

  async init() {
    // Everything slow starts here and runs at once: pipeline compiles and
    // the texture worker (Renderer.create), the city workers (loadCity) and
    // the vehicle workers. Pipelines are awaited only before the first frame.
    this.renderer = Renderer.create(this.gpu, {
      lowMemory: lowMemory(),
      signLocale: signLocaleOf(this.cityType),
    });
    this.renderer.offBits = this.opts.off ?? 0;
    this.applySettings();
    if (this.opts.prof) {
      this.renderer.enableProfiler(this.opts.prof === 'pass');
      this.cpuProf = new CpuProfiler();
      this.renderer.cpuProf = this.cpuProf;
    }
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
    // (sprites.wgsl lightsOn(): zero at night <= 0.25 and rain <= 0.3; the
    // renderer's sky is this frame's by the time hooks draw.)
    this.sprites.lightsOn = () =>
      this.renderer.sky.night > 0.25 || this.weather.state.rain > 0.3;
    this.rain.density = this.settings.rain;
    const gpuReady = Promise.all([
      this.renderer.ready,
      this.rain.ready,
      this.sprites.ready,
    ]);
    gpuReady.catch(() => {}); // (awaited below; no unhandled rejection meanwhile)
    const city = timedAsync(
      'city load',
      this.loadCity(this.cityType, this.seed),
    );
    const vehicles = timedAsync(
      'vehicles init',
      this.vehicles.init(GBUFFER_FORMATS, 'rgba16float'),
    );
    await Promise.all([city, vehicles]);
    loadScreen.phase('Compiling shaders', 'finish');
    await timedAsync('wait: pipelines + textures', gpuReady);
    loadScreen.phase('Starting traffic');
    await nextPaint();
    timed('setupWorld', () => this.setupWorld());
    this.ui = new UI(this);
    if (this.opts.swap) this.camera.beforeCut = () => this.directorSwap();
    if (this.opts.camera) {
      this.camera.mode = this.opts.camera;
      this.camera.directorEnabled = this.opts.director;
    }
  }

  private spawnPoint(): Vec3 {
    const lab = this.city?.summary?.lab;
    if (lab) return lab.focus;
    if (this.opts.spawn) return [this.opts.spawn[0], 0, this.opts.spawn[1]];
    const L = this.city!.summary.layout;
    // Start in a dense district (a sub-center), not beside the central park.
    const hub = (L.hubs[1] ?? L.hubs[0]).p;
    return [hub[0] + 60, 0, hub[1] + 40];
  }

  private async loadCity(type: CityType, seed: number) {
    this.loading = true;
    loadScreen.show(PRESETS_CITY[type].name, seed);
    this.city?.dispose();
    this.city = new City(this.renderer, type, seed, this.opts.lab);
    if (lowMemory()) this.city.useLowMemory();
    const lod2 = this.opts.lod2 ?? this.settings.drawDist;
    this.city.lod2Dist = lod2 > 0 ? lod2 : Infinity;
    let focus: Vec3 = [0, 0, 0];
    const city = this.city;
    // A city of another preset repaints the sign atlas in its locale
    // (in the texture worker, while the city loads).
    const signs = this.renderer.setSignLocale(signLocaleOf(type));
    signs.catch(() => {}); // (awaited below)
    // The asset lab knows its focus as soon as the layout arrives.
    await city.load(loadScreen, () => city.summary?.lab?.focus ?? focus);
    await signs;
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
    this.traffic.target = this.trafficTarget();
    this.trains = new Trains(
      city.summary.layout.elevated,
      this.vehicles,
      net.side,
    );
    // The rail lab parks one train at the site for scale.
    const labTrain = city.summary.lab?.train;
    if (labTrain !== undefined) this.trains.park(labTrain);
    else if (this.opts.lab) this.trains.trains = [];
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
    this.applyBudget(this.settings.lean);
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
        // Not one in a tunnel.
        if (!m || m[13] < this.net!.hf.sample(m[12], m[14])) continue;
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
        if (!p || p[1] < this.net!.hf.sample(p[0], p[2])) continue;
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
    if (this.city!.summary.lab) {
      const views = Object.keys(this.city!.summary.lab.views);
      const v = this.opts.view;
      this.setLabView(v && views.includes(v) ? v : views[0]);
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
    for (let i = 0; i < (this.opts.lab ? 0 : 40); i++)
      this.traffic.update(
        0.25,
        this.time + i * 0.25,
        this.player.pos,
        this.player.follower ? [this.player.follower] : [],
      );
    loadScreen.hide();
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

  /** Asset lab: switch to camera preset `name` (see city/lab.ts). */
  setLabView(name: string) {
    const lab = this.city?.summary.lab;
    const v = lab?.views[name];
    if (!lab || !v) return;
    this.labView = name;
    this.orbitAngle = 0.3;
    this.city!.forceLod1 = !!v.lod1;
    this.city!.forceLod2 = !!v.lod2;
    const [yaw, pitch] = yawPitch(v.eye, v.target);
    this.freeCam.setPose(v.eye, yaw, pitch, v.fov);
    this.freeMode = true;
  }

  /** The orbit preset circles the asset slowly. */
  private updateOrbit(dt: number) {
    const o = this.city?.summary.lab?.orbit;
    if (!o || this.labView !== 'orbit' || !this.freeMode) return;
    this.orbitAngle += dt * 0.12;
    const eye: Vec3 = [
      o.center[0] + Math.sin(this.orbitAngle) * o.radius,
      o.height,
      o.center[2] + Math.cos(this.orbitAngle) * o.radius,
    ];
    const [yaw, pitch] = yawPitch(eye, o.center);
    this.freeCam.setPose(eye, yaw, pitch, o.fov);
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
      // The asset lab has no traffic.
      if (c.kind < 1 || this.opts.lab) return;
      const pts = c.pts.map((q, i): Vec3 => [q[0], c.heights[i], q[1]]);
      const offs = [...Array(net.lanesPerDir(ci)).keys()].map(
        k => net.laneOffset(ci, k) * net.side,
      );
      // City traffic: 30-50 km/h.
      both(pts, offs, c.kind >= 2 ? 12 : 10, 30);
    });
    for (const e of L.elevated) {
      if (e.kind !== 'expressway' || this.opts.lab) continue;
      const pts = e.pts.map((q, i): Vec3 => [q[0], e.heights[i], q[1]]);
      // Shuto expressway: ~70 km/h.
      both(pts, [2.2 * net.side, 5.6 * net.side], 19, 40);
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
    const s = this.settings;
    return {
      motionBlur: s.motionBlur ? (blur[shot] ?? 0.3) * moving : 0,
      dofAperture: s.dof ? (dof[shot] ?? 0) : 0,
      focus,
    };
  }

  /** Vehicle button / V key: helicopter <-> the car driven last. */
  toggleHeli() {
    const pl = this.player;
    if (pl.kind === 'car') {
      this.lastCar = pl.variant;
      pl.spawnHeli(this.pickVariant('helicopter'));
    } else {
      this.spawnCarBelow(
        this.lastCar >= 0 ? this.lastCar : this.pickVariant('car', 'sports'),
      );
    }
  }

  /** A car on the road nearest the player (the spawn point if none is near). */
  private spawnCarBelow(variant: number) {
    const pl = this.player;
    pl.spawnCar(pl.pos[0], pl.pos[2], variant);
    if (!pl.follower) {
      const sp = this.spawnPoint();
      pl.spawnCar(sp[0], sp[2], variant);
    }
  }

  /**
   * Director: every few shots, film another vehicle. Called as a planned shot
   * ends, so the swap happens on the cut. Mostly a different road vehicle in
   * place; the helicopter gets about one shot in five (runs of two or three).
   */
  private directorSwap() {
    const pl = this.player;
    // Waiting at lights or in a jam makes dull footage: move on sooner.
    if (pl.kind === 'car' && this.stoppedFor > 8) this.swapIn = 1;
    if (--this.swapIn > 0) return;
    const r = this.swapRng;
    const pick = (n: number) => r.int(0, n);
    if (pl.kind === 'car' && r.chance(0.3)) {
      this.lastCar = pl.variant;
      pl.spawnHeli(this.pickVariant('helicopter'));
      this.swapIn = r.int(2, 4);
      return;
    }
    // Another vehicle: a moving one from traffic nearby, else a different
    // model in place.
    const near = pl.kind === 'heli' ? [0, 300] : [25, 250];
    const ground: Vec3 = [pl.pos[0], 0, pl.pos[2]];
    const c = this.traffic?.take(ground, near[0], near[1], pick, pl.variant);
    if (c) pl.takeOver(c);
    else if (pl.kind === 'heli')
      this.spawnCarBelow(this.randomRoadVehicle(r, pl.variant));
    else
      pl.spawnCar(pl.pos[0], pl.pos[2], this.randomRoadVehicle(r, pl.variant));
    this.stoppedFor = 0;
    this.swapIn = r.int(2, 5);
  }

  /** A road vehicle variant other than `not` (cars more often than trucks and buses). */
  private randomRoadVehicle(r: Rng, not: number): number {
    const v = this.vehicles.variants;
    const ids: number[] = [];
    const w: number[] = [];
    v.forEach((x, i) => {
      const k = x.info.kind;
      if (i === not || !['car', 'taxi', 'van', 'truck', 'bus'].includes(k))
        return;
      ids.push(i);
      w.push(k === 'car' ? 3 : k === 'taxi' ? 1.5 : 0.6);
    });
    return ids.length ? r.weighted(ids, w) : not;
  }

  /** B key: next variant of the same family (car or heli). */
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
    if (i.hit('KeyT')) {
      this.hour = (this.hour + 1) % 24;
      this.weather.update(0, 1);
    }
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
    if (i.hit('KeyV')) this.toggleHeli();
    if (i.hit('KeyB')) this.nextVehicle();
  }

  frame(dt: number) {
    if (this.loading || !this.city || !this.traffic) return;
    const endFirst = this.frames === 0 ? begin('first frame()') : null;
    const prof = this.cpuProf;
    const t0 = prof ? performance.now() : 0;
    prof?.start();
    resizeToCss(this.gpu.canvas);
    this.handleKeys();
    this.time += dt;
    this.hour = (this.hour + dt * this.timeSpeed + 24) % 24;
    this.weather.update(dt, dt * this.timeSpeed);
    this.stoppedFor =
      Math.abs(this.player.speed) < 1 ? this.stoppedFor + dt : 0;
    // The asset lab shows its asset alone: no player, traffic, trains,
    // helicopters or pedestrians.
    const frozen = this.freeze && !!this.lastCam;
    const lab = !!this.opts.lab || frozen;
    if (!lab)
      this.player.update(
        dt,
        this.freeMode ? this.noInput : this.input,
        this.time,
      );
    prof?.mark('player');
    // Trains and helicopters move before the camera: the director films a
    // train, and aiming at last frame's position leaves the car one frame's
    // travel ahead of the aim point, so every uneven frame time made it jump
    // forward and back on screen.
    if (!lab) {
      this.trains!.update(dt);
      this.helis!.update(dt);
    }
    prof?.mark('trains+helis');
    this.updateOrbit(dt);
    // (The free camera still moves while frozen: fixed-view A/B shots.)
    const cam =
      frozen && !this.freeMode
        ? this.lastCam!
        : this.freeMode
          ? this.freeCam.update(dt, this.input)
          : this.camera.update(dt, this.player, this.input);
    prof?.mark('camera');
    const focus = this.player.pos;
    if (!lab) {
      this.traffic.update(
        dt,
        this.time,
        focus,
        this.player.follower && this.player.autopilot
          ? [this.player.follower]
          : [],
      );
      prof?.mark('traffic');
      this.peds!.update(dt, cam.eye);
      prof?.mark('peds');
    }
    this.city.updateStreaming(cam.eye);
    prof?.mark('streaming');
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
    if (!lab || frozen)
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
    prof?.mark('lights');
    // Vehicles.
    this.vehicles.begin(cam.eye);
    const offBits = this.renderer.offBits;
    if (!this.opts.lab) {
      this.player.draw(lightsOn);
      if (!(offBits & OFF_BITS.traffic)) this.traffic.draw(lightsOn);
      this.trains!.draw(lightsOn);
      this.helis!.draw(this.time, lightsOn);
      if (!(offBits & OFF_BITS.peds)) this.peds!.draw();
    } else this.trains!.draw(lightsOn);
    prof?.mark('vehicle add');
    this.vehicles.finish();
    prof?.mark('vehicle upload');
    this.lastCam = cam;
    this.rain.intensity = this.weather.state.rain;
    this.renderer.renderScale = this.renderScale();
    // Field of view setting: the gameplay cameras only (free-camera links
    // and the asset lab keep their exact framing).
    const fovK = this.freeMode || this.opts.lab ? 1 : this.settings.fov;
    this.renderer.render({
      eye: cam.eye,
      target: cam.target,
      fov: fovK === 1 ? cam.fov : 2 * Math.atan(Math.tan(cam.fov / 2) * fovK),
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
    prof?.mark('render submit');
    this.input.endFrame();
    this.fpsAvg = this.fpsAvg * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this.frames++;
    if (this.frames % 10 === 0) this.ui.update(this.fpsAvg);
    window.__stats = {
      ...this.renderer.stats,
      ...this.city.stats,
      fps: Math.round(this.fpsAvg),
      render: `${this.renderer.renderSize.join('x')}`,
      cars: this.traffic.cars.length,
      shot: this.opts.lab
        ? `lab ${this.labView}`
        : (this.camera.shot?.name ?? this.camera.mode),
      eye: cam.eye.map(v => Math.round(v)),
    };
    if (prof) {
      prof.mark('ui+stats');
      const ms = performance.now() - t0;
      prof.endFrame(ms);
      if (this.cpuFrames.length < 4096) this.cpuFrames.push(ms);
      window.__stats.cpu = prof.averages;
      window.__stats.gpu = this.renderer.prof?.averages ?? {};
    }
    if (endFirst) {
      endFirst();
      void timedAsync(
        'first frame GPU work',
        this.renderer.device.queue.onSubmittedWorkDone(),
        'gpu',
      );
    }
    if (this.frames === 20) {
      mark('frame 20 (ready)');
      finish();
      window.__ready = true;
    }
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
