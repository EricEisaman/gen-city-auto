// Per-tile city geometry: buildings (LOD0 detailed, LOD1 shells) and street
// props (lights, utility poles and wires, signals, trees, vending machines).

import {Rng, hash2, hash3} from '../math/random.ts';
import {
  dist2,
  lerp,
  polygonArea,
  pointInPolygon,
  type Vec2,
  type Vec3,
} from '../math/vec.ts';
import {CM, CMesh, packMat, triangulate} from './cmesh.ts';
import {
  LightKind,
  LightList,
  SODIUM,
  LED,
  sidewalkY,
  streetLightSpots,
} from './gen-base.ts';
import {insetPolygon} from './graph.ts';
import {
  closestOnPolyline,
  elevatedHalfWidth,
  FILL_CELL,
  obb,
  ROAD_WIDTH,
  SIDEWALK,
  Road,
  type BlockFill,
  type Building,
  type CityLayout,
} from './layout.ts';
import {chainAt, type RoadGeom} from './roadgeom.ts';
import {SIGN, SIGN_FABRIC, SIGN_STRIPES, signColor} from './signs.ts';
import type {Heightfield} from './terrain.ts';

export const TILE_SIZE = 256;

export const KIND_INDEX: Record<Building['kind'], number> = {
  tower: 0,
  glass: 1,
  midrise: 2,
  pencil: 3,
  house: 4,
  apartment: 5,
  station: 6,
};

export function tileOf(size: number, x: number, z: number) {
  const n = Math.ceil(size / TILE_SIZE);
  const tx = Math.min(
    n - 1,
    Math.max(0, Math.floor((x + size / 2) / TILE_SIZE)),
  );
  const tz = Math.min(
    n - 1,
    Math.max(0, Math.floor((z + size / 2) / TILE_SIZE)),
  );
  return tz * n + tx;
}

const UP: Vec3 = [0, 1, 0];

const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));

function centroid(poly: Vec2[]): Vec2 {
  let x = 0,
    z = 0;
  for (const q of poly) {
    x += q[0];
    z += q[1];
  }
  return [x / poly.length, z / poly.length];
}

function shrink(poly: Vec2[], f: number): Vec2[] {
  const c = centroid(poly);
  return poly.map(q => [c[0] + (q[0] - c[0]) * f, c[1] + (q[1] - c[1]) * f]);
}

function inset(poly: Vec2[], d: number): Vec2[] | null {
  const r = insetPolygon(
    poly,
    poly.map(() => d),
  );
  return r && r.length >= 3 && polygonArea(r) > 20 ? r : null;
}

/** Outward normal of polygon edge i (math-CCW polygon in x/z). */
function edgeNormal(poly: Vec2[], i: number): Vec3 {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  return [dz / l, 0, -dx / l];
}

function walls(
  m: CMesh,
  poly: Vec2[],
  y0: number,
  y1: number,
  base: number,
  mat: number,
  aux: number,
  u0 = 0,
) {
  let u = u0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = dist2(a, b);
    const n = edgeNormal(poly, i);
    m.quad(
      [
        [a[0], y0, a[1]],
        [b[0], y0, b[1]],
        [b[0], y1, b[1]],
        [a[0], y1, a[1]],
      ],
      n,
      [
        [u, y0 - base],
        [u + len, y0 - base],
        [u + len, y1 - base],
        [u, y1 - base],
      ],
      mat,
      aux,
    );
    u += len;
  }
}

function cap(m: CMesh, poly: Vec2[], y: number, mat: number, aux = 0) {
  const idx = triangulate(poly);
  // Roofs get uv along the footprint's axes, so membrane sheets, joints and
  // drains line up with the building rather than the world grid.
  const u = (mat & 0xff) === CM.roof ? obb(poly).u : ([1, 0] as Vec2);
  const ids = poly.map(q =>
    m.vertex(
      [q[0], y, q[1]],
      UP,
      q[0] * u[0] + q[1] * u[1],
      q[1] * u[0] - q[0] * u[1],
      mat,
      aux,
    ),
  );
  for (let i = 0; i < idx.length; i += 3)
    m.triFacing(ids[idx[i]], ids[idx[i + 1]], ids[idx[i + 2]], UP);
}

function parapet(m: CMesh, poly: Vec2[], y: number, h: number, mat: number) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    m.beam([a[0], y + h / 2, a[1]], [b[0], y + h / 2, b[1]], 0.18, h / 2, mat);
  }
}

/**
 * A sign panel: box whose two big faces show atlas sign `id` (id may carry
 * SIGN_* flags). With `sideId` the two end faces show that sign too (cube
 * light boxes); otherwise they are a metal frame.
 */
function signPanel(
  m: CMesh,
  c: Vec3,
  along: Vec3,
  halfLen: number,
  halfH: number,
  thick: number,
  id: number,
  sideId = -1,
) {
  const n: Vec3 = [along[2], 0, -along[0]];
  const P = (s: number, t: number, k: number): Vec3 => [
    c[0] + along[0] * s * halfLen + n[0] * k * thick,
    c[1] + t * halfH,
    c[2] + along[2] * s * halfLen + n[2] * k * thick,
  ];
  const mat = packMat(CM.sign, id);
  // Front (+n) and back (-n) faces carry the sign, mirrored so text reads correctly.
  m.quad(
    [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)],
    n,
    [
      [1, 1],
      [0, 1],
      [0, 0],
      [1, 0],
    ],
    mat,
  );
  m.quad(
    [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)],
    [-n[0], 0, -n[2]],
    [
      [1, 1],
      [0, 1],
      [0, 0],
      [1, 0],
    ],
    mat,
  );
  const frame = packMat(CM.metal);
  m.quad(
    [P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)],
    UP,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    frame,
  );
  m.quad(
    [P(-1, -1, 1), P(1, -1, 1), P(1, -1, -1), P(-1, -1, -1)],
    [0, -1, 0],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    frame,
  );
  const side = sideId >= 0 ? packMat(CM.sign, sideId) : frame;
  const sideUv: Vec2[] =
    sideId >= 0
      ? [
          [1, 1],
          [0, 1],
          [0, 0],
          [1, 0],
        ]
      : [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ];
  m.quad(
    [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)],
    along,
    sideUv,
    side,
  );
  m.quad(
    [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)],
    [-along[0], 0, -along[2]],
    sideUv,
    side,
  );
}

function facadeParam(b: Building, shop: boolean, podium: boolean) {
  return (
    (b.style & 0xffff) |
    (KIND_INDEX[b.kind] << 16) |
    (shop ? 1 << 19 : 0) |
    (podium ? 1 << 20 : 0)
  );
}

/** Horizontal band around a polygon (ledge / cornice), pushed out by `depth`. */
function band(
  m: CMesh,
  poly: Vec2[],
  y: number,
  depth: number,
  thick: number,
  mat: number,
) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    const n = edgeNormal(poly, i);
    const len = dist2(a, c);
    if (len < 0.5) continue;
    const ex = depth / len;
    // Extend each run slightly so corners overlap instead of leaving notches.
    const a2: Vec2 = [a[0] - (c[0] - a[0]) * ex, a[1] - (c[1] - a[1]) * ex];
    const c2: Vec2 = [c[0] + (c[0] - a[0]) * ex, c[1] + (c[1] - a[1]) * ex];
    m.beam(
      [a2[0] + n[0] * depth * 0.5, y, a2[1] + n[2] * depth * 0.5],
      [c2[0] + n[0] * depth * 0.5, y, c2[1] + n[2] * depth * 0.5],
      depth * 0.5,
      thick * 0.5,
      mat,
    );
  }
}

/** Vertical fins along every edge of a polygon. */
function fins(
  m: CMesh,
  poly: Vec2[],
  y0: number,
  y1: number,
  spacing: number,
  depth: number,
  mat: number,
) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    const len = dist2(a, c);
    const n = edgeNormal(poly, i);
    const yaw = Math.atan2(n[0], n[2]);
    const count = Math.floor(len / spacing);
    for (let k = 1; k < count; k++) {
      const t = k / count;
      const p: Vec3 = [
        lerp(a[0], c[0], t) + n[0] * depth * 0.5,
        (y0 + y1) / 2,
        lerp(a[1], c[1], t) + n[2] * depth * 0.5,
      ];
      m.box(p, [0.06, (y1 - y0) / 2, depth * 0.5], mat, yaw);
    }
  }
}

/**
 * Equipment that scales with roof area, so big flat roofs read at their size
 * from the air: AC condenser banks in 2-row grids (about one unit per 120 m²,
 * 4 to 40), and on roofs over 1500 m² 2 to 4 skylight strips (2 x 12 m) and a
 * 3 m stair core. `hole` is a tower standing on this roof (a podium cap);
 * `taken` lists rects [su, sv, hu, hv] in the roof's OBB frame already used.
 * LOD1 merges each bank into one box. Uses its own random stream.
 */
