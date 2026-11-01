// Compact GPU vertex format for city clusters (decoded by city.wgsl fetch).
//
// clusterize() emits 32-byte vertices (cmesh.ts: pos f32x3, oct normal, uv
// f32x2, mat, aux). packClusters() rewrites each cluster's vertices into 20
// bytes (VPACK_WORDS) plus a per-cluster palette of its distinct (mat, aux)
// pairs, which is where most of the 32 bytes went (7.5 pairs per cluster of
// ~170 vertices on average):
//
//   w0 = qx (19 bits) | qy low 13 bits << 19
//   w1 = qy high 6 bits | qz (19 bits) << 6 | palette index (7 bits) << 25
//   w2 = octahedral normal (unchanged)
//   w3, w4 = uv as f32 (unchanged; road and wire uvs run to 11 km)
//
// Positions sit on a global grid of step 2^k / 4096 m relative to the
// cluster's origin floor(center / step) * step (q stored offset by 2^18, so
// +-64 m at k = 0). The grid is the same for every cluster of one k, so a
// vertex shared by two clusters decodes to the same point in both (no
// cracks), and at k = 0 it is finer than f32 itself between 2048 and 4096 m
// (the city's outer half): the error is at most 0.12 mm (k 0), 0.24 mm (1)
// or 0.49 mm (2). Every term of the decode is exact in f32, so JS and WGSL
// agree to the bit. A cluster that needs k > 2 (long far-culled paint
// strips and pier rows of the base mesh, ~0.3 % of clusters) or more than
// 128 pairs keeps the 32-byte vertices (k field RAW_SHIFT).
//
// Cluster record word 4 becomes the word offset W of the cluster's vertices
// in the vertex buffer (bits 0-27) and k (bits 28-31); palette entry j
// (mat, aux) is at words W - 2 - 2j, W - 1 - 2j.

import {CLUSTER_WORDS, VERTEX_WORDS, type ClusterData} from './cmesh.ts';

export const VPACK_WORDS = 5;
/** Cluster word 4: word offset bits. */
export const VOFFSET_MASK = 0x0fffffff;
export const VSHIFT_SHIFT = 28;
/** Shift field value of a cluster that kept the 32-byte vertices. */
export const RAW_SHIFT = 15;
const MAX_SHIFT = 2;
const POS_BITS = 19;
const POS_BIAS = 1 << (POS_BITS - 1);
const PAL_MAX = 128;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const asF32 = (u: number) => {
  u32[0] = u;
  return f32[0];
};

/** Grid step (m) for shift k. */
export const gridStep = (k: number) => 2 ** k / 4096;

/** Index of (mat, aux) in the palette, appended if new. */
function palIndex(list: number[], mat: number, aux: number) {
  for (let j = 0; j < list.length; j += 2)
    if (list[j] === mat && list[j + 1] === aux) return j / 2;
  list.push(mat, aux);
  return list.length / 2 - 1;
}

/**
 * Grid coordinates (+ POS_BIAS) of the vertices v0..v1 of cluster record i
 * at shift k into q (3 per vertex); false if one is out of range.
 */
function quantize(
  src: Uint32Array,
  cf: Float32Array,
  i: number,
  v0: number,
  v1: number,
  k: number,
  q: Int32Array,
) {
  const s = gridStep(k);
  for (let a = 0; a < 3; a++) {
    const org = Math.floor(cf[i * CLUSTER_WORDS + a] / s);
    for (let v = v0; v < v1; v++) {
      const qq = Math.round(asF32(src[v * VERTEX_WORDS + a]) / s - org);
      if (qq < -POS_BIAS || qq >= POS_BIAS) return false;
      q[(v - v0) * 3 + a] = qq + POS_BIAS;
    }
  }
  return true;
}

