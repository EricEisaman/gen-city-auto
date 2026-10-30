// City generation worker. Every worker regenerates the deterministic layout for
// itself (in parallel), then serves base-geometry and tile jobs.

import {clusterize, type ClusterData} from '../city/cmesh.ts';
import {PRESETS, type CityType} from '../city/config.ts';
import {buildBase} from '../city/gen-base.ts';
import {
  buildTile,
  makeTileContext,
  type TileContext,
} from '../city/gen-tile.ts';
import {isolate, labInfo, type LabInfo, type LabSpec} from '../city/lab.ts';
import {generateLayout, type CityLayout} from '../city/layout.ts';
import type {RoadGeom} from '../city/roadgeom.ts';

export type WorkerRequest =
  | {
      type: 'init';
      cityType: CityType;
      seed: number;
      primary: boolean;
      /** Asset lab: isolate one asset (see city/lab.ts). */
      lab?: LabSpec;
    }
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

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

function clusterTransfer(c: ClusterData): Transferable[] {
  return [c.vertices.buffer, c.tris.buffer, c.clusters.buffer];
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'init') {
      const params = PRESETS[req.cityType];
      layout = generateLayout(
        params,
        req.seed,
        req.primary ? (msg, f) => post({type: 'progress', msg, f}) : undefined,
      );
      // The lab filters the finished layout, so generation is unchanged.
      const iso = req.lab ? isolate(layout, req.lab) : null;
      if (iso) layout = iso.layout;
      const base = buildBase(layout);
      ctx = makeTileContext(layout, base.geom, base.roadMask);
      if (req.primary) {
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
        const baseClusters = clusterize(base.mesh, 0, 0xffffffff, 1);
        const pierClusters = clusterize(base.piers, 0, 0xffffffff, 0);
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
      }
      post({type: 'ready'});
    } else if (req.type === 'tile') {
      if (!ctx) throw new Error('tile request before init');
      const r = buildTile(ctx, req.tile, req.lod);
      const c = clusterize(r.mesh, req.lod, req.tile, 1);
      const lights = new Float32Array(r.lights);
      post(
        {
          type: 'tile',
          tile: req.tile,
          lod: req.lod,
          id: req.id,
          clusters: c,
          lights,
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