function roofField(
  m: CMesh,
  roof: Vec2[],
  y: number,
  hole: Vec2[] | null,
  seed: number,
  lod: number,
  coreMat: number,
  aux: number,
  taken: number[][] = [],
) {
  const area = polygonArea(roof) - (hole ? polygonArea(hole) : 0);
  if (area < 400) return;
  const rng = new Rng(hash2(seed, 0x700f));
  const box = obb(roof);
  const U = box.u;
  const V: Vec2 = [-U[1], U[0]];
  // CMesh.box: forward (h[2]) runs along U, right (h[0]) along V.
  const yaw = Math.atan2(U[0], U[1]);
  const at = (su: number, sv: number): Vec2 => [
    box.c[0] + U[0] * su + V[0] * sv,
    box.c[1] + U[1] * su + V[1] * sv,
  ];
  const rectPoly = (su: number, sv: number, hu: number, hv: number) => [
    at(su - hu, sv - hv),
    at(su + hu, sv - hv),
    at(su + hu, sv + hv),
    at(su - hu, sv + hv),
  ];
  const fits = (su: number, sv: number, hu: number, hv: number) => {
    for (const [a, c] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [0, 0],
    ]) {
      const q = at(su + a * (hu + 1), sv + c * (hv + 1));
      if (!pointInPolygon(q, roof)) return false;
      if (hole && pointInPolygon(q, hole)) return false;
    }
    if (
      hole &&
      hole.some(q => pointInPolygon(q, rectPoly(su, sv, hu + 1, hv + 1)))
    )
      return false;
    for (const t of taken)
      if (
        Math.abs(su - t[0]) < hu + t[2] + 0.8 &&
        Math.abs(sv - t[1]) < hv + t[3] + 0.8
      )
        return false;
    return true;
  };
  const place = (hu: number, hv: number, tries: number) => {
    if (box.hu < hu + 1 || box.hv < hv + 1) return null;
    for (let k = 0; k < tries; k++) {
      const su = rng.range(-box.hu + hu, box.hu - hu);
      const sv = rng.range(-box.hv + hv, box.hv - hv);
      if (fits(su, sv, hu, hv)) {
        taken.push([su, sv, hu, hv]);
        return [su, sv];
      }
    }
    return null;
  };
  const big = area > 1500;
  if (big) {
    // Stair core.
    const s = place(1.5, 1.5, 12);
    if (s) {
      const q = at(s[0], s[1]);
      m.box([q[0], y + 1.5, q[1]], [1.5, 1.5, 1.5], coreMat, yaw, aux);
    }
    // Skylight strips side by side along U.
    const n = 2 + Math.min(2, Math.floor((area - 1500) / 1500));
    const span = (n - 1) * 3.6;
    const c = place(6, span / 2 + 1, 16);
    if (c) {
      for (let k = 0; k < n; k++) {
        const q = at(c[0], c[1] - span / 2 + k * 3.6);
        m.box([q[0], y + 0.2, q[1]], [1, 0.2, 6], packMat(CM.metal), yaw);
        m.box(
          [q[0], y + 0.42, q[1]],
          [0.9, 0.04, 5.9],
          packMat(CM.glass, 4),
          yaw,
        );
      }
    }
  }
  // AC banks: 2 x up to 6 condensers each, until the area's quota is met
  // (commercial-size units on big roofs).
  let units = Math.max(4, Math.min(40, Math.round(area / 120)));
  const unitMat = (k: number) => packMat(CM.paint, 0xe0 + (k & 3));
  const pitch = big ? 2.0 : 1.4;
  const rowW = big ? 2.4 : 1.6;
  const uh: Vec3 = big ? [0.5, 0.6, 0.85] : [0.4, 0.45, 0.55];
  for (let bank = 0; units > 0 && bank < 10; bank++) {
    const cols = Math.min(6, Math.ceil(units / 2));
    const hu = (cols * pitch) / 2;
    const s = place(hu, rowW, 10);
    if (!s) break;
    units -= cols * 2;
    if (lod > 0) {
      const q = at(s[0], s[1]);
      m.box(
        [q[0], y + uh[1], q[1]],
        [rowW / 2 + uh[0], uh[1], hu - 0.1],
        unitMat(bank),
        yaw,
      );
      continue;
    }
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < cols; k++) {
        const q = at(
          s[0] - hu + pitch / 2 + k * pitch,
          s[1] + (r - 0.5) * rowW,
        );
        m.box([q[0], y + uh[1], q[1]], uh, unitMat(k + bank), yaw);
      }
    }
    // Refrigerant pipe tray alongside the bank.
    const a = at(s[0] - hu, s[1] + rowW - 0.05);
    const d = at(s[0] + hu, s[1] + rowW - 0.05);
    m.beam(
      [a[0], y + 0.18, a[1]],
      [d[0], y + 0.18, d[1]],
      0.1,
      0.1,
      packMat(CM.metal),
    );
  }
  if (!big) return;
  // Air handlers with a duct run, and a cooling tower on the largest roofs.
  const ahus = 1 + Math.min(3, Math.floor(area / 3000));
  for (let k = 0; k < ahus; k++) {
    const s = place(3, 1.5, 8);
    if (!s) break;
    const q = at(s[0], s[1]);
    m.box([q[0], y + 1.1, q[1]], [1.5, 1.1, 3], packMat(CM.paint, 0xe1), yaw);
    if (lod === 0) {
      const e = at(s[0] + 3, s[1]);
      const f = at(s[0] + 3 + Math.min(10, box.hu - s[0] - 4), s[1]);
      if (pointInPolygon(f, roof) && !(hole && pointInPolygon(f, hole)))
        m.beam(
          [e[0], y + 1.4, e[1]],
          [f[0], y + 1.4, f[1]],
          0.45,
          0.35,
          packMat(CM.metal),
        );
    }
  }
  if (area > 3000) {
    const s = place(2.4, 2.4, 8);
    if (s) {
      const q = at(s[0], s[1]);
      m.box(
        [q[0], y + 1.2, q[1]],
        [2.3, 1.2, 2.3],
        packMat(CM.paint, 0xe2),
        yaw,
      );
      m.cylinder(
        [q[0], y + 2.4, q[1]],
        1.9,
        1.2,
        lod === 0 ? 12 : 6,
        packMat(CM.paint, 0xe3),
        true,
      );
    }
  }
}

