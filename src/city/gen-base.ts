// Always-resident city geometry: road strips, junctions, bridges, sidewalk
// slabs, parks, elevated rail viaducts and expressways. Also produces the
// street light list and the land-use raster used by the terrain shader.

import {Rng, hash2} from '../math/random.ts';
import {
  dist2,
  lerp,
  pointInPolygon,
  type Vec2,
  type Vec3,
} from '../math/vec.ts';
import {CM, CMesh, packMat, triangulate} from './cmesh.ts';
import {
  LANES,
  ROAD_WIDTH,
  SIDEWALK,
  type CityLayout,
  type Elevated,
} from './layout.ts';
import {chainAt, computeRoadGeom, type RoadGeom} from './roadgeom.ts';
import {SEA_LEVEL, type Heightfield} from './terrain.ts';

export const LIGHT_FLOATS = 8;

/** Collects point lights: x, y, z, radius, r, g, b, kind. */
export class LightList {
  data: number[] = [];
  add(p: Vec3, radius: number, color: Vec3, kind: number) {
    this.data.push(
      p[0],
      p[1],
      p[2],
      radius,
      color[0],
      color[1],
      color[2],
      kind,
    );
  }
}

export const LightKind = {
  street: 0,
  sign: 1,
  vending: 2,
  station: 3,
  window: 4,
} as const;
export const SODIUM: Vec3 = [1.0, 0.55, 0.22];
export const LED: Vec3 = [1.0, 0.88, 0.72];

/** Road coverage raster (1 = road surface) on the heightfield grid. */
export function roadMask(L: CityLayout): Uint8Array {
  const hf = L.terrain.heights;
  const n = hf.n;
  const mask = new Uint8Array(n * n);
  const S = hf.size / 2;
  for (const c of L.chains) {
    const half = ROAD_WIDTH[c.kind] / 2 + 1;
    for (let i = 0; i + 1 < c.pts.length; i++) {
      const a = c.pts[i];
      const b = c.pts[i + 1];
      const len = dist2(a, b);
      const steps = Math.ceil(len / 2);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        const r = Math.ceil(half / hf.cell);
        const gx = Math.round((x + S) / hf.cell);
        const gz = Math.round((z + S) / hf.cell);
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const X = gx + dx,
              Z = gz + dz;
            if (X < 0 || Z < 0 || X >= n || Z >= n) continue;
            if (Math.hypot(X * hf.cell - S - x, Z * hf.cell - S - z) < half)
              mask[Z * n + X] = 1;
          }
        }
      }
    }
  }
  return mask;
}

/** Land use raster for the terrain shader: 0 natural, 1 urban, 2 park, 3 road. */
export function landUse(L: CityLayout, mask: Uint8Array): Uint8Array {
  const hf = L.terrain.heights;
  const n = hf.n;
  const S = hf.size / 2;
  const out = new Uint8Array(n * n);
  for (const b of L.blocks) {
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const q of b.curb) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      z0 = Math.min(z0, q[1]);
      z1 = Math.max(z1, q[1]);
    }
    for (
      let gz = Math.max(0, Math.floor((z0 + S) / hf.cell));
      gz <= Math.min(n - 1, Math.ceil((z1 + S) / hf.cell));
      gz++
    ) {
      for (
        let gx = Math.max(0, Math.floor((x0 + S) / hf.cell));
        gx <= Math.min(n - 1, Math.ceil((x1 + S) / hf.cell));
        gx++
      ) {
        if (pointInPolygon([gx * hf.cell - S, gz * hf.cell - S], b.curb))
          out[gz * n + gx] = b.park ? 2 : 1;
      }
    }
  }
  for (let i = 0; i < n * n; i++) if (mask[i]) out[i] = 3;
  return out;
}

const UP: Vec3 = [0, 1, 0];

/** Emit a strip between left/right polylines, facing up. */
function strip(
  m: CMesh,
  left: Vec3[],
  right: Vec3[],
  uvL: Vec2[],
  uvR: Vec2[],
  mat: number,
  aux = 0,
) {
  let pl = m.vertex(left[0], UP, uvL[0][0], uvL[0][1], mat, aux);
  let pr = m.vertex(right[0], UP, uvR[0][0], uvR[0][1], mat, aux);
  for (let i = 1; i < left.length; i++) {
    const l = m.vertex(left[i], UP, uvL[i][0], uvL[i][1], mat, aux);
    const r = m.vertex(right[i], UP, uvR[i][0], uvR[i][1], mat, aux);
    m.triFacing(pl, pr, r, UP);
    m.triFacing(pl, r, l, UP);
    pl = l;
    pr = r;
  }
}

