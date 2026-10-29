// NURBS curves and surfaces (after Piegl & Tiller, "The NURBS Book").
//
// Control points are stored in Cartesian form with a separate weight; evaluation
// works in homogeneous space. Surfaces index control points as points[i][j] with
// i along u and j along v.

import type {Vec3} from '../math/vec.ts';

export interface NurbsCurve {
  degree: number;
  knots: number[];
  points: Vec3[];
  weights: number[];
}

export interface NurbsSurface {
  degreeU: number;
  degreeV: number;
  knotsU: number[];
  knotsV: number[];
  points: Vec3[][];
  weights: number[][];
}

// ---------------------------------------------------------------------------
// Knot vectors and basis functions

/** Clamped uniform knot vector for n control points of degree p, domain [0, 1]. */
export function clampedKnots(n: number, p: number): number[] {
  const m = n + p + 1;
  const knots: number[] = [];
  const spans = n - p;
  for (let i = 0; i < m; i++) {
    if (i <= p) knots.push(0);
    else if (i >= n) knots.push(1);
    else knots.push((i - p) / spans);
  }
  return knots;
}

/** Index of the knot span containing u. */
export function findSpan(n: number, p: number, u: number, knots: number[]) {
  if (u >= knots[n]) return n - 1;
  if (u <= knots[p]) return p;
  let lo = p;
  let hi = n;
  let mid = (lo + hi) >> 1;
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** Non-zero basis functions N[span-p..span] at u. */
export function basisFuns(span: number, u: number, p: number, knots: number[]) {
  const N = new Array<number>(p + 1).fill(0);
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom !== 0 ? N[r] / denom : 0;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/** Basis functions and their first `nd` derivatives: ders[k][j]. */
export function basisFunsDerivs(span: number, u: number, p: number, nd: number, knots: number[]) {
  const ndu: number[][] = Array.from({length: p + 1}, () => new Array<number>(p + 1).fill(0));
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[j][r] !== 0 ? ndu[r][j - 1] / ndu[j][r] : 0;
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }
  const ders: number[][] = Array.from({length: nd + 1}, () => new Array<number>(p + 1).fill(0));
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];
  const a = [new Array<number>(p + 1).fill(0), new Array<number>(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0;
    let s2 = 1;
    a[0][0] = 1;
    for (let k = 1; k <= nd; k++) {
      let d = 0;
      const rk = r - k;
      const pk = p - k;
      if (r >= k) {
        a[s2][0] = ndu[pk + 1][rk] !== 0 ? a[s1][0] / ndu[pk + 1][rk] : 0;
        d = a[s2][0] * ndu[rk][pk];
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        a[s2][j] = ndu[pk + 1][rk + j] !== 0 ? (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j] : 0;
        d += a[s2][j] * ndu[rk + j][pk];
      }
      if (r <= pk) {
        a[s2][k] = ndu[pk + 1][r] !== 0 ? -a[s1][k - 1] / ndu[pk + 1][r] : 0;
        d += a[s2][k] * ndu[r][pk];
      }
      ders[k][r] = d;
      [s1, s2] = [s2, s1];
    }
  }
  let r = p;
  for (let k = 1; k <= nd; k++) {
    for (let j = 0; j <= p; j++) ders[k][j] *= r;
    r *= p - k;
  }
  return ders;
}

// ---------------------------------------------------------------------------
// Curves

export function makeCurve(points: Vec3[], degree = 3, weights?: number[], knots?: number[]): NurbsCurve {
  const p = Math.min(degree, points.length - 1);
  return {
    degree: p,
    points: points.map(q => [q[0], q[1], q[2]] as Vec3),
    weights: weights ?? points.map(() => 1),
    knots: knots ?? clampedKnots(points.length, p),
  };
}

export function curvePoint(c: NurbsCurve, u: number): Vec3 {
  const n = c.points.length;
  const span = findSpan(n, c.degree, u, c.knots);
  const N = basisFuns(span, u, c.degree, c.knots);
  let x = 0, y = 0, z = 0, w = 0;
  for (let j = 0; j <= c.degree; j++) {
    const i = span - c.degree + j;
    const b = N[j] * c.weights[i];
    const P = c.points[i];
    x += b * P[0];
    y += b * P[1];
    z += b * P[2];
    w += b;
  }
  return [x / w, y / w, z / w];
}

/** First derivative of a rational curve at u. */
export function curveTangent(c: NurbsCurve, u: number): Vec3 {
  const n = c.points.length;
  const span = findSpan(n, c.degree, u, c.knots);
  const D = basisFunsDerivs(span, u, c.degree, 1, c.knots);
  const A = [0, 0, 0], dA = [0, 0, 0];
  let w = 0, dw = 0;
  for (let j = 0; j <= c.degree; j++) {
    const i = span - c.degree + j;
    const wi = c.weights[i];
    const P = c.points[i];
    for (let k = 0; k < 3; k++) {
      A[k] += D[0][j] * wi * P[k];
      dA[k] += D[1][j] * wi * P[k];
    }
    w += D[0][j] * wi;
    dw += D[1][j] * wi;
  }
  return [0, 1, 2].map(k => (dA[k] - (dw * A[k]) / w) / w) as Vec3;
}

/** Sample n+1 points evenly in parameter space. */
export function sampleCurve(c: NurbsCurve, n: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) out.push(curvePoint(c, i / n));
  return out;
}