export function building(
  b: Building,
  m: CMesh,
  lod: number,
  lights: LightList,
  signDensity: number,
) {
  const rng = new Rng(b.seed);
  const fp = b.footprint;
  const base = b.base;
  const top = base + b.height;
  const aux = b.seed;
  const shop = b.density > 0.15 && b.kind !== 'house' && b.kind !== 'glass';
  const concrete = packMat(CM.concrete);
  let roof = fp;
  let roofY = top;

  if (b.kind === 'house') {
    const box = obb(fp);
    const eaves = top - 1.6;
    walls(
      m,
      fp,
      b.low,
      eaves,
      base,
      packMat(CM.facade, facadeParam(b, false, false)),
      aux,
    );
    cap(m, fp, eaves, packMat(CM.roof, b.style & 0xffff), aux);
    // Gable roof over the OBB along its long axis.
    const u = box.hu >= box.hv ? box.u : ([-box.u[1], box.u[0]] as Vec2);
    const hu = Math.max(box.hu, box.hv) + 0.4;
    const hv = Math.min(box.hu, box.hv) + 0.5;
    const v: Vec2 = [-u[1], u[0]];
    const C = box.c;
    const P = (su: number, sv: number, y: number): Vec3 => [
      C[0] + u[0] * su * hu + v[0] * sv * hv,
      y,
      C[1] + u[1] * su * hu + v[1] * sv * hv,
    ];
    const ridge = eaves + hv * 0.55;
    const tileMat = packMat(CM.tile, b.style & 0xffff);
    for (const s of [-1, 1]) {
      const n: Vec3 = [v[0] * s * 0.6, 0.8, v[1] * s * 0.6];
      m.quad(
        [
          P(-1, s, eaves - 0.1),
          P(1, s, eaves - 0.1),
          P(1, 0, ridge),
          P(-1, 0, ridge),
        ],
        n,
        [
          [0, 0],
          [hu * 2, 0],
          [hu * 2, hv],
          [0, hv],
        ],
        tileMat,
      );
      // Gable end triangle.
      const e = m.vertex(
        P(s, -1, eaves - 0.1),
        [u[0] * s, 0, u[1] * s],
        0,
        0,
        packMat(CM.facade, facadeParam(b, false, false)),
        aux,
      );
      const f = m.vertex(
        P(s, 1, eaves - 0.1),
        [u[0] * s, 0, u[1] * s],
        hv * 2,
        0,
        packMat(CM.facade, facadeParam(b, false, false)),
        aux,
      );
      const g = m.vertex(
        P(s, 0, ridge),
        [u[0] * s, 0, u[1] * s],
        hv,
        ridge - eaves,
        packMat(CM.facade, facadeParam(b, false, false)),
        aux,
      );
      m.triFacing(e, f, g, [u[0] * s, 0, u[1] * s]);
    }
    if (lod === 0 && rng.chance(0.5)) {
      // Small AC unit and a garden wall.
      const i = rng.int(0, fp.length);
      const n = edgeNormal(fp, i);
      const a = fp[i],
        c = fp[(i + 1) % fp.length];
      m.box(
        [
          lerp(a[0], c[0], 0.3) + n[0] * 0.35,
          base + 0.4,
          lerp(a[1], c[1], 0.3) + n[2] * 0.35,
        ],
        [0.4, 0.3, 0.15],
        packMat(CM.paint, 0xe0),
        Math.atan2(n[0], n[2]),
      );
    }
    return;
  }

  if (b.kind === 'glass' || b.kind === 'tower') {
    const podFloors = rng.int(2, 5);
    const podTop = base + podFloors * 4.6;
    const towerFp = inset(fp, rng.range(3, 8)) ?? shrink(fp, 0.7);
    walls(
      m,
      fp,
      b.low,
      podTop,
      base,
      packMat(CM.facade, facadeParam(b, true, true)),
      aux,
    );
    cap(m, fp, podTop, packMat(CM.roof, b.style & 0xffff), aux);
    if (lod === 0) parapet(m, fp, podTop, 1.1, concrete);
    roofField(m, fp, podTop, towerFp, b.seed ^ 0x90d, lod, concrete, aux);
    const towerMat =
      b.kind === 'glass'
        ? packMat(CM.glass, facadeParam(b, false, false))
        : packMat(CM.facade, facadeParam(b, false, false));
    let crownFp = towerFp;
    let bodyTop = top;
    if (b.height > 70 && rng.chance(0.7)) {
      const c2 = inset(towerFp, rng.range(2, 4));
      if (c2) {
        bodyTop = top - rng.range(8, 16);
        crownFp = c2;
      }
    }
    walls(m, towerFp, podTop, bodyTop, base, towerMat, aux);
    if (lod === 0) {
      // Vertical fins give the tower facade depth and shadow lines.
      fins(
        m,
        towerFp,
        podTop,
        bodyTop,
        b.kind === 'glass' ? 3.0 : 2.4,
        b.kind === 'glass' ? 0.45 : 0.3,
        packMat(CM.metal),
      );
      band(m, fp, podTop - 0.3, 1.2, 0.35, concrete);
    }
    if (crownFp !== towerFp) {
      cap(m, towerFp, bodyTop, packMat(CM.roof, b.style & 0xffff), aux);
      walls(m, crownFp, bodyTop, top, base, towerMat, aux);
    }
    roof = crownFp;
    roofY = top;
    // Aviation obstruction lights on the corners of tall roofs.
    if (b.height > 60) {
      for (
        let k = 0;
        k < crownFp.length;
        k += Math.max(1, Math.floor(crownFp.length / 4))
      ) {
        const q = crownFp[k];
        m.box([q[0], top + 0.9, q[1]], [0.22, 0.22, 0.22], packMat(CM.lamp, 2));
      }
    }
    // LED crown line (lit at night).
    for (let i = 0; i < roof.length; i++) {
      const a = roof[i],
        c = roof[(i + 1) % roof.length];
      const n = edgeNormal(roof, i);
      m.beam(
        [a[0] + n[0] * 0.05, top - 0.4, a[1] + n[2] * 0.05],
        [c[0] + n[0] * 0.05, top - 0.4, c[1] + n[2] * 0.05],
        0.06,
        0.12,
        packMat(CM.ledLine, b.style & 0xff),
        aux,
      );
    }
    cap(m, roof, roofY, packMat(CM.roof, b.style & 0xffff), aux);
    {
      // Plant around the central helipad / machine room (radius ~9 m).
      const box = obb(roof);
      const c = centroid(roof);
      const d: Vec2 = [c[0] - box.c[0], c[1] - box.c[1]];
      roofField(m, roof, roofY, null, b.seed ^ 0xc70, lod, concrete, aux, [
        [
          d[0] * box.u[0] + d[1] * box.u[1],
          d[1] * box.u[0] - d[0] * box.u[1],
          9.5,
          9.5,
        ],
      ]);
    }
    if (lod === 0) {
      parapet(m, roof, roofY, 1.2, concrete);
      const c = centroid(roof);
      if (b.height > 120 && rng.chance(0.5)) {
        m.cylinder(
          [c[0], roofY, c[1]],
          9,
          0.6,
          16,
          packMat(CM.paint, 0x50),
          true,
        );
        m.cylinder(
          [c[0], roofY + 0.6, c[1]],
          0.25,
          18,
          6,
          packMat(CM.metal),
          false,
        );
      } else {
        m.box(
          [c[0], roofY + 2.5, c[1]],
          [Math.min(8, Math.sqrt(polygonArea(roof)) * 0.25), 2.5, 5],
          packMat(CM.concrete),
          rng.range(0, 3),
        );
      }
    }
    // Big screen on the podium of towers near hubs.
    if (b.density > 0.55 && b.front >= 0 && rng.chance(0.5)) {
      const i = b.front;
      const a = fp[i],
        c = fp[(i + 1) % fp.length];
      const n = edgeNormal(fp, i);
      const len = dist2(a, c);
      const w = Math.min(len * 0.7, 16);
      const mid: Vec2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      const along: Vec3 = [(c[0] - a[0]) / len, 0, (c[1] - a[1]) / len];
      const y = podTop - 4;
      const P = (s: number, t: number): Vec3 => [
        mid[0] + (along[0] * s * w) / 2 + n[0] * 0.3,
        y + t * 3.5,
        mid[1] + (along[2] * s * w) / 2 + n[2] * 0.3,
      ];
      m.quad(
        [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)],
        n,
        [
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
        packMat(CM.screen, b.seed & 0xffff),
      );
      lights.add(
        [mid[0] + n[0] * 6, y, mid[1] + n[2] * 6],
        22,
        [0.6, 0.7, 1.0],
        LightKind.sign,
      );
    }
    return;
  }

  // Midrise, pencil and apartment buildings.
  const setbackTop =
    b.kind !== 'apartment' && b.height > 20 && rng.chance(0.35);
  const mainTop = setbackTop ? top - b.floorH * rng.int(1, 3) : top;
  const wallMat = packMat(CM.facade, facadeParam(b, shop, false));
  walls(m, fp, b.low, mainTop, base, wallMat, aux);
  {
    // Floor ledges (LOD0) and a cornice (all LODs) so the building isn't a box.
    const floors = Math.floor((mainTop - base) / b.floorH);
    const office = b.kind === 'midrise' && rng.chance(0.5);
    if (lod === 0) {
      for (let f = 1; f < floors; f++) {
        const deep = office && f % 3 === 0;
        band(
          m,
          fp,
          base + f * b.floorH + 0.06,
          deep ? 0.35 : 0.18,
          0.12,
          concrete,
        );
      }
    }
    band(m, fp, mainTop - 0.2, 0.4, 0.4, concrete);
  }
  roof = fp;
  roofY = mainTop;
  if (setbackTop) {
    const s = inset(fp, rng.range(1.5, 3));
    if (s) {
      cap(m, fp, mainTop, packMat(CM.roof, b.style & 0xffff), aux);
      walls(m, s, mainTop, top, base, wallMat, aux);
      roof = s;
      roofY = top;
    } else {
      roofY = mainTop;
    }
  }
  cap(m, roof, roofY, packMat(CM.roof, b.style & 0xffff), aux);
  if (lod === 0) parapet(m, roof, roofY, 0.9, concrete);

  // Balconies on apartments.
  if (b.kind === 'apartment' && lod === 0) {
    const floors = Math.floor(b.height / b.floorH);
    for (let i = 0; i < fp.length; i++) {
      if (!b.frontage[i]) continue;
      const a = fp[i],
        c = fp[(i + 1) % fp.length];
      const len = dist2(a, c);
      if (len < 6) continue;
      const n = edgeNormal(fp, i);
      const ia: Vec2 = [lerp(a[0], c[0], 0.05), lerp(a[1], c[1], 0.05)];
      const ic: Vec2 = [lerp(a[0], c[0], 0.95), lerp(a[1], c[1], 0.95)];
      for (let f = 1; f < floors; f++) {
        const y = base + f * b.floorH;
        const o0: Vec3 = [ia[0] + n[0] * 0.6, y, ia[1] + n[2] * 0.6];
        const o1: Vec3 = [ic[0] + n[0] * 0.6, y, ic[1] + n[2] * 0.6];
        m.beam(o0, o1, 0.6, 0.08, concrete);
        m.beam(
          [ia[0] + n[0] * 1.15, y + 0.55, ia[1] + n[2] * 1.15],
          [ic[0] + n[0] * 1.15, y + 0.55, ic[1] + n[2] * 1.15],
          0.04,
          0.5,
          packMat(CM.paint, (b.style >> 4) & 0xff),
          aux,
        );
      }
      break;
    }
  }

  // Business signs (the Tokyo look): stacks of vertical blades protruding
  // from the front, mixed with projecting cube signs, horizontal box signs,
  // small LED screens and hanging cloth banners; fascia boxes and fabric
  // awnings over shops; rooftop billboards.
  if (b.front >= 0 && b.kind !== 'apartment') {
    const i = b.front;
    const a = fp[i],
      c = fp[(i + 1) % fp.length];
    const len = dist2(a, c);
    const n = edgeNormal(fp, i);
    const along: Vec3 = [(c[0] - a[0]) / len, 0, (c[1] - a[1]) / len];
    const floors = Math.floor((mainTop - base) / b.floorH);
    // Sign variety comes from a local stream: the building stream `rng` is
    // drawn exactly as before, so everything generated after is unchanged.
    const sr = new Rng(hash2(b.seed, 0x51c7));
    const wallAt = (t: number, out: number, y: number): Vec3 => [
      lerp(a[0], c[0], t) + n[0] * out,
      y,
      lerp(a[1], c[1], t) + n[2] * out,
    ];
    const vertical = Math.round(
      b.density * 5 * signDensity * rng.range(0.5, 1.4) +
        (b.kind === 'pencil' ? 2 : 0),
    );
    // Tokyo stacks: several tenant signs per facade at different floors.
    const slots = [0.1, 0.9, 0.5, 0.3, 0.7];
    for (let k = 0; k < Math.min(vertical, 6); k++) {
      const t = clamp(
        slots[k % slots.length] + (k >= 5 ? 0.05 : 0) + sr.range(-0.04, 0.04),
        0.04,
        0.96,
      );
      const span = Math.min(floors - 1, rng.int(2, 6));
      if (span < 1) continue;
      const startFloor = k < 2 ? 1 : rng.int(1, Math.max(2, floors - span));
      const id = SIGN.vertical.first + rng.int(0, SIGN.vertical.count);
      const lit = rng.chance(0.6);
      const y0 = base + b.floorH * (startFloor + 0.2);
      const hgt = span * b.floorH * 0.9;
      // Mostly blades, but not exclusively.
      const roll = sr.next();
      const style =
        k < 2
          ? roll < 0.72
            ? 'blade'
            : 'cube'
          : roll < 0.5
            ? 'blade'
            : roll < 0.65
              ? 'cube'
              : roll < 0.82 && len > 6
                ? 'box'
                : roll < 0.92
                  ? 'led'
                  : 'banner';
      let lightY = y0 + 1;
      if (style === 'blade') {
        // Blades vary in depth off the wall, width, thickness and length.
        const halfW = sr.range(0.4, 0.78);
        const out = sr.range(0.3, 0.55) + halfW;
        const h2 = hgt * sr.range(0.65, 1);
        const p = wallAt(t, out, y0 + h2 / 2);
        // The panel runs perpendicular to the facade.
        signPanel(m, p, n, halfW, h2 / 2, sr.range(0.1, 0.2), id);
        if (lod === 0) {
          for (const e of [-0.42, 0.42]) {
            m.beam(
              wallAt(t, 0, p[1] + e * h2),
              wallAt(t, out - halfW, p[1] + e * h2),
              0.04,
              0.04,
              packMat(CM.metal),
            );
          }
        }
      } else if (style === 'cube') {
        // Projecting light box on a bracket, sign on all four sides.
        const hs = sr.range(0.42, 0.75);
        const out = 0.35 + hs;
        const y = y0 + hs + sr.range(0, Math.max(0, hgt - hs * 2));
        const sq = SIGN.square.first + ((id + k * 5) % SIGN.square.count);
        signPanel(m, wallAt(t, out, y), n, hs, hs, hs * 0.85, sq, sq);
        m.beam(
          wallAt(t, 0, y + hs * 0.6),
          wallAt(t, 0.36, y + hs * 0.6),
          0.05,
          0.05,
          packMat(CM.metal),
        );
        lightY = y;
      } else if (style === 'box') {
        // Horizontal box sign across part of the facade at a tenant floor.
        const halfW = Math.min(len * sr.range(0.18, 0.32), 4.5);
        const tc = clamp(t, halfW / len + 0.02, 1 - halfW / len - 0.02);
        const halfH = sr.range(0.35, 0.6);
        const y = base + b.floorH * (startFloor + sr.range(0.15, 0.6));
        const hid = SIGN.horizontal.first + (id % SIGN.horizontal.count);
        signPanel(
          m,
          wallAt(tc, sr.range(0.2, 0.45), y),
          along,
          halfW,
          halfH,
          0.16,
          hid,
        );
        lightY = y;
      } else if (style === 'led') {
        // Small LED screen flush on the facade in a metal case.
        const w = sr.range(1.4, 2.6);
        const hh = w * sr.range(0.5, 0.65);
        const tc = clamp(t, w / len + 0.02, 1 - w / len - 0.02);
        const y = base + b.floorH * (startFloor + 0.5);
        const q = wallAt(tc, 0.12, y);
        m.box(
          q,
          [w / 2 + 0.08, hh / 2 + 0.08, 0.1],
          packMat(CM.metal),
          Math.atan2(n[0], n[2]),
        );
        const P = (s: number, u: number): Vec3 => [
          q[0] + (along[0] * s * w) / 2 + n[0] * 0.11,
          y + (u * hh) / 2,
          q[2] + (along[2] * s * w) / 2 + n[2] * 0.11,
        ];
        m.quad(
          [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)],
          n,
          [
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
          packMat(CM.screen, (b.seed + k * 31) & 0xffff),
        );
        lightY = y;
      } else {
        // Hanging cloth banner on a pole arm (unlit, printed).
        const out = sr.range(0.6, 0.9);
        const h2 = Math.min(hgt * 0.8, sr.range(2.5, 4.5));
        const p = wallAt(t, out, y0 + h2 / 2);
        signPanel(m, p, n, 0.32, h2 / 2, 0.01, id | SIGN_FABRIC);
        m.beam(
          wallAt(t, 0, p[1] + h2 / 2 + 0.05),
          wallAt(t, out + 0.4, p[1] + h2 / 2 + 0.05),
          0.025,
          0.025,
          packMat(CM.metal),
        );
      }
      if (lit && style !== 'banner')
        lights.add(wallAt(t, 1.95, lightY), 8, signColor(id), LightKind.sign);
    }
    // Signs on the side walls near the street corner.
    if (b.density > 0.3 && floors > 2) {
      for (const di of [-1, 1]) {
        const j = (i + (di > 0 ? 1 : fp.length - 1)) % fp.length;
        if (!rng.chance(0.5 * signDensity)) continue;
        const a2 = fp[j];
        const c2 = fp[(j + 1) % fp.length];
        const n2 = edgeNormal(fp, j);
        const t = di > 0 ? 0.12 : 0.88;
        const span = Math.min(floors - 1, rng.int(2, 5));
        const y0 = base + b.floorH * 1.2;
        const hgt = span * b.floorH * 0.9;
        const id = SIGN.vertical.first + rng.int(0, SIGN.vertical.count);
        const at = (out: number, y: number): Vec3 => [
          lerp(a2[0], c2[0], t) + n2[0] * out,
          y,
          lerp(a2[1], c2[1], t) + n2[2] * out,
        ];
        if (sr.chance(0.25)) {
          const hs = sr.range(0.5, 0.8);
          const sq = SIGN.square.first + (id % SIGN.square.count);
          signPanel(m, at(0.35 + hs, y0 + hs), n2, hs, hs, hs * 0.85, sq, sq);
        } else {
          const halfW = sr.range(0.4, 0.65);
          const h2 = hgt * sr.range(0.7, 1);
          signPanel(
            m,
            at(0.25 + halfW, y0 + h2 / 2),
            n2,
            halfW,
            h2 / 2,
            0.12,
            id,
          );
        }
      }
    }
    if (shop && len > 4) {
      const id = SIGN.horizontal.first + rng.int(0, SIGN.horizontal.count);
      // Fascia box sign: depth, height and width vary; wide frontages
      // sometimes carry two tenants side by side.
      const two = len > 9 && sr.chance(0.3);
      const halfH = sr.range(0.35, 0.6);
      const out = sr.range(0.18, 0.5);
      const y = base + b.floorH * 0.95 + (halfH - 0.45) * 0.5;
      if (two) {
        const halfW = Math.min(len * 0.2, 4);
        signPanel(m, wallAt(0.26, out, y), along, halfW, halfH, 0.16, id);
        const id2 = SIGN.horizontal.first + ((id + 5) % SIGN.horizontal.count);
        signPanel(
          m,
          wallAt(0.74, out, y),
          along,
          halfW,
          halfH * 0.85,
          0.16,
          id2,
        );
      } else {
        const halfW = Math.min(len * sr.range(0.3, 0.44), 6);
        signPanel(m, wallAt(0.5, out, y), along, halfW, halfH, 0.16, id);
      }
      if (lod === 0) {
        const ay = base + b.floorH * 0.72;
        const aStyle = sr.next();
        if (aStyle < 0.55) {
          // Sloped fabric awning: striped canvas with a printed valance.
          const t0 = sr.range(0.06, 0.2),
            t1 = 1 - sr.range(0.06, 0.2);
          const reach = sr.range(1.0, 1.5);
          const drop = reach * sr.range(0.35, 0.55);
          const W = (t: number, o: number, y2: number) => wallAt(t, o, y2);
          const q = [
            W(t0, 0.15, ay),
            W(t1, 0.15, ay),
            W(t1, reach, ay - drop),
            W(t0, reach, ay - drop),
          ];
          const span = (t1 - t0) * len * 2;
          const uv: Vec2[] = [
            [0, 0],
            [span, 0],
            [span, 1],
            [0, 1],
          ];
          const nl = Math.hypot(drop, reach - 0.15);
          const up: Vec3 = [
            (n[0] * drop) / nl,
            (reach - 0.15) / nl,
            (n[2] * drop) / nl,
          ];
          const mat = packMat(CM.sign, ((id * 3 + 1) & 0xff) | SIGN_STRIPES);
          m.quad(q, up, uv, mat);
          m.quad(q, [-up[0], -up[1], -up[2]], uv, mat);
          const vid =
            SIGN.horizontal.first + ((id + 3) % SIGN.horizontal.count);
          const vm = (t0 + t1) / 2;
          signPanel(
            m,
            wallAt(vm, reach, ay - drop - 0.14),
            along,
            ((t1 - t0) * len) / 2,
            0.14,
            0.01,
            vid | SIGN_FABRIC,
          );
        } else if (aStyle < 0.85) {
          // Flat painted canopy.
          m.beam(
            wallAt(0.08, 0.8, ay),
            wallAt(0.92, 0.8, ay),
            0.8,
            0.05,
            packMat(CM.paint, (b.seed >> 8) & 0xff),
            aux,
          );
        }
        // Nobori: cloth banners on poles in front of the shop.
        if (b.density > 0.3 && sr.chance(0.3)) {
          const count = sr.int(2, 4);
          for (let f = 0; f < count; f++) {
            const t = 0.15 + (0.7 * (f + 0.5)) / count;
            const g = wallAt(t, sr.range(1.0, 1.3), base);
            m.cylinder(
              [g[0], g[1] - SINK, g[2]],
              0.02,
              2.5 + SINK,
              4,
              packMat(CM.metal),
              false,
            );
            const fid =
              SIGN.vertical.first + ((id * 5 + f) % SIGN.vertical.count);
            signPanel(
              m,
              [g[0] + along[0] * 0.27, base + 1.5, g[2] + along[2] * 0.27],
              along,
              0.25,
              0.85,
              0.005,
              fid | SIGN_FABRIC,
            );
          }
        }
      }
    }
    const billboard =
      b.density > 0.4 && b.height < 60 && rng.chance(0.1 * signDensity);
    if (billboard) {
      const id = SIGN.billboard.first + rng.int(0, SIGN.billboard.count);
      const c2 = centroid(roof);
      const w = Math.min(len * 0.45, 7);
      const p: Vec3 = [c2[0], roofY + 3 + w * 0.25, c2[1]];
      signPanel(m, p, along, w, w * 0.5, 0.15, id);
      m.box([p[0], roofY + 1.5, p[2]], [0.15, 1.5, 0.15], packMat(CM.metal));
      lights.add(
        [p[0] + n[0] * 4, p[1], p[2] + n[2] * 4],
        14,
        signColor(id),
        LightKind.sign,
      );
    } else if (
      b.density > 0.35 &&
      b.height < 45 &&
      len > 5 &&
      sr.chance(0.16 * signDensity)
    ) {
      // Rooftop sign on a steel frame near the front edge: a wide billboard,
      // an LED board or a tall vertical tower sign.
      const kind = sr.next();
      const c2 = centroid(roof);
      const fr = wallAt(0.5, 0, 0);
      const back = Math.min(2.5, dist2([fr[0], fr[2]], c2));
      const toC = Math.hypot(c2[0] - fr[0], c2[1] - fr[2]) || 1;
      const ox = fr[0] + ((c2[0] - fr[0]) / toC) * back;
      const oz = fr[2] + ((c2[1] - fr[2]) / toC) * back;
      const lift = sr.range(1.2, 2.5);
      const metal = packMat(CM.metal);
      if (kind < 0.3) {
        const hh = sr.range(2.5, 4.5);
        const p: Vec3 = [ox, roofY + lift + hh, oz];
        const vid = SIGN.vertical.first + sr.int(0, SIGN.vertical.count);
        signPanel(m, p, n, hh * 0.26, hh, 0.25, vid);
        m.box([ox, roofY + lift / 2, oz], [0.12, lift / 2, 0.12], metal);
      } else {
        const w = Math.min(len * sr.range(0.3, 0.45), 6.5);
        const hh = w * sr.range(0.3, 0.5);
        const p: Vec3 = [ox, roofY + lift + hh, oz];
        if (kind < 0.55) {
          const P = (s: number, u: number): Vec3 => [
            ox + along[0] * s * w,
            p[1] + u * hh,
            oz + along[2] * s * w,
          ];
          m.box(
            [ox, p[1], oz],
            [w + 0.1, hh + 0.1, 0.15],
            metal,
            Math.atan2(n[0], n[2]),
          );
          m.quad(
            [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)].map((q): Vec3 => [
              q[0] + n[0] * 0.16,
              q[1],
              q[2] + n[2] * 0.16,
            ]),
            n,
            [
              [0, 1],
              [1, 1],
              [1, 0],
              [0, 0],
            ],
            packMat(CM.screen, (b.seed >> 4) & 0xffff),
          );
        } else {
          const bid = SIGN.billboard.first + sr.int(0, SIGN.billboard.count);
          signPanel(m, p, along, w, hh, 0.15, bid);
        }
        // Legs and a cross brace behind the board.
        for (const s of [-0.7, 0.7]) {
          const lx = ox + along[0] * s * w - n[0] * 0.4;
          const lz = oz + along[2] * s * w - n[2] * 0.4;
          m.box(
            [lx, roofY + (lift + hh) / 2, lz],
            [0.1, (lift + hh) / 2, 0.1],
            metal,
          );
        }
        m.beam(
          [
            ox - along[0] * 0.7 * w - n[0] * 0.4,
            roofY + 0.3,
            oz - along[2] * 0.7 * w - n[2] * 0.4,
          ],
          [
            ox + along[0] * 0.7 * w - n[0] * 0.4,
            roofY + lift + hh,
            oz + along[2] * 0.7 * w - n[2] * 0.4,
          ],
          0.05,
          0.05,
          metal,
        );
      }
    }
  }

  // Facade clutter: AC condensers under windows and external fire escapes.
  if (lod === 0) {
    const floors = Math.floor((mainTop - base) / b.floorH);
    for (let i = 0; i < fp.length; i++) {
      if (i === b.front) continue;
      const a = fp[i],
        c = fp[(i + 1) % fp.length];
      const len = dist2(a, c);
      if (len < 5) continue;
      const n = edgeNormal(fp, i);
      const yaw = Math.atan2(n[0], n[2]);
      const units = Math.min(8, Math.floor(len / 4) * Math.min(floors, 6));
      for (let k = 0; k < units; k++) {
        if (!rng.chance(0.35)) continue;
        const t = rng.range(0.1, 0.9);
        const f = rng.int(1, Math.max(2, floors));
        const y = base + f * b.floorH + 0.35;
        m.box(
          [
            lerp(a[0], c[0], t) + n[0] * 0.3,
            y,
            lerp(a[1], c[1], t) + n[2] * 0.3,
          ],
          [0.4, 0.3, 0.15],
          packMat(CM.paint, 0xe0),
          yaw,
        );
      }
    }
    if (
      (b.kind === 'pencil' || (b.kind === 'midrise' && rng.chance(0.25))) &&
      floors >= 3
    ) {
      // Exterior staircase on a side wall: landings per floor with railings.
      const i = (b.front + 1) % fp.length;
      const a = fp[i],
        c = fp[(i + 1) % fp.length];
      const len = dist2(a, c);
      if (len > 4) {
        const n = edgeNormal(fp, i);
        const along: Vec3 = [(c[0] - a[0]) / len, 0, (c[1] - a[1]) / len];
        const yaw = Math.atan2(n[0], n[2]);
        const mid: Vec2 = [lerp(a[0], c[0], 0.7), lerp(a[1], c[1], 0.7)];
        for (let f = 1; f < floors; f++) {
          const y = base + f * b.floorH;
          const p: Vec3 = [mid[0] + n[0] * 0.75, y, mid[1] + n[2] * 0.75];
          m.box(p, [1.3, 0.06, 0.7], packMat(CM.metal), yaw);
          m.beam(
            [
              p[0] - along[0] * 1.3 + n[0] * 0.7,
              y + 0.55,
              p[2] - along[2] * 1.3 + n[2] * 0.7,
            ],
            [
              p[0] + along[0] * 1.3 + n[0] * 0.7,
              y + 0.55,
              p[2] + along[2] * 1.3 + n[2] * 0.7,
            ],
            0.03,
            0.5,
            packMat(CM.paint, 0x80),
          );
          // Stair flight to the next landing.
          const s0: Vec3 = [p[0] - along[0] * 1.1, y, p[2] - along[2] * 1.1];
          const s1: Vec3 = [
            p[0] + along[0] * 1.1,
            y + b.floorH,
            p[2] + along[2] * 1.1,
          ];
          m.beam(s0, s1, 0.45, 0.05, packMat(CM.metal));
        }
      }
    }
  }

  // Roof clutter.
  if (lod === 0) {
    const c = centroid(roof);
    if (rng.chance(0.45)) {
      const q: Vec2 = [
        lerp(c[0], roof[0][0], 0.5),
        lerp(c[1], roof[0][1], 0.5),
      ];
      m.cylinder(
        [q[0], roofY + 1.2, q[1]],
        1.1,
        2.2,
        8,
        packMat(CM.paint, 0xd0),
        true,
      );
      for (const [dx, dz] of [
        [-0.7, -0.7],
        [0.7, -0.7],
        [0.7, 0.7],
        [-0.7, 0.7],
      ]) {
        m.box(
          [q[0] + dx, roofY + 0.6, q[1] + dz],
          [0.06, 0.6, 0.06],
          packMat(CM.metal),
        );
      }
    }
    const area = polygonArea(roof);
    const box = obb(roof);
    const yaw = Math.atan2(box.u[0], box.u[1]);
    const R: Vec2 = box.u;
    const F: Vec2 = [-box.u[1], box.u[0]];
    const at = (su: number, sv: number): Vec2 => [
      box.c[0] + R[0] * su + F[0] * sv,
      box.c[1] + R[1] * su + F[1] * sv,
    ];
    // AC condenser arrays in rows (big roofs get roofField's banks instead).
    const field = area >= 400;
    const nUnits = rng.int(4, 12);
    const units = field ? 0 : Math.min(14, nUnits * Math.min(1, area / 300));
    const rows = rng.chance(0.6) ? 2 : 1;
    const su0 = rng.range(-box.hu * 0.6, box.hu * 0.2);
    const sv0 = rng.range(-box.hv * 0.5, box.hv * 0.3);
    for (let k = 0; k < units; k++) {
      const q = at(
        su0 + (k % Math.ceil(units / rows)) * 1.4,
        sv0 + Math.floor(k / Math.ceil(units / rows)) * 1.6,
      );
      if (!pointInPolygon(q, roof)) continue;
      m.box(
        [q[0], roofY + 0.45, q[1]],
        [0.55, 0.45, 0.4],
        packMat(CM.paint, 0xe0 + (k & 3)),
        yaw,
      );
    }
    // Stair / elevator housing.
    if (b.height > 15) {
      const q = at(box.hu * 0.45, -box.hv * 0.4);
      if (pointInPolygon(q, roof)) {
        m.box(
          [q[0], roofY + 1.6, q[1]],
          [1.6, 1.6, 1.6],
          packMat(CM.facade, (b.style & 0xffff) | (KIND_INDEX[b.kind] << 16)),
          yaw,
          aux,
        );
      }
    }
    // Safety rails.
    if (rng.chance(0.5)) {
      for (let i = 0; i < roof.length; i++) {
        const a = roof[i];
        const d = roof[(i + 1) % roof.length];
        const n = edgeNormal(roof, i);
        m.beam(
          [a[0] - n[0] * 0.5, roofY + 2.0, a[1] - n[2] * 0.5],
          [d[0] - n[0] * 0.5, roofY + 2.0, d[1] - n[2] * 0.5],
          0.03,
          0.03,
          packMat(CM.paint, 0x80),
        );
      }
    }
    // Solar array on low roofs.
    if (b.height < 25 && rng.chance(0.2)) {
      for (let k = 0; k < 4; k++) {
        const q = at(-box.hu * 0.3 + k * 2.2, box.hv * 0.35);
        if (pointInPolygon(q, roof))
          m.box(
            [q[0], roofY + 0.5, q[1]],
            [1.0, 0.04, 0.8],
            packMat(CM.glass, 4),
            yaw,
          );
      }
    }
    // Pipe run.
    if (rng.chance(0.4)) {
      const a = at(-box.hu * 0.7, sv0 - 1.2);
      const d = at(box.hu * 0.7, sv0 - 1.2);
      if (pointInPolygon(a, roof) && pointInPolygon(d, roof))
        m.beam(
          [a[0], roofY + 0.25, a[1]],
          [d[0], roofY + 0.25, d[1]],
          0.12,
          0.12,
          packMat(CM.metal),
        );
    }
    if (field)
      roofField(
        m,
        roof,
        roofY,
        null,
        b.seed,
        0,
        packMat(CM.facade, (b.style & 0xffff) | (KIND_INDEX[b.kind] << 16)),
        aux,
        roofTaken(roof),
      );
  } else if (b.height > 10) {
    // Distant roofs: a coarse silhouette of the same clutter (stair housing,
    // a merged block of AC units, a water tank) so skylines aren't bare boxes.
    const area = polygonArea(roof);
    if (area > 80) {
      const box = obb(roof);
      const yaw = Math.atan2(box.u[0], box.u[1]);
      const at = (su: number, sv: number): Vec2 => [
        box.c[0] + box.u[0] * su - box.u[1] * sv,
        box.c[1] + box.u[1] * su + box.u[0] * sv,
      ];
      const h = at(box.hu * 0.45, -box.hv * 0.4);
      if (b.height > 15 && pointInPolygon(h, roof))
        m.box(
          [h[0], roofY + 1.6, h[1]],
          [1.6, 1.6, 1.6],
          packMat(CM.facade, (b.style & 0xffff) | (KIND_INDEX[b.kind] << 16)),
          yaw,
          aux,
        );
      const ac = at(-box.hu * 0.2, box.hv * 0.25);
      if (area < 400 && pointInPolygon(ac, roof))
        m.box(
          [ac[0], roofY + 0.45, ac[1]],
          [Math.min(box.hu * 0.4, 4), 0.45, Math.min(box.hv * 0.25, 1.6)],
          packMat(CM.paint, 0xe0),
          yaw,
        );
      if (rng.chance(0.35)) {
        const t = at(-box.hu * 0.5, -box.hv * 0.3);
        if (pointInPolygon(t, roof))
          m.cylinder(
            [t[0], roofY, t[1]],
            1.1,
            3.2,
            6,
            packMat(CM.paint, 0xd0),
            true,
          );
      }
      roofField(
        m,
        roof,
        roofY,
        null,
        b.seed,
        1,
        packMat(CM.facade, (b.style & 0xffff) | (KIND_INDEX[b.kind] << 16)),
        aux,
        roofTaken(roof),
      );
    }
  }
}

