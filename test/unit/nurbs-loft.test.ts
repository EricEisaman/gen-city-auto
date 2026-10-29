// loftPoints / interpolateCurve must pass through every input point, even when
// the rows have very different point spacing or degenerate to a pole.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  curvePoint,
  interpolateCurve,
  loftPoints,
  surfacePoint,
} from '../../src/nurbs/nurbs.ts';
import type {Vec3} from '../../src/math/vec.ts';

const close = (a: Vec3, b: Vec3, eps = 1e-6) =>
  assert.ok(
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < eps,
    `${a} != ${b}`,
  );

/** Find the surface point nearest p by dense sampling + local refinement. */
function distanceToSurface(s: ReturnType<typeof loftPoints>, p: Vec3) {
  let best = Infinity;
  let bu = 0,
    bv = 0;
  const n = 300;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const q = surfacePoint(s, i / n, j / n);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (d < best) [best, bu, bv] = [d, i / n, j / n];
    }
  }
  let h = 1 / n;
  for (let it = 0; it < 40; it++) {
    for (const [du, dv] of [
      [h, 0],
      [-h, 0],
      [0, h],
      [0, -h],
    ]) {
      const u = Math.min(1, Math.max(0, bu + du)),
        v = Math.min(1, Math.max(0, bv + dv));
      const q = surfacePoint(s, u, v);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (d < best) [best, bu, bv] = [d, u, v];
    }
    h *= 0.7;
  }
  return best;
}

void test('interpolateCurve passes through its points (including the 4-point cubic case)', () => {
  const pts: Vec3[] = [
    [0, 0, 0],
    [1, 2, 0],
    [3, 1, 0],
    [4, 3, 1],
  ];
  const c = interpolateCurve(pts, 3);
  close(curvePoint(c, 0), pts[0]);
  close(curvePoint(c, 1), pts[3]);
  // Interior points lie on the curve.
  for (const p of pts.slice(1, 3)) {
    let best = Infinity;
    for (let i = 0; i <= 4000; i++) {
      const q = curvePoint(c, i / 4000);
      best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    }
    assert.ok(best < 1e-3, `interior point off curve by ${best}`);
  }
});

void test('loftPoints interpolates rows with different spacing', () => {
  // Row 1 has its points bunched at one end: a per-row parameterization that is
  // then evaluated with row 0's knots would miss these points.
  const rows: Vec3[][] = [
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [4, 0, 0],
    ],
    [
      [0, 0.5, 1],
      [0.6, 0.6, 1],
      [1.3, 0.5, 1],
      [3, 0.2, 1],
      [4, 0, 1],
    ],
    [
      [0, 0, 2],
      [1, 0.3, 2],
      [2, 0, 2],
      [3, 0.3, 2],
      [4, 0, 2],
    ],
    [
      [0, 0, 3],
      [1, 0, 3],
      [2, 0.1, 3],
      [3, 0, 3],
      [4, 0, 3],
    ],
  ];
  const s = loftPoints(rows);
  for (const row of rows)
    for (const p of row)
      assert.ok(distanceToSurface(s, p) < 1e-4, `point ${p} not on surface`);
});

void test('loftPoints accepts a degenerate (pole) row', () => {
  const rows: Vec3[][] = [
    [
      [0, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
    ],
    [
      [0, 0, 1],
      [1, 1.2, 1],
      [2, 0, 1],
    ],
    [
      [1, 0.5, 2],
      [1, 0.5, 2],
      [1, 0.5, 2],
    ],
  ];
  const s = loftPoints(rows, {degreeU: 2, degreeV: 2});
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      const p = surfacePoint(s, i / 10, j / 10);
      assert.ok(p.every(Number.isFinite), 'non-finite surface point');
    }
  }
  close(surfacePoint(s, 0.3, 1), [1, 0.5, 2]);
  for (const row of rows)
    for (const p of row) assert.ok(distanceToSurface(s, p) < 1e-4);
});
