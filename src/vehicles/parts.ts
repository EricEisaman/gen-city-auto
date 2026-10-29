// Reusable NURBS-built parts shared by vehicle designs.

import type {Vec3} from '../math/vec.ts';
import {emptyMesh, tessellate, type Mesh} from '../nurbs/mesh.ts';
import {circle, loftPoints, makeCurve, revolve} from '../nurbs/nurbs.ts';
import {Mat} from './types.ts';

/**
 * A wheel (tyre + rim) around the origin with its axle along x, built by
 * revolving profiles. The rim face points toward +x (the renderer mirrors the
 * mesh for left-side wheels).
 */
export function wheelMesh(
  radius: number,
  width: number,
  opts: {spokes?: number; rimRatio?: number; rimMat?: number} = {},
): Mesh {
  const m = emptyMesh();
  const hw = width / 2;
  const rimR = radius * (opts.rimRatio ?? 0.66);
  const rimMat = opts.rimMat ?? Mat.rim;
  // Tyre profile in the x/y plane (x = axle, y = radius), revolved around x.
  const tyre = makeCurve(
    [
      [hw * 0.82, rimR, 0],
      [hw * 1.02, rimR + (radius - rimR) * 0.3, 0],
      [hw * 1.02, radius * 0.96, 0],
      [hw * 0.7, radius, 0],
      [-hw * 0.7, radius, 0],
      [-hw * 1.02, radius * 0.96, 0],
      [-hw * 1.02, rimR + (radius - rimR) * 0.3, 0],
      [-hw * 0.82, rimR, 0],
    ],
    3,
  );
  tessellate(m, revolve(tyre, [0, 0, 0], [1, 0, 0]), Mat.rubber, {
    segU: 12,
    segV: 28,
  });
  // Rim lip: from the tyre bead out to the face.
  const lip = makeCurve(
    [
      [hw * 0.82, rimR, 0],
      [hw * 0.92, rimR * 0.99, 0],
      [hw * 0.9, rimR * 0.93, 0],
      [hw * 0.7, rimR * 0.9, 0],
    ],
    2,
  );
  tessellate(m, revolve(lip, [0, 0, 0], [1, 0, 0]), rimMat, {
    segU: 4,
    segV: 28,
    flip: true,
  });
  // Recessed dark barrel/disc seen between the spokes.
  const well = makeCurve(
    [
      [hw * 0.7, rimR * 0.9, 0],
      [-hw * 0.2, rimR * 0.88, 0],
      [-hw * 0.3, rimR * 0.4, 0],
      [-hw * 0.3, 0, 0],
    ],
    2,
  );
  tessellate(m, revolve(well, [0, 0, 0], [1, 0, 0]), Mat.metal, {
    segU: 4,
    segV: 20,
    flip: true,
  });
  // Spokes.
  const n = opts.spokes ?? 5;
  const face = hw * 0.72;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const ca = Math.cos(a),
      sa = Math.sin(a);
    const rows: Vec3[][] = [];
    for (const r of [rimR * 0.2, rimR * 0.45, rimR * 0.7, rimR * 0.92]) {
      const w = lerp(rimR * 0.13, rimR * 0.07, r / rimR);
      const dish = face - (r / rimR) * hw * 0.25;
      const pt = (x: number, t: number): Vec3 => [
        x,
        r * ca - t * sa,
        r * sa + t * ca,
      ];
      rows.push([
        pt(dish - hw * 0.5, -w),
        pt(dish, -w * 0.85),
        pt(dish + 0.004, 0),
        pt(dish, w * 0.85),
        pt(dish - hw * 0.5, w),
      ]);
    }
    tessellate(m, loftPoints(rows, {degreeU: 2, degreeV: 2}), rimMat, {
      segU: 4,
      segV: 3,
      flip: true,
    });
  }
  // Hub cap.
  const hub = makeCurve(
    [
      [face + 0.004, rimR * 0.22, 0],
      [face + 0.012, rimR * 0.15, 0],
      [face + 0.014, 0, 0],
    ],
    2,
  );
  tessellate(m, revolve(hub, [0, 0, 0], [1, 0, 0]), rimMat, {
    segU: 2,
    segV: 12,
    flip: true,
  });
  // Inner side of the wheel (brake side).
  const inner = makeCurve(
    [
      [-hw * 0.82, rimR, 0],
      [-hw * 0.5, rimR * 0.6, 0],
      [-hw * 0.4, 0, 0],
    ],
    2,
  );
  tessellate(m, revolve(inner, [0, 0, 0], [1, 0, 0]), Mat.metal, {
    segU: 3,
    segV: 16,
  });
  return m;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Steering wheel in its local frame: ring in the x/y plane, column along +z. */
export function steeringWheelMesh(
  radius = 0.185,
  mat: number = Mat.plastic,
): Mesh {
  const m = emptyMesh();
  const ring = circle([radius, 0, 0], [1, 0, 0], [0, 0, 1], 0.016);
  tessellate(m, revolve(ring, [0, 0, 0], [0, 0, 1]), mat, {
    segU: 8,
    segV: 28,
    flip: true,
  });
  // Hub and three spokes (left, right, bottom).
  const hub = makeCurve(
    [
      [0.06, 0, 0.03],
      [0.065, 0, 0.0],
      [0.05, 0, -0.025],
      [0, 0, -0.03],
    ],
    2,
  );
  tessellate(m, revolve(hub, [0, 0, 0], [0, 0, 1]), mat, {segU: 4, segV: 16});
  for (const a of [0, Math.PI, -Math.PI / 2]) {
    const ca = Math.cos(a),
      sa = Math.sin(a);
    const rows: Vec3[][] = [];
    for (const r of [0.05, radius * 0.6, radius - 0.01]) {
      const w = a === -Math.PI / 2 ? 0.03 : 0.022;
      const z = lerp(-0.01, 0.0, r / radius);
      const pt = (t: number, dz: number): Vec3 => [
        r * ca - t * sa,
        r * sa + t * ca,
        z + dz,
      ];
      rows.push([
        pt(-w, 0.008),
        pt(-w, -0.008),
        pt(0, -0.012),
        pt(w, -0.008),
        pt(w, 0.008),
        pt(0, 0.012),
        pt(-w, 0.008),
      ]);
    }
    tessellate(m, loftPoints(rows, {degreeU: 2, degreeV: 2}), mat, {
      segU: 6,
      segV: 2,
    });
  }
  return m;
}

/** Helper to mirror a list of points across x = 0. */
export const mirrorPts = (pts: Vec3[]): Vec3[] =>
  pts.map(p => [-p[0], p[1], p[2]]);