/**
 * Roof spots (OBB frame rects [su, sv, hu, hv]) used by the fixed clutter in
 * building(): stair housing, water tanks (both LODs' spots) and solar array.
 */
function roofTaken(roof: Vec2[]): number[][] {
  const box = obb(roof);
  const c = centroid(roof);
  const t: Vec2 = [lerp(c[0], roof[0][0], 0.5), lerp(c[1], roof[0][1], 0.5)];
  const d: Vec2 = [t[0] - box.c[0], t[1] - box.c[1]];
  return [
    [box.hu * 0.45, -box.hv * 0.4, 1.6, 1.6],
    [-box.hu * 0.5, -box.hv * 0.3, 1.2, 1.2],
    [
      d[0] * box.u[0] + d[1] * box.u[1],
      d[1] * box.u[0] - d[0] * box.u[1],
      1.2,
      1.2,
    ],
    [-box.hu * 0.3 + 3.3, box.hv * 0.35, 4.4, 0.6],
  ];
}

// ---------------------------------------------------------------------------
// Props

/** Street tree species (leaf/foliage material param; tinted in the shader). */
export const TREE = {zelkova: 0, ginkgo: 1, columnar: 2} as const;

/**
 * Species from position: runs of one species along a street (coarse cell
 * hash; Tokyo tends to plant a street with a single species), plus a few
 * odd ones out.
 */
