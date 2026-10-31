import type {Vec3} from '../math/vec.ts';

/**
 * Culling planes (xyz inward normal, w) for the shadow casters of one
 * cascade: the planes of its receivers, the camera frustum slice between
 * view depths near and far (lighting.wgsl picks the cascade by view depth),
 * that still bound that slice once it is swept toward the light. A caster
 * outside one of them cannot shadow a pixel that reads this cascade. Planes
 * the sweep crosses (inward normal facing away from the light) are dropped,
 * which keeps the test conservative. Each plane is pushed out by margin.
 */
export function receiverPlanes(
  camPlanes: Float32Array,
  eye: Vec3,
  fwd: Vec3,
  near: number,
  far: number,
  toLight: Vec3,
  margin: number,
): number[] {
  const fe = fwd[0] * eye[0] + fwd[1] * eye[1] + fwd[2] * eye[2];
  const cand: number[][] = [
    // Side planes of the camera frustum (left, right, bottom, top).
    ...[0, 1, 2, 3].map(i => [...camPlanes.slice(i * 4, i * 4 + 4)]),
    // View depth >= near, <= far.
    [fwd[0], fwd[1], fwd[2], -fe - near],
    [-fwd[0], -fwd[1], -fwd[2], fe + far],
  ];
  const out: number[] = [];
  for (const p of cand) {
    if (p[0] * toLight[0] + p[1] * toLight[1] + p[2] * toLight[2] < 0) continue;
    out.push(p[0], p[1], p[2], p[3] + margin);
  }
  return out;
}
