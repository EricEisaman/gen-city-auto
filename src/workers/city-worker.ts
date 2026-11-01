// City generation worker. Every worker regenerates the deterministic layout for
// itself (in parallel), then serves tile jobs. Only the primary builds the
// base mesh: it sends the one piece of base-build state that tiles depend on
// (the curb band triangles) to the others, which derive the rest themselves
// (see tileGeom). Running buildBase in every worker at once cost several GB
// of transient memory in the one renderer process.

import {clusterize, type ClusterData} from '../city/cmesh.ts';
import {PRESETS, type CityType} from '../city/config.ts';
import {bandTrisData, buildBase, tileGeom} from '../city/gen-base.ts';
import {
  buildTile,
  makeTileContext,
  type TileContext,
} from '../city/gen-tile.ts';
import {baseFarOf} from '../city/lod.ts';
import {isolate, labInfo, type LabInfo, type LabSpec} from '../city/lab.ts';
import {
  generateLayout,
  type CityLayout,
  type LayoutPartial,
} from '../city/layout.ts';
import {packPreview, previewTransfer} from '../city/preview.ts';
import type {RoadGeom} from '../city/roadgeom.ts';
import {buildSkyline, SKYLINE_N} from '../city/skyline.ts';
import {Heightfield} from '../city/terrain.ts';

export type WorkerRequest =
  | {
      type: 'init';
      cityType: CityType;
      seed: number;
      primary: boolean;
      /** Asset lab: isolate one asset (see city/lab.ts). */
      lab?: LabSpec;
    }
  /** Non-primary workers: the primary's curb band (see tileGeom). */
  | {type: 'band'; band: Float64Array}
  | {type: 'tile'; tile: number; lod: number; id: number};

export interface LayoutSummary {
  layout: Omit<CityLayout, 'blocks' | 'terrain'> & {
    heights: Float32Array;
    heightN: number;
    cell: number;
  };
  geom: RoadGeom;
  /** Bridge/viaduct solids for the camera (see BaseGeometry.solids). */
  solids?: number[];
  /** Asset lab: the isolated asset and its camera presets. */
  lab?: LabInfo;
}

let layout: CityLayout | null = null;
let ctx: TileContext | null = null;
/** Primary: the skyline map, built once the base is on its way. */
let skyline: (() => Float32Array) | null = null;

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

const abs = () => performance.timeOrigin + performance.now();
/** Timeline span (absolute times; see ui/timeline.ts). */
const span = (name: string, start: number) =>
  post({type: 'span', name, start, end: abs()});
// Worker spin-up: creation to this module running.
span('worker script loaded', performance.timeOrigin);

/** Run fn and send its span. */
function timed<T>(name: string, fn: () => T): T {
  const t = abs();
  const r = fn();
  span(name, t);
  return r;
}

/** Tile builds served since the last report (sum of ms). */
let tileMs = 0;
let tileCount = 0;

function clusterTransfer(c: ClusterData): Transferable[] {
  return [c.vertices.buffer, c.tris.buffer, c.clusters.buffer];
}

function init(req: Extract<WorkerRequest, {type: 'init'}>) {
  const params = PRESETS[req.cityType];
  // Primary: progress messages, each layout step as a span, and the
  // finished parts for the loading screen's map.
  let step = '';
  let stepT = 0;
  const progress = (msg: string, f: number, partial?: LayoutPartial) => {
    if (step) span(`layout: ${step}`, stepT);
    step = msg;
    stepT = abs();
    post({type: 'progress', msg, f});
    const pv = partial && packPreview(partial, params.size);
    if (pv) post({type: 'preview', preview: pv}, previewTransfer(pv));
  };
  layout = timed('generateLayout', () =>
    generateLayout(params, req.seed, req.primary ? progress : undefined),
  );
  // The lab filters the finished layout, so generation is unchanged.
  const iso = req.lab ? isolate(layout, req.lab) : null;
  if (iso) layout = iso.layout;
  if (!req.primary) return;
  const lay = layout;
  post({type: 'progress', msg: 'Building street meshes', f: 0.72});
  const base = timed('buildBase', () => buildBase(lay));
  ctx = timed('makeTileContext', () =>
    makeTileContext(lay, base.geom, base.roadMask),
  );
  // The others build their tile context while this one clusterizes.
  const band = bandTrisData(base.geom);
  post({type: 'band', band}, [band.buffer]);
  post({type: 'progress', msg: 'Uploading city', f: 0.75});
  const {terrain, blocks, ...rest} = layout;
  void blocks;
  const summary: LayoutSummary = {
    layout: {
      ...rest,
      heights: base.terrainHeights,
      heightN: terrain.heights.n,
      cell: terrain.heights.cell,
    },
    geom: base.geom,
    solids: base.solids,
    lab: iso ? labInfo(iso, base.geom, base.solids) : undefined,
  };
  // Fine base detail (kerbs, railings, wires, thin paint) drops at range.
  const tc = abs();
  const baseClusters = clusterize(
    base.mesh,
    0,
    0xffffffff,
    1,
    baseFarOf(base.mesh),
  );
  const pierClusters = clusterize(base.piers, 0, 0xffffffff, 0);
  span('clusterize base', tc);
  post(
    {
      type: 'base',
      summary,
      base: baseClusters,
      piers: pierClusters,
      lights: new Float32Array(base.lights),
      landUse: base.landUse,
    },
    [
      ...clusterTransfer(baseClusters),
      ...clusterTransfer(pierClusters),
      base.landUse.buffer,
    ],
  );
  const hf = new Heightfield(
    lay.params.size,
    terrain.heights.cell,
    base.terrainHeights,
  );
  skyline = () => buildSkyline(lay.buildings, hf, lay.params.size);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'init') {
      init(req);
      post({type: 'ready'});
      if (skyline) {
        // (After 'ready': the other workers start on tiles meanwhile.)
        const sky = timed('buildSkyline', skyline);
        skyline = null;
        post({type: 'skyline', sky, n: SKYLINE_N}, [sky.buffer]);
      }
    } else if (req.type === 'band') {
      if (!layout) throw new Error('band before init');
      const lay = layout;
      const t = timed('tileGeom', () => tileGeom(lay, req.band));
      ctx = timed('makeTileContext', () =>
        makeTileContext(lay, t.geom, t.roadMask),
      );
    } else if (req.type === 'tile') {
      if (!ctx) throw new Error('tile request before init');
      const t0 = abs();
      const r = buildTile(ctx, req.tile, req.lod);
      const c = clusterize(r.mesh, req.lod, req.tile, 1);
      const lights = new Float32Array(r.lights);
      tileMs += abs() - t0;
      tileCount++;
      post(
        {
          type: 'tile',
          tile: req.tile,
          lod: req.lod,
          id: req.id,
          clusters: c,
          lights,
          tileMs,
          tileCount,
        },
        [...clusterTransfer(c), lights.buffer],
      );
    }
  } catch (err) {
    post({
      type: 'error',
      message:
        err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
    });
  }
};
