// City generation worker. The layout is made once: every worker shades a band
// of the terrain rows and sends it up a tree of message ports to the primary
// (set up by world/city.ts), which generates the rest of the layout and sends
// it back down the tree (each worker forwards it to its children). The base
// mesh is built in parts (see BASE_PARTS): the primary builds the blocks,
// two helpers (workers 1 and 2) the roads and the elevated structures, and
// the primary puts them together. The blocks record the one piece of
// base-build state that tiles depend on (the curb band triangles), which the
// primary sends to the others; they derive the rest of their tile context
// themselves (see tileGeom). Running buildBase in every worker at once cost
// several GB of transient memory in the one renderer process.

import {clusterize, type ClusterData} from '../city/cmesh.ts';
import {packClusters} from '../city/vpack.ts';
import {release} from '../mem.ts';
import {PRESETS, type CityType} from '../city/config.ts';
import {
  assembleBase,
  attachBand,
  bandTrisData,
  basePartTransfer,
  buildBasePart,
  tileGeom,
  type BasePart,
  type BasePartName,
} from '../city/gen-base.ts';
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
import {computeRoadGeom, type RoadGeom} from '../city/roadgeom.ts';
import {buildSkyline, SKYLINE_N} from '../city/skyline.ts';
import {
  assembleTerrain,
  Heightfield,
  terrainBand,
  terrainPlan,
  terrainRows,
  type Terrain,
  type TerrainPlan,
} from '../city/terrain.ts';

export type WorkerRequest =
  | {
      type: 'init';
      cityType: CityType;
      seed: number;
      primary: boolean;
      /** Asset lab: isolate one asset (see city/lab.ts). */
      lab?: LabSpec;
      /** This worker's index (0 = primary) and the worker count. */
      index: number;
      count: number;
      /** Tree edges: bands and base parts go up, the layout comes down. */
      parent?: MessagePort;
      children: MessagePort[];
    }
  /** Non-primary workers: the primary's curb band (see tileGeom). */
  | {type: 'band'; band: Float64Array}
  | {type: 'tile'; tile: number; lod: number; id: number};

/** Worker-to-worker messages, over the tree's ports. */
type PortMessage =
  | {type: 'terrain'; k: number; rows: Float32Array}
  | {type: 'layout'; layout: CityLayout; sent: number}
  | {type: 'part'; part: BasePart};

/** The base parts the helpers build; the primary builds the blocks. */
const HELPER_PARTS: BasePartName[] = ['roads', 'elevated'];
/**
 * Worker i's share of HELPER_PARTS (workers 1 .. count - 1, round robin;
 * they are the primary's children in the tree).
 */
const helperParts = (i: number, count: number) =>
  i ? HELPER_PARTS.filter((_, j) => 1 + (j % (count - 1)) === i) : [];

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

let req0: Extract<WorkerRequest, {type: 'init'}>;
let layout: CityLayout | null = null;
let ctx: TileContext | null = null;
/** Non-primary: the tile context's road geometry, awaiting the band. */
let roadGeom: ReturnType<typeof tileGeom> | null = null;
/** Main-thread requests that arrived before the layout. */
const pending: WorkerRequest[] = [];
/** Primary: the terrain bands so far. */
let bands: {plan: TerrainPlan; rows: Float32Array[]; got: number} | null = null;
/** Primary: the base build waiting for the helpers' parts. */
let baseWait: {
  lay: CityLayout;
  iso: ReturnType<typeof isolate> | null;
  geom: RoadGeom;
  parts: BasePart[];
  t: number;
} | null = null;
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

/** The GPU's packed vertex format (vpack.ts); frees the unpacked arrays. */
function pack(c: ClusterData) {
  const p = packClusters(c);
  release(c.vertices, c.clusters);
  return p;
}

function clusterTransfer(c: ClusterData): Transferable[] {
  return [c.vertices.buffer, c.tris.buffer, c.clusters.buffer];
}

