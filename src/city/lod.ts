// Distance detail for the far city:
//   - baseFarOf: per-triangle cull distances for the always-resident base
//     mesh (kerbs, railings, wires, thin road paint go at range; road
//     surfaces, sidewalks and rail / expressway structure stay).
//   - lod2: the LOD2 tile (beyond ~1.5 km) derived from the LOD1 shell:
//     building boxes, roofs, signs and big props kept; leaf cards, thin
//     painted-steel / metal props and small signs dropped; each tree crown
//     one opaque low-poly blob.
//
// Both classify a triangle by material, its narrowest width (twice its area
// over its longest edge: a 5 cm rail or a 15 cm lane line is narrow however
// long) and, for tubes, the radius they carry in aux. One pixel at 1.5 km is
// ~2 m at 720p and ~1 m at 1440p, so anything under ~0.4 m wide is well
// below a pixel there.

import {CM, CMesh, packMat, VERTEX_WORDS} from './cmesh.ts';

/** Leaf param flag: a solid LOD2 crown (opaque pipeline, no cutout). */
export const LEAF_SOLID = 0x100;

/** Materials that may carry a tube radius in aux (cmesh.ts TUBE_MATS). */
const TUBES =
  (1 << CM.wire) |
  (1 << CM.frame) |
  (1 << CM.paint) |
  (1 << CM.metal) |
  (1 << CM.lamp) |
  (1 << CM.ledLine);

/** Narrowest width of triangle `t` (2 * area / longest edge), metres. */
function width(m: CMesh, t: number) {
  const f = m.f32;
  const a = m.idx[t * 3] * VERTEX_WORDS;
  const b = m.idx[t * 3 + 1] * VERTEX_WORDS;
  const c = m.idx[t * 3 + 2] * VERTEX_WORDS;
  const ux = f[b] - f[a],
    uy = f[b + 1] - f[a + 1],
    uz = f[b + 2] - f[a + 2];
  const vx = f[c] - f[a],
    vy = f[c + 1] - f[a + 1],
    vz = f[c + 2] - f[a + 2];
  const wx = f[c] - f[b],
    wy = f[c + 1] - f[b + 1],
    wz = f[c + 2] - f[b + 2];
  const cx = uy * vz - uz * vy,
    cy = uz * vx - ux * vz,
    cz = ux * vy - uy * vx;
  const e = Math.max(
    ux * ux + uy * uy + uz * uz,
    vx * vx + vy * vy + vz * vz,
    wx * wx + wy * wy + wz * wz,
  );
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / Math.max(Math.sqrt(e), 1e-6);
}

/** Material id and tube radius (m, 0 if not a tube) of triangle `t`. */
function matOf(m: CMesh, t: number): [number, number] {
  const v = m.idx[t * 3] * VERTEX_WORDS;
  const id = m.u32[v + 6] & 0xff;
  const r =
    id < 32 && (TUBES >>> id) & 1 ? (m.u32[v + 7] & 0xffff) * 0.0005 : 0;
  return [id, r];
}

/**
 * Base-mesh cull distance of each triangle (metres, 0 = always drawn), for
 * clusterize(). Near/mid views are unchanged: nothing goes before 700 m.
 */
export function baseFarOf(m: CMesh): (t: number) => number {
  return t => {
    const [id, r] = matOf(m, t);
    switch (id) {
      case CM.wire:
        return 700;
      case CM.metal:
      case CM.paint:
      case CM.frame: {
        if (r > 0) return r < 0.15 ? 900 : r < 0.4 ? 1600 : 0;
        // Lane lines, railing bars, sign posts; then stop lines, guard
        // rail beams. Zebra bars and wide boxes stay.
        const w = width(m, t);
        return w < 0.15 ? 900 : w < 0.4 ? 1400 : 0;
      }
      case CM.curb:
        // Kerb faces and tops (15-30 cm): their colour line is sub-pixel.
        return width(m, t) < 1 ? 1200 : 0;
      case CM.roadSign:
        return 900;
      case CM.concrete:
        // Thin parapet caps and kerbs of structures; decks, walls, piers stay.
        return width(m, t) < 0.15 ? 1800 : 0;
      default:
        return 0;
    }
  };
}

/** True if LOD2 keeps triangle `t` of a LOD1 shell (trees handled apart). */
function keep2(m: CMesh, t: number) {
  const [id, r] = matOf(m, t);
  switch (id) {
    case CM.leaves:
    case CM.bark:
    case CM.wire:
      return false;
    case CM.lamp:
    case CM.sign:
    case CM.vending:
      // Lit fittings and signs stay, small ones too: at night the street
      // lights and the specks of sign colour read from afar (dropping signs
      // under 0.4 m thinned them visibly for 0.3 % of the triangles).
      return true;
    case CM.metal:
    case CM.paint:
    case CM.frame:
      // Masts, big frames, tanks and roof plant stay; railings, ladders,
      // fire escapes, pipes and thin trim go.
      return r > 0 ? r >= 0.25 : width(m, t) >= 0.6;
    case CM.roadSign:
    case CM.curb:
    case CM.hedge:
      return width(m, t) >= 0.4;
    default:
      return true;
  }
}

