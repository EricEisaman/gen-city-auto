// City streaming: runs the generation workers, uploads base geometry, keeps
// LOD1 shells for every tile resident and streams LOD0 detail near the camera.
// Also selects the point lights near the camera each frame.

import type {ClusterData} from '../city/cmesh.ts';
import type {CityType} from '../city/config.ts';
import {LIGHT_FLOATS, LightKind} from '../city/gen-base.ts';
import {TILE_SIZE} from '../city/gen-tile.ts';
import {Heightfield} from '../city/terrain.ts';
import type {Vec3} from '../math/vec.ts';
import type {PoolHandle} from '../render/cluster-pool.ts';
import type {Renderer} from '../render/renderer.ts';
import type {LayoutSummary, WorkerRequest} from '../workers/city-worker.ts';

interface TileState {
  lod1: PoolHandle | null;
  lod0: PoolHandle | null;
  lights1: Float32Array;
  lights0: Float32Array;
  pending0: boolean;
  pending1: boolean;
}

type Progress = (msg: string, f: number) => void;

export class City {
  summary!: LayoutSummary;
  heights!: Heightfield;
  readonly type: CityType;
  readonly seed: number;
  tilesPerSide = 0;
  private renderer: Renderer;
  private workers: Worker[] = [];
  private tiles: TileState[] = [];
  private baseHandles: PoolHandle[] = [];
  private baseLights: Float32Array = new Float32Array(0);
  private baseLightTiles: number[][] = [];
  private queue: {tile: number; lod: number}[] = [];
  private busy: number[] = [];
  private nextId = 1;
  private tileLods = new Uint32Array(0);
  private lightScratch = new Float32Array(1024 * 8);
  lod0Radius = 520;
  stats = {lod0: 0, lod1: 0, queue: 0};

  constructor(renderer: Renderer, type: CityType, seed: number) {
    this.renderer = renderer;
    this.type = type;
    this.seed = seed;
  }