export function treeSpecies(x: number, z: number): number {
  const cell = hash2(Math.floor(x / 90), Math.floor(z / 90)) % 100;
  const own = hash2(Math.floor(x * 4), Math.floor(z * 4)) % 100;
  const pick = own < 18 ? (own * 37) % 100 : cell;
  return pick < 45 ? TREE.zelkova : pick < 75 ? TREE.ginkgo : TREE.columnar;
}

const TREE_SHAPE = [
  // zelkova: broad vase, crowns widen and spread as they rise.
  {trunk: 0.4, r0: 0.22, r1: 0.32, spread: 0.075, step: 0.38, taper: -0.12},
  // ginkgo: loose upright cone, crowns shrink toward the top.
  {trunk: 0.3, r0: 0.2, r1: 0.25, spread: 0.05, step: 0.5, taper: 0.3},
  // columnar (pruned street tree): narrow stacked column.
  {trunk: 0.22, r0: 0.14, r1: 0.17, spread: 0.02, step: 0.62, taper: 0.1},
];

export function tree(m: CMesh, p: Vec3, h: number, lod: number, rng: Rng) {
  // Take exactly one value from the caller's stream, so whatever is placed
  // after a tree does not depend on its species or LOD; the crown is built
  // from a local stream.
  const aux = rng.nextU32();
  const lr = new Rng(aux ^ hash2(Math.floor(p[0] * 8), Math.floor(p[2] * 8)));
  const sp = treeSpecies(p[0], p[2]);
  const S = TREE_SHAPE[sp];
  const trunkH = h * S.trunk;
  m.cylinder(
    [p[0], p[1] - SINK, p[2]],
    0.12 + h * 0.012,
    trunkH + 0.5 + SINK + (sp === TREE.zelkova ? 0 : h * 0.3),
    lod === 0 ? 6 : 4,
    packMat(CM.bark),
    false,
  );
  if (lod !== 0) {
    // Far LOD: one crown with the species' overall proportions.
    const r = h * (S.r0 + S.r1) * 0.55;
    const c: Vec3 = [p[0], p[1] + trunkH + r * (0.6 + S.step * 0.8), p[2]];
    blob(m, c, r * 0.62, 0, aux, lr, sp);
    leafCards(m, c, r, 4, aux, lr, 1, sp);
    return;
  }
  for (let k = 0; k < 4; k++) {
    const t = k / 3 - 0.5;
    const r = h * lr.range(S.r0, S.r1) * (1 - S.taper * t * 2);
    const c: Vec3 = [
      p[0] + lr.range(-1, 1) * h * S.spread * (1 + t),
      p[1] + trunkH + r * 0.6 + h * S.step * 0.3 * k,
      p[2] + lr.range(-1, 1) * h * S.spread * (1 + t),
    ];
    blob(m, c, r * 0.48, 0, aux, lr, sp);
    // Many smaller cards toward the crown surface give a broken, leafy
    // silhouette instead of a few big clumps.
    leafCards(m, c, r, 16, aux, lr, 0.62, sp);
  }
}

