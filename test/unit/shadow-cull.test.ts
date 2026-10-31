import assert from 'node:assert/strict';
import {test} from 'node:test';
import {frustumPlanes, mat4} from '../../src/math/mat4.ts';
import {receiverPlanes} from '../../src/render/shadow-cull.ts';

// Camera at the origin looking down -z, 60 degree fov, 16:9.
const eye: [number, number, number] = [0, 2, 0];
const fwd: [number, number, number] = [0, 0, -1];
const view = mat4.lookAt(mat4.create(), eye, [0, 2, -1], [0, 1, 0]);
const proj = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 16 / 9, 0.1);
const cam = frustumPlanes(mat4.multiply(mat4.create(), proj, view));

const inside = (planes: number[], p: number[], r = 0) => {
  for (let i = 0; i < planes.length; i += 4)
    if (
      planes[i] * p[0] +
        planes[i + 1] * p[1] +
        planes[i + 2] * p[2] +
        planes[i + 3] <
      -r
    )
      return false;
  return true;
};

void test('receiverPlanes keeps casters that can shadow the slice, drops the rest', () => {
  // Sun high behind the camera (toward +z, up).
  const toLight: [number, number, number] = [0, 0.8, 0.6];
  const pl = receiverPlanes(cam, eye, fwd, 240, 800, toLight, 1);
  // Receivers in the slice are kept.
  assert.ok(inside(pl, [0, 0, -500]));
  // So is a caster behind the camera between the slice and the sun: the
  // near plane faces away from the light and is dropped.
  assert.ok(inside(pl, [0, 150, -150]));
  // Beyond the far end (shadows fall further away from the sun): culled.
  assert.ok(!inside(pl, [0, 0, -900]));
  // Below the bottom plane (it faces the sun): culled. (The side planes
  // face away from this light and are dropped.)
  assert.ok(!inside(pl, [0, -600, -500]));
  assert.ok(inside(pl, [2000, 0, -500]));
  // The margin widens every kept plane.
  assert.ok(inside(pl, [0, 0, -800.5]));
});

void test('receiverPlanes drops every plane the light sweep crosses', () => {
  // Light straight ahead and low: the far plane's inward normal (-fwd)
  // faces away from it, so casters beyond the slice stay.
  const pl = receiverPlanes(cam, eye, fwd, 240, 800, [0, 0.2, -0.98], 0);
  assert.ok(inside(pl, [0, 30, -1500]));
  // But not those behind the near end (shadows fall away from the light).
  assert.ok(!inside(pl, [0, 0, -100]));
});