  async load(progress: Progress, focus: () => Vec3) {
    const n = Math.max(
      2,
      Math.min(6, (navigator.hardwareConcurrency || 4) - 1),
    );
    let readyCount = 0;
    let resolveBase!: () => void;
    let rejectAll!: (e: Error) => void;
    const baseDone = new Promise<void>((res, rej) => {
      resolveBase = res;
      rejectAll = rej;
    });
    let resolveReady!: () => void;
    const allReady = new Promise<void>(res => (resolveReady = res));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./city-worker.js', import.meta.url), {
        type: 'module',
        name: `city-worker-${i}`,
      });
      this.workers.push(w);
      this.busy.push(0);
      w.onmessage = (e: MessageEvent) => {
        const m = e.data;
        switch (m.type) {
          case 'progress':
            progress(m.msg, m.f);
            break;
          case 'base':
            this.onBase(m.summary, m.base, m.piers, m.lights, m.landUse);
            resolveBase();
            break;
          case 'ready':
            if (++readyCount === n) resolveReady();
            break;
          case 'tile':
            this.busy[i]--;
            this.onTile(m.tile, m.lod, m.clusters, m.lights);
            this.pump();
            break;
          case 'error':
            rejectAll(new Error(`[city worker ${i}] ${m.message}`));
            break;
        }
      };
      w.onerror = e => rejectAll(new Error(`[city worker ${i}] ${e.message}`));
      const req: WorkerRequest = {
        type: 'init',
        cityType: this.type,
        seed: this.seed,
        primary: i === 0,
      };
      w.postMessage(req);
    }
    await baseDone;
    await allReady;
    // Every tile gets its LOD1 shell; tiles near the focus get LOD0 first.
    const total = this.tilesPerSide * this.tilesPerSide;
    for (let t = 0; t < total; t++) this.queue.push({tile: t, lod: 1});
    this.updateStreaming(focus(), true);
    this.pump();
    await new Promise<void>(res => {
      const check = () => {
        const done1 = this.tiles.filter(s => !s.pending1).length;
        const near = this.nearTiles(focus(), this.lod0Radius);
        const done0 = near.filter(t => this.tiles[t].lod0).length;
        progress(
          'Building streets',
          0.8 +
            0.2 *
              ((done1 / total) * 0.6 +
                (done0 / Math.max(1, near.length)) * 0.4),
        );
        if (done1 === total && done0 === near.length) res();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  private onBase(
    summary: LayoutSummary,
    base: ClusterData,
    piers: ClusterData,
    lights: Float32Array,
    landUse: Uint8Array,
  ) {
    this.summary = summary;
    const L = summary.layout;
    this.heights = new Heightfield(L.params.size, L.cell, L.heights);
    this.tilesPerSide = Math.ceil(L.params.size / TILE_SIZE);
    const total = this.tilesPerSide * this.tilesPerSide;
    this.tileLods = new Uint32Array(total).fill(1);
    this.tiles = Array.from({length: total}, () => ({
      lod1: null,
      lod0: null,
      lights1: new Float32Array(0),
      lights0: new Float32Array(0),
      pending0: false,
      pending1: true,
    }));
    this.renderer.setTerrain(
      L.heights,
      L.heightN,
      L.cell,
      L.params.size,
      landUse,
    );
    for (const c of [base, piers]) {
      const h = this.renderer.uploadClusters(c);
      if (h) this.baseHandles.push(h);
    }
    this.baseLights = lights;
    this.baseLightTiles = Array.from({length: total}, () => []);
    for (let i = 0; i < lights.length / LIGHT_FLOATS; i++) {
      this.baseLightTiles[this.tileAt(lights[i * 8], lights[i * 8 + 2])].push(
        i,
      );
    }
    this.renderer.setTileLods(this.tileLods);
  }

  tileAt(x: number, z: number) {
    const s = this.summary.layout.params.size;
    const tx = Math.min(
      this.tilesPerSide - 1,
      Math.max(0, Math.floor((x + s / 2) / TILE_SIZE)),
    );
    const tz = Math.min(
      this.tilesPerSide - 1,
      Math.max(0, Math.floor((z + s / 2) / TILE_SIZE)),
    );
    return tz * this.tilesPerSide + tx;
  }

  private tileDist(t: number, p: Vec3) {
    const s = this.summary.layout.params.size;
    const x0 = (t % this.tilesPerSide) * TILE_SIZE - s / 2;
    const z0 = Math.floor(t / this.tilesPerSide) * TILE_SIZE - s / 2;
    const dx = Math.max(x0 - p[0], 0, p[0] - (x0 + TILE_SIZE));
    const dz = Math.max(z0 - p[2], 0, p[2] - (z0 + TILE_SIZE));
    return Math.hypot(dx, dz);
  }

  private nearTiles(p: Vec3, r: number) {
    const out: number[] = [];
    for (let t = 0; t < this.tiles.length; t++)
      if (this.tileDist(t, p) < r) out.push(t);
    return out;
  }

  private onTile(
    tile: number,
    lod: number,
    clusters: ClusterData,
    lights: Float32Array,
  ) {
    const s = this.tiles[tile];
    const h = this.renderer.uploadClusters(clusters);
    if (lod === 1) {
      s.pending1 = false;
      s.lod1 = h;
      s.lights1 = lights;
    } else {
      s.pending0 = false;
      if (s.lod0) this.renderer.freeClusters(s.lod0);
      s.lod0 = h;
      s.lights0 = lights;
    }
  }

  private pump() {
    for (let i = 0; i < this.workers.length; i++) {
      while (this.busy[i] < 2 && this.queue.length) {
        const job = this.queue.shift()!;
        this.busy[i]++;
        const req: WorkerRequest = {
          type: 'tile',
          tile: job.tile,
          lod: job.lod,
          id: this.nextId++,
        };
        this.workers[i].postMessage(req);
      }
    }
    this.stats.queue = this.queue.length;
  }

  /** Request/evict LOD0 tiles around `p` and publish per-tile LOD choices. */
  updateStreaming(p: Vec3, initial = false) {
    if (!this.tiles.length) return;
    const want = new Set(this.nearTiles(p, this.lod0Radius));
    // Prioritize LOD0 jobs by distance (they jump ahead of LOD1 jobs).
    const add: number[] = [];
    for (const t of want) {
      const s = this.tiles[t];
      if (!s.lod0 && !s.pending0) {
        s.pending0 = true;
        add.push(t);
      }
    }
    add.sort((a, b) => this.tileDist(a, p) - this.tileDist(b, p));
    if (add.length) this.queue.unshift(...add.map(tile => ({tile, lod: 0})));
    let lod0 = 0;
    let lod1 = 0;
    for (let t = 0; t < this.tiles.length; t++) {
      const s = this.tiles[t];
      if (s.lod0 && this.tileDist(t, p) > this.lod0Radius + 250) {
        this.renderer.freeClusters(s.lod0);
        s.lod0 = null;
        s.lights0 = new Float32Array(0);
      }
      const use0 = !!s.lod0 && this.tileDist(t, p) < this.lod0Radius + 120;
      this.tileLods[t] = use0 ? 0 : 1;
      if (use0) lod0++;
      else if (s.lod1) lod1++;
    }
    this.renderer.setTileLods(this.tileLods);
    this.stats.lod0 = lod0;
    this.stats.lod1 = lod1;
    if (!initial) this.pump();
  }

  /** Pick the nearest lights to the camera and upload them. */
  updateLights(
    eye: Vec3,
    night: number,
    flicker: number,
    extra: Float32Array = new Float32Array(0),
  ) {
    if (!this.tiles.length) return;
    const ne = Math.min(extra.length / 8, 128);
    if (night < 0.05) {
      this.lightScratch.set(extra.subarray(0, ne * 8));
      this.renderer.setLights(this.lightScratch, ne);
      return;
    }
    const near = this.nearTiles(eye, 650);
    const cand: {d: number; src: Float32Array; i: number}[] = [];
    const consider = (src: Float32Array, i: number) => {
      const dx = src[i * 8] - eye[0];
      const dy = src[i * 8 + 1] - eye[1];
      const dz = src[i * 8 + 2] - eye[2];
      const d = Math.hypot(dx, dy, dz) - src[i * 8 + 3];
      if (d < 600) cand.push({d, src, i});
    };
    for (const t of near) {
      for (const i of this.baseLightTiles[t]) consider(this.baseLights, i);
      const s = this.tiles[t];
      const tl = this.tileLods[t] === 0 ? s.lights0 : s.lights1;
      for (let i = 0; i < tl.length / 8; i++) consider(tl, i);
    }
    cand.sort((a, b) => a.d - b.d);
    const out = this.lightScratch;
    out.set(extra.subarray(0, ne * 8));
    const n = Math.min(cand.length, 1024 - ne);
    for (let k = 0; k < n; k++) {
      const {src, i} = cand[k];
      const kind = src[i * 8 + 7];
      const scale =
        (kind === LightKind.street
          ? 3.5
          : kind === LightKind.sign
            ? 0.55 * flicker
            : kind === LightKind.vending
              ? 0.35
              : 0.8) * night;
      const o = (k + ne) * 8;
      out[o] = src[i * 8];
      out[o + 1] = src[i * 8 + 1];
      out[o + 2] = src[i * 8 + 2];
      out[o + 3] = src[i * 8 + 3];
      out[o + 4] = src[i * 8 + 4] * scale;
      out[o + 5] = src[i * 8 + 5] * scale;
      out[o + 6] = src[i * 8 + 6] * scale;
      out[o + 7] = kind;
    }
    this.renderer.setLights(out, n + ne);
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const s of this.tiles) {
      if (s.lod0) this.renderer.freeClusters(s.lod0);
      if (s.lod1) this.renderer.freeClusters(s.lod1);
    }
    for (const h of this.baseHandles) this.renderer.freeClusters(h);
    this.workers = [];
    this.tiles = [];
  }

  groundHeight(x: number, z: number) {
    return this.heights ? this.heights.sample(x, z) : 0;
  }
}