/** Offset a polyline sideways with mitered joins. */
function offsetLine(pts: Vec2[], off: number): Vec2[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    let scale = 1;
    if (i > 0 && i < n - 1) {
      const d0x = p[0] - a[0],
        d0z = p[1] - a[1];
      const l0 = Math.hypot(d0x, d0z) || 1;
      const cos = (d0x / l0) * dx + (d0z / l0) * dz;
      scale = 1 / Math.max(0.5, Math.sqrt((1 + cos) / 2));
    }
    return [p[0] - dz * off * scale, p[1] + dx * off * scale];
  });
}

function roads(
  L: CityLayout,
  geom: RoadGeom,
  m: CMesh,
  lights: LightList,
  piers: CMesh,
) {
  const hf = L.terrain.heights;
  L.chains.forEach((c, ci) => {
    const [s0, s1] = geom.setbacks[ci];
    const arc = geom.arc[ci];
    const total = arc[arc.length - 1];
    const len = total - s0 - s1;
    if (len < 0.5) return;
    // Resample between the setbacks.
    const pts: Vec2[] = [];
    const hs: number[] = [];
    const along: number[] = [];
    const step = 6;
    const k = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i <= k; i++) {
      const s = s0 + (len * i) / k;
      const q = chainAt(c, arc, s);
      pts.push(q.p);
      hs.push(q.h + 0.02);
      along.push(s - s0);
    }
    const w = ROAD_WIDTH[c.kind];
    const left = offsetLine(pts, w / 2);
    const right = offsetLine(pts, -w / 2);
    const startSignal = s0 > 2;
    const endSignal = s1 > 2;
    const param =
      (c.kind & 3) |
      (startSignal ? 4 : 0) |
      (endSignal ? 8 : 0) |
      (Math.min(65535, Math.round(len)) << 4);
    const mat = packMat(CM.road, param);
    strip(
      m,
      left.map((q, i) => [q[0], hs[i], q[1]] as Vec3),
      right.map((q, i) => [q[0], hs[i], q[1]] as Vec3),
      along.map(a => [w / 2, a] as Vec2),
      along.map(a => [-w / 2, a] as Vec2),
      mat,
      LANES[c.kind],
    );
    // Bridge deck structure where the road is well above the ground.
    const elevated = pts.map(
      (q, i) => hs[i] - Math.max(hf.sample(q[0], q[1]), SEA_LEVEL) > 2.5,
    );
    if (elevated.some(e => e)) {
      for (let i = 0; i + 1 < pts.length; i++) {
        if (!elevated[i] && !elevated[i + 1]) continue;
        const depth = 1.4;
        const L0: Vec3 = [left[i][0], hs[i], left[i][1]];
        const L1: Vec3 = [left[i + 1][0], hs[i + 1], left[i + 1][1]];
        const R0: Vec3 = [right[i][0], hs[i], right[i][1]];
        const R1: Vec3 = [right[i + 1][0], hs[i + 1], right[i + 1][1]];
        const dn = (p: Vec3, d: number): Vec3 => [p[0], p[1] - d, p[2]];
        const nl: Vec3 = [left[i][0] - pts[i][0], 0, left[i][1] - pts[i][1]];
        const nr: Vec3 = [-nl[0], 0, -nl[2]];
        const cm = packMat(CM.concrete);
        m.quad(
          [L0, L1, dn(L1, depth), dn(L0, depth)],
          norm(nl),
          [
            [0, 0],
            [6, 0],
            [6, depth],
            [0, depth],
          ],
          cm,
        );
        m.quad(
          [R0, R1, dn(R1, depth), dn(R0, depth)],
          norm(nr),
          [
            [0, 0],
            [6, 0],
            [6, depth],
            [0, depth],
          ],
          cm,
        );
        m.quad(
          [dn(L0, depth), dn(L1, depth), dn(R1, depth), dn(R0, depth)],
          [0, -1, 0],
          [
            [0, 0],
            [6, 0],
            [6, w],
            [0, w],
          ],
          cm,
        );
        // Parapets / railings.
        for (const [a, b] of [
          [L0, L1],
          [R0, R1],
        ]) {
          m.beam(
            [a[0], a[1] + 0.5, a[2]],
            [b[0], b[1] + 0.5, b[2]],
            0.2,
            0.5,
            packMat(CM.concrete),
          );
          m.beam(
            [a[0], a[1] + 1.1, a[2]],
            [b[0], b[1] + 1.1, b[2]],
            0.05,
            0.05,
            packMat(CM.paint, 0x80),
          );
        }
      }
      // Piers.
      let lastPier = -100;
      for (let i = 0; i < pts.length; i++) {
        if (!elevated[i] || along[i] - lastPier < 35) continue;
        lastPier = along[i];
        const ground = hf.sample(pts[i][0], pts[i][1]);
        const top = hs[i] - 1.4;
        const bottom = Math.min(ground, SEA_LEVEL) - 3;
        piers.cylinder(
          [pts[i][0], bottom, pts[i][1]],
          1.3,
          top - bottom,
          10,
          packMat(CM.concrete),
          false,
        );
      }
      // Long crossings become suspension bridges: two towers, main cables, hangers.
      const wetIdx = pts
        .map((q, i) => (hf.sample(q[0], q[1]) < SEA_LEVEL ? i : -1))
        .filter(i => i >= 0);
      if (
        wetIdx.length &&
        along[wetIdx[wetIdx.length - 1]] - along[wetIdx[0]] > 400
      ) {
        const a0 = along[wetIdx[0]];
        const a1 = along[wetIdx[wetIdx.length - 1]];
        const span = a1 - a0;
        const towerAt = [a0 + span * 0.2, a0 + span * 0.8];
        const idxAt = (s: number) => along.findIndex(a => a >= s);
        const towerH = 70 + span * 0.04;
        const tops: Vec3[][] = [];
        for (const ta of towerAt) {
          const i = Math.max(0, idxAt(ta));
          const sides: Vec3[] = [];
          for (const side of [left, right]) {
            const q = side[i];
            const base = Math.min(hf.sample(q[0], q[1]), SEA_LEVEL) - 4;
            const off: Vec2 = [q[0] - pts[i][0], q[1] - pts[i][1]];
            const ol = Math.hypot(off[0], off[1]) || 1;
            const tx = q[0] + (off[0] / ol) * 2.5;
            const tz = q[1] + (off[1] / ol) * 2.5;
            piers.box(
              [tx, (base + hs[i] + towerH) / 2, tz],
              [2.2, (hs[i] + towerH - base) / 2, 3],
              packMat(CM.concrete),
            );
            sides.push([tx, hs[i] + towerH, tz]);
          }
          // Cross beams.
          piers.beam(
            [sides[0][0], hs[i] + towerH * 0.95, sides[0][2]],
            [sides[1][0], hs[i] + towerH * 0.95, sides[1][2]],
            1.6,
            1.6,
            packMat(CM.concrete),
          );
          piers.beam(
            [sides[0][0], hs[i] + towerH * 0.5, sides[0][2]],
            [sides[1][0], hs[i] + towerH * 0.5, sides[1][2]],
            1.4,
            1.4,
            packMat(CM.concrete),
          );
          tops.push(sides);
          lights.add(
            [sides[0][0], sides[0][1] + 1, sides[0][2]],
            30,
            [1, 0.1, 0.05],
            LightKind.station,
          );
        }
        // Main cables: parabola between towers, and side spans down to the deck.
        for (let side = 0; side < 2; side++) {
          const sideLine = side === 0 ? left : right;
          const sStart = Math.max(0, towerAt[0] - span * 0.2);
          const sEnd = Math.min(
            along[along.length - 1],
            towerAt[1] + span * 0.2,
          );
          const cable = (s: number): Vec3 => {
            const i = Math.max(
              0,
              Math.min(
                pts.length - 1,
                idxAt(s) < 0 ? pts.length - 1 : idxAt(s),
              ),
            );
            const q = sideLine[i];
            const off: Vec2 = [q[0] - pts[i][0], q[1] - pts[i][1]];
            const ol = Math.hypot(off[0], off[1]) || 1;
            let y: number;
            if (s < towerAt[0])
              y = lerp(
                hs[i] + 1,
                hs[i] + towerH,
                (s - sStart) / Math.max(1, towerAt[0] - sStart),
              );
            else if (s > towerAt[1])
              y = lerp(
                hs[i] + towerH,
                hs[i] + 1,
                (s - towerAt[1]) / Math.max(1, sEnd - towerAt[1]),
              );
            else {
              const t = (s - towerAt[0]) / (towerAt[1] - towerAt[0]);
              y = hs[i] + 4 + (towerH - 4) * Math.pow(2 * t - 1, 2);
            }
            return [
              q[0] + (off[0] / ol) * 2.5,
              Math.max(y, hs[i] + 1),
              q[1] + (off[1] / ol) * 2.5,
            ];
          };
          let prev = cable(sStart);
          for (let s = sStart + 12; s <= sEnd; s += 12) {
            const c = cable(s);
            piers.beam(prev, c, 0.35, 0.35, packMat(CM.metal));
            const i = Math.max(0, idxAt(s));
            if (s > towerAt[0] && s < towerAt[1] && c[1] - hs[i] > 2)
              piers.beam(
                [c[0], hs[i] + 1, c[2]],
                c,
                0.06,
                0.06,
                packMat(CM.metal),
              );
            prev = c;
          }
        }
        void tops;
      }
      // Bridge lights.
      for (let i = 0; i < pts.length; i += 6) {
        if (!elevated[i]) continue;
        for (const side of [left, right]) {
          const q = side[i];
          const base: Vec3 = [q[0], hs[i], q[1]];
          m.cylinder(base, 0.08, 9, 5, packMat(CM.metal), false);
          m.box([q[0], hs[i] + 9, q[1]], [0.3, 0.12, 0.3], packMat(CM.lamp, 1));
          lights.add([q[0], hs[i] + 8.5, q[1]], 26, LED, LightKind.street);
        }
      }
    }
  });
  // Junction surfaces.
  geom.junctions.forEach((jg, ji) => {
    const j = L.junctions[ji];
    if (jg.outline.length < 3) return;
    const h = j.h + 0.02;
    const mat = packMat(CM.asphaltPlain);
    const center = m.vertex([j.p[0], h, j.p[1]], UP, j.p[0], j.p[1], mat);
    const ring = jg.outline.map(q =>
      m.vertex([q[0], h, q[1]], UP, q[0], q[1], mat),
    );
    for (let i = 0; i < ring.length; i++)
      m.triFacing(center, ring[i], ring[(i + 1) % ring.length], UP);
  });
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Subdivide a triangle list until edges are short, so slabs follow terrain. */
function subdivide(tris: Vec2[][], maxEdge: number): Vec2[][] {
  const out: Vec2[][] = [];
  const stack = tris.slice();
  while (stack.length) {
    const t = stack.pop()!;
    const e = [dist2(t[0], t[1]), dist2(t[1], t[2]), dist2(t[2], t[0])];
    const m = Math.max(...e);
    if (m <= maxEdge || out.length > 200000) {
      out.push(t);
      continue;
    }
    const i = e.indexOf(m);
    const a = t[i],
      b = t[(i + 1) % 3],
      c = t[(i + 2) % 3];
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    stack.push([a, mid, c], [mid, b, c]);
  }
  return out;
}

