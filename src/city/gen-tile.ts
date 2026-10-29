// Per-tile city geometry: buildings (LOD0 detailed, LOD1 shells) and street
// props (lights, utility poles and wires, signals, trees, vending machines).

import {Rng, hash2} from '../math/random.ts';
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
  streetLightSpots,
} from './gen-base.ts';
import {insetPolygon} from './graph.ts';
import {
  obb,
  ROAD_WIDTH,
  SIDEWALK,
  Road,
  type Building,
  type CityLayout,
} from './layout.ts';
import {chainAt, type RoadGeom} from './roadgeom.ts';
import {SIGN, signColor} from './signs.ts';
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
  const ids = poly.map(q =>
    m.vertex([q[0], y, q[1]], UP, q[0], q[1], mat, aux),
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

/** A sign panel: box whose two big faces show atlas sign `id`. */
function signPanel(
  m: CMesh,
  c: Vec3,
  along: Vec3,
  halfLen: number,
  halfH: number,
  thick: number,
  id: number,
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
  m.quad(
    [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)],
    along,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    frame,
  );
  m.quad(
    [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)],
    [-along[0], 0, -along[2]],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    frame,
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
    if (crownFp !== towerFp) {
      cap(m, towerFp, bodyTop, packMat(CM.roof, b.style & 0xffff), aux);
      walls(m, crownFp, bodyTop, top, base, towerMat, aux);
    }
    roof = crownFp;
    roofY = top;
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

  // Business signs (the Tokyo look): vertical signs protruding from the front,
  // fascia signs above shops, rooftop billboards.
  if (b.front >= 0 && b.kind !== 'apartment') {
    const i = b.front;
    const a = fp[i],
      c = fp[(i + 1) % fp.length];
    const len = dist2(a, c);
    const n = edgeNormal(fp, i);
    const along: Vec3 = [(c[0] - a[0]) / len, 0, (c[1] - a[1]) / len];
    const floors = Math.floor((mainTop - base) / b.floorH);
    const vertical = Math.round(
      b.density * 3 * signDensity * rng.range(0.4, 1.4) +
        (b.kind === 'pencil' ? 1 : 0),
    );
    for (let k = 0; k < Math.min(vertical, 3); k++) {
      const t = k === 0 ? 0.12 : k === 1 ? 0.88 : 0.5;
      const span = Math.min(floors - 1, rng.int(2, 7));
      if (span < 1) continue;
      const y0 = base + b.floorH * 1.2;
      const hgt = span * b.floorH * 0.9;
      const p: Vec3 = [
        lerp(a[0], c[0], t) + n[0] * 0.75,
        y0 + hgt / 2,
        lerp(a[1], c[1], t) + n[2] * 0.75,
      ];
      const id = SIGN.vertical.first + rng.int(0, SIGN.vertical.count);
      // The panel runs perpendicular to the facade.
      signPanel(m, p, n, 0.6, hgt / 2, 0.15, id);
      if (rng.chance(0.6))
        lights.add(
          [p[0] + n[0] * 1.2, y0 + 1, p[2] + n[2] * 1.2],
          8,
          signColor(id),
          LightKind.sign,
        );
    }
    if (shop && len > 4) {
      const id = SIGN.horizontal.first + rng.int(0, SIGN.horizontal.count);
      const mid: Vec3 = [
        (a[0] + c[0]) / 2 + n[0] * 0.2,
        base + b.floorH * 0.95,
        (a[1] + c[1]) / 2 + n[2] * 0.2,
      ];
      signPanel(m, mid, along, Math.min(len * 0.42, 6), 0.45, 0.12, id);
      if (lod === 0) {
        // Awning.
        const w0: Vec3 = [
          lerp(a[0], c[0], 0.08) + n[0] * 0.8,
          base + b.floorH * 0.72,
          lerp(a[1], c[1], 0.08) + n[2] * 0.8,
        ];
        const w1: Vec3 = [
          lerp(a[0], c[0], 0.92) + n[0] * 0.8,
          base + b.floorH * 0.72,
          lerp(a[1], c[1], 0.92) + n[2] * 0.8,
        ];
        m.beam(w0, w1, 0.8, 0.05, packMat(CM.paint, (b.seed >> 8) & 0xff), aux);
      }
    }
    if (b.density > 0.4 && b.height < 60 && rng.chance(0.1 * signDensity)) {
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
    const units = rng.int(1, 4);
    for (let k = 0; k < units; k++) {
      const t = rng.range(0.2, 0.7);
      const j = rng.int(0, roof.length);
      const q: Vec2 = [lerp(c[0], roof[j][0], t), lerp(c[1], roof[j][1], t)];
      if (!pointInPolygon(q, roof)) continue;
      m.box(
        [q[0], roofY + 0.5, q[1]],
        [0.6, 0.5, 0.4],
        packMat(CM.paint, 0xe0),
        rng.range(0, 3),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Props

export function tree(m: CMesh, p: Vec3, h: number, lod: number, rng: Rng) {
  const trunkH = h * 0.4;
  m.cylinder(
    p,
    0.12 + h * 0.012,
    trunkH + 0.5,
    lod === 0 ? 6 : 4,
    packMat(CM.bark),
    false,
  );
  const blobs = lod === 0 ? 3 : 1;
  const aux = rng.nextU32();
  for (let k = 0; k < blobs; k++) {
    const r = h * (lod === 0 ? rng.range(0.22, 0.32) : 0.33);
    const c: Vec3 = [
      p[0] + rng.range(-0.25, 0.25) * h * 0.3,
      p[1] + trunkH + r * (0.6 + k * 0.5),
      p[2] + rng.range(-0.25, 0.25) * h * 0.3,
    ];
    blob(m, c, r * 0.62, 0, aux, rng);
    leafCards(m, c, r, lod === 0 ? 9 : 4, aux, rng);
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
) {
  const mat = packMat(CM.leaves);
  for (let k = 0; k < count; k++) {
    // Random point in the crown and a random card orientation.
    const u = rng.range(-1, 1);
    const th = rng.range(0, Math.PI * 2);
    const s = Math.sqrt(1 - u * u);
    const off: Vec3 = [s * Math.cos(th), u * 0.8, s * Math.sin(th)];
    const d = rng.range(0.25, 0.7) * r;
    const q: Vec3 = [c[0] + off[0] * d, c[1] + off[1] * d, c[2] + off[2] * d];
    const yaw = rng.range(0, Math.PI);
    const tilt = rng.range(-0.6, 0.6);
    const ax: Vec3 = [Math.cos(yaw), 0, Math.sin(yaw)];
    const ay: Vec3 = [
      -Math.sin(yaw) * Math.sin(tilt),
      Math.cos(tilt),
      Math.cos(yaw) * Math.sin(tilt),
    ];
    const sz = r * rng.range(0.75, 1.05);
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
  const mat = packMat(CM.foliage);
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

function streetLight(
  m: CMesh,
  p: Vec3,
  dir: Vec2,
  kind: number,
  sodium: boolean,
) {
  const h = kind >= 2 ? 9 : 6.5;
  const reach = kind >= 2 ? 2.2 : 1.2;
  m.cylinder(p, 0.09, h, 6, packMat(CM.metal), false);
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
  m.cylinder(p, 0.12, 6.2, 8, packMat(CM.paint, 0x90), false);
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
  m.cylinder(p, 0.16, 10, 6, packMat(CM.concrete), false);
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
  layout.buildings.forEach((b, i) => {
    const c = centroid(b.footprint);
    tileBuildings[tileOf(size, c[0], c[1])].push(i);
  });
  layout.junctions.forEach((j, i) =>
    tileJunctions[tileOf(size, j.p[0], j.p[1])].push(i),
  );
  layout.chains.forEach((c, i) => {
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
    if (!b.park) return;
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
        if (!tileParks[t].includes(i)) tileParks[t].push(i);
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
    tilesPerSide: n,
  };
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
  streetLightSpots(L, ctx.geom, (p, dir, kind, sodium) => {
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
        const p: Vec3 = [q.p[0] + l[0] * off, q.h, q.p[1] + l[1] * off];
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
          const p: Vec3 = [
            q.p[0] + l[0] * off,
            q.h + 0.16,
            q.p[1] + l[1] * off,
          ];
          if (!inTile(p[0], p[2])) continue;
          tree(m, p, rng.range(6, 9), lod, rng);
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
      const p: Vec3 = [
        j.p[0] + a.dir[0] * (a.setback + 1.5) + l[0] * off,
        j.h + 0.16,
        j.p[1] + a.dir[1] * (a.setback + 1.5) + l[1] * off,
      ];
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
    for (let k = 0; k < 140; k++) {
      const x = tx + prng.next() * TILE_SIZE;
      const z = tz + prng.next() * TILE_SIZE;
      if (!pointInPolygon([x, z], b.curb)) continue;
      const near = b.curb.some((q, i) => {
        const r = b.curb[(i + 1) % b.curb.length];
        const d =
          Math.abs((r[0] - q[0]) * (z - q[1]) - (r[1] - q[1]) * (x - q[0])) /
          (dist2(q, r) || 1);
        return d < 3;
      });
      if (near) continue;
      tree(m, [x, hf.sample(x, z) + 0.16, z], prng.range(7, 13), lod, prng);
    }
  }

  // Vending machines in front of some buildings (LOD0 only).
  if (lod === 0) {
    for (const bi of ctx.tileBuildings[tile] ?? []) {
      const b = L.buildings[bi];
      if (b.front < 0 || b.density < 0.12 || hash2(b.id, 55) % 4 !== 0)
        continue;
      const a = b.footprint[b.front],
        c = b.footprint[(b.front + 1) % b.footprint.length];
      const n = edgeNormal(b.footprint, b.front);
      const p: Vec3 = [
        lerp(a[0], c[0], 0.2) + n[0] * 0.5,
        b.base + 0.9,
        lerp(a[1], c[1], 0.2) + n[2] * 0.5,
      ];
      const yaw = Math.atan2(n[0], n[2]);
      m.box(p, [0.5, 0.9, 0.4], packMat(CM.vending, b.id & 0xff), yaw);
      lights.add(
        [p[0] + n[0] * 1, p[1], p[2] + n[2] * 1],
        4,
        [0.9, 0.95, 1.0],
        LightKind.vending,
      );
    }
  }
  void SODIUM;
  void LED;
  return {mesh: m, lights: lights.data};
}