interface Crown {
  lo: [number, number, number];
  hi: [number, number, number];
  param: number;
  aux: number;
}

/**
 * LOD2 tile mesh from the LOD1 shell `m` (same generation, so placement,
 * colours and every per-building choice match LOD1 exactly).
 */
export function lod2(m: CMesh): CMesh {
  const out = new CMesh(
    Math.max(1024, m.vcount >> 1),
    Math.max(2048, m.icount >> 1),
  );
  const remap = new Int32Array(m.vcount).fill(-1);
  const crowns = new Map<number, Crown>();
  const triCount = m.icount / 3;
  const W = VERTEX_WORDS;
  for (let t = 0; t < triCount; t++) {
    const v0 = m.idx[t * 3] * W;
    if ((m.u32[v0 + 6] & 0xff) === CM.leaves) {
      // Crown bounds per tree (leaf aux is the tree's hash).
      const aux = m.u32[v0 + 7];
      let c = crowns.get(aux);
      if (!c) {
        c = {
          lo: [Infinity, Infinity, Infinity],
          hi: [-Infinity, -Infinity, -Infinity],
          param: m.u32[v0 + 6] >>> 8,
          aux,
        };
        crowns.set(aux, c);
      }
      for (let k = 0; k < 3; k++) {
        const v = m.idx[t * 3 + k] * W;
        for (let j = 0; j < 3; j++) {
          c.lo[j] = Math.min(c.lo[j], m.f32[v + j]);
          c.hi[j] = Math.max(c.hi[j], m.f32[v + j]);
        }
      }
      continue;
    }
    if (!keep2(m, t)) continue;
    const ids = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const g = m.idx[t * 3 + k];
      let l = remap[g];
      if (l < 0) {
        l = out.vcount;
        out.copyVertex(m, g);
        remap[g] = l;
      }
      ids[k] = l;
    }
    out.tri(ids[0], ids[1], ids[2]);
  }
  for (const c of crowns.values()) crownBlob(out, c);
  return out;
}

/**
 * A tree crown as one opaque blob: a six-sided, two-ring closed ellipsoid
 * (24 triangles, single-sided) at 0.78 of the LOD1 crown's bounds (its
 * cards stick out past the shell, and the shell's leaf gaps make it read
 * smaller than its outline), in the leaf material with LEAF_SOLID
 * (opaque pipeline: no cutout, the leaf texture's mean tone). Normals are
 * the ellipsoid's, bent up like the LOD1 shell's.
 */
function crownBlob(m: CMesh, c: Crown) {
  const cx = (c.lo[0] + c.hi[0]) / 2;
  const cz = (c.lo[2] + c.hi[2]) / 2;
  const rx = ((c.hi[0] - c.lo[0]) / 2) * 0.78;
  const rz = ((c.hi[2] - c.lo[2]) / 2) * 0.78;
  const y0 = c.lo[1] + (c.hi[1] - c.lo[1]) * 0.06;
  const y1 = c.hi[1] - (c.hi[1] - c.lo[1]) * 0.04;
  const cy = (y0 + y1) / 2;
  const ry = (y1 - y0) / 2;
  const mat = packMat(CM.leaves, (c.param & 0xff) | LEAF_SOLID);
  const N = 6;
  const yaw = (c.aux & 0xff) / 40;
  const nrm = (x: number, y: number, z: number): [number, number, number] => {
    const l = Math.hypot(x, y + 0.3, z) || 1;
    return [x / l, (y + 0.3) / l, z / l];
  };
  const top = m.vertex([cx, y1, cz], [0, 1, 0], 0.5, 0.32, mat, c.aux);
  const bot = m.vertex([cx, y0, cz], nrm(0, -1, 0), 0.5, 0.68, mat, c.aux);
  const rings = [-0.42, 0.38].map((u, r) => {
    const s = Math.sqrt(1 - u * u);
    const out: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = yaw + ((i + r * 0.5) / N) * Math.PI * 2;
      const dx = Math.cos(a) * s,
        dz = Math.sin(a) * s;
      out.push(
        m.vertex(
          [cx + dx * rx, cy + u * ry, cz + dz * rz],
          nrm(dx, u, dz),
          i & 1 ? 0.68 : 0.32,
          r ? 0.32 : 0.68,
          mat,
          c.aux,
        ),
      );
    }
    return out;
  });
  const [lo, hi] = rings;
  const face = (a: number, b: number, d: number) => {
    // Outward: from the crown centre through the triangle's centroid.
    const A = m.pos(a),
      B = m.pos(b),
      D = m.pos(d);
    m.triFacing(a, b, d, [
      (A[0] + B[0] + D[0]) / 3 - cx,
      (A[1] + B[1] + D[1]) / 3 - cy,
      (A[2] + B[2] + D[2]) / 3 - cz,
    ]);
  };
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    face(top, hi[i], hi[j]);
    face(bot, lo[i], lo[j]);
    // Band between the staggered rings: two triangles per side.
    face(lo[i], lo[j], hi[i]);
    face(hi[i], lo[j], hi[j]);
  }
}
