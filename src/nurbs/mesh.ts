// Triangle meshes built from NURBS surfaces (and a few helper primitives).

import type {Vec3} from '../math/vec.ts';
import {surfaceEval, type NurbsSurface} from './nurbs.ts';

export interface Mesh {
  positions: number[];
  normals: number[];
  /** One material id per vertex (see vehicles/materials.ts). */
  materials: number[];
  indices: number[];
}

export const emptyMesh = (): Mesh => ({
  positions: [],
  normals: [],
  materials: [],
  indices: [],
});

export interface TessOptions {
  /** Segments along u / v. Default: chosen from surface size and curvature. */
  segU?: number;
  segV?: number;
  /** Approximate edge length in meters for automatic segment counts. */
  edge?: number;
  /** Emit both sides (for thin parts such as glass or mirrors). */
  doubleSided?: boolean;
  /** Flip the normal direction (S_u x S_v is the default front). */
  flip?: boolean;
}

let detailScale = 1;

/**
 * Global level-of-detail scale applied to every tessellate() call: 1 = full
 * detail, 0.5 = half the segments in each direction, and so on. The renderer
 * builds vehicle LODs by regenerating the same design at lower scales.
 */
export function setDetailScale(s: number) {
  detailScale = s;
}

/** Estimate segments for one parameter direction from the control net. */
function autoSegments(s: NurbsSurface, dirU: boolean, edge: number) {
  const nu = s.points.length;
  const nv = s.points[0].length;
  let maxLen = 0;
  let maxTurn = 0;
  const count = dirU ? nv : nu;
  const along = dirU ? nu : nv;
  for (let k = 0; k < count; k++) {
    let len = 0;
    let turn = 0;
    let prev: Vec3 | null = null;
    for (let i = 0; i < along; i++) {
      const p = dirU ? s.points[i][k] : s.points[k][i];
      if (i > 0) {
        const q = dirU ? s.points[i - 1][k] : s.points[k][i - 1];
        const d: Vec3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
        len += Math.hypot(d[0], d[1], d[2]);
        if (prev) {
          const a = Math.hypot(prev[0], prev[1], prev[2]);
          const b = Math.hypot(d[0], d[1], d[2]);
          if (a > 1e-9 && b > 1e-9) {
            const c =
              (prev[0] * d[0] + prev[1] * d[1] + prev[2] * d[2]) / (a * b);
            turn += Math.acos(Math.max(-1, Math.min(1, c)));
          }
        }
        prev = d;
      }
    }
    maxLen = Math.max(maxLen, len);
    maxTurn = Math.max(maxTurn, turn);
  }
  const deg = dirU ? s.degreeU : s.degreeV;
  if (deg === 1 && along === 2) return 1;
  const byLen = Math.ceil(maxLen / edge);
  const byTurn = Math.ceil(maxTurn / 0.2);
  return Math.max(2, Math.min(64, Math.max(byLen, byTurn)));
}