function blocks(L: CityLayout, m: CMesh) {
  const hf = L.terrain.heights;
  for (const b of L.blocks) {
    const poly = b.curb;
    const idx = triangulate(poly);
    const tris: Vec2[][] = [];
    for (let i = 0; i < idx.length; i += 3)
      tris.push([poly[idx[i]], poly[idx[i + 1]], poly[idx[i + 2]]]);
    const fine = subdivide(tris, b.park ? 10 : 9);
    const mat = packMat(b.park ? CM.grass : CM.sidewalk);
    const lift = 0.16;
    const cache = new Map<string, number>();
    const vid = (q: Vec2) => {
      const k = `${q[0].toFixed(2)},${q[1].toFixed(2)}`;
      let v = cache.get(k);
      if (v === undefined) {
        v = m.vertex(
          [q[0], hf.sample(q[0], q[1]) + lift, q[1]],
          UP,
          q[0],
          q[1],
          mat,
        );
        cache.set(k, v);
      }
      return v;
    };
    for (const t of fine) m.triFacing(vid(t[0]), vid(t[1]), vid(t[2]), UP);
    // Curb faces around the edge (subdivided to follow the road).
    const cm = packMat(CM.curb);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const c = poly[(i + 1) % poly.length];
      const len = dist2(a, c);
      const k = Math.max(1, Math.ceil(len / 9));
      const out: Vec3 = norm([c[1] - a[1], 0, -(c[0] - a[0])]);
      for (let s = 0; s < k; s++) {
        const p0: Vec2 = [lerp(a[0], c[0], s / k), lerp(a[1], c[1], s / k)];
        const p1: Vec2 = [
          lerp(a[0], c[0], (s + 1) / k),
          lerp(a[1], c[1], (s + 1) / k),
        ];
        const h0 = hf.sample(p0[0], p0[1]);
        const h1 = hf.sample(p1[0], p1[1]);
        m.quad(
          [
            [p0[0], h0 - 0.3, p0[1]],
            [p1[0], h1 - 0.3, p1[1]],
            [p1[0], h1 + lift, p1[1]],
            [p0[0], h0 + lift, p0[1]],
          ],
          out,
          [
            [0, 0],
            [len / k, 0],
            [len / k, lift + 0.3],
            [0, lift + 0.3],
          ],
          cm,
        );
      }
    }
  }
}

