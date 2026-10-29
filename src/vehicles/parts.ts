// Reusable NURBS-built parts shared by vehicle designs.

import type {Vec3} from '../math/vec.ts';
import {emptyMesh, tessellate, type Mesh} from '../nurbs/mesh.ts';
import {makeCurve, revolve} from '../nurbs/nurbs.ts';
import {Mat} from './types.ts';

/**
 * A wheel (tyre + rim) around the origin with its axle along x, built by
 * revolving profiles. `outward` = +1 puts the rim face toward +x.
 */
export function wheelMesh(radius: number, width: number, opts: {spokes?: number; rimRatio?: number} = {}): Mesh {
  const m = emptyMesh();
  const hw = width / 2;
  const rimR = radius * (opts.rimRatio ?? 0.62);
  // Tyre profile in the x/y plane (x = axle, y = radius), revolved around x.
  const tyre = makeCurve(
    [
      [hw * 0.8, rimR, 0],
      [hw * 1.05, rimR + (radius - rimR) * 0.35, 0],
      [hw * 1.0, radius * 0.97, 0],
      [hw * 0.6, radius, 0],
      [-hw * 0.6, radius, 0],
      [-hw * 1.0, radius * 0.97, 0],
      [-hw * 1.05, rimR + (radius - rimR) * 0.35, 0],
      [-hw * 0.8, rimR, 0],
    ],
    3,
  );
  tessellate(m, revolve(tyre, [0, 0, 0], [1, 0, 0]), Mat.rubber, {segU: 10, segV: 24});
  // Rim face: a dished disc.
  const rim = makeCurve(
    [
      [hw * 0.8, rimR, 0],
      [hw * 0.7, rimR * 0.8, 0],
      [hw * 0.45, rimR * 0.35, 0],
      [hw * 0.5, rimR * 0.12, 0],
      [hw * 0.55, 0, 0],
    ],
    2,
  );
  tessellate(m, revolve(rim, [0, 0, 0], [1, 0, 0]), Mat.rim, {segU: 6, segV: 24, flip: true});
  const inner = makeCurve(
    [
      [-hw * 0.8, rimR, 0],
      [-hw * 0.3, rimR * 0.5, 0],
      [-hw * 0.2, 0, 0],
    ],
    2,
  );
  tessellate(m, revolve(inner, [0, 0, 0], [1, 0, 0]), Mat.metal, {segU: 3, segV: 16});
  return m;
}

/** Helper to mirror a list of points across x = 0. */
export const mirrorPts = (pts: Vec3[]): Vec3[] => pts.map(p => [-p[0], p[1], p[2]]);
