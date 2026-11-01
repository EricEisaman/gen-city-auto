// City streaming: runs the generation workers, uploads base geometry, keeps a
// shell resident for every tile (LOD1 within lod2Dist of the camera, the
// thinner LOD2 beyond: city/lod.ts) and streams LOD0 detail near the camera.
// Also selects the point lights near the camera each frame.

import type {ClusterData} from '../city/cmesh.ts';
import type {CityType} from '../city/config.ts';
import type {LabSpec} from '../city/lab.ts';
import {LIGHT_FLOATS, LightKind} from '../city/gen-base.ts';
import {TILE_SIZE} from '../city/gen-tile.ts';
import {Heightfield} from '../city/terrain.ts';
import type {Vec3} from '../math/vec.ts';
import {nearestFirst} from './nearest.ts';
import {release} from '../mem.ts';
import type {PoolHandle} from '../render/cluster-pool.ts';
import type {Renderer} from '../render/renderer.ts';
import type {LayoutSummary, WorkerRequest} from '../workers/city-worker.ts';
import type {Preview} from '../city/preview.ts';
import {
  addSpan,
  begin,
  fromWorker,
  mark,
  timed,
  timedAsync,
} from '../ui/timeline.ts';

interface TileState {
  lod2: PoolHandle | null;
  lod1: PoolHandle | null;
  lod0: PoolHandle | null;
  lights1: Float32Array;
  lights0: Float32Array;
  pending0: boolean;
  pending1: boolean;
  pending2: boolean;
}

/**
 * LOD1 / LOD2 residency band around lod2Dist: a tile asks for the shell it
 * is about to need this far before the switch, and frees the one it no
 * longer shows this far past it, so a moving camera always has the next
 * shell ready (the swap itself is at lod2Dist, like LOD0 / LOD1's).
 */
const SHELL_PREFETCH = 100;
const SHELL_KEEP = 150;

