// Game orchestration: city loading, simulation systems, cameras and the
// render loop.

import type {CityType} from '../city/config.ts';
import {reportError, resizeToCss, type Gpu} from '../gpu/device.ts';
import {Rng} from '../math/random.ts';
import type {Vec3} from '../math/vec.ts';
import {RainRenderer} from '../render/rain.ts';
import {GBUFFER_FORMATS, Renderer} from '../render/renderer.ts';
import {VehicleRenderer} from '../render/vehicles.ts';
import {UI} from '../ui/ui.ts';
import {City} from '../world/city.ts';
import {CameraSystem, CAMERA_MODES, type CameraMode} from './camera.ts';
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
    this.vehicles = new VehicleRenderer(this.renderer, this.renderer.frameBuffer, this.renderer.shadowViewBuffers);
    this.rain = new RainRenderer(this.renderer.device, this.renderer.frameBuffer, 'rgba16float');
    this.renderer.hooks.push(this.vehicles, this.rain);
    const progress = this.progress.bind(this);
    progress('Building vehicles from NURBS', 0.02);
    await Promise.all([this.vehicles.init(GBUFFER_FORMATS, 'rgba16float'), this.loadCity(this.cityType, this.seed)]);
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
    const hub = L.hubs[0].p;
    return [hub[0] + 120, 0, hub[1] + 60];
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
    this.traffic.target = this.opts.traffic;
    this.trains = new Trains(city.summary.layout.elevated, this.vehicles);
    this.helis = new AmbientHelis(city.summary.layout.hubs, this.vehicles, (x, z) => city.groundHeight(x, z));
    this.peds = new Pedestrians(net, this.vehicles, city.summary.layout.hubs.map(h => h.p));
    this.player = new Player(net, this.vehicles, city.summary.layout.hubs.map(h => h.p));
    this.camera = new CameraSystem(net);
    this.camera.trainFocus = () => {
      // Nearest train car to the player.
      const t = this.trains!;
      let best: Vec3 | null = null;
      let bd = Infinity;
      for (let i = 0; i < t.trains.length; i++) {
        const p = t.focusPoint(i);
        if (!p) continue;
        const d = Math.hypot(p[0] - this.player.pos[0], p[2] - this.player.pos[2]);
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
      const named = this.vehicles.variants.findIndex(v => v.info.name === vname);
      this.player.spawnCar(sp[0], sp[2], named >= 0 ? named : this.pickVariant('car', 'sports'));
    }
    if (this.opts.shot) this.forceShot(this.opts.shot);
    // Warm up traffic so the streets are busy immediately.
    for (let i = 0; i < 40; i++) this.traffic.update(0.25, this.time + i * 0.25, this.player.pos, this.player.follower ? [this.player.follower] : []);
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
    const any = v.findIndex(x => !['train', 'helicopter', 'person'].includes(x.info.kind));
    return Math.max(0, any);
  }

  forceShot(name: string) {
    this.camera.directorEnabled = true;
    const pl = this.player;
    const cam = this.camera as unknown as {shot: {name: string; t: number; dur: number} | null; newShotNamed?: (n: string) => void};
    cam.shot = null;
    this.camera.locked = false;
    // Ask the director repeatedly until it picks the requested shot.
    for (let i = 0; i < 200; i++) {
      this.camera.update(0.01, pl, this.input);
      if (this.camera.shot?.name === name) {
        this.camera.shot.dur = 1e9;
        this.camera.locked = true;
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

  private handleKeys() {
    const i = this.input;
    if (i.hit('KeyC')) {
      this.camera.cycle();
      this.camera.directorEnabled = false;
    }
    if (i.hit('KeyK')) this.camera.directorEnabled = !this.camera.directorEnabled;
    if (i.hit('KeyT')) this.hour = (this.hour + 1) % 24;
    if (i.hit('KeyY')) this.weather.set(WEATHER_KINDS[(WEATHER_KINDS.indexOf(this.weather.kind) + 1) % WEATHER_KINDS.length]);
    if (i.hit('KeyN')) void this.regenerate(this.cityType, Math.floor(Math.random() * 100000));
    if (i.hit('KeyM')) this.ui.toggleMenu();
    if (i.hit('KeyH')) this.ui.toggleHelp();
    if (i.hit('KeyF')) this.ui.showStats = !this.ui.showStats;
    if (i.hit('KeyV')) {
      if (this.player.kind === 'car') this.player.spawnHeli(this.pickVariant('helicopter'));
      else this.player.spawnCar(this.player.pos[0], this.player.pos[2], this.pickVariant('car', 'sports'));
    }
    if (i.hit('KeyB')) {
      const v = this.vehicles.variants;
      const kinds = this.player.kind === 'heli' ? ['helicopter'] : ['car', 'taxi', 'van', 'truck', 'bus'];
      for (let k = 1; k <= v.length; k++) {
        const idx = (this.player.variant + k) % v.length;
        if (kinds.includes(v[idx].info.kind)) {
          this.selectVehicle(idx);
          break;
        }
      }
    }
    void CAMERA_MODES;
  }

  frame(dt: number) {
    if (this.loading || !this.city || !this.traffic) return;
    resizeToCss(this.gpu.canvas);
    this.handleKeys();
    this.time += dt;
    this.hour = (this.hour + dt * this.timeSpeed + 24) % 24;
    this.weather.update(dt);
    this.player.update(dt, this.input, this.time);
    let cam = this.camera.update(dt, this.player, this.input);
    const fc = this.opts.freecam;
    if (fc) {
      const f: Vec3 = [Math.sin(fc[3]) * Math.cos(fc[4]), Math.sin(fc[4]), -Math.cos(fc[3]) * Math.cos(fc[4])];
      cam = {eye: [fc[0], fc[1], fc[2]], target: [fc[0] + f[0], fc[1] + f[1], fc[2] + f[2]], fov: 1.0, near: 0.5, interior: false};
    }
    const focus = this.player.pos;
    this.traffic.update(dt, this.time, focus, this.player.follower && this.player.autopilot ? [this.player.follower] : []);
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
      const p: Vec3 = [model[12] + model[8] * (len / 2 + 0.3), model[13] + 0.75, model[14] + model[10] * (len / 2 + 0.3)];
      const yaw = (Math.atan2(model[8], model[10]) / (Math.PI * 2) + 1) % 1;
      this.carLights.set([p[0], p[1], p[2], 30, 2.5, 2.35, 2.1, 5 + Math.min(yaw, 0.999)], n * 8);
      n++;
    };
    addHeadlights(this.player.model, this.player.info?.size[2] ?? 4.5);
    const near = this.traffic.cars
      .map(c => ({c, d: Math.hypot(c.model[12] - cam.eye[0], c.model[14] - cam.eye[2])}))
      .filter(x => x.d < 120)
      .sort((a, b) => a.d - b.d)
      .slice(0, 40);
    for (const {c} of near) addHeadlights(c.model, 4.5);
    this.city.updateLights(cam.eye, night, 1, this.carLights.subarray(0, n * 8));
    // Vehicles.
    this.vehicles.begin(cam.eye);
    this.player.draw(lightsOn);
    this.traffic.draw(lightsOn);
    this.trains!.draw(lightsOn);
    this.helis!.draw(this.time, lightsOn);
    this.peds!.draw();
    this.vehicles.finish();
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
    });
    this.input.endFrame();
    this.fpsAvg = this.fpsAvg * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    this.frames++;
    if (this.frames % 10 === 0) this.ui.update(this.fpsAvg);
    window.__stats = {...this.renderer.stats, ...this.city.stats, fps: Math.round(this.fpsAvg), cars: this.traffic.cars.length, shot: this.camera.shot?.name ?? this.camera.mode, eye: cam.eye.map(v => Math.round(v))};
    if (this.frames === 20) window.__ready = true;
  }

  get rngSeed() {
    return new Rng(this.seed);
  }
}