function frames(pts: Vec2[]) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const l = dist2(a, b) || 1;
    const d: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    return {d, l: [-d[1], d[0]] as Vec2};
  });
}

function elevatedStructures(
  L: CityLayout,
  mask: Uint8Array,
  m: CMesh,
  lights: LightList,
) {
  const hf = L.terrain.heights;
  const onRoad = (q: Vec2) => {
    const S = hf.size / 2;
    const gx = Math.round((q[0] + S) / hf.cell);
    const gz = Math.round((q[1] + S) / hf.cell);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (mask[(gz + dz) * hf.n + gx + dx]) return true;
    return false;
  };
  for (const e of L.elevated) {
    if (e.kind === 'rail') railViaduct(e, hf, onRoad, m, lights);
    else expressway(e, hf, m, lights);
  }
}

function deckBox(
  m: CMesh,
  pts: Vec2[],
  hs: number[],
  halfW: number,
  depth: number,
  topMat: number,
  sideMat: number,
  topU: (i: number) => number,
  closed: boolean,
) {
  const fr = frames(pts);
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const P = (k: number, side: number, dy: number): Vec3 => [
      pts[k][0] + fr[k].l[0] * halfW * side,
      hs[k] + dy,
      pts[k][1] + fr[k].l[1] * halfW * side,
    ];
    const u0 = topU(i),
      u1 = topU(i) + dist2(pts[i], pts[j]);
    m.quad(
      [P(i, -1, 0), P(j, -1, 0), P(j, 1, 0), P(i, 1, 0)],
      UP,
      [
        [-halfW, u0],
        [-halfW, u1],
        [halfW, u1],
        [halfW, u0],
      ],
      topMat,
    );
    const nl: Vec3 = [fr[i].l[0], 0, fr[i].l[1]];
    m.quad(
      [P(i, 1, 0), P(j, 1, 0), P(j, 1, -depth), P(i, 1, -depth)],
      nl,
      [
        [u0, 0],
        [u1, 0],
        [u1, depth],
        [u0, depth],
      ],
      sideMat,
    );
    m.quad(
      [P(i, -1, 0), P(j, -1, 0), P(j, -1, -depth), P(i, -1, -depth)],
      [-nl[0], 0, -nl[2]],
      [
        [u0, 0],
        [u1, 0],
        [u1, depth],
        [u0, depth],
      ],
      sideMat,
    );
    m.quad(
      [P(i, -1, -depth), P(j, -1, -depth), P(j, 1, -depth), P(i, 1, -depth)],
      [0, -1, 0],
      [
        [u0, 0],
        [u1, 0],
        [u1, 1],
        [u0, 1],
      ],
      sideMat,
    );
    // Longitudinal girders under the slab, with cross diaphragms every
    // ~12 m, so the underside reads as a structure rather than a flat sheet.
    for (const g of [-0.62, 0, 0.62]) {
      const a = P(i, g, -depth - 0.55);
      const b = P(j, g, -depth - 0.55);
      m.beam(a, b, 0.32, 0.55, sideMat);
    }
    if (i % 3 === 0) {
      m.beam(
        P(i, -0.62, -depth - 0.4),
        P(i, 0.62, -depth - 0.4),
        0.18,
        0.4,
        sideMat,
      );
    }
  }
}

