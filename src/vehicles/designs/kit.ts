// Shared modeling kit for vehicle designs.
//
// Everything is built from NURBS surfaces (loftPoints / revolve) and tessellated
// with tessellate(). The kit adds:
//   - Sheet: a lofted surface that remembers its rows so that decals (lights,
//     trims, pillars, shut lines, interior skins) can be placed on it either in
//     its own (u, v) parameters or by projecting world-space shapes onto it.
//   - blob(): superellipsoid primitives for seats, mirrors, knobs and lamps.
//   - helpers to mirror the right half (x >= 0) of a design to the left.

import type {Vec3} from '../../math/vec.ts';
import {
  emptyMesh,
  mergeMesh,
  mirrorMeshX,
  tessellate,
  type Mesh,
  type TessOptions,
} from '../../nurbs/mesh.ts';
import {
  loftPoints,
  mirrorX,
  surfaceEval,
  type NurbsSurface,
} from '../../nurbs/nurbs.ts';

/** A projection axis: world axis index (0 = x, 1 = y, 2 = z) or a unit direction. */
export type Axis = number | Vec3;
const axisVec = (a: Axis): Vec3 =>
  typeof a === 'number'
    ? ([a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0] as Vec3)
    : a;

export const clamp = (x: number, a: number, b: number) =>
  Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const dot = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** Superellipse helper: sign(c)·|c|^(2/n). */
export const sp = (c: number, n: number) =>
  Math.sign(c) * Math.pow(Math.abs(c), 2 / n);

/** Rotation of a point about the x axis (pitch), then y (yaw), then translation. */
export function place(p: Vec3, at: Vec3, pitch = 0, yaw = 0, roll = 0): Vec3 {
  let [x, y, z] = p;
  if (roll) {
    const c = Math.cos(roll),
      s = Math.sin(roll);
    [x, y] = [c * x - s * y, s * x + c * y];
  }
  if (pitch) {
    const c = Math.cos(pitch),
      s = Math.sin(pitch);
    [y, z] = [c * y - s * z, s * y + c * z];
  }
  if (yaw) {
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    [x, z] = [c * x + s * z, -s * x + c * z];
  }
  return [x + at[0], y + at[1], z + at[2]];
}

/** Chord-length parameters averaged over several point lists (as loftPoints does). */
function avgParams(lists: Vec3[][]): number[] {
  const n = lists[0].length;
  const acc = new Array<number>(n).fill(0);
  let count = 0;
  for (const pts of lists) {
    const d = [0];
    let tot = 0;
    for (let i = 1; i < n; i++) {
      tot += Math.hypot(
        pts[i][0] - pts[i - 1][0],
        pts[i][1] - pts[i - 1][1],
        pts[i][2] - pts[i - 1][2],
      );
      d.push(tot);
    }
    if (tot < 1e-12) continue;
    for (let i = 0; i < n; i++) acc[i] += d[i] / tot;
    count++;
  }
  return count ? acc.map(v => v / count) : acc.map((_, i) => i / (n - 1));
}

const interp = (params: number[], f: number) => {
  const n = params.length - 1;
  const x = clamp(f, 0, n);
  const i = Math.min(n - 1, Math.floor(x));
  return lerp(params[i], params[i + 1], x - i);
};

/**
 * A lofted NURBS surface built from rows of points (rows[k] = k-th section).
 * `sign` = +1 if S_u x S_v already points to the visible side.
 */
export class Sheet {
  S: NurbsSurface;
  uP: number[];
  vP: number[];
  private grid: {u: number; v: number; p: Vec3}[] | null = null;

  rows: Vec3[][];
  sign: number;

  constructor(rows: Vec3[][], sign = 1, degree: {u?: number; v?: number} = {}) {
    this.rows = rows;
    this.sign = sign;
    this.S = loftPoints(rows, {degreeU: degree.u ?? 3, degreeV: degree.v ?? 3});
    this.uP = avgParams(rows);
    const cols = rows[0].map((_, i) => rows.map(r => r[i]));
    this.vP = avgParams(cols);
  }

  /** u of fractional column index i (points within a row). */
  u(i: number) {
    return interp(this.uP, i);
  }

  /** v of fractional row index k. */
  v(k: number) {
    return interp(this.vP, k);
  }

  point(u: number, v: number): Vec3 {
    return surfaceEval(this.S, clamp(u, 0, 1), clamp(v, 0, 1))[0];
  }