/** Rewrites clusterize() output into the packed vertex format (see header). */
export function packClusters(c: ClusterData): ClusterData {
  const n = c.clusterCount;
  const src = c.vertices;
  const cl = c.clusters.slice(0, n * CLUSTER_WORDS);
  const cf = new Float32Array(cl.buffer);
  const nvTotal = src.length / VERTEX_WORDS;
  const vEnd = (i: number) =>
    i + 1 < n ? cl[(i + 1) * CLUSTER_WORDS + 4] : nvTotal;
  const q = new Int32Array(3 * 256);
  // Pass 1: each cluster's shift (or RAW_SHIFT), palette and size, so the
  // output is allocated once at its exact size.
  const shift = new Uint8Array(n);
  const palOf = new Uint8Array(nvTotal);
  const palStart = new Uint32Array(n + 1);
  const pals: number[] = [];
  const palList: number[] = [];
  let words = 0;
  for (let i = 0; i < n; i++) {
    const v0 = cl[i * CLUSTER_WORDS + 4];
    const v1 = vEnd(i);
    palList.length = 0;
    let k = 0;
    for (let v = v0; v < v1 && k === 0; v++) {
      const j = palIndex(
        palList,
        src[v * VERTEX_WORDS + 6],
        src[v * VERTEX_WORDS + 7],
      );
      if (j < PAL_MAX) palOf[v] = j;
      else k = RAW_SHIFT;
    }
    if (k === 0) {
      while (k <= MAX_SHIFT && !quantize(src, cf, i, v0, v1, k, q)) k++;
      if (k > MAX_SHIFT) k = RAW_SHIFT;
    }
    shift[i] = k;
    palStart[i] = pals.length;
    if (k === RAW_SHIFT) words += (v1 - v0) * VERTEX_WORDS;
    else {
      for (const x of palList) pals.push(x);
      words += palList.length + (v1 - v0) * VPACK_WORDS;
    }
  }
  palStart[n] = pals.length;
  const out = new Uint32Array(words);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const v0 = cl[i * CLUSTER_WORDS + 4];
    const v1 = vEnd(i);
    const k = shift[i];
    if (k === RAW_SHIFT) {
      cl[i * CLUSTER_WORDS + 4] = (o | (RAW_SHIFT << VSHIFT_SHIFT)) >>> 0;
      out.set(src.subarray(v0 * VERTEX_WORDS, v1 * VERTEX_WORDS), o);
      o += (v1 - v0) * VERTEX_WORDS;
      continue;
    }
    // Palette entries count down from the vertices.
    const p0 = palStart[i];
    const np = (palStart[i + 1] - p0) / 2;
    for (let j = 0; j < np; j++) {
      out[o + (np - 1 - j) * 2] = pals[p0 + j * 2];
      out[o + (np - 1 - j) * 2 + 1] = pals[p0 + j * 2 + 1];
    }
    o += np * 2;
    cl[i * CLUSTER_WORDS + 4] = (o | (k << VSHIFT_SHIFT)) >>> 0;
    quantize(src, cf, i, v0, v1, k, q);
    for (let v = v0; v < v1; v++) {
      const s = v * VERTEX_WORDS;
      const qx = q[(v - v0) * 3];
      const qy = q[(v - v0) * 3 + 1];
      const qz = q[(v - v0) * 3 + 2];
      out[o] = (qx | ((qy & 0x1fff) << 19)) >>> 0;
      out[o + 1] = ((qy >>> 13) | (qz << 6) | (palOf[v] << 25)) >>> 0;
      out[o + 2] = src[s + 3];
      out[o + 3] = src[s + 4];
      out[o + 4] = src[s + 5];
      o += VPACK_WORDS;
    }
  }
  return {
    vertices: out,
    tris: c.tris,
    clusters: cl,
    clusterCount: n,
    bounds: c.bounds,
  };
}

/**
 * Decodes vertex `local` of cluster record `ci` from packed words (the same
 * arithmetic as city.wgsl fetch): [x, y, z] as f32 values, normal, u, v
 * (raw bits), mat, aux.
 */
export function unpackVertex(
  words: Uint32Array,
  clusters: Uint32Array,
  ci: number,
  local: number,
): number[] {
  const w4 = clusters[ci * CLUSTER_WORDS + 4];
  const base = w4 & VOFFSET_MASK;
  const k = w4 >>> VSHIFT_SHIFT;
  if (k === RAW_SHIFT) {
    const o = base + local * VERTEX_WORDS;
    return [
      asF32(words[o]),
      asF32(words[o + 1]),
      asF32(words[o + 2]),
      ...words.subarray(o + 3, o + 8),
    ];
  }
  const o = base + local * VPACK_WORDS;
  const w0 = words[o];
  const w1 = words[o + 1];
  const qs = [
    (w0 & 0x7ffff) - POS_BIAS,
    ((w0 >>> 19) | ((w1 & 0x3f) << 13)) - POS_BIAS,
    ((w1 >>> 6) & 0x7ffff) - POS_BIAS,
  ];
  const p = w1 >>> 25;
  const s = gridStep(k);
  const pos = qs.map((qq, a) => {
    const c = asF32(clusters[ci * CLUSTER_WORDS + a]);
    return Math.fround(Math.floor(c / s) * s + qq * s);
  });
  return [
    ...pos,
    words[o + 2],
    words[o + 3],
    words[o + 4],
    words[base - 2 - 2 * p],
    words[base - 1 - 2 * p],
  ];
}