function railViaduct(
  e: Elevated,
  hf: Heightfield,
  onRoad: (q: Vec2) => boolean,
  m: CMesh,
  lights: LightList,
) {
  const pts = e.pts;
  const hs = e.heights;
  const n = pts.length;
  const fr = frames(pts);
  const along: number[] = [0];
  for (let i = 1; i < n; i++)
    along.push(along[i - 1] + dist2(pts[i - 1], pts[i]));
  const halfW = 5.2;
  deckBox(
    m,
    pts,
    hs,
    halfW,
    2.2,
    packMat(CM.rail),
    packMat(CM.concrete),
    i => along[i],
    e.loop,
  );
  const segs = e.loop ? n : n - 1;
  const P = (k: number, off: number, dy: number): Vec3 => [
    pts[k][0] + fr[k].l[0] * off,
    hs[k] + dy,
    pts[k][1] + fr[k].l[1] * off,
  ];
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    // Parapets.
    for (const side of [-1, 1]) {
      m.beam(
        P(i, side * (halfW - 0.15), 0.55),
        P(j, side * (halfW - 0.15), 0.55),
        0.15,
        0.55,
        packMat(CM.concrete),
      );
    }
    // Rails for two tracks.
    for (const track of [-2.1, 2.1]) {
      for (const r of [-0.53, 0.53]) {
        m.beam(
          P(i, track + r, 0.12),
          P(j, track + r, 0.12),
          0.04,
          0.08,
          packMat(CM.metal),
        );
      }
      // Overhead contact wire.
      m.beam(
        P(i, track, 5.4),
        P(j, track, 5.4),
        0.015,
        0.015,
        packMat(CM.wire),
      );
    }
  }
  // Piers and catenary masts.
  let lastPier = -100;
  let lastMast = -100;
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    const ground = hf.sample(q[0], q[1]);
    if (along[i] - lastPier > 22 && !onRoad(q)) {
      lastPier = along[i];
      const top = hs[i] - 2.2;
      const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
      const h = top - (ground - 1);
      if (h > 0.5) {
        m.box(
          [q[0], ground - 1 + h / 2, q[1]],
          [1.1, h / 2, 1.1],
          packMat(CM.concrete),
          yaw,
        );
        m.box(
          [q[0], top - 0.6, q[1]],
          [halfW * 0.9, 0.6, 1.3],
          packMat(CM.concrete),
          yaw,
        );
      }
    }
    if (along[i] - lastMast > 45) {
      lastMast = along[i];
      for (const side of [-1, 1]) {
        const b = P(i, side * (halfW - 0.4), 0);
        m.box([b[0], b[1] + 3.3, b[2]], [0.12, 3.3, 0.12], packMat(CM.metal));
      }
      m.beam(
        P(i, -(halfW - 0.4), 6.4),
        P(i, halfW - 0.4, 6.4),
        0.08,
        0.12,
        packMat(CM.metal),
      );
    }
  }
  // Stations: side platforms with canopies.
  for (const si of e.stations) {
    const i0 = Math.max(0, si - 7);
    const i1 = Math.min(n - 1, si + 7);
    for (const side of [-1, 1]) {
      for (let i = i0; i < i1; i++) {
        const a0 = P(i, side * halfW, 0);
        const a1 = P(i + 1, side * halfW, 0);
        const b0 = P(i, side * (halfW + 4.5), 0);
        const b1 = P(i + 1, side * (halfW + 4.5), 0);
        const out: Vec3 = [fr[i].l[0] * side, 0, fr[i].l[1] * side];
        m.quad(
          [a0, a1, b1, b0],
          UP,
          [
            [0, 0],
            [12, 0],
            [12, 4.5],
            [0, 4.5],
          ],
          packMat(CM.sidewalk),
        );
        m.quad(
          [b0, b1, [b1[0], b1[1] - 1.2, b1[2]], [b0[0], b0[1] - 1.2, b0[2]]],
          out,
          [
            [0, 0],
            [12, 0],
            [12, 1.2],
            [0, 1.2],
          ],
          packMat(CM.concrete),
        );
        // Canopy roof.
        const r0 = P(i, side * (halfW + 0.5), 4.2),
          r1 = P(i + 1, side * (halfW + 0.5), 4.2);
        const r2 = P(i + 1, side * (halfW + 4.8), 4.6),
          r3 = P(i, side * (halfW + 4.8), 4.6);
        m.quad(
          [r0, r1, r2, r3],
          UP,
          [
            [0, 0],
            [12, 0],
            [12, 4],
            [0, 4],
          ],
          packMat(CM.paint, 0xd0) /* light grey steel canopy */,
        );
        m.quad(
          [r0, r1, r2, r3],
          [0, -1, 0],
          [
            [0, 0],
            [12, 0],
            [12, 4],
            [0, 4],
          ],
          packMat(CM.metal),
        );
        if (i % 2 === 0) {
          const post = P(i, side * (halfW + 2.7), 0);
          m.box(
            [post[0], post[1] + 2.2, post[2]],
            [0.12, 2.2, 0.12],
            packMat(CM.metal),
          );
          lights.add(
            [post[0], post[1] + 3.8, post[2]],
            14,
            LED,
            LightKind.station,
          );
          m.box(
            [post[0], post[1] + 4.0, post[2]],
            [0.6, 0.05, 0.15],
            packMat(CM.lamp, 1),
          );
        }
        // Platform edge back wall / fence.
        const f0 = P(i, side * (halfW + 4.4), 0),
          f1 = P(i + 1, side * (halfW + 4.4), 0);
        m.beam(
          [f0[0], f0[1] + 0.6, f0[2]],
          [f1[0], f1[1] + 0.6, f1[2]],
          0.05,
          0.6,
          packMat(CM.paint, 0x60),
        );
      }
      // Station signboard.
      const sgn = P(si, side * (halfW + 2.7), 3.2);
      const yaw = Math.atan2(fr[si].d[0], fr[si].d[1]);
      m.box(sgn, [1.6, 0.35, 0.06], packMat(CM.sign, 64 + (si % 8)), yaw);
    }
    // Stairs block down to the street.
    const q = P(si, halfW + 7, 0);
    const ground = hf.sample(q[0], q[1]);
    const h = hs[si] - ground;
    const yaw = Math.atan2(fr[si].d[0], fr[si].d[1]);
    if (h > 1)
      m.box(
        [q[0], ground + h / 2, q[2]],
        [2.5, h / 2, 6],
        packMat(CM.facade, 0x3a000 | (si & 0xfff)),
        yaw,
      );
  }
}

