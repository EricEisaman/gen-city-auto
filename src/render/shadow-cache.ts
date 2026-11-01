// Static shadow-map cache. The city is static (only vehicles move, and they
// draw through the hooks), so each cascade keeps its city depth in a cache
// layer and only redraws it once the camera has moved or turned past that
// cascade's tolerance, the light has turned, or the geometry it covers has
// changed (streaming). Every frame the cached layer is copied into the live
// shadow map and the moving casters are drawn over it.
//
// A cached cascade must still cover the receivers of every later frame that
// reuses it. Its bounding sphere is grown by the tolerance (the slice
// sphere's centre sits on the view axis at distance s, so a camera moved by
// at most `move` and turned by at most `turn` moves it by at most
// move + s * turn), and the receiver culling planes are pushed out the same
// way (a point of the slice is at most `diag` x far from the eye). The
// field of view changes with speed (chase camera): widening it turns the
// frustum's side planes outward, so a half-angle change spends turn budget,
// and the reused sphere must still hold this frame's slice sphere.

import type {Vec3} from '../math/vec.ts';

/** Per cascade: camera move (m) and turn (radians) a cached map tolerates. */
export const CACHE_TOL: {move: number; turn: number}[] = [
  {move: 0.6, turn: 0.035},
  {move: 2.5, turn: 0.035},
  {move: 8, turn: 0.05},
  {move: 30, turn: 0.07},
];

/**
 * Light turn (radians) a cached cascade tolerates: the shadow of a 150 m
 * tower moves by at most one of its texels (texel = 2 radius / size).
 */
export function lightTolerance(radius: number, size: number) {
  return (2 * radius) / size / 150;
}

export interface CascadeCache {
  eye: Vec3;
  fwd: Vec3;
  light: Vec3;
  /** Half the vertical field of view (radians). */
  halfFov: number;
  /** The slice's own bounding sphere (before growing). */
  center: Vec3;
  sliceRadius: number;
  /** Aspect and anything else that must match exactly. */
  key: string;
  mat: Float32Array;
  radius: number;
  /** Light-space basis and the footprint centre in it. */
  lx: Vec3;
  ly: Vec3;
  cx: number;
  cy: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Whether `c` still covers this frame's cascade `i` (`f`: its fresh fit). */
export function cacheValid(
  c: CascadeCache | null,
  i: number,
  f: CascadeCache,
  size: number,
): c is CascadeCache {
  if (!c || c.key !== f.key) return false;
  const t = CACHE_TOL[i];
  const dx = f.eye[0] - c.eye[0];
  const dy = f.eye[1] - c.eye[1];
  const dz = f.eye[2] - c.eye[2];
  if (dx * dx + dy * dy + dz * dz > t.move * t.move) return false;
  const turn = Math.acos(Math.min(1, dot(f.fwd, c.fwd)));
  if (turn + Math.abs(f.halfFov - c.halfFov) > t.turn) return false;
  const cd = Math.hypot(
    f.center[0] - c.center[0],
    f.center[1] - c.center[1],
    f.center[2] - c.center[2],
  );
  if (cd + f.sliceRadius > c.radius) return false;
  const lt = lightTolerance(c.radius, size);
  return dot(f.light, c.light) >= Math.cos(lt);
}

/** Whether the box lo..hi reaches the cached cascade's footprint. */
export function cacheTouches(c: CascadeCache, lo: Vec3, hi: Vec3) {
  for (const [axis, ctr] of [
    [c.lx, c.cx],
    [c.ly, c.cy],
  ] as const) {
    let mn = 0;
    let mx = 0;
    for (let k = 0; k < 3; k++) {
      const a = axis[k] * lo[k];
      const b = axis[k] * hi[k];
      mn += Math.min(a, b);
      mx += Math.max(a, b);
    }
    if (mx < ctr - c.radius || mn > ctr + c.radius) return false;
  }
  return true;
}