  /** Visible-side unit normal (nudged away from degenerate points). */
  normal(u: number, v: number): Vec3 {
    let [, Su, Sv] = surfaceEval(this.S, clamp(u, 0, 1), clamp(v, 0, 1));
    let n = cross(Su, Sv);
    if (Math.hypot(n[0], n[1], n[2]) < 1e-9) {
      [, Su, Sv] = surfaceEval(
        this.S,
        clamp(u, 1e-3, 1 - 1e-3),
        clamp(v, 1e-3, 1 - 1e-3),
      );
      n = cross(Su, Sv);
    }
    return mul(norm(n), this.sign);
  }

  /**
   * Find (u, v) whose surface point has coordinates `target` on the two world
   * axes `axes` (0 = x, 1 = y, 2 = z). `prefer` scores candidate points when the
   * projection hits the surface more than once (higher is better).
   */
  solve(
    axes: [Axis, Axis],
    target: [number, number],
    prefer?: (p: Vec3) => number,
    guess?: [number, number],
  ): [number, number] {
    const A = axisVec(axes[0]),
      B = axisVec(axes[1]);
    let u: number, v: number;
    if (guess) {
      [u, v] = guess;
    } else {
      if (!this.grid) {
        this.grid = [];
        const N = 48;
        for (let i = 0; i <= N; i++) {
          for (let j = 0; j <= N; j++)
            this.grid.push({u: i / N, v: j / N, p: this.point(i / N, j / N)});
        }
      }
      // Closest grid sample; with `prefer`, the best-scoring sample among those
      // nearly as close (the projection may hit the sheet several times).
      const r = this.grid.map(g =>
        Math.hypot(dot(g.p, A) - target[0], dot(g.p, B) - target[1]),
      );
      const minR = Math.min(...r);
      let best = -Infinity;
      u = v = 0.5;
      this.grid.forEach((g, i) => {
        if (r[i] > minR + 0.06) return;
        const score = prefer ? prefer(g.p) - r[i] * 0.5 : -r[i];
        if (score > best) [best, u, v] = [score, g.u, g.v];
      });
    }
    for (let it = 0; it < 30; it++) {
      const [P, Su, Sv] = surfaceEval(this.S, u, v);
      const r0 = dot(P, A) - target[0];
      const r1 = dot(P, B) - target[1];
      if (Math.abs(r0) + Math.abs(r1) < 1e-7) break;
      const ua = dot(Su, A),
        ub = dot(Su, B),
        va = dot(Sv, A),
        vb = dot(Sv, B);
      const det = ua * vb - va * ub;
      if (Math.abs(det) < 1e-12) break;
      const du = (r0 * vb - r1 * va) / det;
      const dv = (ua * r1 - ub * r0) / det;
      const step = Math.min(
        1,
        0.25 / Math.max(Math.abs(du), Math.abs(dv), 1e-9),
      );
      u = clamp(u - du * step, 0, 1);
      v = clamp(v - dv * step, 0, 1);
    }
    return [u, v];
  }
}

export interface AddOpts extends TessOptions {
  /** Also add the mirror image across x = 0. */
  mirror?: boolean;
  /** Inward offset of the back side when doubleSided (default 1.2 mm). */
  backOffset?: number;
  /** Material of the back side when doubleSided. */
  backMat?: number;
  /** Add only the mirror image (for left-side-only details built on the right half). */
  leftOnly?: boolean;
}

/** Collects tessellated geometry. Build the right half and mirror where needed. */
export class Kit {
  mesh: Mesh = emptyMesh();

  /** Tessellate a raw surface (normal = S_u x S_v unless flip). */
  surf(S: NurbsSurface, mat: number, opts: AddOpts = {}) {
    if (opts.leftOnly) {
      this.surf(mirrorX(S), mat, {...opts, leftOnly: false, mirror: false});
      return;
    }
    const one = (s: NurbsSurface) => {
      tessellate(this.mesh, s, mat, {...opts, doubleSided: false});
      if (opts.doubleSided) {
        // Back side as a separate shell nudged 0.8 mm behind the front so the
        // two never z-fight; kept tiny so open edges show no back-facing rim.
        const back = emptyMesh();
        tessellate(back, s, opts.backMat ?? mat, {
          ...opts,
          doubleSided: false,
          flip: !opts.flip,
        });
        for (let i = 0; i < back.positions.length; i++) {
          // Keep seam vertices on the mirror plane so the halves stay closed.
          if (i % 3 === 0 && Math.abs(back.positions[i]) < 1e-6) continue;
          back.positions[i] += back.normals[i] * (opts.backOffset ?? 0.0012);
        }
        mergeMesh(this.mesh, back);
      }
    };
    one(S);
    if (opts.mirror) one(mirrorX(S));
  }