function expressway(e: Elevated, hf: Heightfield, m: CMesh, lights: LightList) {
  const pts = e.pts;
  const n = pts.length;
  const fr = frames(pts);
  const along: number[] = [0];
  for (let i = 1; i < n; i++)
    along.push(along[i - 1] + dist2(pts[i - 1], pts[i]));
  // Fully elevated: ramps down onto the boulevard would cover its lanes.
  const total = along[n - 1];
  const hs = e.heights.slice();
  const halfW = 9;
  const len = Math.round(total);
  deckBox(
    m,
    pts,
    hs,
    halfW,
    2.0,
    packMat(CM.road, 3 | (Math.min(65535, len) << 4)),
    packMat(CM.concrete),
    i => along[i],
    false,
  );
  const P = (k: number, off: number, dy: number): Vec3 => [
    pts[k][0] + fr[k].l[0] * off,
    hs[k] + dy,
    pts[k][1] + fr[k].l[1] * off,
  ];
  for (let i = 0; i + 1 < n; i++) {
    for (const side of [-1, 1]) {
      m.beam(
        P(i, side * (halfW - 0.2), 0.5),
        P(i + 1, side * (halfW - 0.2), 0.5),
        0.2,
        0.5,
        packMat(CM.concrete),
      );
      // Sound wall panels on top of the barrier.
      m.beam(
        P(i, side * (halfW - 0.2), 2.2),
        P(i + 1, side * (halfW - 0.2), 2.2),
        0.05,
        1.2,
        packMat(CM.paint, 0x40),
      );
    }
  }
  // Termini: the deck ends at a crash wall with a yellow attenuator, carried
  // by an end pier, instead of stopping in mid-air.
  for (const k of [0, n - 1]) {
    const inward = k === 0 ? 1 : -1;
    const d = fr[k].d;
    const yaw = Math.atan2(d[0], d[1]);
    const q = pts[k];
    const ground = hf.sample(q[0], q[1]);
    const c = P(k, 0, 0);
    m.box(
      [c[0], c[1] + 0.9, c[2]],
      [halfW, 1.1, 0.25],
      packMat(CM.concrete),
      yaw,
    );
    const a: Vec3 = [
      c[0] + d[0] * inward * 1.6,
      c[1] + 0.5,
      c[2] + d[1] * inward * 1.6,
    ];
    m.box(a, [halfW * 0.35, 0.5, 1.2], packMat(CM.paint, 0x92), yaw);
    m.box(
      [c[0], (ground + hs[k] - 2) / 2, c[2]],
      [halfW * 0.6, (hs[k] - 2 - ground) / 2 + 0.5, 1.0],
      packMat(CM.concrete),
      yaw,
    );
  }
  let lastPier = -100;
  let lastLight = -100;
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    const ground = hf.sample(q[0], q[1]);
    const top = hs[i] - 2;
    if (along[i] - lastPier > 32 && top - ground > 3) {
      lastPier = along[i];
      m.cylinder(
        [q[0], ground - 1, q[1]],
        1.5,
        top - ground + 1,
        12,
        packMat(CM.concrete),
        false,
      );
      const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
      m.box(
        [q[0], top - 0.8, q[1]],
        [halfW * 0.8, 0.8, 1.4],
        packMat(CM.concrete),
        yaw,
      );
    }
    if (along[i] - lastLight > 40 && hs[i] - ground > 3) {
      lastLight = along[i];
      const b = P(i, 0, 0);
      m.box([b[0], b[1] + 0.5, b[2]], [0.3, 0.5, 0.3], packMat(CM.concrete));
      m.box([b[0], b[1] + 5, b[2]], [0.08, 4.5, 0.08], packMat(CM.metal));
      for (const side of [-1, 1]) {
        const l = P(i, side * 2.5, 9.4);
        m.beam([b[0], b[1] + 9.4, b[2]], l, 0.06, 0.06, packMat(CM.metal));
        m.box(l, [0.35, 0.1, 0.2], packMat(CM.lamp, 0));
        lights.add([l[0], l[1] - 0.5, l[2]], 30, SODIUM, LightKind.street);
      }
    }
  }
}

