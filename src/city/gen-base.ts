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
  closestOnPolyline,
  elevatedHalfWidth,
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

/**
 * Road coverage raster (1 = road surface) on the heightfield grid. `visible`
 * leaves out chains hidden by the asset lab.
 */
export function roadMask(L: CityLayout, visible = false): Uint8Array {
  const hf = L.terrain.heights;
  const n = hf.n;
  const mask = new Uint8Array(n * n);
  const S = hf.size / 2;
  for (const [ci, c] of L.chains.entries()) {
    if (visible && L.hidden?.chains[ci]) continue;
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

/**
 * Land use raster for the terrain shader: 0 natural, 1 urban, 2 park, 3 road.
 * Blocks and roads hidden by the asset lab (`visible` = their road mask
 * without hidden chains) become plain urban ground.
 */
export function landUse(
  L: CityLayout,
  mask: Uint8Array,
  visible?: Uint8Array,
): Uint8Array {
  const hf = L.terrain.heights;
  const n = hf.n;
  const S = hf.size / 2;
  // In the asset lab everything outside the shown asset is bare urban
  // ground (a neutral backdrop rather than patches of grass).
  const out = new Uint8Array(n * n).fill(visible ? 1 : 0);
  for (const [bi, b] of L.blocks.entries()) {
    const use = L.hidden?.blocks[bi] ? 1 : b.park ? 2 : 1;
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
          out[gz * n + gx] = use;
      }
    }
  }
  for (let i = 0; i < n * n; i++)
    if (mask[i]) out[i] = visible && !visible[i] ? 1 : 3;
  // Where a road crosses open land (no block beside it), pull the road paint
  // back one cell so the terrain's asphalt-to-grass blend happens under the
  // road strip, not as dark sawteeth on the verge (the mask reaches 1 m past
  // the road edge and the terrain interpolates per cell).
  const erode: number[] = [];
  for (let z = 1; z < n - 1; z++) {
    for (let x = 1; x < n - 1; x++) {
      const i = z * n + x;
      if (out[i] !== 3) continue;
      if (
        out[i - 1] === 0 ||
        out[i + 1] === 0 ||
        out[i - n] === 0 ||
        out[i + n] === 0 ||
        out[i - n - 1] === 0 ||
        out[i - n + 1] === 0 ||
        out[i + n - 1] === 0 ||
        out[i + n + 1] === 0
      )
        erode.push(i);
    }
  }
  for (const i of erode) out[i] = 0;
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
    if (L.hidden?.chains[ci]) return;
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
    if (jg.outline.length < 3 || L.hidden?.junctions[ji]) return;
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
  for (const [bi, b] of L.blocks.entries()) {
    if (L.hidden?.blocks[bi]) continue;
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
    // Lawns and car parks laid over the paving (a few cm proud of it), as
    // terrain-following grids; uv is the fill frame (stall pattern space).
    for (const f of b.fill ?? []) {
      const fmat = packMat(f.kind === 'parking' ? CM.carPark : CM.grass);
      const V: Vec2 = [-f.u[1], f.u[0]];
      const P = (u: number, v: number): Vec2 => [
        f.o[0] + f.u[0] * u + V[0] * v,
        f.o[1] + f.u[1] * u + V[1] * v,
      ];
      for (const r of f.rects) {
        const nu = Math.max(1, Math.ceil((r[2] - r[0]) / 7.5));
        const nv = Math.max(1, Math.ceil((r[3] - r[1]) / 7.5));
        const ids: number[] = [];
        for (let j = 0; j <= nv; j++) {
          for (let i = 0; i <= nu; i++) {
            const u = lerp(r[0], r[2], i / nu);
            const v = lerp(r[1], r[3], j / nv);
            const q = P(u, v);
            ids.push(
              m.vertex(
                [q[0], hf.sample(q[0], q[1]) + lift + 0.05, q[1]],
                UP,
                u,
                v,
                fmat,
              ),
            );
          }
        }
        for (let j = 0; j < nv; j++) {
          for (let i = 0; i < nu; i++) {
            const a = ids[j * (nu + 1) + i];
            const c = ids[(j + 1) * (nu + 1) + i + 1];
            m.triFacing(a, ids[j * (nu + 1) + i + 1], c, UP);
            m.triFacing(a, c, ids[(j + 1) * (nu + 1) + i], UP);
          }
        }
      }
    }
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
  solid: Solid,
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
  // A pier that would stand on a lower elevated deck becomes a portal frame
  // straddling that deck.
  const pier: Pier = (self, q, top, width, fallback) => {
    for (const o of L.elevated) {
      if (o === self) continue;
      const c = closestOnPolyline(o.pts, q);
      const hw = elevatedHalfWidth(o);
      if (c.d > hw + width + 0.5) continue;
      const a = o.pts[c.i];
      const b = o.pts[c.i + 1];
      if (lerp(o.heights[c.i], o.heights[c.i + 1], c.t) > top) continue;
      const len = dist2(a, b) || 1;
      const nx = -(b[1] - a[1]) / len;
      const nz = (b[0] - a[0]) / len;
      const mid: Vec2 = [lerp(a[0], b[0], c.t), lerp(a[1], b[1], c.t)];
      const span = hw + 1.6;
      const legs = [-1, 1].map(
        s => [mid[0] + nx * span * s, mid[1] + nz * span * s] as Vec2,
      );
      for (const g of legs) {
        const ground = hf.sample(g[0], g[1]);
        m.box(
          [g[0], (ground - 1 + top) / 2, g[1]],
          [0.9, (top - ground + 1) / 2, 0.9],
          packMat(CM.concrete),
          Math.atan2(nx, nz),
        );
      }
      const yaw = Math.atan2(legs[1][0] - legs[0][0], legs[1][1] - legs[0][1]);
      m.box(
        [mid[0], top - 0.8, mid[1]],
        [1.1, 0.8, span + 0.9],
        packMat(CM.concrete),
        yaw,
      );
      return;
    }
    fallback();
  };
  L.elevated.forEach((e, ei) => {
    if (e.kind === 'rail')
      railViaduct(e, ei, hf, onRoad, pier, m, lights, solid);
    else expressway(e, hf, pier, m, lights);
  });
}

/** Records a camera-solid box (centre, half extents, yaw). */
type Solid = (c: Vec3, h: Vec3, yaw: number) => void;

type Pier = (
  self: Elevated,
  q: Vec2,
  top: number,
  width: number,
  fallback: () => void,
) => void;

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

// Rail viaduct material contract, shared with city-materials.wgsl (same
// values there). Concrete faces carry a role in the param's low nibble and
// a per-bent seed in aux bits 16-31; rail faces use "bent units" along the
// line: uv.x = 12 * (point index + t), so bents fall on multiples of 12 and
// gantries on multiples of 48 (vertical faces: uv.y = metres down from the
// face's top edge; track bed: uv = (signed lateral offset, bent units)).
export const RC_GENERIC = 0;
export const RC_FASCIA = 1;
export const RC_BEAM = 2;
export const RC_COLUMN = 3;
export const RC_PARAPET = 4;
export const RC_TROUGH = 5;
export const RC_PLATFORM = 6;
export const RC_PLATFORM_FACE = 7;
export const RC_STATION = 8;
export const RC_SOUNDWALL = 9;
export const RC_ROADSIDE = 0x10;
export const RC_GLAZED = 0x20;
/** CM.metal params: railhead tube, rail web/foot, galvanised OLE steel. */
export const RAIL_STEEL = 0x4000;
export const RAIL_WEB = 0x4001;
export const GALV = 0x8000;
/** CM.paint params: plate girder over roads (| seed8, 0x80 = board face). */
export const RAIL_GIRDER = 0x500;
export const INSULATOR = 0xf9;
/**
 * CM.screen param on station departure boards (| station index & 0xff);
 * uv 0..1 over the board face. Until the shader draws timetable rows it
 * renders as an ad screen.
 */
export const DEPARTURE = 0x100;
/** Railhead top above the deck top (trains.ts sits cars on it). */
export const RAIL_TOP = 0.37;

/** Integer hash of (line, k) to [0, 1): rail variety, not the layout RNG. */
const railHash = (a: number, b: number) => hash2(a * 7919 + 13, b) / 4294967296;

function railViaduct(
  e: Elevated,
  ei: number,
  hf: Heightfield,
  onRoad: (q: Vec2) => boolean,
  pier: Pier,
  m: CMesh,
  lights: LightList,
  solid: Solid,
) {
  const pts = e.pts;
  const hs = e.heights;
  const n = pts.length;
  const fr = frames(pts);
  const segs = e.loop ? n : n - 1;
  const halfW = 5.2;
  const W = (k: number) => ((k % n) + n) % n;
  const P = (k: number, off: number, dy: number): Vec3 => {
    const q = W(k);
    return [
      pts[q][0] + fr[q].l[0] * off,
      hs[q] + dy,
      pts[q][1] + fr[q].l[1] * off,
    ];
  };
  const seed = (i: number) => (((ei * 4099 + i) & 0xffff) << 16) >>> 0;
  const conc = (role: number) => packMat(CM.concrete, role);
  const galv = packMat(CM.metal, GALV);
  const road = pts.map(q => onRoad(q));
  // Stations: segments si-7 .. si+6 carry platforms instead of parapets.
  const station = new Uint8Array(segs);
  for (const si of e.stations)
    for (let i = si - 7; i < si + 7; i++)
      if (e.loop || (i >= 0 && i < segs)) station[W(i) % segs] = 1;
  // Stair wells down to the concourse: one platform segment per side
  // (bit 1 = side -1, bit 2 = side +1), off the station centre.
  const stairOf = new Uint8Array(segs);
  const stairSeg = (si: number, side: number) => si + (side < 0 ? -3 : 2);
  for (const si of e.stations)
    for (const side of [-1, 1]) {
      const k = stairSeg(si, side);
      if (e.loop || (k >= 0 && k < segs))
        stairOf[W(k) % segs] |= side < 0 ? 1 : 2;
    }
  // Lit strip under the coping on some 120 m stretches (per side).
  const glowOf = (i: number, s: number) =>
    railHash(ei + 303, Math.floor(i / 10) * 2 + (s > 0 ? 1 : 0)) < 0.3;
  // Girder spans: segments touching a road point (bent to bent).
  const girder = new Int32Array(segs).fill(-1);
  for (let i = 0; i < segs; i++) {
    if (!road[i] && !road[W(i + 1)]) continue;
    const first = i > 0 && girder[i - 1] >= 0 ? girder[i - 1] & 0x7f : -1;
    girder[i] = first >= 0 ? first : 0x80 | (hash2(ei * 31 + 7, i) & 0x7f);
  }
  // Soundwall stretches: 120 m (10 bents) at a time.
  const wallOf = (i: number) => {
    if (station[i]) return 0;
    const b = Math.floor(i / 10);
    if (railHash(ei, b) >= 0.55) return 0;
    return RC_SOUNDWALL | (railHash(ei + 101, b) < 0.5 ? RC_GLAZED : 0);
  };

  // Cross-section edges: (lateral, dy) a -> b, an outward normal given as
  // (lateral, vertical) components, a material and a UV mode. Lateral
  // offsets are signed (+ = frame left).
  type UvMode = 'v' | 'h' | 'bed' | 'plat';
  interface Edge {
    a: Vec2;
    b: Vec2;
    nl: number;
    ny: number;
    mat: number;
    uv: UvMode;
  }
  const edgesOf = (i: number): Edge[] => {
    const out: Edge[] = [];
    const E = (
      a: Vec2,
      b: Vec2,
      nl: number,
      ny: number,
      mat: number,
      uv: UvMode,
    ) => out.push({a, b, nl, ny, mat, uv});
    const st = station[i] === 1;
    const g = girder[i];
    const bed = packMat(CM.rail);
    E([-0.6, 0], [0.6, 0], 0, 1, bed, 'bed');
    E([-3.4, -0.4], [3.4, -0.4], 0, -1, conc(RC_BEAM), 'h');
    for (const s of [-1, 1]) {
      const L = (o: number, y: number): Vec2 => [s * o, y];
      // Ballast: crown, shoulders.
      E(L(0.9, 0.15), L(3.6, 0.15), 0, 1, bed, 'bed');
      E(L(0.6, 0), L(0.9, 0.15), -s * 0.447, 0.894, bed, 'bed');
      if (st) E(L(3.6, 0.15), L(4.0, 0), s * 0.351, 0.936, bed, 'bed');
      else E(L(3.6, 0.15), L(4.3, 0), s * 0.21, 0.978, bed, 'bed');
      // Rail webs (the heads are continuous tubes).
      for (const r of [-0.53, 0.53]) {
        const c = 2.1 + r * s;
        for (const f of [-1, 1])
          E(
            L(c + f * 0.04, 0.32),
            L(c + f * 0.04, 0.2),
            s * f,
            0,
            packMat(CM.metal, RAIL_WEB),
            'v',
          );
      }
      if (st) {
        // Platform: recessed face under a nosing, top, glazed back fence,
        // outer face and slab soffit.
        const pf = conc(RC_PLATFORM_FACE);
        E(L(4.0, 1.2), L(4.0, 0), -s, 0, pf, 'v');
        E(L(4.0, 1.2), L(3.75, 1.2), 0, -1, pf, 'h');
        E(L(3.75, 1.45), L(3.75, 1.2), -s, 0, pf, 'v');
        if (stairOf[i] & (s < 0 ? 1 : 2)) {
          // Stair well (5.4 .. 7.6) through the platform, walled down to
          // the slab soffit, with a 1.05 m balustrade on both long sides.
          const pl = conc(RC_PLATFORM);
          const sw = conc(RC_STATION);
          E(L(3.75, 1.45), L(5.3, 1.45), 0, 1, pl, 'plat');
          E(L(5.3, 2.5), L(5.3, 1.45), -s, 0, sw, 'v');
          E(L(5.3, 2.5), L(5.4, 2.5), 0, 1, sw, 'h');
          E(L(5.4, 2.5), L(5.4, -1.2), s, 0, pf, 'v');
          E(L(7.6, 2.5), L(7.6, -1.2), -s, 0, pf, 'v');
          E(L(7.6, 2.5), L(7.7, 2.5), 0, 1, sw, 'h');
          E(L(7.7, 2.5), L(7.7, 1.45), s, 0, sw, 'v');
          E(L(7.7, 1.45), L(9.55, 1.45), 0, 1, pl, 'plat');
        } else E(L(3.75, 1.45), L(9.55, 1.45), 0, 1, conc(RC_PLATFORM), 'plat');
        const fence = conc(RC_SOUNDWALL | RC_GLAZED);
        E(L(9.55, 2.65), L(9.55, 1.45), -s, 0, fence, 'v');
        E(L(9.55, 2.65), L(9.7, 2.65), 0, 1, fence, 'h');
        E(L(9.7, 2.65), L(9.7, 1.45), s, 0, fence, 'v');
        E(L(9.7, 1.45), L(9.7, -1.2), s, 0, conc(RC_FASCIA), 'v');
        E(L(9.7, -1.2), L(5.2, -1.2), 0, -1, conc(RC_BEAM), 'h');
        E(L(5.2, -0.9), L(5.2, -1.2), -s, 0, conc(RC_BEAM), 'v');
      } else {
        // Cable trough, parapet with a coping drip lip, fascia.
        const tr = conc(RC_TROUGH);
        E(L(4.3, 0.3), L(4.3, 0), -s, 0, tr, 'v');
        E(L(4.3, 0.3), L(4.95, 0.3), 0, 1, tr, 'h');
        const pa = conc(RC_PARAPET);
        E(L(4.95, 1.25), L(4.95, 0.3), -s, 0, pa, 'v');
        const wall = wallOf(i);
        if (wall) {
          const sw = conc(wall);
          E(L(4.95, 1.25), L(5.04, 1.25), 0, 1, pa, 'h');
          E(L(5.04, 2.75), L(5.04, 1.25), -s, 0, sw, 'v');
          // Precast coping cap over the panels, 4-5 cm proud each side.
          E(L(4.99, 2.87), L(4.99, 2.74), -s, 0, pa, 'v');
          E(L(4.99, 2.87), L(5.21, 2.87), 0, 1, pa, 'h');
          E(L(5.21, 2.87), L(5.21, 2.74), s, 0, pa, 'v');
          E(L(5.16, 2.75), L(5.16, 1.25), s, 0, sw, 'v');
          E(L(5.16, 1.25), L(5.43, 1.25), 0, 1, pa, 'h');
        } else E(L(4.95, 1.25), L(5.43, 1.25), 0, 1, pa, 'h');
        E(L(5.43, 1.25), L(5.43, 1.13), s, 0, pa, 'v');
        E(L(5.43, 1.13), L(5.2, 1.13), 0, -1, pa, 'h');
        E(L(5.2, 1.13), L(5.2, -0.9), s, 0, conc(RC_FASCIA), 'v');
        // LED strip under the coping lip (lamp faces down: lit at night).
        if (glowOf(i, s))
          E(L(5.23, 1.1), L(5.4, 1.1), 0, -1, packMat(CM.lamp, 1), 'h');
        if (s < 0) {
          // Signal/power cable trough hung on the outer fascia.
          const tq = conc(RC_TROUGH);
          E(L(5.2, 0.3), L(5.5, 0.3), 0, 1, tq, 'h');
          E(L(5.5, 0.3), L(5.5, -0.06), s, 0, tq, 'v');
          E(L(5.5, -0.06), L(5.2, -0.06), 0, -1, tq, 'h');
        }
      }
      const beam = conc(RC_BEAM);
      if (g < 0) {
        // RC edge beam with the cantilever soffit outside it.
        E(L(5.2, -0.9), L(4.4, -0.9), 0, -1, beam, 'h');
        E(L(4.4, -0.9), L(4.4, -2.3), s, 0, beam, 'v');
        E(L(4.4, -2.3), L(3.4, -2.3), 0, -1, beam, 'h');
        E(L(3.4, -0.4), L(3.4, -2.3), -s, 0, beam, 'v');
      } else {
        // Two steel plate girders per side (webs seen from both faces).
        // The first segment of a run has 0x80 set: its outer web carries
        // the clearance board.
        const gm = packMat(CM.paint, RAIL_GIRDER | (g & 0x7f));
        const board = packMat(CM.paint, RAIL_GIRDER | g);
        E(L(5.2, -0.9), L(3.4, -0.9), 0, -1, beam, 'h');
        E(L(4.4, -0.9), L(4.4, -2.6), s, 0, board, 'v');
        E(L(4.4, -0.9), L(4.4, -2.6), -s, 0, gm, 'v');
        E(L(3.4, -0.9), L(3.4, -2.6), s, 0, gm, 'v');
        E(L(3.4, -0.4), L(3.4, -2.6), -s, 0, gm, 'v');
      }
    }
    return out;
  };

  // Emit the deck in chunks of 8 segments (two gantry bays, about 96 m,
  // small enough for tight cluster bounds), each cross-section edge as a
  // strip whose vertices are shared along the chunk. The first vertex of every triangle sits at
  // the segment's start point, so flat aux (the bent seed) is per segment.
  const edgeKey = (x: Edge) => `${x.a}|${x.b}|${x.mat}|${x.nl}`;
  for (let c0 = 0; c0 < segs; c0 += 8) {
    const c1 = Math.min(segs, c0 + 8);
    const per: Edge[][] = [];
    for (let i = c0; i < c1; i++) per.push(edgesOf(i));
    const done = per.map(es => es.map(() => false));
    for (let s = 0; s < per.length; s++) {
      for (let k = 0; k < per[s].length; k++) {
        if (done[s][k]) continue;
        const x = per[s][k];
        const key = edgeKey(x);
        // Extend the run over following segments with the same edge.
        let s1 = s + 1;
        for (; s1 < per.length; s1++) {
          const j = per[s1].findIndex(
            (y, q) => !done[s1][q] && edgeKey(y) === key,
          );
          if (j < 0) break;
          done[s1][j] = true;
        }
        done[s][k] = true;
        strip(x, c0 + s, c0 + s1);
      }
    }
  }
  function strip(x: Edge, k0: number, k1: number) {
    const top = Math.max(x.a[1], x.b[1]);
    const uvOf = (p: Vec2, k: number): Vec2 => {
      const u = 12 * k;
      switch (x.uv) {
        case 'v':
          return [u, top - p[1]];
        case 'h':
          return [u, Math.abs(p[0])];
        case 'bed':
          return [p[0], u];
        case 'plat':
          return [Math.abs(p[0]) - 3.75, u];
      }
    };
    const va: number[] = [];
    const vb: number[] = [];
    const nrm: Vec3[] = [];
    for (let k = k0; k <= k1; k++) {
      const l = fr[W(k)].l;
      const nv: Vec3 = [l[0] * x.nl, x.ny, l[1] * x.nl];
      nrm.push(nv);
      const ua = uvOf(x.a, k);
      const ub = uvOf(x.b, k);
      const aux = seed(W(k));
      va.push(m.vertex(P(k, x.a[0], x.a[1]), nv, ua[0], ua[1], x.mat, aux));
      vb.push(m.vertex(P(k, x.b[0], x.b[1]), nv, ub[0], ub[1], x.mat, aux));
    }
    for (let q = 0; q < k1 - k0; q++) {
      m.triFacing(va[q], va[q + 1], vb[q + 1], nrm[q]);
      m.triFacing(va[q], vb[q + 1], vb[q], nrm[q]);
    }
  }

  // Platform end walls where a station meets the plain deck.
  for (let i = 0; i < segs; i++) {
    const prev = e.loop || i > 0 ? station[W(i - 1) % segs] : 0;
    if (station[i] === prev) continue;
    const d = fr[i].d;
    const f: Vec3 = station[i] ? [-d[0], 0, -d[1]] : [d[0], 0, d[1]];
    for (const s of [-1, 1])
      m.quad(
        [
          P(i, s * 4.0, 1.45),
          P(i, s * 9.7, 1.45),
          P(i, s * 9.7, -1.2),
          P(i, s * 4.0, -1.2),
        ],
        f,
        [
          [0, 0],
          [5.7, 0],
          [5.7, 2.65],
          [0, 2.65],
        ],
        conc(RC_FASCIA),
        seed(i),
      );
  }

  // Chamfered column: four faces whose corners are bevelled by CH; the
  // bevels reuse the faces' vertices, so they shade as a rounded arris (16
  // vertices, fewer than a box). `plinth`: a footing collar 8 cm proud up
  // to 0.3 m above the ground, with a weathered top. UV as CMesh.box (u
  // around, v = metres above y0). Logged as a camera solid.
  const CH = 0.07;
  const column = (
    c: Vec2,
    y0: number,
    y1: number,
    hw: number,
    g: number,
    yaw: number,
    mat: number,
    aux: number,
    plinth: boolean,
  ) => {
    solid([c[0], (y0 + y1) / 2, c[1]], [hw, (y1 - y0) / 2, hw], yaw);
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const N: Vec2[] = [
      [cs, -sn],
      [sn, cs],
      [-cs, sn],
      [-sn, -cs],
    ];
    const rings: Vec2[] = plinth
      ? [
          [y0, hw + 0.08],
          [g + 0.3, hw + 0.08],
          [g + 0.36, hw],
          [y1, hw],
        ]
      : [
          [y0, hw],
          [y1, hw],
        ];
    const ids = rings.map(([y, w]) => {
      const r: number[] = [];
      for (let k = 0; k < 4; k++) {
        const nk = N[k];
        const nv: Vec3 = [nk[0], 0, nk[1]];
        for (const [t, o] of [
          [N[(k + 3) & 3], 0],
          [N[(k + 1) & 3], 2 * (hw - CH)],
        ] as [Vec2, number][])
          r.push(
            m.vertex(
              [
                c[0] + nk[0] * w + t[0] * (w - CH),
                y,
                c[1] + nk[1] * w + t[1] * (w - CH),
              ],
              nv,
              k * 2 * hw + o,
              y - y0,
              mat,
              aux,
            ),
          );
      }
      return r;
    });
    for (let j = 0; j + 1 < ids.length; j++)
      for (let q = 0; q < 8; q++) {
        const k = q >> 1;
        const a = N[k];
        const b = q & 1 ? N[(k + 1) & 3] : N[k];
        const f: Vec3 = [a[0] + b[0], 0, a[1] + b[1]];
        const r0 = ids[j];
        const r1 = ids[j + 1];
        m.triFacing(r0[q], r0[(q + 1) & 7], r1[(q + 1) & 7], f);
        m.triFacing(r0[q], r1[(q + 1) & 7], r1[q], f);
      }
  };
  const pipe = packMat(CM.paint, 0x90);

  // Bents: an RC rigid frame (two chamfered columns and a haunched
  // transverse beam) under every point off the roads; heavier ones with a
  // full cap, bearing shelves and pads flank each girder span.
  let bentNo = 0;
  for (let i = 0; i < n; i++) {
    if (road[i]) continue;
    const q = pts[i];
    const ground = hf.sample(q[0], q[1]);
    const top = hs[i] - 0.4;
    if (top - 1.9 - (ground - 1) < 0.5) continue;
    const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
    const gAfter = i < segs && girder[i] >= 0;
    const gBefore = i > 0 && girder[W(i - 1) % segs] >= 0;
    const flank = gAfter || gBefore ? 1 : 0;
    const no = bentNo++;
    const inStation =
      (i < segs && station[i] === 1) ||
      (i > 0 && station[W(i - 1) % segs] === 1);
    pier(e, q, top, 1.1, () => {
      const l = fr[i].l;
      const d = fr[i].d;
      const sd = seed(i);
      let roadside = 0;
      for (const s of [-1, 1]) {
        const c: Vec2 = [q[0] + l[0] * s * 3.9, q[1] + l[1] * s * 3.9];
        const near = [
          c,
          [c[0] + d[0] * 6, c[1] + d[1] * 6],
          [c[0] - d[0] * 6, c[1] - d[1] * 6],
          [c[0] + l[0] * s * 6, c[1] + l[1] * s * 6],
        ] as Vec2[];
        const rs = near.some(p => onRoad(p)) ? RC_ROADSIDE : 0;
        roadside |= rs;
        const g = hf.sample(c[0], c[1]);
        // Station bents carry the platform slab on a second column.
        if (inStation) {
          const o: Vec2 = [q[0] + l[0] * s * 8.2, q[1] + l[1] * s * 8.2];
          const go = hf.sample(o[0], o[1]);
          if (hs[i] - 1.2 - go > 0.5)
            column(
              o,
              go - 1,
              hs[i] - 1.2,
              0.5,
              go,
              yaw,
              conc(RC_COLUMN | rs),
              sd,
              rs !== 0,
            );
        }
        const cTop = hs[i] - (flank ? 3.0 : 2.3);
        const h = cTop - (g - 1);
        const hw = flank ? 0.6 : 0.5;
        if (h > 0.5)
          column(
            c,
            g - 1,
            cTop,
            hw,
            g,
            yaw,
            conc(RC_COLUMN | rs),
            sd,
            rs !== 0,
          );
        // Drain downpipe on every 2nd bent, alternate sides: a clamp
        // bracket to the column and a gully box at its foot.
        if (no % 2 === 0 && s === (no % 4 === 0 ? 1 : -1) && h > 2) {
          const o = hw + 0.12;
          const dp: Vec3 = [c[0] + d[0] * o, g + 0.25, c[1] + d[1] * o];
          m.cylinder(dp, 0.1, cTop - dp[1], 6, pipe, false);
          for (const y of [(g + cTop) / 2]) {
            m.tube(
              [
                [c[0] + d[0] * (hw - 0.02), y, c[1] + d[1] * (hw - 0.02)],
                [c[0] + d[0] * (o + 0.12), y, c[1] + d[1] * (o + 0.12)],
              ],
              0.025,
              pipe,
            );
          }
          m.box(
            [dp[0] + d[0] * 0.05, g + 0.08, dp[2] + d[1] * 0.05],
            [0.26, 0.16, 0.24],
            conc(RC_TROUGH),
            yaw,
            sd,
            true,
            true,
          );
        }
      }
      const bm = conc(RC_BEAM | roadside);
      if (flank) {
        // Full-width cap: also closes the edge beam and girder ends.
        const c = P(i, 0, -1.7);
        m.box(c, [4.5, 1.3, 0.5], bm, yaw, sd, false);
        // Bearing shelf under each girder end, elastomeric pads on it under
        // every web.
        for (const f of [-1, 1]) {
          if (!(f > 0 ? gAfter : gBefore)) continue;
          const at = (o: number, y: number, a: number): Vec3 => {
            const p = P(i, o, y);
            return [p[0] + d[0] * f * a, p[1], p[2] + d[1] * f * a];
          };
          m.box(at(0, -2.88, 0.78), [4.5, 0.12, 0.28], bm, yaw, sd, false);
          for (const o of [-4.4, -3.4, 3.4, 4.4])
            m.box(
              at(o, -2.71, 0.85),
              [0.2, 0.05, 0.15],
              packMat(CM.frame),
              yaw,
            );
        }
      } else {
        // Transverse beam between the edge beams (its ends and top hide
        // inside them): two faces and a soffit, haunched 0.35 m deeper
        // over the last 0.95 m at each column.
        const y0 = -0.4;
        const y1 = -2.3;
        const hw = 3.45;
        const hx = 2.5;
        const hy = y1 - 0.35;
        const A = (o: number, y: number, f: number): Vec3 => {
          const p = P(i, o, y);
          return [p[0] + d[0] * f * 0.4, p[1], p[2] + d[1] * f * 0.4];
        };
        for (const f of [-1, 1]) {
          const nf: Vec3 = [d[0] * f, 0, d[1] * f];
          const v = (o: number, y: number) =>
            m.vertex(A(o, y, f), nf, o, y0 - y, bm, sd);
          const [a, b, c, dd, ee, ff] = [
            v(-hw, y0),
            v(hw, y0),
            v(hw, hy),
            v(hx, y1),
            v(-hx, y1),
            v(-hw, hy),
          ];
          m.triFacing(a, b, dd, nf);
          m.triFacing(a, dd, ee, nf);
          m.triFacing(b, c, dd, nf);
          m.triFacing(a, ee, ff, nf);
        }
        const sl = Math.hypot(0.35, hw - hx);
        const sideN = (o: number): Vec3 => {
          if (Math.abs(o) < hw - 0.01) return [0, -1, 0];
          const t = 0.35 / sl;
          const c = (hw - hx) / sl;
          // The haunch underside faces down and in, toward the centre.
          return [-l[0] * Math.sign(o) * t, -c, -l[1] * Math.sign(o) * t];
        };
        const row = (f: number) =>
          [-hw, -hx, hx, hw].map((o, k) =>
            m.vertex(
              A(o, k === 0 || k === 3 ? hy : y1, f),
              sideN(k === 0 ? -hw : k === 3 ? hw : 0),
              o,
              f > 0 ? 0.8 : 0,
              bm,
              sd,
            ),
          );
        const r0 = row(-1);
        const r1 = row(1);
        for (let k = 0; k < 3; k++) {
          const nd: Vec3 = k === 1 ? [0, -1, 0] : sideN(k === 0 ? -hw : hw);
          m.triFacing(r0[k], r0[k + 1], r1[k + 1], nd);
          m.triFacing(r0[k], r1[k + 1], r1[k], nd);
        }
      }
      // Under-deck LED: at the bents flanking road crossings, and every 4th
      // other bent with headroom.
      if (flank || (no % 4 === 2 && hs[i] - ground > 6)) {
        const u = P(i, 0, flank ? -3.06 : -2.36);
        m.box(u, [0.5, 0.06, 0.2], packMat(CM.lamp, 1), yaw, 0, false);
        lights.add([u[0], u[1] - 0.4, u[2]], 18, LED, LightKind.street);
      }
    });
  }
  // Bottom flanges of the plate girders: crisp shadow lines.
  for (let i = 0; i < segs; i++) {
    if (girder[i] < 0) continue;
    const gm = packMat(CM.paint, RAIL_GIRDER | (girder[i] & 0x7f));
    for (const o of [-4.4, -3.4, 3.4, 4.4])
      m.beam(P(i, o, -2.63), P(i + 1, o, -2.63), 0.25, 0.03, gm, 0, [0, 1, 0]);
  }

  // Continuous lines through every point: railheads, catenary wires, the
  // cable conduit.
  const line = (f: (k: number) => Vec3, r: number, mat: number, step = 1) => {
    const ps: Vec3[] = [];
    for (let k = 0; k <= segs; k += step) ps.push(f(k));
    if (segs % step) ps.push(f(segs));
    m.tube(ps, r, mat);
  };
  for (const c of [-2.1, 2.1])
    for (const r of [-0.53, 0.53])
      line(
        k => P(k, c + r, RAIL_TOP - 0.02),
        0.035,
        packMat(CM.metal, RAIL_STEEL),
      );
  // Gantries every 4th point (48 bent units) and at the line's ends.
  const isGantry = (k: number) => k % 4 === 0 || (!e.loop && k === n - 1);
  // Contact wire stagger: +-0.2 m alternating at gantries, linear between.
  const stag = (k: number) => {
    const g0 = Math.floor(k / 4);
    const t = (k % 4) / 4;
    const s0 = g0 % 2 ? 0.2 : -0.2;
    return lerp(s0, -s0, t);
  };
  // Sag fraction of the bay (0 at gantries, 1 mid-bay).
  const sag = (k: number) => {
    const t = (k % 4) / 4;
    return 4 * t * (1 - t);
  };
  const CW = 5.4 + RAIL_TOP;
  const MW = 6.4 + RAIL_TOP;
  for (const c of [-2.1, 2.1]) {
    line(k => P(k, c + stag(k), CW), 0.007, packMat(CM.wire, 1));
    line(k => P(k, c + stag(k), MW - 0.5 * sag(k)), 0.008, packMat(CM.wire, 2));
    // Droppers at mid-bay bents (every 24 m).
    for (let k = 0; k < segs; k++) {
      if (isGantry(k) || k % 2) continue;
      m.tube(
        [P(k, c + stag(k), CW), P(k, c + stag(k), MW - 0.5 * sag(k))],
        0.004,
        packMat(CM.wire, 2),
      );
    }
  }
  for (const s of [-1, 1]) {
    // Feeders: a point every 2nd bent is enough for their sag.
    line(k => P(k, s * 4.8, 9.0 - 0.6 * sag(k)), 0.012, packMat(CM.wire, 2), 2);
  }

  for (let i = 0; i < n; i++) {
    if (!isGantry(i)) continue;
    const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
    for (const s of [-1, 1]) {
      const b = P(i, s * 4.8, 1.2 + 3.9);
      m.box(b, [0.09, 3.9, 0.15], galv, yaw);
    }
    // Warren truss: two chords and one zig-zag of diagonals.
    m.tube([P(i, -4.8, 8.6), P(i, 4.8, 8.6)], 0.06, galv);
    m.tube([P(i, -4.8, 7.9), P(i, 4.8, 7.9)], 0.06, galv);
    const zz: Vec3[] = [];
    for (let k = 0; k <= 12; k++)
      zz.push(P(i, -4.8 + k * 0.8, k % 2 ? 8.6 : 7.9));
    m.tube(zz, 0.035, galv);
    const ins = packMat(CM.paint, INSULATOR);
    for (const c of [-2.1, 2.1]) {
      // Drop pole outboard of the track, hung from the bottom chord on an
      // insulator; a messenger support arm, and a registration arm on a
      // hinge insulator whose tip is the contact wire's support point (the
      // same staggered point the wire polyline passes through).
      const st = stag(i);
      const sg = Math.sign(c);
      const xd = c + sg * 0.9;
      m.tube([P(i, xd, 7.9), P(i, xd, 7.45)], 0.065, ins);
      m.tube([P(i, xd, 7.45), P(i, xd, CW + 0.55)], 0.04, galv);
      m.tube([P(i, xd, MW), P(i, c + st, MW)], 0.03, galv);
      m.tube([P(i, xd, CW + 0.55), P(i, xd, CW + 0.22)], 0.055, ins);
      m.tube([P(i, xd, CW + 0.22), P(i, c + st, CW)], 0.025, galv);
      // Signal heads every 24 points (288 bent units), facing the trains
      // that approach on this track (left-hand running). Both lamps lit
      // (hash aspect: green over yellow, yellow over yellow, red over red).
      if (i % 24 === 0) {
        const d = fr[i].d;
        const f = c < 0 ? -1 : 1;
        const hp = P(i, c + sg * 1.45, 7.45);
        m.box(hp, [0.15, 0.35, 0.1], packMat(CM.frame), yaw);
        const a = railHash(ei * 3 + (c < 0 ? 1 : 2), i);
        const [up, lo] = a < 0.7 ? [4, 5] : a < 0.9 ? [5, 5] : [3, 3];
        for (const [dy, asp] of [
          [0.15, up],
          [-0.15, lo],
        ] as [number, number][])
          m.box(
            [hp[0] + d[0] * f * 0.11, hp[1] + dy, hp[2] + d[1] * f * 0.11],
            [0.06, 0.06, 0.02],
            packMat(CM.lamp, asp),
            yaw,
          );
      }
    }
  }

  // Night fittings and small deck furniture.
  const cool: Vec3 = [0.8, 0.92, 1.0];
  const lamp = packMat(CM.lamp, 1);
  const mid = (i: number, t: number, o: number, y: number): Vec3 => {
    const a = P(i, o, y);
    const b = P(i + 1, o, y);
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  };
  for (let i = 0; i < segs; i++) {
    const len = dist2(pts[i], pts[W(i + 1)]) || 1;
    const t0 = 0.5 - 0.6 / len;
    const t1 = 0.5 + 0.6 / len;
    // Fluorescent fitting under the centre soffit in every bay; a light in
    // every 2nd bay with headroom.
    m.quad(
      [
        mid(i, t0, -0.07, -0.47),
        mid(i, t1, -0.07, -0.47),
        mid(i, t1, 0.07, -0.47),
        mid(i, t0, 0.07, -0.47),
      ],
      [0, -1, 0],
      [
        [0, 0],
        [1.2, 0],
        [1.2, 0.14],
        [0, 0.14],
      ],
      lamp,
    );
    const c = mid(i, 0.5, 0, -0.6);
    if (i % 2 === 1 && c[1] - hf.sample(c[0], c[2]) > 5)
      lights.add(c, 11, cool, LightKind.station);
    const st = station[i] === 1;
    // Walkway lamp every 3rd bay, alternating sides, on a bracket off the
    // parapet / soundwall (mid-bay, clear of masts and bents).
    if (!st && i % 3 === 1) {
      const s = Math.floor(i / 3) & 1 ? 1 : -1;
      const wy = wallOf(i) ? 2.3 : 1.25;
      m.tube(
        [
          mid(i, 0.5, s * 5.0, wy),
          mid(i, 0.5, s * 5.0, 2.6),
          mid(i, 0.5, s * 4.6, 2.6),
        ],
        0.03,
        galv,
      );
      // Lamp head: a short bar along the track (its lower faces glow).
      m.tube(
        [
          mid(i, 0.5 - 0.22 / len, s * 4.6, 2.54),
          mid(i, 0.5 + 0.22 / len, s * 4.6, 2.54),
        ],
        0.06,
        lamp,
      );
      lights.add(mid(i, 0.5, s * 4.6, 2.3), 9, LED, LightKind.station);
    }
    // Brackets under the outer cable trough, every 4th bay.
    if (!st && i % 4 === 2) {
      const d = fr[i].d;
      m.quad(
        [
          mid(i, 0.5, -5.2, -0.06),
          mid(i, 0.5, -5.46, -0.06),
          mid(i, 0.5, -5.25, -0.42),
          mid(i, 0.5, -5.2, -0.42),
        ],
        [d[0], 0, d[1]],
        [
          [0, 0],
          [0.26, 0],
          [0.05, 0.36],
          [0, 0.36],
        ],
        galv,
      );
    }
    // Rail joint plates (fishplates) on the field side of the outer rails
    // every 16 bays.
    if (i % 16 === 4) {
      const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
      for (const o of [-2.63, 2.63])
        m.box(
          mid(i, 0.5, o + Math.sign(o) * 0.055, 0.26),
          [0.015, 0.05, 0.4],
          packMat(CM.metal, RAIL_WEB),
          yaw,
          0,
          true,
          true,
        );
    }
  }

  // Stations: a low canopy on T-frames over each raised side platform
  // (fascia with a light-box strip and name boards), stairs down through
  // the platform, platform furniture, and a glazed concourse under the
  // deck (or a stair tower beside it where the ground below is road).
  const PL = 1.45;
  const CY = PL + 3.2;
  const metal = packMat(CM.metal);
  const fasciaM = packMat(CM.paint, 0xd0);
  const flat = (
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    nrm: Vec3,
    w: number,
    h: number,
    mat: number,
  ) =>
    m.quad(
      [a, b, c, d],
      nrm,
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
      mat,
    );
  for (const si of e.stations) {
    const i0 = Math.max(0, si - 7);
    const i1 = Math.min(n - 1, si + 7);
    const name = packMat(CM.sign, 64 + (si % 8));
    for (const side of [-1, 1]) {
      const o = (x: number) => side * x;
      for (let i = i0; i < i1; i++) {
        const out: Vec3 = [fr[i].l[0] * side, 0, fr[i].l[1] * side];
        const inn: Vec3 = [-out[0], 0, -out[2]];
        const len = dist2(pts[i], pts[W(i + 1)]);
        // Roof: 4.0 (over the platform edge) to 9.8, rising 0.3 to the
        // back; corrugated top, steel soffit.
        const r0 = P(i, o(4.0), CY + 0.15);
        const r1 = P(i + 1, o(4.0), CY + 0.15);
        const r2 = P(i + 1, o(9.8), CY + 0.45);
        const r3 = P(i, o(9.8), CY + 0.45);
        flat(r0, r1, r2, r3, UP, len, 5.8, packMat(CM.paint, 0xf8));
        flat(r0, r1, r2, r3, [0, -1, 0], len, 5.8, metal);
        // Track-side fascia 0.6 m deep, a light-box strip along its lower
        // edge (lit face down and toward the track), back fascia 0.3 m.
        const dn = (p: Vec3, y: number): Vec3 => [p[0], p[1] - y, p[2]];
        flat(r1, r0, dn(r0, 0.45), dn(r1, 0.45), inn, len, 0.45, fasciaM);
        flat(r0, r1, dn(r1, 0.45), dn(r0, 0.45), out, len, 0.45, fasciaM);
        const b0 = dn(r0, 0.45);
        const b1 = dn(r1, 0.45);
        flat(
          b1,
          b0,
          dn(b0, 0.2),
          dn(b1, 0.2),
          inn,
          len,
          0.2,
          packMat(CM.lamp, 1),
        );
        const c0 = P(i, o(4.15), CY - 0.5);
        const c1 = P(i + 1, o(4.15), CY - 0.5);
        flat(
          dn(b0, 0.2),
          dn(b1, 0.2),
          c1,
          c0,
          [0, -1, 0],
          len,
          0.15,
          packMat(CM.lamp, 1),
        );
        flat(r2, r3, dn(r3, 0.3), dn(r2, 0.3), out, len, 0.3, fasciaM);
        // Fluorescent line under the roof along the platform.
        flat(
          P(i, o(6.2), CY + 0.2),
          P(i + 1, o(6.2), CY + 0.2),
          P(i + 1, o(6.35), CY + 0.21),
          P(i, o(6.35), CY + 0.21),
          [0, -1, 0],
          len,
          0.15,
          packMat(CM.lamp, 1),
        );
        // T-frame at every point: a centre column and a sloped arm.
        const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
        const post = P(i, o(6.8), PL);
        const ph = CY + 0.1 - PL;
        m.box(
          [post[0], post[1] + ph / 2, post[2]],
          [0.12, ph / 2, 0.12],
          metal,
          yaw,
        );
        m.beam(
          P(i, o(4.05), CY + 0.08),
          P(i, o(9.75), CY + 0.38),
          0.08,
          0.12,
          metal,
        );
        if (i % 2 === 0) {
          const lp = P(i, o(6.3), CY - 0.2);
          lights.add(lp, 14, LED, LightKind.station);
        }
      }
      // Hanging name boards facing the track, and a big one on the back
      // fascia facing the street.
      for (const k of [si - 4, si + 3]) {
        if (k < i0 || k >= i1) continue;
        const yaw = Math.atan2(fr[k].d[0], fr[k].d[1]);
        const b = mid(k, 0.5, o(4.6), CY - 0.75);
        const top = mid(k, 0.5, o(4.6), CY + 0.12)[1];
        m.box(b, [0.05, 0.42, 2.5], name, yaw);
        for (const f of [-1.6, 1.6])
          m.tube(
            [
              [b[0] + fr[k].d[0] * f, b[1] + 0.42, b[2] + fr[k].d[1] * f],
              [b[0] + fr[k].d[0] * f, top, b[2] + fr[k].d[1] * f],
            ],
            0.015,
            metal,
          );
      }
      {
        const yaw = Math.atan2(fr[si].d[0], fr[si].d[1]);
        const b = P(si, o(9.86), CY + 0.1);
        m.box(b, [0.05, 0.5, 2.8], name, yaw);
        // Perpendicular hanging sign mid-platform.
        const h = mid(si, 0.5, o(6.8), CY - 0.45);
        m.box(h, [1.2, 0.28, 0.05], name, yaw);
      }
      // Departure boards (screens) hanging over the stair heads.
      const sk = stairSeg(si, side);
      if (sk >= i0 && sk < i1) {
        const yaw = Math.atan2(fr[sk].d[0], fr[sk].d[1]);
        const d = fr[sk].d;
        const b = mid(sk, 0.15, o(6.5), CY - 0.5);
        m.box(b, [0.95, 0.27, 0.05], packMat(CM.frame), yaw);
        for (const f of [-1, 1]) {
          const fp: Vec3 = [
            b[0] + d[0] * f * 0.051,
            b[1],
            b[2] + d[1] * f * 0.051,
          ];
          const l = fr[sk].l;
          const A = (x: number, y: number): Vec3 => [
            fp[0] + l[0] * x,
            fp[1] + y,
            fp[2] + l[1] * x,
          ];
          flat(
            A(-0.9 * f, -0.22),
            A(0.9 * f, -0.22),
            A(0.9 * f, 0.22),
            A(-0.9 * f, 0.22),
            [d[0] * f, 0, d[1] * f],
            1,
            1,
            packMat(CM.screen, DEPARTURE | (si & 0xff)),
          );
        }
        // Stairs: ten 0.265 m risers on 0.32 m treads from the well's near
        // end down to the slab soffit, handrails down both walls.
        const len = dist2(pts[sk], pts[W(sk + 1)]) || 1;
        const st = conc(RC_PLATFORM);
        const at = (a: number, x: number, y: number) =>
          mid(sk, a / len, o(x), y);
        for (let k = 0; k < 10; k++) {
          const a0 = 0.02 + k * 0.32;
          const y = PL - (k + 1) * 0.265;
          flat(
            at(a0, 5.4, y + 0.265),
            at(a0, 7.6, y + 0.265),
            at(a0, 7.6, y),
            at(a0, 5.4, y),
            [d[0], 0, d[1]],
            2.2,
            0.265,
            st,
          );
          flat(
            at(a0, 5.4, y),
            at(a0, 7.6, y),
            at(a0 + 0.32, 7.6, y),
            at(a0 + 0.32, 5.4, y),
            UP,
            2.2,
            0.32,
            st,
          );
        }
        // The far end of the well walled, with the balustrade on top.
        flat(
          at(len - 0.02, 5.3, PL + 1.05),
          at(len - 0.02, 7.7, PL + 1.05),
          at(len - 0.02, 7.7, -1.2),
          at(len - 0.02, 5.3, -1.2),
          [-d[0], 0, -d[1]],
          2.4,
          3.7,
          conc(RC_STATION),
        );
        flat(
          at(len - 0.02, 5.3, PL + 1.05),
          at(len - 0.02, 7.7, PL + 1.05),
          at(len - 0.02, 7.7, PL),
          at(len - 0.02, 5.3, PL),
          [d[0], 0, d[1]],
          2.4,
          1.05,
          conc(RC_STATION),
        );
        for (const x of [5.35, 7.65])
          m.tube(
            [at(0.02, x, PL + 1.12), at(len - 0.02, x, PL + 1.12)],
            0.025,
            galv,
          );
        for (const x of [5.5, 7.5])
          m.tube(
            [
              at(0.02, x, PL + 0.9),
              at(3.22, x, PL - 2.65 + 0.9),
              at(4.2, x, PL - 2.65 + 0.9),
            ],
            0.022,
            galv,
          );
      }
      // Benches along the back fence and a pair of vending machines.
      for (const [k, a] of [
        [si - 5, 0.5],
        [si - 1, 0.3],
        [si + 4, 0.6],
      ] as [number, number][]) {
        if (k < i0 || k >= i1) continue;
        const yaw = Math.atan2(fr[k].d[0], fr[k].d[1]);
        m.box(
          mid(k, a, o(8.95), PL + 0.43),
          [0.22, 0.03, 0.9],
          packMat(CM.paint, 0x60),
          yaw,
        );
        m.box(
          mid(k, a, o(9.2), PL + 0.62),
          [0.03, 0.2, 0.9],
          packMat(CM.paint, 0x60),
          yaw,
        );
        m.box(mid(k, a, o(8.95), PL + 0.2), [0.2, 0.2, 0.75], metal, yaw);
      }
      for (const [k, v] of [
        [si + 1, 0],
        [si + 1, 1],
      ] as [number, number][]) {
        if (k < i0 || k >= i1) continue;
        const yaw = Math.atan2(fr[k].d[0], fr[k].d[1]);
        const c = mid(k, 0.45 + v * 0.08, o(9.15), PL + 0.9);
        // Front (the box's +x face) toward the platform.
        m.box(
          c,
          [0.38, 0.9, 0.45],
          packMat(CM.vending, (si + v + (side > 0 ? 1 : 0)) % 3),
          yaw + (side < 0 ? Math.PI : 0),
        );
      }
    }
    // Glazed concourse under the deck: two bays between the station bents,
    // full width under both platforms, where the ground is clear of roads.
    const span = (k: number) => {
      if (k < si - 7 || k + 2 > si + 7 || k < 0 || k + 2 >= n) return false;
      for (let j = k; j <= k + 2; j++)
        for (const x of [-9.7, -4, 0, 4, 9.7]) {
          const p = P(j, x, 0);
          if (onRoad([p[0], p[2]])) return false;
        }
      return true;
    };
    let ck = -1;
    for (const dk of [-1, 0, -2, 1, -3, 2, -4, 3])
      if (ck < 0 && span(si + dk)) ck = si + dk;
    if (ck >= 0) {
      const a = P(ck, 0, 0);
      const b = P(ck + 2, 0, 0);
      const cx = (a[0] + b[0]) / 2;
      const cz = (a[2] + b[2]) / 2;
      const half = Math.hypot(b[0] - a[0], b[2] - a[2]) / 2;
      const yaw = Math.atan2(b[0] - a[0], b[2] - a[2]);
      let gnd = Infinity;
      for (let j = ck; j <= ck + 2; j++)
        for (const x of [-9.7, 9.7]) {
          const p = P(j, x, 0);
          gnd = Math.min(gnd, hf.sample(p[0], p[2]));
        }
      const roof = Math.min(hs[ck], hs[ck + 1], hs[ck + 2]) - 1.25;
      const hg = Math.min(4.4, roof - gnd - 1);
      if (hg > 2.5) {
        // Curtain wall (RC_STATION | RC_GLAZED), solid upper band.
        m.box(
          [cx, gnd - 0.3 + (hg + 0.3) / 2, cz],
          [9.75, (hg + 0.3) / 2, half],
          conc(RC_STATION | RC_GLAZED),
          yaw,
          seed(ck),
        );
        const ub = roof - (gnd + hg);
        m.box(
          [cx, gnd + hg + ub / 2, cz],
          [9.85, ub / 2, half + 0.1],
          conc(RC_STATION),
          yaw,
          seed(ck),
          false,
        );
        // Entrances in the middle of both long sides: a dark door recess
        // under a steel canopy, the station name above.
        const l = fr[ck + 1].l;
        for (const s of [-1, 1]) {
          const f = (x: number, y: number): Vec3 => [
            cx + l[0] * s * x,
            gnd + y,
            cz + l[1] * s * x,
          ];
          m.box(f(9.77, 1.3), [0.02, 1.3, 2.4], packMat(CM.frame), yaw);
          m.box(f(10.4, 2.95), [0.65, 0.07, 3.0], metal, yaw, 0, false);
          if (ub > 1.4) m.box(f(9.9, hg + ub / 2), [0.05, 0.5, 3.2], name, yaw);
        }
      }
    } else {
      // Stair tower beside the deck, on whichever side and position along
      // the platform keeps its whole footprint off the roads.
      stairTower(si);
    }
  }

  function stairTower(si: number) {
    const clear = (k: number, side: number) => {
      const c = P(k, side * (halfW + 7), 0);
      const d = fr[W(k)].d;
      const l = fr[W(k)].l;
      for (const [a, b] of [
        [0, 0],
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ])
        if (
          onRoad([
            c[0] + l[0] * a * 2.5 + d[0] * b * 6,
            c[2] + l[1] * a * 2.5 + d[1] * b * 6,
          ])
        )
          return false;
      return true;
    };
    let spot: [number, number] | null = null;
    for (const dk of [0, 1, -1, 2, -2, 3, -3])
      for (const side of [1, -1]) {
        const k = si + dk;
        if (!spot && k >= 0 && k < n && clear(k, side)) spot = [k, side];
      }
    if (spot) {
      const [k, side] = spot;
      const q = P(k, side * (halfW + 7), 0);
      const ground = hf.sample(q[0], q[2]);
      const top = hs[k] + PL + 3.0;
      const h = top - ground;
      const yaw = Math.atan2(fr[k].d[0], fr[k].d[1]);
      const l = fr[k].l;
      if (h > 1) {
        m.box(
          [q[0], ground + h / 2, q[2]],
          [2.5, h / 2, 6],
          conc(RC_STATION),
          yaw,
          seed(k),
        );
        m.box(
          [q[0], top + 0.15, q[2]],
          [2.9, 0.15, 6.4],
          conc(RC_PARAPET),
          yaw,
          seed(k),
          false,
        );
        // On the street face (away from the viaduct): the name board under
        // the deck line and a framed entrance.
        const fx = (o: number): Vec3 => [
          q[0] + l[0] * side * o,
          0,
          q[2] + l[1] * side * o,
        ];
        const b = fx(2.56);
        m.box(
          [b[0], hs[k] - 1.0, b[2]],
          [1.8, 0.4, 0.06],
          packMat(CM.sign, 64 + (si % 8)),
          yaw + Math.PI / 2,
        );
        const d = fr[k].d;
        for (const f of [-1, 1]) {
          const j = fx(2.57);
          m.box(
            [j[0] + d[0] * f * 1.3, ground + 1.4, j[2] + d[1] * f * 1.3],
            [0.1, 1.4, 0.15],
            packMat(CM.frame),
            yaw,
          );
        }
        const j = fx(2.57);
        const dk = fx(2.51);
        m.box(
          [dk[0], ground + 1.4, dk[2]],
          [0.01, 1.4, 1.2],
          packMat(CM.frame),
          yaw,
        );
        m.box(
          [j[0], ground + 2.9, j[2]],
          [0.15, 0.1, 1.4],
          packMat(CM.frame),
          yaw,
        );
      }
    }
  }
}

function expressway(
  e: Elevated,
  hf: Heightfield,
  pier: Pier,
  m: CMesh,
  lights: LightList,
) {
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
  // Shuto-style edge: concrete parapet with a coping lip and drip groove, then
  // a sound barrier of discrete panels slotted between steel posts. The base
  // mesh has no LODs and the network is long, so posts stay single boxes.
  const wall = halfW - 0.2; // barrier centerline
  const capY = 1.0; // parapet top
  const postH = 3.0;
  const steel = packMat(CM.paint, 0x90);
  const ribbed = packMat(CM.metal); // ribbed metal
  const clear = packMat(CM.paint, 0x2c); // pale translucent-looking panels
  let nextPost = 0;
  let nextLamp = 6;
  for (let i = 0; i + 1 < n; i++) {
    const seg = along[i + 1] - along[i];
    const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
    for (const side of [-1, 1]) {
      const run = (
        off: number,
        dy: number,
        w: number,
        h: number,
        mat: number,
      ) => m.beam(P(i, side * off, dy), P(i + 1, side * off, dy), w, h, mat);
      run(
        wall,
        capY * 0.5 - 0.04,
        0.2,
        capY * 0.5 - 0.04,
        packMat(CM.concrete),
      );
      // Coping overhangs both faces; a dark drip groove line runs just under
      // the outer lip.
      run(wall, capY, 0.27, 0.06, packMat(CM.concrete));
      run(halfW + 0.004, capY - 0.09, 0.006, 0.02, packMat(CM.frame));
      // Panels sit in the post channels (thinner than the posts): ribbed metal
      // below, translucent above, divided by a steel rail and capped by one.
      const base = capY + 0.06;
      run(wall, base + 0.5, 0.025, 0.5, ribbed);
      run(wall, base + 0.5, 0.032, 0.015, ribbed);
      run(wall, base + 1.0 + (postH - 1.1) / 2, 0.02, (postH - 1.1) / 2, clear);
      run(wall, base + 1.0, 0.05, 0.04, steel);
      run(wall, base + postH - 0.05, 0.08, 0.05, steel);
    }
    // Posts every 2 m, proud of the panels on both faces.
    for (; nextPost < along[i] + seg; nextPost += 2) {
      const t = (nextPost - along[i]) / (seg || 1);
      for (const side of [-1, 1]) {
        const a = P(i, side * wall, capY + 0.06);
        const b = P(i + 1, side * wall, capY + 0.06);
        m.box(
          [
            lerp(a[0], b[0], t),
            lerp(a[1], b[1], t) + postH / 2,
            lerp(a[2], b[2], t),
          ],
          [0.085, postH / 2, 0.06],
          steel,
          yaw,
        );
      }
    }
    // Delineator lamps on the inner parapet face.
    for (; nextLamp < along[i] + seg; nextLamp += 12) {
      const t = (nextLamp - along[i]) / (seg || 1);
      for (const side of [-1, 1]) {
        const a = P(i, side * (wall - 0.21), 0.75);
        const b = P(i + 1, side * (wall - 0.21), 0.75);
        m.box(
          [lerp(a[0], b[0], t), a[1] + (b[1] - a[1]) * t, lerp(a[2], b[2], t)],
          [0.025, 0.03, 0.18],
          packMat(CM.lamp, 1),
          yaw,
        );
      }
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
  let pierCount = 0;
  let lastLight = -100;
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    const ground = hf.sample(q[0], q[1]);
    const top = hs[i] - 2;
    if (along[i] - lastPier > 32 && top - ground > 3) {
      lastPier = along[i];
      const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
      // Expansion joint across the deck over each pier.
      m.beam(
        P(i, -(halfW - 0.45), 0.012),
        P(i, halfW - 0.45, 0.012),
        0.12,
        0.012,
        packMat(CM.metal),
      );
      const pierNo = pierCount++;
      pier(e, q, top, 1.5, () => {
        if (pierNo % 2 === 0) {
          // Drainage downpipe hugging the column, from a deck drain just
          // past the pier cap down into the ground.
          const sd = pierNo % 4 === 0 ? 1 : -1;
          const l = fr[i].l;
          const d = fr[i].d;
          const dp: Vec3 = [
            q[0] + d[0] * 1.6 + l[0] * sd * 0.6,
            ground - 0.3,
            q[1] + d[1] * 1.6 + l[1] * sd * 0.6,
          ];
          const pipe = packMat(CM.paint, 0x90);
          m.cylinder(dp, 0.1, top - dp[1], 6, pipe, false);
          // Pipe clamps.
          for (let y = ground + 2.5; y < top - 1; y += 3)
            m.box([dp[0], y, dp[2]], [0.14, 0.04, 0.14], pipe, yaw);
        }
        m.cylinder(
          [q[0], ground - 1, q[1]],
          1.5,
          top - ground + 1,
          12,
          packMat(CM.concrete),
          false,
        );
        m.box(
          [q[0], top - 0.8, q[1]],
          [halfW * 0.8, 0.8, 1.4],
          packMat(CM.concrete),
          yaw,
        );
      });
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
      // Lamps under the deck light the street below, as on the Shuto.
      if (hs[i] - ground > 6) {
        for (const side of [-1, 1]) {
          const u = P(i, side * halfW * 0.45, -2.15);
          m.box(u, [0.5, 0.08, 0.25], packMat(CM.lamp, 0));
          lights.add([u[0], u[1] - 0.4, u[2]], 22, LED, LightKind.street);
        }
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
          packMat(CM.facade, (style & 0x1fff) | (2 << 16)),
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
  /** Solid boxes of bridges and viaducts (piers, portal frames, station
   * stairs) for camera collision: cx, cy, cz, hx, hy, hz, yaw per box. */
  solids: number[];
}

export function buildBase(L: CityLayout): BaseGeometry {
  const m = new CMesh(1 << 18, 1 << 19);
  const piers = new CMesh(1 << 12, 1 << 13);
  const lights = new LightList();
  const geom = computeRoadGeom(L);
  const mask = roadMask(L);
  // Record the large boxes the bridge and viaduct builders emit, so the
  // camera can treat them as solid (they are otherwise only render meshes).
  const solids: number[] = [];
  const record = (mesh: CMesh) => {
    const box = mesh.box.bind(mesh);
    mesh.box = (
      c,
      h,
      mat,
      yaw = 0,
      aux = 0,
      skipBottom = true,
      skipBack = false,
    ) => {
      if (h[1] >= 0.75 && Math.max(h[0], h[2]) >= 0.5)
        solids.push(c[0], c[1], c[2], h[0], h[1], h[2], yaw);
      box(c, h, mat, yaw, aux, skipBottom, skipBack);
    };
    return () => {
      mesh.box = box;
    };
  };
  const unM = record(m);
  const unP = record(piers);
  roads(L, geom, m, lights, piers);
  blocks(L, m);
  elevatedStructures(L, mask, m, lights, (c, h, yaw) =>
    solids.push(c[0], c[1], c[2], h[0], h[1], h[2], yaw),
  );
  unM();
  unP();
  streetLights(L, geom, lights);
  // The asset lab shows its subject alone, without the distant skyline.
  if (!L.hidden) outskirts(L, m);
  return {
    mesh: m,
    piers,
    lights: lights.data,
    landUse: landUse(L, mask, L.hidden ? roadMask(L, true) : undefined),
    roadMask: mask,
    geom,
    solids,
  };
}

/** Street light positions (the poles themselves are props in detail tiles). */
/**
 * Walking-surface height at (x, z): the sidewalk slab follows the terrain
 * (see blocks()), not the road chain, so furniture must sit on it. Where the
 * road is far from the terrain (embankment), fall back to the road level.
 */
export function sidewalkY(
  hf: Heightfield,
  x: number,
  z: number,
  roadH: number,
) {
  const g = hf.sample(x, z) + 0.16;
  return Math.abs(g - roadH) < 2.5 ? g : roadH + 0.16;
}

export function streetLightSpots(
  L: CityLayout,
  geom: RoadGeom,
  hf: Heightfield,
  cb: (p: Vec3, dir: Vec2, kind: number, sodium: boolean) => void,
) {
  L.chains.forEach((c, ci) => {
    if (c.bridge.some(b => b) || L.hidden?.chains[ci]) return;
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
        const x = q.p[0] + l[0] * off;
        const z = q.p[1] + l[1] * off;
        const p: Vec3 = [x, sidewalkY(hf, x, z, q.h), z];
        cb(p, [-l[0] * side, -l[1] * side], c.kind, sodium);
      }
    }
  });
}

function streetLights(L: CityLayout, geom: RoadGeom, lights: LightList) {
  streetLightSpots(L, geom, L.terrain.heights, (p, dir, kind, sodium) => {
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
