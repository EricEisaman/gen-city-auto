// Reusable NURBS-built parts shared by vehicle designs.

import type {Vec3} from '../math/vec.ts';
import {emptyMesh, mergeMesh, tessellate, type Mesh} from '../nurbs/mesh.ts';
import {Kit, blob, place, tube} from './designs/kit.ts';
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
  // Tyre: sections around the wheel (v) through a profile (u) with a bulged
  // sidewall, three circumferential grooves and staggered lateral tread
  // blocks cut into the crown.
  const d = radius - rimR;
  const prof: [number, number, number][] = [
    // x, radius, tread flag (1 = crown point that gets lateral grooves)
    [0.82, rimR, 0],
    [1.07, rimR + d * 0.35, 0],
    [1.05, radius - d * 0.12, 0],
    [0.86, radius - 0.004, 0],
    [0.66, radius, 1],
    [0.52, radius - 0.007, 0],
    [0.4, radius, 1],
    [0.12, radius, 1],
    [0.0, radius - 0.007, 0],
    [-0.12, radius, -1],
    [-0.4, radius, -1],
    [-0.52, radius - 0.007, 0],
    [-0.66, radius, -1],
    [-0.86, radius - 0.004, 0],
    [-1.05, radius - d * 0.12, 0],
    [-1.07, rimR + d * 0.35, 0],
    [-0.82, rimR, 0],
  ];
  const blocks = 28;
  const N = blocks * 4;
  const rows: Vec3[][] = [];
  for (let k = 0; k <= N; k++) {
    const th = (k / N) * Math.PI * 2;
    rows.push(
      prof.map(([x, r, f]) => {
        // Lateral groove on one of every four sections, staggered per half.
        const phase = (k + (f < 0 ? 2 : 0)) % 4;
        const rr = f !== 0 && phase === 0 ? r - 0.005 : r;
        return [x * hw, rr * Math.cos(th), rr * Math.sin(th)] as Vec3;
      }),
    );
  }
  rows[N] = rows[0];
  tessellate(m, loftPoints(rows, {degreeU: 2, degreeV: 1}), Mat.rubber, {
    segU: 18,
    segV: N,
  });
  // Brake disc with hat and a red calliper, behind the spokes.
  const bk = new Kit();
  const yaw = (p: Vec3) => place(p, [0, 0, 0], 0, Math.PI / 2);
  blob(bk, [hw * 0.05, 0, 0], [rimR * 0.8, rimR * 0.8, 0.012], Mat.metal, {
    n: 2,
    m: 10,
    segU: 24,
    segV: 3,
    xf: yaw,
  });
  blob(bk, [hw * 0.2, 0, 0], [rimR * 0.35, rimR * 0.35, 0.03], Mat.rim, {
    n: 2,
    m: 6,
    segU: 16,
    segV: 3,
    xf: yaw,
  });
  blob(
    bk,
    [hw * 0.05, rimR * 0.55, -rimR * 0.45],
    [0.035, 0.07, 0.05],
    Mat.caliper,
    {n: 4, segU: 8, segV: 3},
  );
  mergeMesh(m, bk.mesh);
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
    segU: 10,
    segV: 36,
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

/**
 * Round instrument dial facing the driver (-z), tilted back by `pitch`:
 * emissive face (Mat.dash), chrome bezel ring and a red needle.
 */
export function dial(kit: Kit, center: Vec3, r: number, pitch: number) {
  const xf = (p: Vec3) => place(p, [0, 0, 0], pitch);
  blob(kit, center, [r, r, 0.003], Mat.dash, {
    n: 2,
    m: 8,
    segU: 24,
    segV: 3,
    xf,
  });
  const ring: Vec3[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const q = xf([Math.cos(a) * r, Math.sin(a) * r, -0.004]);
    ring.push([q[0] + center[0], q[1] + center[1], q[2] + center[2]]);
  }
  tube(kit, ring, 0.0045, Mat.chrome, {along: 20, seg: 4});
  const nx = place([r * 0.4, r * 0.15, -0.006], [0, 0, 0], pitch);
  blob(
    kit,
    [center[0] + nx[0], center[1] + nx[1], center[2] + nx[2]],
    [r * 0.45, 0.0035, 0.002],
    Mat.taillight,
    {segU: 8, segV: 3, xf: p => place(p, [0, 0, 0], pitch, 0, 0.35)},
  );
}