/**
 * Outskirts: the city continues past the generated world as low-detail
 * buildings (an HLOD skyline) so the horizon reads as an endless metropolis.
 */
function outskirts(L: CityLayout, m: CMesh) {
  const hf = L.terrain.heights;
  const S = L.params.size / 2;
  const band = 3600;
  const cell = 75;
  const rng = new Rng(L.seed ^ 0x51ced);
  for (let z = -S - band; z < S + band; z += cell) {
    for (let x = -S - band; x < S + band; x += cell) {
      const dOut = Math.max(Math.abs(x), Math.abs(z)) - S;
      if (dOut < 60) continue;
      const ex = Math.max(-S, Math.min(S, x));
      const ez = Math.max(-S, Math.min(S, z));
      const ground = hf.sample(ex, ez);
      if (ground < 1) continue;
      if (rng.next() > 0.9 * Math.exp(-dOut / 2600)) continue;
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) {
        const w = rng.range(14, 34);
        const d = rng.range(14, 34);
        const h = Math.min(160, rng.range(9, 40) * (rng.chance(0.08) ? 3 : 1));
        const cx = x + rng.range(w / 2, cell - w / 2);
        const cz = z + rng.range(d / 2, cell - d / 2);
        const style = rng.int(0, 1 << 16);
        m.box(
          [cx, ground + h / 2 - 2, cz],
          [w / 2, h / 2 + 2, d / 2],
          packMat(CM.facade, style | (2 << 16)),
          0,
          rng.nextU32(),
        );
      }
    }
  }
}