/** Tessellate a NURBS surface into `mesh` with material id `material`. */
export function tessellate(
  mesh: Mesh,
  s: NurbsSurface,
  material: number,
  opts: TessOptions = {},
) {
  const edge = opts.edge ?? 0.15;
  const scaleSeg = (n: number) =>
    n <= 1 ? n : Math.max(2, Math.round(n * detailScale));
  const segU = scaleSeg(opts.segU ?? autoSegments(s, true, edge));
  const segV = scaleSeg(opts.segV ?? autoSegments(s, false, edge));
  const base = mesh.positions.length / 3;
  const sign = opts.flip ? -1 : 1;
  const grid: Vec3[] = [];
  const norms: Vec3[] = [];
  for (let i = 0; i <= segU; i++) {
    for (let j = 0; j <= segV; j++) {
      const u = i / segU;
      const v = j / segV;
      const [P, Su, Sv] = surfaceEval(s, u, v);
      let n: Vec3 = [
        Su[1] * Sv[2] - Su[2] * Sv[1],
        Su[2] * Sv[0] - Su[0] * Sv[2],
        Su[0] * Sv[1] - Su[1] * Sv[0],
      ];
      let l = Math.hypot(n[0], n[1], n[2]);
      if (l < 1e-10) {
        // Degenerate (e.g. a pole): nudge inward to find a usable normal.
        const [, Su2, Sv2] = surfaceEval(
          s,
          Math.min(Math.max(u, 1e-3), 1 - 1e-3),
          Math.min(Math.max(v, 1e-3), 1 - 1e-3),
        );
        n = [
          Su2[1] * Sv2[2] - Su2[2] * Sv2[1],
          Su2[2] * Sv2[0] - Su2[0] * Sv2[2],
          Su2[0] * Sv2[1] - Su2[1] * Sv2[0],
        ];
        l = Math.hypot(n[0], n[1], n[2]) || 1;
      }
      grid.push(P);
      norms.push([(sign * n[0]) / l, (sign * n[1]) / l, (sign * n[2]) / l]);
    }
  }
  const emit = (flip: boolean) => {
    const b = mesh.positions.length / 3;
    for (let k = 0; k < grid.length; k++) {
      mesh.positions.push(...grid[k]);
      const n = norms[k];
      mesh.normals.push(
        flip ? -n[0] : n[0],
        flip ? -n[1] : n[1],
        flip ? -n[2] : n[2],
      );
      mesh.materials.push(material);
    }
    const row = segV + 1;
    for (let i = 0; i < segU; i++) {
      for (let j = 0; j < segV; j++) {
        const a = b + i * row + j;
        const c = a + row;
        // Counter-clockwise when viewed from the normal side.
        if (flip !== !!opts.flip)
          mesh.indices.push(a, a + 1, c, c, a + 1, c + 1);
        else mesh.indices.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
  };
  emit(false);
  if (opts.doubleSided) emit(true);
  return base;
}

/** Axis-aligned box (useful for small details); center + half extents. */
export function addBox(mesh: Mesh, center: Vec3, half: Vec3, material: number) {
  const [cx, cy, cz] = center;
  const [hx, hy, hz] = half;
  const faces: [Vec3, Vec3, Vec3][] = [
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
    ],
    [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ],
    [
      [0, -1, 0],
      [0, 0, -1],
      [1, 0, 0],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
  ];
  for (const [n, a, b] of faces) {
    // Pick tangents so a x b = n (counter-clockwise front faces).
    const t = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const flip = t[0] * n[0] + t[1] * n[1] + t[2] * n[2] < 0;
    const B = flip ? ([-b[0], -b[1], -b[2]] as Vec3) : b;
    const base = mesh.positions.length / 3;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      mesh.positions.push(
        cx + (n[0] + a[0] * su + B[0] * sv) * hx,
        cy + (n[1] + a[1] * su + B[1] * sv) * hy,
        cz + (n[2] + a[2] * su + B[2] * sv) * hz,
      );
      mesh.normals.push(...n);
      mesh.materials.push(material);
    }
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Append mesh b (optionally transformed by a point/normal mapping) into a. */
export function mergeMesh(
  a: Mesh,
  b: Mesh,
  xform?: (p: Vec3) => Vec3,
  nform?: (n: Vec3) => Vec3,
) {
  const base = a.positions.length / 3;
  for (let i = 0; i < b.positions.length; i += 3) {
    const p: Vec3 = [b.positions[i], b.positions[i + 1], b.positions[i + 2]];
    const n: Vec3 = [b.normals[i], b.normals[i + 1], b.normals[i + 2]];
    a.positions.push(...(xform ? xform(p) : p));
    a.normals.push(...(nform ? nform(n) : n));
  }
  a.materials.push(...b.materials);
  for (const i of b.indices) a.indices.push(i + base);
}

/** Mirror a mesh across x = 0, fixing winding so faces stay front-facing. */
export function mirrorMeshX(m: Mesh): Mesh {
  const out = emptyMesh();
  mergeMesh(
    out,
    m,
    p => [-p[0], p[1], p[2]],
    n => [-n[0], n[1], n[2]],
  );
  for (let i = 0; i < out.indices.length; i += 3) {
    const t = out.indices[i + 1];
    out.indices[i + 1] = out.indices[i + 2];
    out.indices[i + 2] = t;
  }
  return out;
}

export function meshBounds(m: Mesh): [Vec3, Vec3] {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.positions[i + k]);
      hi[k] = Math.max(hi[k], m.positions[i + k]);
    }
  }
  return [lo, hi];
}