/** Solve A x = b (dense, partial pivoting). b may hold several columns. */
function solve(A: number[][], b: number[][]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...b[i]]);
  const cols = b[0].length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k < n + cols; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row.slice(n).map(v => v / (M[i][i] || 1e-12)));
}

/** Global curve interpolation through points (chord-length parameterization). */
export function interpolateCurve(points: Vec3[], degree = 3): NurbsCurve {
  const n = points.length;
  const p = Math.min(degree, n - 1);
  if (n <= p + 1) return makeCurve(points, p);
  const d: number[] = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2],
    );
    d.push(total);
  }
  const params = d.map(v => (total > 0 ? v / total : 0));
  const knots: number[] = new Array(p + 1).fill(0);
  for (let j = 1; j < n - p; j++) {
    let s = 0;
    for (let i = j; i < j + p; i++) s += params[i];
    knots.push(s / p);
  }
  for (let i = 0; i <= p; i++) knots.push(1);
  const A = params.map(u => {
    const row = new Array<number>(n).fill(0);
    const span = findSpan(n, p, u, knots);
    const N = basisFuns(span, u, p, knots);
    for (let j = 0; j <= p; j++) row[span - p + j] = N[j];
    return row;
  });
  const ctrl = solve(A, points.map(q => [q[0], q[1], q[2]]));
  return makeCurve(ctrl as Vec3[], p, undefined, knots);
}

/** Exact rational circular arc in the plane spanned by unit vectors x and y. */
export function arc(center: Vec3, x: Vec3, y: Vec3, radius: number, start: number, end: number): NurbsCurve {
  let sweep = end - start;
  if (sweep <= 0) sweep += Math.PI * 2;
  const narcs = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9));
  const dtheta = sweep / narcs;
  const w1 = Math.cos(dtheta / 2);
  const pt = (a: number, r: number): Vec3 => [
    center[0] + r * (Math.cos(a) * x[0] + Math.sin(a) * y[0]),
    center[1] + r * (Math.cos(a) * x[1] + Math.sin(a) * y[1]),
    center[2] + r * (Math.cos(a) * x[2] + Math.sin(a) * y[2]),
  ];
  const points: Vec3[] = [pt(start, radius)];
  const weights = [1];
  for (let i = 1; i <= narcs; i++) {
    const a0 = start + dtheta * (i - 1);
    points.push(pt(a0 + dtheta / 2, radius / w1));
    weights.push(w1);
    points.push(pt(a0 + dtheta, radius));
    weights.push(1);
  }
  const knots = [0, 0, 0];
  for (let i = 1; i < narcs; i++) knots.push(i / narcs, i / narcs);
  knots.push(1, 1, 1);
  return {degree: 2, points, weights, knots};
}

