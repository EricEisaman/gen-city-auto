import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fitPath, fitRises, gradeStats} from '../../src/city/grade.ts';
import type {Vec2} from '../../src/math/vec.ts';

void test('gradeStats: max, length-weighted p99 and segments over 15%', () => {
  const pts: Vec2[] = [];
  const heights: number[] = [];
  // 99 flat 10 m segments, then one at 30%.
  for (let i = 0; i <= 100; i++) {
    pts.push([i * 10, 0]);
    heights.push(i === 100 ? 3 : 0);
  }
  const s = gradeStats([{pts, heights}]);
  assert.equal(s.segments, 100);
  assert.equal(s.over15, 1);
  assert.ok(Math.abs(s.max - 0.3) < 1e-9);
  assert.equal(s.p99, 0);
  // Exactly 15% is not over it; segments under minRun are skipped.
  const t = gradeStats([
    {
      pts: [
        [0, 0],
        [10, 0],
        [10.5, 0],
      ],
      heights: [0, 1.5, 3],
    },
  ]);
  assert.equal(t.segments, 1);
  assert.equal(t.over15, 0);
});

/** Largest |h[a] - h[b]| - rise over the edges. */
function overshoot(a: number[], b: number[], rise: number[], h: Float64Array) {
  let worst = -Infinity;
  a.forEach((u, k) => {
    worst = Math.max(worst, Math.abs(h[u] - h[b[k]]) - rise[k]);
  });
  return worst;
}

void test('fitRises keeps every rise and the floor, close to the target', () => {
  // A 3 x 40 grid of 8 m edges at a 10% limit over a 60 m high ridge.
  const W = 40;
  const H = 3;
  const n = W * H;
  const a: number[] = [];
  const b: number[] = [];
  const rise: number[] = [];
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const v = j * W + i;
      const join = (u: number) => {
        a.push(v);
        b.push(u);
        rise.push(0.8);
      };
      if (i + 1 < W) join(v + 1);
      if (j + 1 < H) join(v + W);
    }
  const target = Float64Array.from({length: n}, (_, v) =>
    Math.max(0, 60 - 6 * Math.abs((v % W) - W / 2)),
  );
  const floor = new Float64Array(n).fill(NaN);
  floor[0] = 20; // A bridge deck at one end.
  const h = fitRises(
    {
      n,
      a: Int32Array.from(a),
      b: Int32Array.from(b),
      rise: Float32Array.from(rise),
    },
    target,
    new Float64Array(n).fill(1),
    {floor},
  );
  assert.ok(overshoot(a, b, rise, h) < 1e-6);
  assert.ok(h[0] >= 20 - 1e-9);
  // The ridge is cut and its foot filled, about evenly.
  const top = h[W / 2];
  assert.ok(top < 60 && top > 15, `top ${top}`);
  assert.ok(h[W / 2 - 15] > target[W / 2 - 15]);
});

void test('fitPath keeps its ends, the rises and the ceiling', () => {
  const n = 30;
  const rise = new Float32Array(n - 1).fill(1);
  const target = Float64Array.from({length: n}, (_, i) => (i % 2) * 10);
  target[0] = 5;
  target[n - 1] = 25;
  const weight = new Float64Array(n).fill(1);
  weight[0] = weight[n - 1] = 1e6;
  const ceil = new Float64Array(n).fill(NaN);
  ceil[10] = 6;
  const h = fitPath(target, weight, {ceil}, rise, 80);
  assert.equal(h[0], 5);
  assert.equal(h[n - 1], 25);
  assert.ok(h[10] <= 6 + 1e-9);
  for (let i = 0; i + 1 < n; i++)
    assert.ok(Math.abs(h[i + 1] - h[i]) <= 1 + 1e-9, `segment ${i}`);
});