// Primary: progress messages, each layout step as a span, and the finished
// parts for the loading screen's map.
let step = '';
let stepT = 0;
function progress(msg: string, f: number, partial?: LayoutPartial) {
  if (step) span(`layout: ${step}`, stepT);
  step = msg;
  stepT = abs();
  post({type: 'progress', msg, f});
  const pv = partial && packPreview(partial, PRESETS[req0.cityType].size);
  if (pv) post({type: 'preview', preview: pv}, previewTransfer(pv));
}

/** Every worker: shade its band of terrain rows and send it up. */
function start(req: Extract<WorkerRequest, {type: 'init'}>) {
  req0 = req;
  for (const c of req.children) c.onmessage = onPort;
  if (req.parent) req.parent.onmessage = onPort;
  if (req.primary) progress('Shaping terrain', 0.05);
  const plan = terrainPlan(PRESETS[req.cityType], req.seed);
  const [j0, j1] = terrainBand(plan.n, req.index, req.count);
  const rows = timed('terrain rows', () => terrainRows(plan, j0, j1));
  if (req.primary) {
    bands = {plan, rows: [], got: 0};
    addBand(req.index, rows);
  } else {
    const m: PortMessage = {type: 'terrain', k: req.index, rows};
    req.parent!.postMessage(m, [rows.buffer]);
  }
}

/** Primary: a band arrived; with all of them, make the city. */
function addBand(k: number, rows: Float32Array) {
  const b = bands!;
  b.rows[k] = rows;
  if (++b.got < req0.count) return;
  bands = null;
  const heights = new Float32Array(b.plan.n * b.plan.n);
  for (let i = 0, o = 0; i < b.rows.length; o += b.rows[i++].length)
    heights.set(b.rows[i], o);
  makeCity(assembleTerrain(b.plan, heights));
}

function onPort(e: MessageEvent<PortMessage>) {
  const m = e.data;
  try {
    if (m.type === 'terrain') {
      if (req0.primary) addBand(m.k, m.rows);
      else req0.parent!.postMessage(m, [m.rows.buffer]);
      return;
    }
    if (m.type === 'part') {
      // (Helpers are the primary's children.)
      addPart(m.part);
      return;
    }
    // The layout: down the tree first, then unpack this worker's copy.
    span('layout transfer', m.sent);
    if (req0.children.length)
      timed('forward layout', () => {
        for (const c of req0.children) c.postMessage(m);
      });
    const L = m.layout;
    const h = L.terrain.heights;
    L.terrain.heights = new Heightfield(h.size, h.cell, h.data);
    // The lab filters the finished layout, so generation is unchanged.
    const lay = (layout = req0.lab ? isolate(L, req0.lab).layout : L);
    // Everything of the tile context but the primary's curb band, made
    // while the primary builds the base mesh.
    const rg = (roadGeom = timed('tileGeom', () => tileGeom(lay)));
    post({type: 'ready'});
    for (const r of pending.splice(0)) handle(r);
    // This worker's share of the base mesh, for the primary.
    for (const name of helperParts(req0.index, req0.count)) {
      const part = timed(`base part: ${name}`, () =>
        buildBasePart(lay, name, rg.geom, rg.roadMask),
      );
      // (The primary takes the mask from the roads.)
      if (name === 'roads') part.mask = rg.roadMask.slice();
      const pm: PortMessage = {type: 'part', part};
      req0.parent!.postMessage(pm, basePartTransfer(part));
    }
  } catch (err) {
    fail(err);
  }
}

/** Primary: the layout (sent down the tree), then its part of the base. */
function makeCity(terrain: Terrain) {
  const req = req0;
  const params = PRESETS[req.cityType];
  layout = timed('generateLayout', () =>
    generateLayout(params, req.seed, progress, terrain),
  );
  if (req.children.length) {
    const m: PortMessage = {type: 'layout', layout, sent: abs()};
    timed('send layout', () => {
      for (const c of req.children) c.postMessage(m);
    });
  }
  const iso = req.lab ? isolate(layout, req.lab) : null;
  if (iso) layout = iso.layout;
  const lay = layout;
  post({type: 'progress', msg: 'Building street meshes', f: 0.72});
  const t = abs();
  const geom = timed('computeRoadGeom', () => computeRoadGeom(lay));
  const blocks = timed('base part: blocks', () =>
    buildBasePart(lay, 'blocks', geom),
  );
  // The others attach the curb band to their tile context meanwhile.
  const band = bandTrisData(geom);
  post({type: 'band', band}, [band.buffer]);
  baseWait = {lay, iso, geom, parts: [blocks], t};
}