export function circle(center: Vec3, x: Vec3, y: Vec3, radius: number): NurbsCurve {
  return arc(center, x, y, radius, 0, Math.PI * 2);
}

/** Insert knot u once (Boehm). Returns a new curve with the same shape. */
export function insertKnot(c: NurbsCurve, u: number): NurbsCurve {
  const p = c.degree;
  const n = c.points.length;
  const k = findSpan(n, p, u, c.knots);
  const Pw = c.points.map((P, i) => [P[0] * c.weights[i], P[1] * c.weights[i], P[2] * c.weights[i], c.weights[i]]);
  const Q: number[][] = [];
  for (let i = 0; i <= k - p; i++) Q.push(Pw[i]);
  for (let i = k - p + 1; i <= k; i++) {
    const a = (u - c.knots[i]) / (c.knots[i + p] - c.knots[i]);
    Q.push(Pw[i].map((v, j) => a * v + (1 - a) * Pw[i - 1][j]));
  }
  for (let i = k; i < n; i++) Q.push(Pw[i]);
  const knots = [...c.knots.slice(0, k + 1), u, ...c.knots.slice(k + 1)];
  return {
    degree: p,
    knots,
    points: Q.map(q => [q[0] / q[3], q[1] / q[3], q[2] / q[3]] as Vec3),
    weights: Q.map(q => q[3]),
  };
}

// ---------------------------------------------------------------------------
// Surfaces

export function makeSurface(
  points: Vec3[][],
  degreeU = 3,
  degreeV = 3,
  weights?: number[][],
  knotsU?: number[],
  knotsV?: number[],
): NurbsSurface {
  const nu = points.length;
  const nv = points[0].length;
  const pu = Math.min(degreeU, nu - 1);
  const pv = Math.min(degreeV, nv - 1);
  return {
    degreeU: pu,
    degreeV: pv,
    points: points.map(row => row.map(q => [q[0], q[1], q[2]] as Vec3)),
    weights: weights ?? points.map(row => row.map(() => 1)),
    knotsU: knotsU ?? clampedKnots(nu, pu),
    knotsV: knotsV ?? clampedKnots(nv, pv),
  };
}

/** Point, dS/du and dS/dv of a rational surface. */
export function surfaceEval(s: NurbsSurface, u: number, v: number): [Vec3, Vec3, Vec3] {
  const nu = s.points.length;
  const nv = s.points[0].length;
  const su = findSpan(nu, s.degreeU, u, s.knotsU);
  const sv = findSpan(nv, s.degreeV, v, s.knotsV);
  const Du = basisFunsDerivs(su, u, s.degreeU, 1, s.knotsU);
  const Dv = basisFunsDerivs(sv, v, s.degreeV, 1, s.knotsV);
  const A = [0, 0, 0], Au = [0, 0, 0], Av = [0, 0, 0];
  let w = 0, wu = 0, wv = 0;
  for (let a = 0; a <= s.degreeU; a++) {
    const i = su - s.degreeU + a;
    for (let b = 0; b <= s.degreeV; b++) {
      const j = sv - s.degreeV + b;
      const wij = s.weights[i][j];
      const P = s.points[i][j];
      const n00 = Du[0][a] * Dv[0][b] * wij;
      const n10 = Du[1][a] * Dv[0][b] * wij;
      const n01 = Du[0][a] * Dv[1][b] * wij;
      for (let k = 0; k < 3; k++) {
        A[k] += n00 * P[k];
        Au[k] += n10 * P[k];
        Av[k] += n01 * P[k];
      }
      w += n00;
      wu += n10;
      wv += n01;
    }
  }
  const S = A.map(x => x / w) as Vec3;
  const Su = [0, 1, 2].map(k => (Au[k] - wu * S[k]) / w) as Vec3;
  const Sv = [0, 1, 2].map(k => (Av[k] - wv * S[k]) / w) as Vec3;
  return [S, Su, Sv];
}