export interface BaseGeometry {
  mesh: CMesh;
  piers: CMesh;
  lights: number[];
  landUse: Uint8Array;
  roadMask: Uint8Array;
  geom: RoadGeom;
}

export function buildBase(L: CityLayout): BaseGeometry {
  const m = new CMesh(1 << 18, 1 << 19);
  const piers = new CMesh(1 << 12, 1 << 13);
  const lights = new LightList();
  const geom = computeRoadGeom(L);
  const mask = roadMask(L);
  roads(L, geom, m, lights, piers);
  blocks(L, m);
  elevatedStructures(L, mask, m, lights);
  streetLights(L, geom, lights);
  outskirts(L, m);
  return {
    mesh: m,
    piers,
    lights: lights.data,
    landUse: landUse(L, mask),
    roadMask: mask,
    geom,
  };
}

/** Street light positions (the poles themselves are props in detail tiles). */
export function streetLightSpots(
  L: CityLayout,
  geom: RoadGeom,
  cb: (p: Vec3, dir: Vec2, kind: number, sodium: boolean) => void,
) {
  L.chains.forEach((c, ci) => {
    if (c.bridge.some(b => b)) return;
    const arc = geom.arc[ci];
    const total = arc[arc.length - 1];
    const [s0, s1] = geom.setbacks[ci];
    const spacing = c.kind >= 2 ? 30 : 34;
    const sodium = c.kind >= 3 || hash2(ci, 77) % 6 === 0;
    const sides = c.kind >= 2 ? [-1, 1] : [hash2(ci, 5) % 2 ? 1 : -1];
    for (const side of sides) {
      for (
        let s = s0 + 6 + (side > 0 ? spacing / 2 : 0);
        s < total - s1 - 6;
        s += spacing
      ) {
        const q = chainAt(c, arc, s);
        const off =
          (ROAD_WIDTH[c.kind] / 2 + Math.min(0.8, SIDEWALK[c.kind] * 0.4)) *
          side;
        const l: Vec2 = [-q.d[1], q.d[0]];
        const p: Vec3 = [q.p[0] + l[0] * off, q.h, q.p[1] + l[1] * off];
        cb(p, [-l[0] * side, -l[1] * side], c.kind, sodium);
      }
    }
  });
}

function streetLights(L: CityLayout, geom: RoadGeom, lights: LightList) {
  streetLightSpots(L, geom, (p, dir, kind, sodium) => {
    const reach = kind >= 2 ? 2.2 : 1.2;
    const h = kind >= 2 ? 9 : 6.5;
    lights.add(
      [p[0] + dir[0] * reach, p[1] + h - 0.4, p[2] + dir[1] * reach],
      kind >= 2 ? 20 : 14,
      sodium ? SODIUM : LED,
      LightKind.street,
    );
  });
}

export {Rng};
