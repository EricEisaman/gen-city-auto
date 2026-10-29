// Small vector library. Vectors are plain tuples so they are cheap to create
// in generation code; hot per-frame code writes into Float32Arrays directly.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const scale3 = (a: Vec3, s: number): Vec3 => [
  a[0] * s,
  a[1] * s,
  a[2] * s,
];
export const mul3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] * b[0],
  a[1] * b[1],
  a[2] * b[2],
];
export const dot3 = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const dist3 = (a: Vec3, b: Vec3) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const madd3 = (a: Vec3, b: Vec3, s: number): Vec3 => [
  a[0] + b[0] * s,
  a[1] + b[1] * s,
  a[2] + b[2] * s,
];

export const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale2 = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot2 = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
export const len2 = (a: Vec2) => Math.hypot(a[0], a[1]);
export const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm2 = (a: Vec2): Vec2 => {
  const l = len2(a) || 1;
  return [a[0] / l, a[1] / l];
};
export const perp2 = (a: Vec2): Vec2 => [-a[1], a[0]];
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const fract = (x: number) => x - Math.floor(x);
export const DEG = Math.PI / 180;

/** Signed area of a 2D polygon (positive = counter-clockwise). */
export function polygonArea(poly: Vec2[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Intersect segments p0-p1 and q0-q1, returning parameters along each, or null. */
export function segmentIntersect(
  p0: Vec2,
  p1: Vec2,
  q0: Vec2,
  q1: Vec2,
): [number, number] | null {
  const r = sub2(p1, p0);
  const s = sub2(q1, q0);
  const d = cross2(r, s);
  if (Math.abs(d) < 1e-9) return null;
  const qp = sub2(q0, p0);
  const t = cross2(qp, s) / d;
  const u = cross2(qp, r) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [t, u];
}

/** Distance from p to segment a-b, plus the parameter of the closest point. */
export function pointSegment(p: Vec2, a: Vec2, b: Vec2): [number, number] {
  const ab = sub2(b, a);
  const l2 = dot2(ab, ab);
  const t = l2 > 0 ? clamp(dot2(sub2(p, a), ab) / l2, 0, 1) : 0;
  return [dist2(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]), t];
}