export function surfacePoint(s: NurbsSurface, u: number, v: number): Vec3 {
  return surfaceEval(s, u, v)[0];
}

/**
 * Loft a surface through cross-section curves. Sections are made compatible by
 * sampling each at `samples` points and interpolating; the result interpolates
 * every section (u runs along each section, v across sections).
 */
export function loft(sections: NurbsCurve[], opts: {samples?: number; degreeV?: number} = {}): NurbsSurface {
  const samples = opts.samples ?? 12;
  const rows: Vec3[][] = sections.map(c => sampleCurve(c, samples - 1));
  return loftPoints(rows, {degreeU: 3, degreeV: opts.degreeV ?? 3});
}

/**
 * Loft through rows of points. rows[k] is the k-th section; every row must have
 * the same length. Each section is interpolated, then each column is interpolated
 * across sections, giving a surface that passes through all the given points.
 */
export function loftPoints(rows: Vec3[][], opts: {degreeU?: number; degreeV?: number} = {}): NurbsSurface {
  const degreeU = opts.degreeU ?? 3;
  const degreeV = opts.degreeV ?? 3;
  const sectionCurves = rows.map(r => interpolateCurve(r, degreeU));
  const nu = sectionCurves[0].points.length;
  const columns: NurbsCurve[] = [];
  for (let i = 0; i < nu; i++) {
    columns.push(interpolateCurve(sectionCurves.map(c => c.points[i]), degreeV));
  }
  // points[i][j]: i along the section (u), j across sections (v).
  const points = columns.map(c => c.points);
  return makeSurface(points, sectionCurves[0].degree, columns[0].degree, undefined, sectionCurves[0].knots, columns[0].knots);
}