/** Alpha-tested leaf cards around a crown center with spherical normals. */
function leafCards(
  m: CMesh,
  c: Vec3,
  r: number,
  count: number,
  aux: number,
  rng: Rng,
  scale = 1,
  species = 0,
) {
  const mat = packMat(CM.leaves, species);
  for (let k = 0; k < count; k++) {
    // Random point in the crown and a random card orientation.
    const u = rng.range(-1, 1);
    const th = rng.range(0, Math.PI * 2);
    const s = Math.sqrt(1 - u * u);
    const off: Vec3 = [s * Math.cos(th), u * 0.8, s * Math.sin(th)];
    const d = rng.range(0.25, 0.7) * r * (scale < 1 ? 1.3 : 1);
    const q: Vec3 = [c[0] + off[0] * d, c[1] + off[1] * d, c[2] + off[2] * d];
    const yaw = rng.range(0, Math.PI);
    const tilt = rng.range(-0.6, 0.6);
    const ax: Vec3 = [Math.cos(yaw), 0, Math.sin(yaw)];
    const ay: Vec3 = [
      -Math.sin(yaw) * Math.sin(tilt),
      Math.cos(tilt),
      Math.cos(yaw) * Math.sin(tilt),
    ];
    const sz = r * rng.range(0.75, 1.05) * scale;
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const ids = corners.map(([a, b]) => {
      const pp: Vec3 = [
        q[0] + (ax[0] * a + ay[0] * b) * sz,
        q[1] + (ax[1] * a + ay[1] * b) * sz,
        q[2] + (ax[2] * a + ay[2] * b) * sz,
      ];
      let nn: Vec3 = [
        pp[0] - c[0],
        (pp[1] - c[1]) * 1.3 + r * 0.3,
        pp[2] - c[2],
      ];
      const l = Math.hypot(nn[0], nn[1], nn[2]) || 1;
      nn = [nn[0] / l, nn[1] / l, nn[2] / l];
      return m.vertex(pp, nn, (a + 1) / 2, (1 - b) / 2, mat, aux);
    });
    // Double-sided: emit both windings.
    m.tri(ids[0], ids[1], ids[2]);
    m.tri(ids[0], ids[2], ids[3]);
    m.tri(ids[0], ids[2], ids[1]);
    m.tri(ids[0], ids[3], ids[2]);
  }
}

/** Lumpy sphere for foliage (subdivided octahedron with noise). */
function blob(
  m: CMesh,
  c: Vec3,
  r: number,
  subdiv: number,
  aux: number,
  rng: Rng,
  species = 0,
) {
  let tris: Vec3[][] = [];
  const V: Vec3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const F = [
    [0, 2, 4],
    [4, 2, 1],
    [1, 2, 5],
    [5, 2, 0],
    [4, 3, 0],
    [1, 3, 4],
    [5, 3, 1],
    [0, 3, 5],
  ];
  tris = F.map(f => f.map(i => V[i]));
  const nrm = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  for (let s = 0; s < subdiv; s++) {
    const next: Vec3[][] = [];
    for (const [a, b, d] of tris) {
      const ab = nrm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
      const bd = nrm([(b[0] + d[0]) / 2, (b[1] + d[1]) / 2, (b[2] + d[2]) / 2]);
      const da = nrm([(d[0] + a[0]) / 2, (d[1] + a[1]) / 2, (d[2] + a[2]) / 2]);
      next.push([a, ab, da], [ab, b, bd], [da, bd, d], [ab, bd, da]);
    }
    tris = next;
  }
  const jit = new Map<string, number>();
  const disp = (v: Vec3) => {
    const k = v.map(x => x.toFixed(3)).join();
    let j = jit.get(k);
    if (j === undefined) jit.set(k, (j = rng.range(0.82, 1.12)));
    return j;
  };
  const mat = packMat(CM.foliage, species);
  for (const t of tris) {
    const ids = t.map(v => {
      const d = disp(v) * r;
      return m.vertex(
        [c[0] + v[0] * d, c[1] + v[1] * d * 0.85, c[2] + v[2] * d],
        v,
        v[0],
        v[2],
        mat,
        aux,
      );
    });
    const ctr = nrm([
      (t[0][0] + t[1][0] + t[2][0]) / 3,
      (t[0][1] + t[1][1] + t[2][1]) / 3,
      (t[0][2] + t[1][2] + t[2][2]) / 3,
    ]);
    m.triFacing(ids[0], ids[1], ids[2], ctr);
  }
}

/** How far street furniture extends below the sidewalk so slopes show no gap. */
const SINK = 0.3;

function streetLight(
  m: CMesh,
  p: Vec3,
  dir: Vec2,
  kind: number,
  sodium: boolean,
) {
  const h = kind >= 2 ? 9 : 6.5;
  const reach = kind >= 2 ? 2.2 : 1.2;
  m.cylinder(
    [p[0], p[1] - SINK, p[2]],
    0.09,
    h + SINK,
    6,
    packMat(CM.metal),
    false,
  );
  const top: Vec3 = [p[0], p[1] + h, p[2]];
  const head: Vec3 = [
    p[0] + dir[0] * reach,
    p[1] + h - 0.1,
    p[2] + dir[1] * reach,
  ];
  m.beam(top, head, 0.05, 0.05, packMat(CM.metal));
  m.box(
    [head[0], head[1] - 0.12, head[2]],
    [0.3, 0.08, 0.18],
    packMat(CM.lamp, sodium ? 0 : 1),
    Math.atan2(dir[0], dir[1]),
  );
}

function signal(
  m: CMesh,
  p: Vec3,
  armDir: Vec2,
  reach: number,
  phase: number,
  group: number,
) {
  // Japanese-style horizontal signal head on an arm over the road.
  m.cylinder(
    [p[0], p[1] - SINK, p[2]],
    0.12,
    6.2 + SINK,
    8,
    packMat(CM.paint, 0x90),
    false,
  );
  const top: Vec3 = [p[0], p[1] + 5.8, p[2]];
  const end: Vec3 = [
    p[0] + armDir[0] * reach,
    p[1] + 5.8,
    p[2] + armDir[1] * reach,
  ];
  m.beam(top, end, 0.06, 0.06, packMat(CM.paint, 0x90));
  // Head faces back toward oncoming traffic (perpendicular to the arm).
  const face: Vec2 = [armDir[1], -armDir[0]];
  const yaw = Math.atan2(armDir[0], armDir[1]);
  const hc: Vec3 = [
    end[0] - armDir[0] * 0.8,
    end[1] - 0.1,
    end[2] - armDir[1] * 0.8,
  ];
  m.box(
    hc,
    [0.85, 0.22, 0.14],
    packMat(CM.paint, 0x91),
    yaw + Math.PI / 2 + Math.PI / 2,
  );
  for (let k = 0; k < 3; k++) {
    const off = (k - 1) * 0.55;
    const lp: Vec3 = [
      hc[0] - armDir[0] * off + face[0] * 0.15,
      hc[1],
      hc[2] - armDir[1] * off + face[1] * 0.15,
    ];
    // param: lamp (0 green/blue, 1 yellow, 2 red) | group << 2 | phase << 3
    m.box(
      lp,
      [0.17, 0.17, 0.03],
      packMat(CM.signal, k | (group << 2) | ((phase & 0xff) << 3)),
      Math.atan2(face[0], face[1]),
    );
  }
}

function utilityPole(m: CMesh, p: Vec3) {
  m.cylinder(
    [p[0], p[1] - SINK, p[2]],
    0.16,
    10 + SINK,
    6,
    packMat(CM.concrete),
    false,
  );
  m.beam(
    [p[0] - 0.8, p[1] + 9, p[2]],
    [p[0] + 0.8, p[1] + 9, p[2]],
    0.05,
    0.05,
    packMat(CM.metal),
  );
  m.cylinder(
    [p[0] + 0.3, p[1] + 7.2, p[2] + 0.25],
    0.22,
    0.9,
    6,
    packMat(CM.paint, 0xa0),
    true,
  );
}

function wireSag(m: CMesh, a: Vec3, b: Vec3, sag: number) {
  const n = 5;
  let prev = a;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const q: Vec3 = [
      lerp(a[0], b[0], t),
      lerp(a[1], b[1], t) - sag * 4 * t * (1 - t),
      lerp(a[2], b[2], t),
    ];
    m.beam(prev, q, 0.012, 0.012, packMat(CM.wire));
    prev = q;
  }
}

export interface TileContext {
  layout: CityLayout;
  geom: RoadGeom;
  /** Buildings per tile. */
  tileBuildings: number[][];
  /** Junction ids per tile. */
  tileJunctions: number[][];
  roadMask: Uint8Array;
  /** Chains with any point in (or near) each tile. */
  tileChains: number[][];
  /** Park blocks overlapping each tile. */
  tileParks: number[][];
  /** All blocks (sidewalk slabs and parks) overlapping each tile. */
  tileBlocks: number[][];
  /** Lowest elevated deck underside per DECK_CELL cell (Infinity if none). */
  deckFloor: Float32Array;
  /** Tiles per side. */
  tilesPerSide: number;
}