/** Primary: a base part arrived; with all of them, finish the city. */
function addPart(part: BasePart) {
  const w = baseWait!;
  w.parts.push(part);
  if (w.parts.length < 1 + HELPER_PARTS.length) return;
  baseWait = null;
  span('base parts (in workers)', w.t);
  finishCity(w.lay, w.iso, w.geom, w.parts);
  // (The other workers are on tiles meanwhile.)
  const sky = timed('buildSkyline', skyline!);
  skyline = null;
  post({type: 'skyline', sky, n: SKYLINE_N}, [sky.buffer]);
  post({type: 'ready'});
  for (const r of pending.splice(0)) handle(r);
}

/** Primary: the base from its parts; the summary, then the base clusters. */
function finishCity(
  lay: CityLayout,
  iso: ReturnType<typeof isolate> | null,
  geom: RoadGeom,
  parts: BasePart[],
) {
  const base = timed('assembleBase', () =>
    assembleBase(lay, geom, undefined, parts),
  );
  // (Free the parts' copies before clusterize allocates.)
  for (const p of parts) release(p.words, p.idx, p.pierWords, p.pierIdx);
  parts.length = 0;
  ctx = timed('makeTileContext', () =>
    makeTileContext(lay, base.geom, base.roadMask),
  );
  post({type: 'progress', msg: 'Uploading city', f: 0.75});
  const {terrain: lt, blocks: _blocks, ...rest} = lay;
  void _blocks;
  const summary: LayoutSummary = {
    layout: {
      ...rest,
      heights: base.terrainHeights,
      heightN: lt.heights.n,
      cell: lt.heights.cell,
    },
    geom: base.geom,
    solids: base.solids,
    lab: iso ? labInfo(iso, base.geom, base.solids) : undefined,
  };
  post(
    {
      type: 'summary',
      summary,
      lights: new Float32Array(base.lights),
      landUse: base.landUse,
    },
    [base.landUse.buffer],
  );
  // Fine base detail (kerbs, railings, wires, thin paint) drops at range.
  const tc = abs();
  const baseClusters = pack(
    clusterize(base.mesh, 0, 0xffffffff, 1, baseFarOf(base.mesh)),
  );
  release(base.mesh.u32, base.mesh.idx);
  const pierClusters = pack(clusterize(base.piers, 0, 0xffffffff, 0));
  release(base.piers.u32, base.piers.idx);
  span('clusterize base', tc);
  post({type: 'base', base: baseClusters, piers: pierClusters}, [
    ...clusterTransfer(baseClusters),
    ...clusterTransfer(pierClusters),
  ]);
  const hf = new Heightfield(
    lay.params.size,
    lt.heights.cell,
    base.terrainHeights,
  );
  skyline = () => buildSkyline(lay.buildings, hf, lay.params.size);
}

function fail(err: unknown) {
  post({
    type: 'error',
    message:
      err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
  });
}

function handle(req: WorkerRequest) {
  if (req.type === 'init') {
    start(req);
    return;
  }
  if (!layout) {
    // (A non-primary worker before the layout reached it.)
    pending.push(req);
    return;
  }
  if (req.type === 'band') {
    const lay = layout;
    const t = roadGeom!;
    roadGeom = null;
    attachBand(t.geom, req.band);
    ctx = timed('makeTileContext', () =>
      makeTileContext(lay, t.geom, t.roadMask),
    );
  } else if (req.type === 'tile') {
    if (!ctx) throw new Error('tile request before init');
    const t0 = abs();
    const r = buildTile(ctx, req.tile, req.lod);
    const raw = clusterize(r.mesh, req.lod, req.tile, 1);
    release(r.mesh.u32, r.mesh.idx);
    const c = pack(raw);
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
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    handle(e.data);
  } catch (err) {
    fail(err);
  }
};