/** Loading progress (the loading screen). */
export interface LoadListener {
  /** A generation step started (f: the worker's own 0..0.75 estimate). */
  step(msg: string, f: number): void;
  /** A finished part of the layout, for the map. */
  preview(p: Preview): void;
  /** Initial tile set: fraction done. */
  tiles(f: number): void;
  /** A tile mesh arrived (the map lights it up). */
  tile(tile: number, tilesPerSide: number): void;
}

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
  /** Per worker: posted ready (its tile jobs can be sent). */
  private ready: boolean[] = [];
  private nextId = 1;
  private tileLods = new Uint32Array(0);
  private lightScratch = new Float32Array(1024 * 8);
  private candD = new Float64Array(8192);
  private candSrc = new Uint32Array(8192);
  private candI = new Uint32Array(8192);
  lod0Radius = 520;
  /**
   * Tiles farther than this show LOD2 (city/lod.ts); Infinity = LOD1
   * everywhere. Set before load (?lod2=metres, 0 = off).
   */
  lod2Dist = 1500;
  /** Show every tile at LOD1 (asset lab: judge the distant shell up close). */
  forceLod1 = false;
  /** Show every tile at LOD2 (asset lab). */
  forceLod2 = false;
  stats = {lod0: 0, lod1: 0, lod2: 0, queue: 0};
  /** Until this time (ms) the shell band has no prefetch (pool was full). */
  private tightUntil = 0;
  private lab?: LabSpec;

  constructor(renderer: Renderer, type: CityType, seed: number, lab?: LabSpec) {
    this.renderer = renderer;
    this.type = type;
    this.seed = seed;
    this.lab = lab;
  }

  async load(progress: LoadListener, focus: () => Vec3) {
    const n = Math.max(
      2,
      Math.min(6, (navigator.hardwareConcurrency || 4) - 1),
    );
    let resolveSummary!: () => void;
    let rejectAll!: (e: Error) => void;
    const summaryDone = new Promise<void>((res, rej) => {
      resolveSummary = res;
      rejectAll = rej;
    });
    let resolveBase!: () => void;
    const baseDone = new Promise<void>(res => (resolveBase = res));
    let resolveSky!: () => void;
    const skyDone = new Promise<void>(res => (resolveSky = res));
    const endSpawn = begin(`spawn ${n} city workers`);
    const endBase = begin('city: layout + base mesh (workers)');
    const tileMs: number[] = new Array(n).fill(0);
    const tileCount: number[] = new Array(n).fill(0);
    // The workers' distribution tree: terrain bands and base parts go up to
    // the primary, the layout comes down (see city-worker.ts). Workers 1-3
    // hang off the primary (1 and 2 build base parts as soon as the layout
    // reaches them, so they forward nothing); 3 forwards to the rest.
    const parents: (MessagePort | undefined)[] = [undefined];
    const children: MessagePort[][] = Array.from({length: n}, () => []);
    for (let i = 1; i < n; i++) {
      const ch = new MessageChannel();
      children[i <= 3 ? 0 : 3 + ((i - 4) >> 1)].push(ch.port1);
      parents.push(ch.port2);
    }
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./city-worker.js', import.meta.url), {
        type: 'module',
        name: `city-worker-${i}`,
      });
      this.workers.push(w);
      this.busy.push(0);
      this.ready.push(false);
      w.onmessage = (e: MessageEvent) => {
        const m = e.data;
        switch (m.type) {
          case 'progress':
            progress.step(m.msg, m.f);
            break;
          case 'span':
            addSpan(
              m.name,
              fromWorker(m.start),
              fromWorker(m.end),
              `worker ${i}`,
            );
            break;
          case 'band':
            // The primary's curb band: the others' tile context waits on it
            // (they never build the base mesh; see city-worker.ts).
            timed('forward band', () => {
              for (const o of this.workers.slice(1)) {
                const req: WorkerRequest = {type: 'band', band: m.band};
                o.postMessage(req);
              }
            });
            break;
          case 'summary':
            // Tiles can start: the base clusters follow.
            mark('summary message received');
            this.onSummary(m.summary, m.lights, m.landUse);
            resolveSummary();
            break;
          case 'base':
            mark('base message received');
            timed('upload base mesh', () => {
              for (const c of [m.base, m.piers] as ClusterData[]) {
                const h = this.renderer.uploadClusters(c);
                if (h) this.baseHandles.push(h);
                // (Copied to the GPU: free now, not at the next GC.)
                release(c.vertices, c.tris, c.clusters);
              }
            });
            resolveBase();
            break;
          case 'preview':
            progress.preview(m.preview);
            break;
          case 'skyline':
            this.renderer.setSkyline(m.sky, m.n);
            resolveSky();
            break;
          case 'ready':
            // (Tile jobs go only to workers that have their tile context
            // or will have it before they read the job.)
            this.ready[i] = true;
            this.pump();
            break;
          case 'tile': {
            this.busy[i]--;
            tileMs[i] = m.tileMs;
            tileCount[i] = m.tileCount;
            const t = performance.now();
            this.onTile(m.tile, m.lod, m.clusters, m.lights);
            progress.tile(m.tile, this.tilesPerSide);
            uploadMs += performance.now() - t;
            uploads++;
            this.pump();
            break;
          }
          case 'error':
            // (After loading nothing awaits the promise: log it as well.)
            console.error(`[city worker ${i}] ${m.message}`);
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
        lab: this.lab,
        index: i,
        count: n,
        parent: parents[i],
        children: children[i],
      };
      const ports = parents[i] ? [parents[i]!, ...children[i]] : children[i];
      w.postMessage(req, ports);
    }
    endSpawn();
    let uploadMs = 0;
    let uploads = 0;
    await summaryDone;
    endBase();
    const endTiles = begin('city: tiles (initial set)');
    // Every tile gets its shell (LOD1 near, LOD2 far); tiles near the focus
    // get LOD0 first.
    const total = this.tilesPerSide * this.tilesPerSide;
    this.updateStreaming(focus(), true);
    this.pump();
    await new Promise<void>(res => {
      const check = () => {
        const done1 = this.tiles.filter(
          s => s.lod1 || s.lod2 || (!s.pending1 && !s.pending2),
        ).length;
        const near = this.nearTiles(focus(), this.lod0Radius);
        const done0 = near.filter(t => this.tiles[t].lod0).length;
        progress.tiles(
          (done1 / total) * 0.6 + (done0 / Math.max(1, near.length)) * 0.4,
        );
        if (done1 === total && done0 === near.length) {
          endTiles();
          const t = performance.now();
          const sum = tileMs.reduce((a, b) => a + b, 0);
          const cnt = tileCount.reduce((a, b) => a + b, 0);
          addSpan(
            `tile builds: ${cnt} jobs, ${sum.toFixed(0)} worker-ms over ${n} workers`,
            t,
            t,
            'workers',
          );
          addSpan(
            `tile uploads: ${uploads}, ${uploadMs.toFixed(0)} ms main thread`,
            t,
            t,
          );
          res();
        } else setTimeout(check, 100);
      };
      check();
    });
    await timedAsync(
      'city: base mesh + skyline',
      Promise.all([baseDone, skyDone]),
    );
  }

  private onSummary(
    summary: LayoutSummary,
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
      lod2: null,
      lod1: null,
      lod0: null,
      lights1: new Float32Array(0),
      lights0: new Float32Array(0),
      pending0: false,
      pending1: false,
      pending2: false,
    }));
    timed('setTerrain', () =>
      this.renderer.setTerrain(
        L.heights,
        L.heightN,
        L.cell,
        L.params.size,
        landUse,
      ),
    );
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
    let h = this.renderer.uploadClusters(clusters);
    // Pool full (or too fragmented): drop the shells in the LOD1 / LOD2
    // band that are not on show and try once more.
    if (!h && clusters.clusterCount > 0 && this.reclaimShells())
      h = this.renderer.uploadClusters(clusters);
    if (!h && clusters.clusterCount > 0)
      console.warn(`city: cluster pool full, tile ${tile} LOD${lod} dropped`);
    release(clusters.vertices, clusters.tris, clusters.clusters);
    if (lod === 2) {
      s.pending2 = false;
      if (s.lod2) this.renderer.freeClusters(s.lod2);
      s.lod2 = h;
      // (Shell lights are the same at LOD1 and LOD2.)
      s.lights1 = lights;
    } else if (lod === 1) {
      s.pending1 = false;
      if (s.lod1) this.renderer.freeClusters(s.lod1);
      s.lod1 = h;
      s.lights1 = lights;
    } else {
      s.pending0 = false;
      if (s.lod0) this.renderer.freeClusters(s.lod0);
      s.lod0 = h;
      s.lights0 = lights;
    }
  }

  /** Frees every resident shell its tile is not showing; true if any. */
  private reclaimShells() {
    let freed = false;
    // For a while, ask only for the shell a tile shows (no prefetch band),
    // or the band would refill the pool straight away.
    this.tightUntil = performance.now() + 10000;
    for (let t = 0; t < this.tiles.length; t++) {
      const s = this.tiles[t];
      if (!s.lod1 || !s.lod2) continue;
      if (this.tileLods[t] === 2) {
        this.renderer.freeClusters(s.lod1);
        s.lod1 = null;
      } else {
        this.renderer.freeClusters(s.lod2);
        s.lod2 = null;
      }
      freed = true;
    }
    return freed;
  }

  private pump() {
    for (let i = 0; i < this.workers.length; i++) {
      if (!this.ready[i]) continue;
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
    // Queued plus in flight (the asset lab waits for 0).
    this.stats.queue = this.queue.length + this.busy.reduce((a, b) => a + b, 0);
  }

  /**
   * Request/evict LOD0 tiles around `p`, keep each tile's LOD1 or LOD2
   * shell resident and publish per-tile LOD choices.
   */
  updateStreaming(p: Vec3, initial = false) {
    if (!this.tiles.length) return;
    this.updateShells(p, initial);
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
    let lod2 = 0;
    const forced = this.forceLod1 || this.forceLod2;
    for (let t = 0; t < this.tiles.length; t++) {
      const s = this.tiles[t];
      const d = this.tileDist(t, p);
      if (s.lod0 && d > this.lod0Radius + 250) {
        this.renderer.freeClusters(s.lod0);
        s.lod0 = null;
        s.lights0 = new Float32Array(0);
      }
      const use0 = !!s.lod0 && !forced && d < this.lod0Radius + 120;
      // The shell for this distance (40 m hysteresis), or whichever one
      // is resident.
      const edge = this.lod2Dist + (this.tileLods[t] === 2 ? -40 : 0);
      const far = this.forceLod2 || (!this.forceLod1 && d >= edge);
      let lod = 1;
      if (use0) lod = 0;
      else if (s.lod2 && (far || !s.lod1)) lod = 2;
      this.tileLods[t] = lod;
      if (lod === 0) lod0++;
      else if (lod === 1 && s.lod1) lod1++;
      else if (lod === 2) lod2++;
    }
    this.renderer.setTileLods(this.tileLods);
    this.stats.lod0 = lod0;
    this.stats.lod1 = lod1;
    this.stats.lod2 = lod2;
    if (!initial) this.pump();
  }

  /**
   * Shell residency: LOD1 within lod2Dist (+ SHELL_PREFETCH), LOD2 beyond
   * (- SHELL_PREFETCH); a shell is freed once the other one is resident and
   * the tile is SHELL_KEEP past the switch. New requests go to the back of
   * the queue (behind LOD0), nearest first.
   */
  private updateShells(p: Vec3, initial: boolean) {
    const add: {tile: number; lod: number; d: number}[] = [];
    const pre = performance.now() < this.tightUntil ? 0 : SHELL_PREFETCH;
    for (let t = 0; t < this.tiles.length; t++) {
      const s = this.tiles[t];
      const d = this.tileDist(t, p);
      const want1 =
        this.forceLod1 || (!this.forceLod2 && d < this.lod2Dist + pre);
      const want2 =
        this.forceLod2 || (!this.forceLod1 && d >= this.lod2Dist - pre);
      if (want1 && !s.lod1 && !s.pending1) {
        s.pending1 = true;
        add.push({tile: t, lod: 1, d});
      }
      if (want2 && !s.lod2 && !s.pending2) {
        s.pending2 = true;
        add.push({tile: t, lod: 2, d});
      }
      const forced = this.forceLod1 || this.forceLod2;
      if (
        s.lod1 &&
        s.lod2 &&
        (forced ? this.forceLod2 : d > this.lod2Dist + SHELL_KEEP)
      ) {
        this.renderer.freeClusters(s.lod1);
        s.lod1 = null;
      }
      if (
        s.lod1 &&
        s.lod2 &&
        (forced ? this.forceLod1 : d < this.lod2Dist - SHELL_KEEP)
      ) {
        this.renderer.freeClusters(s.lod2);
        s.lod2 = null;
      }
    }
    if (!add.length) return;
    add.sort((a, b) => a.d - b.d);
    for (const j of add) this.queue.push({tile: j.tile, lod: j.lod});
    if (initial) this.stats.queue = this.queue.length;
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
    // Candidates in typed arrays (no object per light): distance beyond the
    // light's radius, source array and light index.
    let nc = 0;
    const srcs: Float32Array[] = [];
    const consider = (src: Float32Array, si: number, i: number) => {
      const dx = src[i * 8] - eye[0];
      const dy = src[i * 8 + 1] - eye[1];
      const dz = src[i * 8 + 2] - eye[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - src[i * 8 + 3];
      if (d >= 600) return;
      if (nc === this.candD.length) this.growCandidates();
      this.candD[nc] = d;
      this.candSrc[nc] = si;
      this.candI[nc] = i;
      nc++;
    };
    for (const t of near) {
      const bi = srcs.push(this.baseLights) - 1;
      for (const i of this.baseLightTiles[t]) consider(this.baseLights, bi, i);
      const s = this.tiles[t];
      const tl = this.tileLods[t] === 0 ? s.lights0 : s.lights1;
      const ti = srcs.push(tl) - 1;
      for (let i = 0; i < tl.length / 8; i++) consider(tl, ti, i);
    }
    const out = this.lightScratch;
    out.set(extra.subarray(0, ne * 8));
    const n = Math.min(nc, 1024 - ne);
    const order = nearestFirst(this.candD, nc, n);
    for (let k = 0; k < n; k++) {
      const c = order[k];
      const src = srcs[this.candSrc[c]];
      const i = this.candI[c];
      const kind = src[i * 8 + 7];
      const scale =
        (kind < 0.5 // street lights carry their road axis in the fraction
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

  private growCandidates() {
    const grow = <T extends Float64Array | Uint32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.candD = grow(this.candD);
    this.candSrc = grow(this.candSrc);
    this.candI = grow(this.candI);
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const s of this.tiles) {
      if (s.lod0) this.renderer.freeClusters(s.lod0);
      if (s.lod1) this.renderer.freeClusters(s.lod1);
      if (s.lod2) this.renderer.freeClusters(s.lod2);
    }
    for (const h of this.baseHandles) this.renderer.freeClusters(h);
    this.workers = [];
    this.tiles = [];
  }

  groundHeight(x: number, z: number) {
    return this.heights ? this.heights.sample(x, z) : 0;
  }
}