export function makeTileContext(
  layout: CityLayout,
  geom: RoadGeom,
  roadMask: Uint8Array,
): TileContext {
  const size = layout.params.size;
  const n = Math.ceil(size / TILE_SIZE);
  const lists = () => Array.from({length: n * n}, () => [] as number[]);
  const tileBuildings = lists();
  const tileJunctions = lists();
  const tileChains = lists();
  const tileParks = lists();
  const tileBlocks = lists();
  // Chains, junctions and blocks hidden by the asset lab get no props.
  const hid = layout.hidden;
  layout.buildings.forEach((b, i) => {
    const c = centroid(b.footprint);
    tileBuildings[tileOf(size, c[0], c[1])].push(i);
  });
  layout.junctions.forEach((j, i) => {
    if (!hid?.junctions[i]) tileJunctions[tileOf(size, j.p[0], j.p[1])].push(i);
  });
  layout.chains.forEach((c, i) => {
    if (hid?.chains[i]) return;
    const seen = new Set<number>();
    for (const q of c.pts) {
      for (const [dx, dz] of [
        [0, 0],
        [12, 12],
        [-12, -12],
        [12, -12],
        [-12, 12],
      ]) {
        const t = tileOf(size, q[0] + dx, q[1] + dz);
        if (!seen.has(t)) {
          seen.add(t);
          tileChains[t].push(i);
        }
      }
    }
  });
  layout.blocks.forEach((b, i) => {
    // Hidden parks stay listed: they share a tile's tree random stream.
    const hidden = !!hid?.blocks[i];
    if (hidden && !b.park) return;
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
    for (let z = z0; z <= z1 + TILE_SIZE; z += TILE_SIZE) {
      for (let x = x0; x <= x1 + TILE_SIZE; x += TILE_SIZE) {
        const t = tileOf(size, Math.min(x, x1), Math.min(z, z1));
        if (!hidden && !tileBlocks[t].includes(i)) tileBlocks[t].push(i);
        if (b.park && !tileParks[t].includes(i)) tileParks[t].push(i);
      }
    }
  });
  return {
    layout,
    geom,
    roadMask,
    tileBuildings,
    tileJunctions,
    tileChains,
    tileParks,
    tileBlocks,
    deckFloor: deckFloor(layout),
    tilesPerSide: n,
  };
}

const DECK_CELL = 8;

function deckFloor(L: CityLayout) {
  const size = L.params.size;
  const n = Math.ceil(size / DECK_CELL);
  const g = new Float32Array(n * n).fill(Infinity);
  for (const e of L.elevated) {
    const r = elevatedHalfWidth(e) + 2;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const a = e.pts[i];
      const b = e.pts[i + 1];
      const steps = Math.ceil(dist2(a, b) / 3);
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const x = lerp(a[0], b[0], t);
        const z = lerp(a[1], b[1], t);
        // Underside of the deck with its girders.
        const h = lerp(e.heights[i], e.heights[i + 1], t) - 3.5;
        for (let dz = -r; dz <= r; dz += DECK_CELL / 2) {
          for (let dx = -r; dx <= r; dx += DECK_CELL / 2) {
            if (dx * dx + dz * dz > r * r) continue;
            const gx = Math.floor((x + dx + size / 2) / DECK_CELL);
            const gz = Math.floor((z + dz + size / 2) / DECK_CELL);
            if (gx < 0 || gz < 0 || gx >= n || gz >= n) continue;
            g[gz * n + gx] = Math.min(g[gz * n + gx], h);
          }
        }
      }
    }
  }
  return g;
}

/** Height available above ground before hitting an elevated deck. */
function deckClearance(ctx: TileContext, x: number, z: number, ground: number) {
  const size = ctx.layout.params.size;
  const n = Math.ceil(size / DECK_CELL);
  const gx = Math.floor((x + size / 2) / DECK_CELL);
  const gz = Math.floor((z + size / 2) / DECK_CELL);
  if (gx < 0 || gz < 0 || gx >= n || gz >= n) return Infinity;
  return ctx.deckFloor[gz * n + gx] - ground;
}

/**
 * Props on a block's open-ground fill: trees on a jittered grid on lawns,
 * parked cars in about two thirds of car-park stalls (matching the stall
 * pattern of carParkMat: 2.5 m stalls, rows at v 0..5 and 11..16 of each
 * 16 m period). Cars keep clear of viaduct piers.
 */
function fillProps(
  ctx: TileContext,
  m: CMesh,
  f: BlockFill,
  seed: number,
  lod: number,
  inTile: (x: number, z: number) => boolean,
) {
  const L = ctx.layout;
  const hf = L.terrain.heights;
  const V: Vec2 = [-f.u[1], f.u[0]];
  const P = (u: number, v: number): Vec2 => [
    f.o[0] + f.u[0] * u + V[0] * v,
    f.o[1] + f.u[1] * u + V[1] * v,
  ];
  const ground = (q: Vec2) => hf.sample(q[0], q[1]) + 0.21;
  if (f.kind === 'green') {
    const rng = new Rng(seed ^ 0x6ee7);
    for (const r of f.rects) {
      for (let v = r[1] + 4; v < r[3] - 2; v += 9) {
        for (let u = r[0] + 4; u < r[2] - 2; u += 9) {
          const q = P(u + rng.range(-2, 2), v + rng.range(-2, 2));
          const th = rng.range(6, 11);
          if (!inTile(q[0], q[1]) || rng.chance(0.2)) continue;
          const y = ground(q);
          if (deckClearance(ctx, q[0], q[1], y) < th + 1) continue;
          tree(m, [q[0], y, q[1]], th, lod, rng);
        }
      }
    }
    return;
  }
  // Cars face along v; CMesh.box forward (h[2]) runs along (sin yaw, cos yaw).
  const yaw = Math.atan2(V[0], V[1]);
  for (const r of f.rects) {
    for (let p = Math.floor(r[1] / 16); p * 16 < r[3]; p++) {
      for (const [v0, v1] of [
        [p * 16, p * 16 + 5],
        [p * 16 + 11, p * 16 + 16],
      ]) {
        if (v0 < r[1] - 0.01 || v1 > r[3] + 0.01) continue;
        for (let k = Math.ceil(r[0] / FILL_CELL - 0.01); ; k++) {
          const u0 = k * FILL_CELL;
          if (u0 + FILL_CELL > r[2] + 0.01) break;
          const h = hash3(seed, k, v0);
          if (h % 100 >= 65) continue;
          const q = P(
            u0 + FILL_CELL / 2,
            (v0 + v1) / 2 + (v0 % 16 ? 0.3 : -0.3),
          );
          if (!inTile(q[0], q[1])) continue;
          const y = ground(q);
          const clear = deckClearance(ctx, q[0], q[1], y);
          if (clear < 2) continue;
          if (
            clear < 40 &&
            L.elevated.some(
              e => closestOnPolyline(e.pts, q).d < elevatedHalfWidth(e) * 0.5,
            )
          )
            continue;
          const c = (h >>> 8) % 10;
          const paint =
            c < 4 ? 0xd0 : c < 6 ? 0x90 : c < 8 ? 0x91 : (h >>> 12) & 0x7f;
          const body = packMat(CM.paint, paint);
          const len = 2.0 + ((h >>> 16) % 4) * 0.12;
          m.box([q[0], y + 0.6, q[1]], [0.84, 0.32, len], body, yaw);
          const back: Vec2 = [q[0] - V[0] * 0.25, q[1] - V[1] * 0.25];
          if (lod === 0) {
            m.box(
              [q[0], y + 0.18, q[1]],
              [0.72, 0.18, len - 0.45],
              packMat(CM.frame),
              yaw,
            );
            m.box([back[0], y + 1.17, back[1]], [0.76, 0.25, 1.1], body, yaw);
            m.box(
              [back[0], y + 1.12, back[1]],
              [0.79, 0.17, 1.0],
              packMat(CM.frame),
              yaw,
            );
          } else {
            m.box([back[0], y + 1.15, back[1]], [0.76, 0.24, 1.1], body, yaw);
          }
        }
      }
    }
  }
}

