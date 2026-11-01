// Compact snapshots of a layout in progress for the loading screen's map
// (packed in the primary city worker, drawn by ui/loading.ts).

import type {Vec2} from '../math/vec.ts';
import type {LayoutPartial} from './layout.ts';
import {SEA_LEVEL} from './terrain.ts';

/** Polylines or polygons: x,z pairs, start offsets (in points), a value each. */
export interface PreviewShapes {
  pts: Float32Array;
  offs: Uint32Array;
  val: Float32Array;
}

export type Preview =
  | {kind: 'terrain'; size: number; n: number; h: Float32Array; sea: number}
  | ({
      kind: 'streets' | 'roads' | 'rail' | 'blocks' | 'buildings';
      size: number;
    } & PreviewShapes);

/** Terrain heights resampled to this many cells per side. */
const TERRAIN_N = 256;

function shapes(list: {pts: Vec2[]; val: number}[]): PreviewShapes {
  let n = 0;
  for (const s of list) n += s.pts.length;
  const pts = new Float32Array(n * 2);
  const offs = new Uint32Array(list.length + 1);
  const val = new Float32Array(list.length);
  let k = 0;
  list.forEach((s, i) => {
    offs[i] = k;
    val[i] = s.val;
    for (const q of s.pts) {
      pts[k * 2] = q[0];
      pts[k * 2 + 1] = q[1];
      k++;
    }
  });
  offs[list.length] = k;
  return {pts, offs, val};
}

/** Pack what a progress step finished (null if nothing to show). */
export function packPreview(p: LayoutPartial, size: number): Preview | null {
  if (p.terrain) {
    const hf = p.terrain.heights;
    const n = TERRAIN_N;
    const h = new Float32Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++)
        h[j * n + i] = hf.sample(
          -size / 2 + ((i + 0.5) / n) * size,
          -size / 2 + ((j + 0.5) / n) * size,
        );
    return {kind: 'terrain', size, n, h, sea: SEA_LEVEL};
  }
  if (p.streets)
    return {
      kind: 'streets',
      size,
      ...shapes(p.streets.map(l => ({pts: l.pts, val: l.kind}))),
    };
  if (p.chains)
    return {
      kind: 'roads',
      size,
      ...shapes(p.chains.map(c => ({pts: c.pts, val: c.kind}))),
    };
  if (p.elevated)
    return {
      kind: 'rail',
      size,
      ...shapes(
        p.elevated.map(e => ({pts: e.pts, val: e.kind === 'rail' ? 1 : 0})),
      ),
    };
  if (p.blocks)
    return {
      kind: 'blocks',
      size,
      ...shapes(p.blocks.map(b => ({pts: b.curb, val: b.park ? 1 : 0}))),
    };
  if (p.buildings)
    return {
      kind: 'buildings',
      size,
      ...shapes(p.buildings.map(b => ({pts: b.footprint, val: b.height}))),
    };
  return null;
}

/** Transferable buffers of a preview. */
export function previewTransfer(p: Preview): Transferable[] {
  return p.kind === 'terrain'
    ? [p.h.buffer]
    : [p.pts.buffer, p.offs.buffer, p.val.buffer];
}
