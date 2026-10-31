// Column-major 4x4 matrices in Float32Arrays, WebGPU clip space (z in 0..1).
// The renderer uses reverse-Z (near = 1, far = 0) for precision across a huge city.

import type {Vec3} from './vec.ts';

export type Mat4 = Float32Array;

const mulScratch = new Float32Array(16);

export const mat4 = {
  create(): Mat4 {
    return mat4.identity(new Float32Array(16));
  },

  identity(out: Mat4): Mat4 {
    out.fill(0);
    out[0] = out[5] = out[10] = out[15] = 1;
    return out;
  },

  copy(out: Mat4, a: Mat4): Mat4 {
    out.set(a);
    return out;
  },

  multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
    // Into a shared scratch first (out may alias a or b), with no allocation.
    const r = mulScratch;
    for (let c = 0; c < 4; c++) {
      for (let row = 0; row < 4; row++) {
        r[c * 4 + row] =
          a[row] * b[c * 4] +
          a[4 + row] * b[c * 4 + 1] +
          a[8 + row] * b[c * 4 + 2] +
          a[12 + row] * b[c * 4 + 3];
      }
    }
    out.set(r);
    return out;
  },

  /** Reverse-Z infinite perspective: near maps to 1, infinity to 0. */
  perspectiveReverseZ(
    out: Mat4,
    fovY: number,
    aspect: number,
    near: number,
  ): Mat4 {
    const f = 1 / Math.tan(fovY / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[11] = -1;
    out[14] = near;
    return out;
  },

  /** Orthographic projection with z in 0..1 (near -> 0, far -> 1). */
  ortho(
    out: Mat4,
    l: number,
    r: number,
    b: number,
    t: number,
    n: number,
    f: number,
  ): Mat4 {
    out.fill(0);
    out[0] = 2 / (r - l);
    out[5] = 2 / (t - b);
    out[10] = 1 / (n - f);
    out[12] = (l + r) / (l - r);
    out[13] = (t + b) / (b - t);
    out[14] = n / (n - f);
    out[15] = 1;
    return out;
  },

  lookAt(out: Mat4, eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    let zx = eye[0] - target[0];
    let zy = eye[1] - target[1];
    let zz = eye[2] - target[2];
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l;
    zy /= l;
    zz /= l;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l;
    xy /= l;
    xz /= l;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    out[0] = xx;
    out[1] = yx;
    out[2] = zx;
    out[3] = 0;
    out[4] = xy;
    out[5] = yy;
    out[6] = zy;
    out[7] = 0;
    out[8] = xz;
    out[9] = yz;
    out[10] = zz;
    out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  },

  invert(out: Mat4, m: Mat4): Mat4 {
    const a00 = m[0],
      a01 = m[1],
      a02 = m[2],
      a03 = m[3];
    const a10 = m[4],
      a11 = m[5],
      a12 = m[6],
      a13 = m[7];
    const a20 = m[8],
      a21 = m[9],
      a22 = m[10],
      a23 = m[11];
    const a30 = m[12],
      a31 = m[13],
      a32 = m[14],
      a33 = m[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det =
      b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return mat4.identity(out);
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  },

  /** Build a transform from a position and orthonormal basis (right, up, forward=-z). */
  fromBasis(out: Mat4, pos: Vec3, right: Vec3, up: Vec3, back: Vec3): Mat4 {
    out[0] = right[0];
    out[1] = right[1];
    out[2] = right[2];
    out[3] = 0;
    out[4] = up[0];
    out[5] = up[1];
    out[6] = up[2];
    out[7] = 0;
    out[8] = back[0];
    out[9] = back[1];
    out[10] = back[2];
    out[11] = 0;
    out[12] = pos[0];
    out[13] = pos[1];
    out[14] = pos[2];
    out[15] = 1;
    return out;
  },

  transformPoint(m: Mat4, p: Vec3): Vec3 {
    const x = p[0],
      y = p[1],
      z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    return [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ];
  },
};

/** Extract 6 frustum planes (normal.xyz, d) from a view-projection matrix, reverse-Z aware. */
export function frustumPlanes(vp: Mat4, out = new Float32Array(24)) {
  const row = (r: number) => [vp[r], vp[4 + r], vp[8 + r], vp[12 + r]];
  const r0 = row(0),
    r1 = row(1),
    r2 = row(2),
    r3 = row(3);
  const planes = [
    r3.map((v, i) => v + r0[i]),
    r3.map((v, i) => v - r0[i]),
    r3.map((v, i) => v + r1[i]),
    r3.map((v, i) => v - r1[i]),
    r2, // z >= 0
    r3.map((v, i) => v - r2[i]), // z <= w
  ];
  planes.forEach((p, i) => {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    out.set([p[0] / l, p[1] / l, p[2] / l, p[3] / l], i * 4);
  });
  return out;
}