export function buildTile(
  ctx: TileContext,
  tile: number,
  lod: number,
): {mesh: CMesh; lights: number[]} {
  const L = ctx.layout;
  const m = new CMesh(1 << 14, 1 << 15);
  const lights = new LightList();
  const hf: Heightfield = L.terrain.heights;
  const size = L.params.size;
  const inTile = (x: number, z: number) => tileOf(size, x, z) === tile;
  for (const bi of ctx.tileBuildings[tile] ?? [])
    building(L.buildings[bi], m, lod, lights, L.params.signDensity);

  // Street lights.
  streetLightSpots(L, ctx.geom, hf, (p, dir, kind, sodium) => {
    if (inTile(p[0], p[2])) streetLight(m, p, dir, kind, sodium);
  });

  // Props along chains: utility poles + wires on small streets, trees on avenues.
  for (const ci of ctx.tileChains[tile] ?? []) {
    const c = L.chains[ci];
    if (c.bridge.some(b => b)) continue;
    const arc = ctx.geom.arc[ci];
    const total = arc[arc.length - 1];
    const [s0, s1] = ctx.geom.setbacks[ci];
    const rng = new Rng(hash2(ci, 991));
    if (c.kind <= Road.street) {
      const side = hash2(ci, 3) % 2 ? 1 : -1;
      const off = (ROAD_WIDTH[c.kind] / 2 + 0.4) * side;
      let prev: Vec3 | null = null;
      for (let s = s0 + 4; s < total - s1 - 4; s += 28) {
        const q = chainAt(c, arc, s);
        const l: Vec2 = [-q.d[1], q.d[0]];
        const x = q.p[0] + l[0] * off;
        const z = q.p[1] + l[1] * off;
        const p: Vec3 = [x, sidewalkY(hf, x, z, q.h), z];
        const here = inTile(p[0], p[2]);
        if (here && lod === 0) utilityPole(m, p);
        if (prev && lod === 0 && here) {
          for (const dy of [9.05, 8.5, 8.0])
            wireSag(
              m,
              [prev[0], prev[1] + dy, prev[2]],
              [p[0], p[1] + dy, p[2]],
              0.5,
            );
        }
        prev = p;
      }
    } else {
      for (const side of [-1, 1]) {
        const off = (ROAD_WIDTH[c.kind] / 2 + SIDEWALK[c.kind] * 0.55) * side;
        for (let s = s0 + 10; s < total - s1 - 8; s += 13) {
          const q = chainAt(c, arc, s);
          const l: Vec2 = [-q.d[1], q.d[0]];
          const x = q.p[0] + l[0] * off;
          const z = q.p[1] + l[1] * off;
          const p: Vec3 = [x, sidewalkY(hf, x, z, q.h), z];
          if (!inTile(p[0], p[2])) continue;
          const th = rng.range(6, 9);
          if (deckClearance(ctx, p[0], p[2], p[1]) < th + 1) continue;
          tree(m, p, th, lod, rng);
        }
      }
    }
  }

  // Traffic signals.
  for (const ji of ctx.tileJunctions[tile] ?? []) {
    const j = L.junctions[ji];
    if (!j.signal || lod !== 0) continue;
    const jg = ctx.geom.junctions[ji];
    const phase = hash2(ji, 17) & 0xff;
    jg.arms.forEach((a, k) => {
      const l: Vec2 = [-a.dir[1], a.dir[0]];
      // Pole on the right corner of the approach (traffic drives on the left in
      // Tokyo, so oncoming traffic sees the pole on its left/curb side).
      const off = a.width / 2 + 0.8;
      const x = j.p[0] + a.dir[0] * (a.setback + 1.5) + l[0] * off;
      const z = j.p[1] + a.dir[1] * (a.setback + 1.5) + l[1] * off;
      const p: Vec3 = [x, sidewalkY(hf, x, z, j.h), z];
      const group = Math.round((a.angle / Math.PI) * 2) & 1;
      signal(
        m,
        p,
        [-l[0], -l[1]],
        Math.min(a.width * 0.45, 6),
        phase,
        group ^ (k & 0),
      );
    });
  }

  // Park trees.
  const tx = (tile % Math.ceil(size / TILE_SIZE)) * TILE_SIZE - size / 2;
  const tz =
    Math.floor(tile / Math.ceil(size / TILE_SIZE)) * TILE_SIZE - size / 2;
  const prng = new Rng(hash2(tile, 4242));
  for (const bi of ctx.tileParks[tile] ?? []) {
    const b = L.blocks[bi];
    const r = b.late ? new Rng(hash2(tile, bi ^ 0x1a7e)) : prng;
    // Parks hidden by the asset lab still draw their trees from the shared
    // stream (into a discarded mesh) so the visible parks keep theirs.
    const pm = L.hidden?.blocks[bi] ? new CMesh(1 << 10, 1 << 11) : m;
    for (let k = 0; k < 140; k++) {
      const x = tx + r.next() * TILE_SIZE;
      const z = tz + r.next() * TILE_SIZE;
      if (!pointInPolygon([x, z], b.curb)) continue;
      const near = b.curb.some((q, i) => {
        const r = b.curb[(i + 1) % b.curb.length];
        const d =
          Math.abs((r[0] - q[0]) * (z - q[1]) - (r[1] - q[1]) * (x - q[0])) /
          (dist2(q, r) || 1);
        return d < 3;
      });
      if (near) continue;
      const ground = hf.sample(x, z) + 0.16;
      const th = r.range(7, 13);
      if (deckClearance(ctx, x, z, ground) < th + 1) continue;
      tree(pm, [x, ground, z], th, lod, r);
    }
  }

  // Lawns (trees) and car parks (parked cars) on blocks' open ground.
  for (const bi of ctx.tileBlocks[tile] ?? []) {
    L.blocks[bi].fill?.forEach((f, fi) =>
      fillProps(ctx, m, f, hash2(bi, fi), lod, inTile),
    );
  }

  // Shop-front clutter (LOD0): vending machine clusters, parked bicycles.
  if (lod === 0) {
    for (const bi of ctx.tileBuildings[tile] ?? []) {
      const b = L.buildings[bi];
      if (b.front < 0 || b.density < 0.1) continue;
      const a = b.footprint[b.front],
        c = b.footprint[(b.front + 1) % b.footprint.length];
      const n = edgeNormal(b.footprint, b.front);
      const yaw = Math.atan2(n[0], n[2]);
      const h = hash2(b.id, 55);
      if (h % 3 === 0) {
        const count = 1 + ((h >> 4) % 3);
        for (let k = 0; k < count; k++) {
          const t = 0.15 + k * 0.09;
          const x = lerp(a[0], c[0], t) + n[0] * 0.5;
          const z = lerp(a[1], c[1], t) + n[2] * 0.5;
          const p: Vec3 = [x, sidewalkY(hf, x, z, b.base) + 0.8, z];
          m.box(
            p,
            [0.5, 1.0, 0.4],
            packMat(CM.vending, (b.id + k) & 0xff),
            yaw,
          );
        }
        const p0: Vec3 = [
          lerp(a[0], c[0], 0.2) + n[0] * 1.5,
          b.base + 0.9,
          lerp(a[1], c[1], 0.2) + n[2] * 1.5,
        ];
        lights.add(p0, 5, [0.9, 0.95, 1.0], LightKind.vending);
      }
      if (h % 5 === 1 && dist2(a, c) > 6) {
        // A row of parked bicycles against the frontage.
        const count = 3 + ((h >> 6) % 5);
        for (let k = 0; k < count; k++) {
          const t = 0.55 + k * (0.35 / count);
          const x = lerp(a[0], c[0], t) + n[0] * 0.9;
          const z = lerp(a[1], c[1], t) + n[2] * 0.9;
          const base: Vec3 = [x, sidewalkY(hf, x, z, b.base), z];
          const col = packMat(CM.paint, (h + k * 37) & 0xff);
          // Two wheels and a frame, oriented toward the wall.
          for (const off of [-0.5, 0.5]) {
            const wc: Vec3 = [
              base[0] + n[0] * off,
              base[1] + 0.33,
              base[2] + n[2] * off,
            ];
            m.beam(
              [wc[0], wc[1] - 0.3, wc[2]],
              [wc[0], wc[1] + 0.3, wc[2]],
              0.02,
              0.3,
              packMat(CM.wire),
            );
          }
          m.beam(
            [base[0] - n[0] * 0.45, base[1] + 0.55, base[2] - n[2] * 0.45],
            [base[0] + n[0] * 0.45, base[1] + 0.6, base[2] + n[2] * 0.45],
            0.03,
            0.03,
            col,
          );
          m.box(
            [base[0] - n[0] * 0.15, base[1] + 0.85, base[2] - n[2] * 0.15],
            [0.25, 0.02, 0.06],
            packMat(CM.metal),
            yaw + Math.PI / 2,
          );
        }
      }
    }
    // Guardrails along arterial curbs, bollards at corners, bus stops.
    for (const ci of ctx.tileChains[tile] ?? []) {
      const c = L.chains[ci];
      if (c.kind < Road.avenue || c.bridge.some(b => b)) continue;
      const arc = ctx.geom.arc[ci];
      const total = arc[arc.length - 1];
      const [s0, s1] = ctx.geom.setbacks[ci];
      for (const side of [-1, 1]) {
        const off = (ROAD_WIDTH[c.kind] / 2 + 0.35) * side;
        let prev: Vec3 | null = null;
        for (let s = s0 + 6; s < total - s1 - 6; s += 2) {
          const q = chainAt(c, arc, s);
          const l: Vec2 = [-q.d[1], q.d[0]];
          const x = q.p[0] + l[0] * off;
          const z = q.p[1] + l[1] * off;
          const p: Vec3 = [x, sidewalkY(hf, x, z, q.h), z];
          if (!inTile(p[0], p[2])) {
            prev = null;
            continue;
          }
          // Gaps for crossings / driveways.
          if (hash2(ci * 7 + side, Math.floor(s / 24)) % 5 === 0) {
            prev = null;
            continue;
          }
          m.box(
            [p[0], p[1] + (0.4 - SINK) / 2 + 0.2, p[2]],
            [0.03, 0.4 + SINK / 2, 0.03],
            packMat(CM.paint, 0xd0),
          );
          if (prev) {
            m.beam(
              [prev[0], prev[1] + 0.78, prev[2]],
              [p[0], p[1] + 0.78, p[2]],
              0.025,
              0.03,
              packMat(CM.paint, 0xd0),
            );
            m.beam(
              [prev[0], prev[1] + 0.45, prev[2]],
              [p[0], p[1] + 0.45, p[2]],
              0.02,
              0.02,
              packMat(CM.paint, 0xd0),
            );
          }
          prev = p;
        }
        // Bus stop every ~300 m on one side.
        for (
          let s = s0 + 40 + (hash2(ci, side) % 120);
          s < total - s1 - 20;
          s += 300
        ) {
          const q = chainAt(c, arc, s);
          const l: Vec2 = [-q.d[1], q.d[0]];
          const o = (ROAD_WIDTH[c.kind] / 2 + SIDEWALK[c.kind] * 0.6) * side;
          const x = q.p[0] + l[0] * o;
          const z = q.p[1] + l[1] * o;
          const p: Vec3 = [x, sidewalkY(hf, x, z, q.h), z];
          if (!inTile(p[0], p[2])) continue;
          const yaw = Math.atan2(q.d[0], q.d[1]);
          m.box(
            [p[0], p[1] + 2.4, p[2]],
            [1.8, 0.05, 0.7],
            packMat(CM.metal),
            yaw,
          );
          for (const e of [-1.6, 1.6]) {
            const px = p[0] + q.d[0] * e;
            const pz = p[2] + q.d[1] * e;
            const g = sidewalkY(hf, px, pz, q.h) - SINK;
            m.box(
              [px, (g + p[1] + 2.4) / 2, pz],
              [0.05, (p[1] + 2.4 - g) / 2, 0.05],
              packMat(CM.metal),
            );
          }
          m.box(
            [p[0] - l[0] * side * 0.65, p[1] + 1.3, p[2] - l[1] * side * 0.65],
            [1.2, 0.9, 0.04],
            packMat(CM.screen, (ci + side) & 0xff),
            yaw,
          );
          m.box(
            [p[0], p[1] + 0.45, p[2]],
            [1.2, 0.05, 0.25],
            packMat(CM.metal),
            yaw,
          );
          lights.add(
            [p[0], p[1] + 2.0, p[2]],
            6,
            [0.9, 0.95, 1.0],
            LightKind.vending,
          );
        }
      }
    }
    // Bollards at signalized corners, only where they land on the corner
    // sidewalk (not out in the carriageway).
    const onSidewalk = (x: number, z: number) =>
      (ctx.tileBlocks[tileOf(size, x, z)] ?? []).some(bi =>
        pointInPolygon([x, z], L.blocks[bi].curb),
      );
    for (const ji of ctx.tileJunctions[tile] ?? []) {
      const j = L.junctions[ji];
      if (!j.signal) continue;
      const jg = ctx.geom.junctions[ji];
      for (const q of jg.outline) {
        const d: Vec2 = [q[0] - j.p[0], q[1] - j.p[1]];
        const dl = Math.hypot(d[0], d[1]) || 1;
        for (let k = -2; k <= 2; k++) {
          const t: Vec2 = [-d[1] / dl, d[0] / dl];
          const x = q[0] + (d[0] / dl) * 0.7 + t[0] * k * 0.9;
          const z = q[1] + (d[1] / dl) * 0.7 + t[1] * k * 0.9;
          if (!onSidewalk(x, z)) continue;
          const bp: Vec3 = [x, sidewalkY(hf, x, z, j.h) - SINK, z];
          m.cylinder(bp, 0.07, 0.8 + SINK, 6, packMat(CM.paint, 0xd8), true);
        }
      }
    }
  }
  void SODIUM;
  void LED;
  return {mesh: m, lights: lights.data};
}