  sheet(sh: Sheet, mat: number, opts: AddOpts = {}) {
    this.surf(sh.S, mat, {...opts, flip: sh.sign < 0 !== !!opts.flip});
  }

  /** Append a finished mesh (optionally mirrored copy too). */
  merge(m: Mesh, mirror = false) {
    mergeMesh(this.mesh, m);
    if (mirror) mergeMesh(this.mesh, mirrorMeshX(m));
  }

  /**
   * Decal: a patch that follows `sh`, sampled at (u, v) = map(s, t) for s, t in
   * [0, 1] and lifted `offset` meters along the visible normal (or pushed
   * inward and facing the other way if `inner`).
   */
  decal(
    sh: Sheet,
    map: (s: number, t: number) => [number, number],
    mat: number,
    o: DecalOpts = {},
  ) {
    const S = decalSurface(sh, map, o);
    if (!S) return;
    const segU = o.segS ?? Math.max(1, (o.ns ?? 5) - 1);
    const segV = o.segT ?? Math.max(1, (o.nt ?? 5) - 1);
    this.surf(S, mat, {
      segU,
      segV,
      mirror: o.mirror,
      doubleSided: o.doubleSided,
      leftOnly: o.leftOnly,
    });
  }
}

export interface DecalOpts {
  leftOnly?: boolean;
  ns?: number;
  nt?: number;
  segS?: number;
  segT?: number;
  offset?: number;
  inner?: boolean;
  mirror?: boolean;
  doubleSided?: boolean;
  /** Extra displacement along the normal as a function of (s, t) (embossing). */
  bump?: (s: number, t: number) => number;
}

/** Build the oriented NURBS patch for a decal (see Kit.decal). */
export function decalSurface(
  sh: Sheet,
  map: (s: number, t: number) => [number, number],
  o: DecalOpts = {},
): NurbsSurface | null {
  const ns = o.ns ?? 5;
  const nt = o.nt ?? 5;
  const off = o.offset ?? 0.004;
  const dir = o.inner ? -1 : 1;
  const rows: Vec3[][] = [];
  for (let j = 0; j < nt; j++) {
    const row: Vec3[] = [];
    for (let i = 0; i < ns; i++) {
      const s = i / (ns - 1),
        t = j / (nt - 1);
      const [u, v] = map(s, t);
      const n = sh.normal(u, v);
      const d = (off + (o.bump ? o.bump(s, t) : 0)) * dir;
      row.push(add(sh.point(u, v), mul(n, d)));
    }
    rows.push(row);
  }
  if ((map as {failed?: boolean}).failed) {
    decalWarnings.push(
      `decal off-sheet near ${rows[0][0].map(v => v.toFixed(2)).join(',')}`,
    );
    return null;
  }
  const S = loftPoints(rows, {
    degreeU: Math.min(3, ns - 1),
    degreeV: Math.min(3, nt - 1),
  });
  // Orient so the patch faces the same way as the sheet (or inward for inner).
  const [u, v] = map(0.5, 0.5);
  const want = mul(sh.normal(u, v), dir);
  const [, Su, Sv] = surfaceEval(S, 0.5, 0.5);
  let have = cross(Su, Sv);
  if (Math.hypot(...have) < 1e-12) {
    const [, a, b] = surfaceEval(S, 0.45, 0.55);
    have = cross(a, b);
  }
  return dot(have, want) < 0 ? flipUV(S) : S;
}

function flipUV(S: NurbsSurface): NurbsSurface {
  return {
    ...S,
    points: [...S.points].reverse(),
    weights: [...S.weights].reverse(),
    knotsU: S.knotsU.map(k => 1 - k).reverse(),
  };
}

// ---------------------------------------------------------------------------
// Decal shape maps

/** Rectangle in (u, v) parameter space. */
export const uvRect =
  (u0: number, u1: number, v0: number, v1: number) =>
  (s: number, t: number): [number, number] => [
    lerp(u0, u1, s),
    lerp(v0, v1, t),
  ];

/**
 * World-space shape projected onto a sheet along the axis not in `axes`.
 * shape(s, t) returns the two world coordinates.
 */