/** Surface of revolution of a profile curve about an axis (angle in radians). */
export function revolve(profile: NurbsCurve, origin: Vec3, axis: Vec3, angle = Math.PI * 2): NurbsSurface {
  const al = Math.hypot(axis[0], axis[1], axis[2]);
  const ax: Vec3 = [axis[0] / al, axis[1] / al, axis[2] / al];
  const points: Vec3[][] = [];
  const weights: number[][] = [];
  let knotsV: number[] = [];
  let degreeV = 2;
  for (let i = 0; i < profile.points.length; i++) {
    const P = profile.points[i];
    const d: Vec3 = [P[0] - origin[0], P[1] - origin[1], P[2] - origin[2]];
    const t = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
    const center: Vec3 = [origin[0] + ax[0] * t, origin[1] + ax[1] * t, origin[2] + ax[2] * t];
    const rv: Vec3 = [P[0] - center[0], P[1] - center[1], P[2] - center[2]];
    const r = Math.hypot(rv[0], rv[1], rv[2]);
    let x: Vec3;
    if (r > 1e-9) {
      x = [rv[0] / r, rv[1] / r, rv[2] / r];
    } else {
      // Point on the axis: any perpendicular works; the circle degenerates.
      const tmp: Vec3 = Math.abs(ax[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const c = tmp[0] * ax[0] + tmp[1] * ax[1] + tmp[2] * ax[2];
      const px: Vec3 = [tmp[0] - c * ax[0], tmp[1] - c * ax[1], tmp[2] - c * ax[2]];
      const pl = Math.hypot(px[0], px[1], px[2]);
      x = [px[0] / pl, px[1] / pl, px[2] / pl];
    }
    const y: Vec3 = [
      ax[1] * x[2] - ax[2] * x[1],
      ax[2] * x[0] - ax[0] * x[2],
      ax[0] * x[1] - ax[1] * x[0],
    ];
    const c = arc(center, x, y, Math.max(r, 1e-9), 0, angle);
    points.push(c.points);
    weights.push(c.weights.map(w => w * profile.weights[i]));
    knotsV = c.knots;
    degreeV = c.degree;
  }
  return {degreeU: profile.degree, degreeV, knotsU: profile.knots, knotsV, points, weights};
}

/** Extrude a curve along a direction vector. */
export function extrude(c: NurbsCurve, dir: Vec3): NurbsSurface {
  const points = c.points.map(P => [P, [P[0] + dir[0], P[1] + dir[1], P[2] + dir[2]] as Vec3]);
  const weights = c.weights.map(w => [w, w]);
  return {degreeU: c.degree, degreeV: 1, knotsU: c.knots, knotsV: [0, 0, 1, 1], points, weights};
}

/** Ruled surface between two curves (made compatible by sampling). */
export function ruled(a: NurbsCurve, b: NurbsCurve, samples = 16): NurbsSurface {
  return loftPoints([sampleCurve(a, samples - 1), sampleCurve(b, samples - 1)], {degreeV: 1});
}

/** Sweep a planar profile (in its local XY plane) along a rail curve. */
export function sweep(profile: Vec3[], rail: NurbsCurve, opts: {samples?: number; up?: Vec3; scale?: (t: number) => number} = {}): NurbsSurface {
  const samples = opts.samples ?? 16;
  const up = opts.up ?? [0, 1, 0];
  const rows: Vec3[][] = [];
  for (let k = 0; k < samples; k++) {
    const t = k / (samples - 1);
    const P = curvePoint(rail, t);
    let T = curveTangent(rail, t);
    const tl = Math.hypot(T[0], T[1], T[2]) || 1;
    T = [T[0] / tl, T[1] / tl, T[2] / tl];
    let X: Vec3 = [up[1] * T[2] - up[2] * T[1], up[2] * T[0] - up[0] * T[2], up[0] * T[1] - up[1] * T[0]];
    const xl = Math.hypot(X[0], X[1], X[2]) || 1;
    X = [X[0] / xl, X[1] / xl, X[2] / xl];
    const Y: Vec3 = [T[1] * X[2] - T[2] * X[1], T[2] * X[0] - T[0] * X[2], T[0] * X[1] - T[1] * X[0]];
    const s = opts.scale ? opts.scale(t) : 1;
    rows.push(profile.map(q => [P[0] + (X[0] * q[0] + Y[0] * q[1]) * s, P[1] + (X[1] * q[0] + Y[1] * q[1]) * s, P[2] + (X[2] * q[0] + Y[2] * q[1]) * s] as Vec3));
  }
  // rows[k] are cross sections; transpose so u runs along the profile.
  return loftPoints(rows, {degreeU: Math.min(3, profile.length - 1), degreeV: 3});
}

/** Bilinear patch from four corners (p00, p10, p01, p11). */
export function bilinear(p00: Vec3, p10: Vec3, p01: Vec3, p11: Vec3): NurbsSurface {
  return makeSurface([[p00, p01], [p10, p11]], 1, 1);
}

/** Apply a point transform to every control point (affine transforms keep the surface exact). */
export function transformSurface(s: NurbsSurface, f: (p: Vec3) => Vec3): NurbsSurface {
  return {...s, points: s.points.map(row => row.map(f)), weights: s.weights.map(r => [...r])};
}

/** Mirror across the plane x = 0 (vehicles are modeled with +x = right side). */
export function mirrorX(s: NurbsSurface): NurbsSurface {
  // Mirroring flips orientation; reverse u so normals keep pointing outward.
  const m = transformSurface(s, p => [-p[0], p[1], p[2]]);
  return {
    ...m,
    points: [...m.points].reverse(),
    weights: [...m.weights].reverse(),
    knotsU: s.knotsU.map(k => 1 - k).reverse(),
  };
}

/** Flip the surface orientation (swaps which side the normal faces). */
export function flipSurface(s: NurbsSurface): NurbsSurface {
  return {
    ...s,
    points: [...s.points].reverse(),
    weights: [...s.weights].reverse(),
    knotsU: s.knotsU.map(k => 1 - k).reverse(),
  };
}
