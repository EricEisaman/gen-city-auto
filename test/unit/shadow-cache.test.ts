import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  CACHE_TOL,
  cacheTouches,
  cacheValid,
  lightTolerance,
  type CascadeCache,
} from '../../src/render/shadow-cache.ts';

type V = [number, number, number];

// A cascade fit (shadow-cache.ts CascadeCache) for a camera at `eye`.
const fit = (o: Partial<CascadeCache> = {}): CascadeCache => ({
  eye: [0, 2, 0],
  fwd: [0, 0, -1],
  light: [0, 1, 0],
  halfFov: 0.5,
  center: [0, 2, -50],
  sliceRadius: 90,
  key: 'k',
  mat: new Float32Array(16),
  radius: 100,
  // Light straight down: light-space x = world x, y = world z.
  lx: [1, 0, 0],
  ly: [0, 0, 1],
  cx: 0,
  cy: -50,
  ...o,
});

void test('cacheValid holds within the move / turn / fov / light tolerance', () => {
  const c = fit();
  const t = CACHE_TOL[2];
  const moved = (d: number): Partial<CascadeCache> => ({
    eye: [d, 2, 0] as V,
    center: [d, 2, -50] as V,
  });
  assert.ok(cacheValid(c, 2, fit(), 2048));
  assert.ok(cacheValid(c, 2, fit(moved(t.move * 0.9)), 2048));
  assert.ok(!cacheValid(c, 2, fit(moved(t.move * 1.1)), 2048));
  const a = t.turn * 1.1;
  assert.ok(
    !cacheValid(c, 2, fit({fwd: [Math.sin(a), 0, -Math.cos(a)]}), 2048),
  );
  // A wider field of view spends turn budget.
  assert.ok(cacheValid(c, 2, fit({halfFov: 0.5 + t.turn * 0.5}), 2048));
  assert.ok(!cacheValid(c, 2, fit({halfFov: 0.5 + t.turn * 1.1}), 2048));
  // The fresh slice sphere must fit inside the cached (grown) one.
  assert.ok(!cacheValid(c, 2, fit({sliceRadius: 101}), 2048));
  const lt = lightTolerance(100, 2048) * 1.5;
  assert.ok(
    !cacheValid(c, 2, fit({light: [Math.sin(lt), Math.cos(lt), 0]}), 2048),
  );
  assert.ok(!cacheValid(c, 2, fit({key: 'other'}), 2048));
  assert.ok(!cacheValid(null, 2, fit(), 2048));
});

void test('cacheTouches tests boxes against the light-space footprint', () => {
  const c = fit();
  // Inside the footprint (x in -100..100, z in -150..50).
  assert.ok(cacheTouches(c, [-5, 0, -60], [5, 40, -50]));
  // Overlapping its edge.
  assert.ok(cacheTouches(c, [95, 0, 0], [130, 40, 10]));
  // Beyond it in x and in z.
  assert.ok(!cacheTouches(c, [101, 0, 0], [130, 40, 10]));
  assert.ok(!cacheTouches(c, [0, 0, 51], [10, 40, 80]));
});