export function projected(
  sh: Sheet,
  axes: [Axis, Axis],
  shape: (s: number, t: number) => [number, number],
  prefer?: (p: Vec3) => number,
) {
  const cache = new Map<string, [number, number]>();
  let last: [number, number] | undefined;
  const fn = (s: number, t: number): [number, number] => {
    const key = `${s},${t}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let uv = sh.solve(axes, shape(s, t), prefer, last);
    // Fall back to a global search if the warm start drifted off target.
    const A = axisVec(axes[0]),
      B = axisVec(axes[1]);
    const p = sh.point(uv[0], uv[1]);
    const target = shape(s, t);
    if (Math.hypot(dot(p, A) - target[0], dot(p, B) - target[1]) > 2e-3)
      uv = sh.solve(axes, target, prefer);
    const q = sh.point(uv[0], uv[1]);
    if (Math.hypot(dot(q, A) - target[0], dot(q, B) - target[1]) > 0.01) {
      if (!fn.failed)
        decalWarnings.push(
          `projection miss at ${target.map(v => v.toFixed(2)).join(',')}`,
        );
      fn.failed = true;
    }
    last = uv;
    cache.set(key, uv);
    return uv;
  };
  fn.failed = false;
  return fn;
}

/** Set by decalSurface when a projected decal misses its sheet (for debugging). */
export const decalWarnings: string[] = [];

/** Axis-aligned rectangle shape in world coordinates. */
export const rect =
  (a0: number, a1: number, b0: number, b1: number) =>
  (s: number, t: number): [number, number] => [
    lerp(a0, a1, s),
    lerp(b0, b1, t),
  ];

/**
 * Superellipse (rounded rectangle for large n) centered at (ca, cb) with half
 * extents (ha, hb). Rows run along b; the end rows collapse to points.
 * With `half` only the a >= ca half is produced (for shapes centered on x = 0
 * that are mirrored).
 */
export const superellipse =
  (
    ca: number,
    cb: number,
    ha: number,
    hb: number,
    n = 4,
    slant = 0,
    half = false,
  ) =>
  (s: number, t: number): [number, number] => {
    const y = lerp(-1, 1, t);
    // Keep the end rows slightly open so the patch never fully degenerates.
    const w = Math.pow(
      Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(y)), n)),
      1 / n,
    );
    const x = (half ? s : lerp(-1, 1, s)) * Math.max(w, 0.04);
    return [ca + ha * x + slant * y * hb, cb + hb * y];
  };

/** Quad with corners (a0,b0) (a1,b1) on the s = 0 edge and (a2,b2) (a3,b3) on s = 1. */
export const quad =
  (
    p00: [number, number],
    p01: [number, number],
    p10: [number, number],
    p11: [number, number],
  ) =>
  (s: number, t: number): [number, number] => [
    lerp(lerp(p00[0], p01[0], t), lerp(p10[0], p11[0], t), s),
    lerp(lerp(p00[1], p01[1], t), lerp(p10[1], p11[1], t), s),
  ];

/** Thin band along a world-space polyline/curve c(t) with width w (in the projection plane). */
export const band =
  (c: (t: number) => [number, number], w: number) =>
  (s: number, t: number): [number, number] => {
    const e = 1e-3;
    const p = c(t);
    const a = c(Math.max(0, t - e));
    const b = c(Math.min(1, t + e));
    const d = [b[0] - a[0], b[1] - a[1]];
    const l = Math.hypot(d[0], d[1]) || 1;
    const nx = -d[1] / l,
      ny = d[0] / l;
    return [p[0] + nx * w * (s - 0.5), p[1] + ny * w * (s - 0.5)];
  };

// ---------------------------------------------------------------------------
// Primitives

export interface BlobOpts {
  /** Superellipse exponents: around the ring (n) and along the axis (m). */
  n?: number;
  m?: number;
  /** Ring / axial segment counts. */
  segU?: number;
  segV?: number;
  /** Transform applied to the local point (after scaling). */
  xf?: (p: Vec3) => Vec3;
  /** Taper of the x/y size along the axis: scale(t) for t in [0, 1] (back to front). */
  taper?: (t: number) => [number, number];
}

/**
 * Superellipsoid with half extents `half` around `center`, axis along z.
 * Returns the NURBS surface (outward normals).
 */
export function blobSurface(
  center: Vec3,
  half: Vec3,
  o: BlobOpts = {},
): NurbsSurface {
  const n = o.n ?? 3;
  const m = o.m ?? 3;
  // Sample the ring and the axial profile at equal arclength (in true scale)
  // so very elongated shapes interpolate without overshoot.
  const ring = equalArc(
    16,
    th => [half[0] * sp(Math.cos(th), n), half[1] * sp(Math.sin(th), n)],
    -Math.PI / 2,
    Math.PI * 1.5,
  );
  const rmax = Math.max(half[0], half[1]);
  const axial = equalArc(
    8,
    phi => [
      rmax * Math.pow(Math.max(Math.cos(phi), 0), 2 / m),
      half[2] * sp(Math.sin(phi), m),
    ],
    -Math.PI / 2,
    Math.PI / 2,
  );
  const rows: Vec3[][] = [];
  axial.forEach((phi, k) => {
    const r = Math.pow(Math.max(Math.cos(phi), 0), 2 / m);
    const z = sp(Math.sin(phi), m);
    const [tx, ty] = o.taper ? o.taper(k / (axial.length - 1)) : [1, 1];
    const row: Vec3[] = [];
    for (const th of ring) {
      const p: Vec3 = [
        half[0] * r * tx * sp(Math.cos(th), n),
        half[1] * r * ty * sp(Math.sin(th), n),
        half[2] * z,
      ];
      const q = o.xf ? o.xf(p) : p;
      row.push([q[0] + center[0], q[1] + center[1], q[2] + center[2]]);
    }
    rows.push(row);
  });
  return loftPoints(rows, {degreeU: 3, degreeV: 3});
}

/** Parameters t0..t1 (count + 1 values) at equal arclength along the 2D curve f. */
function equalArc(
  count: number,
  f: (t: number) => [number, number],
  t0: number,
  t1: number,
): number[] {
  const N = 400;
  const acc = [0];
  let prev = f(t0);
  for (let i = 1; i <= N; i++) {
    const p = f(lerp(t0, t1, i / N));
    acc.push(acc[i - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
  }
  const total = acc[N];
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k <= count; k++) {
    const target = (total * k) / count;
    while (j < N - 1 && acc[j + 1] < target) j++;
    const f2 =
      acc[j + 1] > acc[j] ? (target - acc[j]) / (acc[j + 1] - acc[j]) : 0;
    out.push(lerp(t0, t1, (j + clamp(f2, 0, 1)) / N));
  }
  return out;
}

export function blob(
  kit: Kit,
  center: Vec3,
  half: Vec3,
  mat: number,
  o: BlobOpts & {mirror?: boolean} = {},
) {
  const S = blobSurface(center, half, o);
  kit.surf(S, mat, {segU: o.segU ?? 12, segV: o.segV ?? 6, mirror: o.mirror});
}

/** A flat-ish quad patch from four corners (p00, p10 along u; p01, p11 along v), two-sided optional. */
export function panel(
  kit: Kit,
  p00: Vec3,
  p10: Vec3,
  p01: Vec3,
  p11: Vec3,
  mat: number,
  o: AddOpts = {},
) {
  const S = loftPoints(
    [
      [p00, p10],
      [p01, p11],
    ],
    {degreeU: 1, degreeV: 1},
  );
  kit.surf(S, mat, {segU: 1, segV: 1, ...o});
}

/** Tube along a polyline (interpolated), radius r, ring segments. */
export function tube(
  kit: Kit,
  pts: Vec3[],
  r: number,
  mat: number,
  o: {
    seg?: number;
    along?: number;
    mirror?: boolean;
    up?: Vec3;
    caps?: boolean;
  } = {},
) {
  if (o.caps) {
    for (const p of [pts[0], pts[pts.length - 1]])
      blob(kit, p, [r, r, r], mat, {
        n: 2,
        m: 2,
        segU: 8,
        segV: 4,
        mirror: o.mirror,
      });
  }
  const ring = 8;
  const rows: Vec3[][] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[Math.max(0, k - 1)];
    const b = pts[Math.min(pts.length - 1, k + 1)];
    const T = norm(sub(b, a));
    let up = o.up ?? [0, 1, 0];
    if (Math.abs(dot(up, T)) > 0.9) up = [1, 0, 0];
    const X = norm(cross(up, T));
    const Y = cross(T, X);
    const row: Vec3[] = [];
    for (let i = 0; i <= ring; i++) {
      const th = (i / ring) * Math.PI * 2;
      row.push(
        add(pts[k], add(mul(X, Math.cos(th) * r), mul(Y, Math.sin(th) * r))),
      );
    }
    rows.push(row);
  }
  const S = loftPoints(rows, {
    degreeU: 3,
    degreeV: Math.min(3, pts.length - 1),
  });
  kit.surf(S, mat, {
    segU: o.seg ?? 6,
    segV: o.along ?? Math.max(1, (pts.length - 1) * 2),
    mirror: o.mirror,
  });
}
