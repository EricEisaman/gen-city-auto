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
import {
  SHOP_TYPE,
  SIGN,
  SIGN_FABRIC,
  SIGN_STRIPES,
  TENANT_SIGNS,
  TENANT_SQUARES,
  signColor,
} from './signs.ts';
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
 * light boxes); otherwise they are a metal frame. Distant shells (`lod` > 0)
 * get only the two sign faces (and lit cube sides), so far and shell views
 * keep their colour.
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
  lod = 0,
  back = true,
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
  // (Signs flush on a wall skip the back face.)
  if (back)
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
  if (lod > 0 && sideId < 0) return;
  const frame = packMat(CM.metal);
  if (lod === 0) {
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
  }
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

/** Facade zones (param bits 13-15), FZ_* in city-materials.wgsl. */
const FZ = {body: 0, base: 1, lobby: 2, crown: 3, core: 4, trim: 5} as const;
/** Facade roles of footprint edges (param bits 21-22). */
const ROLE = {front: 0, street: 1, party: 2, rear: 3} as const;
/** Ground floor height of midrise, pencil and apartment buildings. */
const GROUND_H = 4.2;
/** Solid parapet (crown) height above the roof. */
const CROWN_H = 1.0;
/** Corner pier width; stair core strip width and how far it stands out. */
const PIER = 0.6;
const CORE_W = 2.8;
const CORE_OUT = 0.4;
/** Steel fire stair: length along the wall (two flights plus landings), depth. */
const STAIR_L = 5.0;
const STAIR_D = 1.8;
/** Blade signs on distant shells are this much wider (still two faces). */
const BLADE_LOD1 = 1.6;

/**
 * Facade material param: style (13 bits), zone, kind, shop, podium, edge
 * role and the solid flag (wall without windows).
 */
function facadeParam(
  b: Building,
  shop: boolean,
  podium: boolean,
  role = 0,
  zone = 0,
  solid = false,
) {
  return (
    (b.style & 0x1fff) |
    (zone << 13) |
    (KIND_INDEX[b.kind] << 16) |
    (shop ? 1 << 19 : 0) |
    (podium ? 1 << 20 : 0) |
    (role << 21) |
    (solid ? 1 << 23 : 0)
  );
}

/** The shaders' hashu (Wang hash), for facade decisions both sides make. */
function hashu(x: number) {
  let v = x >>> 0;
  v = v ^ 61 ^ (v >>> 16);
  v = Math.imul(v, 9);
  v ^= v >>> 4;
  v = Math.imul(v, 0x27d4eb2d);
  v ^= v >>> 15;
  return v >>> 0;
}
const hashuf = (x: number) => (hashu(x) & 0xffffff) / 16777216;

/** Window bay width of a facade style (facadeStyle in city-materials.wgsl). */
function facadeBay(style: number) {
  const h = hashu(Math.imul(style & 0x1fff, 747796405) + 1);
  return 1.5 + 1.7 * hashuf(h ^ 0x1234);
}

/**
 * Ground-floor tenant type (SHOP_TYPE) of the shopfront bay with facade grid
 * index `bayIdx`: city-materials.wgsl facadeMat's shopType, per bay pair.
 */
function shopTypeAt(aux: number, bayIdx: number) {
  return hashu((aux ^ (Math.floor(bayIdx / 2) + 3000)) >>> 0) % 4;
}

/** Facade role of each footprint edge (the longest edge fronts if none does). */
function edgeRoles(b: Building): number[] {
  const fp = b.footprint;
  let front = b.front;
  if (front < 0) {
    let best = 0;
    fp.forEach((a, i) => {
      const l = dist2(a, fp[(i + 1) % fp.length]);
      if (l > best) {
        best = l;
        front = i;
      }
    });
  }
  const nf = edgeNormal(fp, front);
  return fp.map((_, i) => {
    if (i === front) return ROLE.front;
    if (b.frontage[i]) return ROLE.street;
    const n = edgeNormal(fp, i);
    return n[0] * nf[0] + n[2] * nf[2] < -0.7 ? ROLE.rear : ROLE.party;
  });
}

/**
 * One footprint edge's facade layout: corner piers, then a window field
 * [f0, f1] (metres along the edge) holding `count` whole bays at
 * u = u0 + (s - f0) * k, so windows never get cut at a corner. A stair core
 * strip, if any, stands in for the pier at one end ([core, core + CORE_W]).
 */
interface FacadeEdge {
  a: Vec2;
  n: Vec3;
  along: Vec3;
  len: number;
  role: number;
  f0: number;
  f1: number;
  count: number;
  k: number;
  u0: number;
  core: number;
}

function facadeEdges(
  poly: Vec2[],
  roles: number[],
  bay: number,
  core: {edge: number; atEnd: boolean} | null,
): FacadeEdge[] {
  let u = 0;
  return poly.map((a, i) => {
    const c = poly[(i + 1) % poly.length];
    const len = dist2(a, c);
    const along: Vec3 = [
      (c[0] - a[0]) / (len || 1),
      0,
      (c[1] - a[1]) / (len || 1),
    ];
    let f0 = Math.min(PIER, len / 2);
    let f1 = len - f0;
    let coreAt = NaN;
    if (core && core.edge === i) {
      coreAt = core.atEnd ? len - CORE_W : 0;
      if (core.atEnd) f1 = coreAt;
      else f0 = CORE_W;
    }
    const w = f1 - f0;
    let count = Math.max(1, Math.round(w / bay));
    let k = (count * bay) / w;
    if (!(w > 0) || k > 1.18 || k < 0.85) {
      // Stretching to whole bays would distort the wall; widen the piers.
      count = Math.max(0, Math.floor(w / bay));
      const extra = w - count * bay;
      if (core && core.edge === i) {
        if (core.atEnd) f0 += extra;
        else f1 -= extra;
      } else {
        f0 += extra / 2;
        f1 -= extra / 2;
      }
      k = 1;
    }
    const e = {
      a,
      n: edgeNormal(poly, i),
      along,
      len,
      role: roles[i] ?? ROLE.front,
      f0,
      f1,
      count,
      k,
      u0: u,
      core: coreAt,
    };
    u += count * bay;
    return e;
  });
}

/** Point on a facade edge: `s` metres along it, `out` metres in front. */
function edgeAt(e: FacadeEdge, s: number, out: number, y: number): Vec3 {
  return [
    e.a[0] + e.along[0] * s + e.n[0] * out,
    y,
    e.a[1] + e.along[2] * s + e.n[2] * out,
  ];
}

/** Wall quad on a facade edge over [s0, s1] x [y0, y1]; uv u from uA to uB. */
function edgeQuad(
  m: CMesh,
  e: FacadeEdge,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  out: number,
  uA: number,
  uB: number,
  vOff: number,
  mat: number,
  aux: number,
) {
  if (s1 - s0 < 1e-3 || y1 - y0 < 1e-3) return;
  m.quad(
    [
      edgeAt(e, s0, out, y0),
      edgeAt(e, s1, out, y0),
      edgeAt(e, s1, out, y1),
      edgeAt(e, s0, out, y1),
    ],
    e.n,
    [
      [uA, y0 - vOff],
      [uB, y0 - vOff],
      [uB, y1 - vOff],
      [uA, y1 - vOff],
    ],
    mat,
    aux,
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

/**
 * Aluminium coping capping a parapet whose outer face is `poly` and top is
 * at `y`, about 6 cm proud with a turned-down drip edge: a bright line
 * against the sky that survives any distance.
 */
function coping(m: CMesh, poly: Vec2[], y: number, lod: number) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    const n = edgeNormal(poly, i);
    const len = dist2(a, c);
    if (len < 0.3) continue;
    const ex = 0.07 / len;
    if (lod > 0) {
      // Distant shells: just the outer face.
      const P = (t: number, out: number, h: number): Vec3 => [
        lerp(a[0], c[0], t) + n[0] * out,
        y + h,
        lerp(a[1], c[1], t) + n[2] * out,
      ];
      const t0 = -ex,
        t1 = 1 + ex;
      const uv: Vec2[] = [
        [0, 0],
        [len, 0],
        [len, 1],
        [0, 1],
      ];
      const mat = packMat(CM.metal);
      m.quad(
        [
          P(t0, 0.07, -0.08),
          P(t1, 0.07, -0.08),
          P(t1, 0.07, 0.07),
          P(t0, 0.07, 0.07),
        ],
        n,
        uv,
        mat,
      );
      continue;
    }
    // Drip edge: the coping's outer lip turned down past the wall face.
    const D = (t: number, h: number): Vec3 => [
      lerp(a[0], c[0], t) + n[0] * 0.07,
      y + h,
      lerp(a[1], c[1], t) + n[2] * 0.07,
    ];
    m.quad(
      [D(-ex, -0.08), D(1 + ex, -0.08), D(1 + ex, 0.06), D(-ex, 0.06)],
      n,
      [
        [0, 0],
        [len, 0],
        [len, 1],
        [0, 1],
      ],
      packMat(CM.metal),
    );
    m.beam(
      [
        a[0] - (c[0] - a[0]) * ex - n[0] * 0.1,
        y + 0.03,
        a[1] - (c[1] - a[1]) * ex - n[2] * 0.1,
      ],
      [
        c[0] + (c[0] - a[0]) * ex - n[0] * 0.1,
        y + 0.03,
        c[1] + (c[1] - a[1]) * ex - n[2] * 0.1,
      ],
      0.17,
      0.03,
      packMat(CM.metal),
      0,
      [0, -1, 0],
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

/**
 * One flat quad facing `n`, centred on `c`: `hw` along the horizontal
 * `right`, `hh` up. Thin bars, plates and slats that only need their front.
 */
function flatQuad(
  m: CMesh,
  c: Vec3,
  right: Vec3,
  hw: number,
  hh: number,
  n: Vec3,
  mat: number,
) {
  const P = (x: number, y: number): Vec3 => [
    c[0] + right[0] * x * hw,
    c[1] + y * hh,
    c[2] + right[2] * x * hw,
  ];
  m.quad(
    [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)],
    n,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    mat,
  );
}

/**
 * Steel door in a dark frame on a wall: `p` is its bottom centre on the wall
 * face, `along` runs along the wall and `n` out of it. With `canopy`, a small
 * concrete canopy and a lamp above it.
 */
function steelDoor(
  m: CMesh,
  p: Vec3,
  along: Vec3,
  n: Vec3,
  paint: number,
  canopy: boolean,
) {
  const Q = (ds: number, out: number, dy: number): Vec3 => [
    p[0] + along[0] * ds + n[0] * out,
    p[1] + dy,
    p[2] + along[2] * ds + n[2] * out,
  ];
  const uv: Vec2[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  m.quad(
    [
      Q(-0.52, 0.015, 0),
      Q(0.52, 0.015, 0),
      Q(0.52, 0.015, 2.16),
      Q(-0.52, 0.015, 2.16),
    ],
    n,
    uv,
    packMat(CM.frame),
  );
  m.quad(
    [
      Q(-0.45, 0.025, 0),
      Q(0.45, 0.025, 0),
      Q(0.45, 0.025, 2.05),
      Q(-0.45, 0.025, 2.05),
    ],
    n,
    uv,
    packMat(CM.paint, paint),
  );
  const along2: Vec3 = [along[0], 0, along[2]];
  flatQuad(m, Q(0.31, 0.05, 1.0), along2, 0.07, 0.015, n, packMat(CM.metal));
  if (!canopy) return;
  m.box(
    Q(0, 0.4, 2.5),
    [0.75, 0.04, 0.4],
    packMat(CM.concrete),
    Math.atan2(n[0], n[2]),
  );
  flatQuad(m, Q(0, 0.03, 2.33), along2, 0.08, 0.07, n, packMat(CM.lamp, 1));
}

/**
 * Rooftop stair house kit (LOD0) on the walls of `rect` (CCW) from `y0` to
 * `top`: a steel door with a canopy on edge `door`, an exhaust louvre on the
 * next edge and a cat ladder up to its roof on the one before.
 */
function roofHouse(
  m: CMesh,
  rect: Vec2[],
  y0: number,
  top: number,
  door: number,
) {
  const k = rect.length;
  const side = (i: number) => {
    const a = rect[(i + k) % k];
    const c = rect[(i + 1 + k) % k];
    const len = dist2(a, c) || 1;
    const along: Vec3 = [(c[0] - a[0]) / len, 0, (c[1] - a[1]) / len];
    const n = edgeNormal(rect, (i + k) % k);
    const at = (t: number, out: number, y: number): Vec3 => [
      lerp(a[0], c[0], t) + n[0] * out,
      y,
      lerp(a[1], c[1], t) + n[2] * out,
    ];
    return {along, n, len, at, yaw: Math.atan2(n[0], n[2])};
  };
  const d = side(door);
  steelDoor(m, d.at(0.5, 0, y0 + 0.15), d.along, d.n, 0x90, true);
  const l = side(door + 1);
  const metal = packMat(CM.metal);
  const dark = packMat(CM.paint, 0x91);
  m.box(l.at(0.5, 0.04, y0 + 2.1), [0.4, 0.3, 0.04], metal, l.yaw);
  for (let j = 0; j < 4; j++)
    flatQuad(
      m,
      l.at(0.5, 0.09, y0 + 1.9 + j * 0.14),
      l.along,
      0.36,
      0.025,
      l.n,
      dark,
    );
  const r = side(door - 1);
  const t0 = Math.min(0.75, 1 - 0.5 / r.len);
  const steel = packMat(CM.paint, 0x90);
  for (const dt of [-0.22, 0.22]) {
    const t = t0 + dt / r.len;
    m.beam(r.at(t, 0.2, y0), r.at(t, 0.2, top + 0.9), 0.02, 0.02, steel);
  }
  for (let y = y0 + 0.35; y < top + 0.8; y += 0.35)
    flatQuad(m, r.at(t0, 0.2, y), r.along, 0.22, 0.012, r.n, steel);
}

/**
 * Steel guard rail standing on `y` round the closed ring `ring` (LOD0): a
 * heavy top rail and flat bar posts about every 3.2 m facing out, so the
 * roof edge reads against the sky and from the air.
 */
function guardRail(m: CMesh, ring: Vec2[], y: number, mat: number) {
  m.tube(
    [...ring, ring[0]].map((q): Vec3 => [q[0], y + 1.08, q[1]]),
    0.06,
    mat,
  );
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      c = ring[(i + 1) % ring.length];
    const len = dist2(a, c);
    const nn = edgeNormal(ring, i);
    const dx = (c[0] - a[0]) / (len || 1),
      dz = (c[1] - a[1]) / (len || 1);
    const posts = Math.max(1, Math.round(len / 3.2));
    for (let k = 0; k < posts; k++) {
      const t = k / posts;
      const x = lerp(a[0], c[0], t) + nn[0] * 0.04,
        z = lerp(a[1], c[1], t) + nn[2] * 0.04;
      m.quad(
        [
          [x - dx * 0.035, y, z - dz * 0.035],
          [x + dx * 0.035, y, z + dz * 0.035],
          [x + dx * 0.035, y + 1.1, z + dz * 0.035],
          [x - dx * 0.035, y + 1.1, z - dz * 0.035],
        ],
        nn,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        mat,
      );
    }
  }
}

/**
 * Drinks vending machine (1.0 x 1.83 x 0.7 m) standing on `p` and facing
 * `n`: a cabinet in vending colour `col` (red, blue or white), a recessed
 * lit display of sample cans, a lit button row, the coin and note panel, the
 * dispenser slot and a lit header strip. Vending uv.y in [0.7, 1.5] lights
 * up (M_VENDING), so unlit parts keep uv.y above it.
 */
function vendingMachine(m: CMesh, p: Vec3, n: Vec3, col: number) {
  const r: Vec3 = [n[2], 0, -n[0]];
  const D = 0.35;
  const P = (x: number, y: number, z: number): Vec3 => [
    p[0] + r[0] * x + n[0] * z,
    p[1] + y,
    p[2] + r[2] * x + n[2] * z,
  ];
  const body = packMat(CM.vending, col);
  const flat = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
    mat: number,
    v0 = 5,
    v1 = 5,
  ) =>
    m.quad(
      [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)],
      n,
      [
        [0, v0],
        [1, v0],
        [1, v1],
        [0, v1],
      ],
      mat,
    );
  const uv: Vec2[] = [
    [0, 5],
    [1, 5],
    [1, 6],
    [0, 6],
  ];
  const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
  const Hc = 1.83;
  // Cabinet: back, sides, top.
  m.quad(
    [P(0.5, 0, -D), P(-0.5, 0, -D), P(-0.5, Hc, -D), P(0.5, Hc, -D)],
    neg(n),
    uv,
    body,
  );
  m.quad(
    [P(0.5, 0, D), P(0.5, 0, -D), P(0.5, Hc, -D), P(0.5, Hc, D)],
    r,
    uv,
    body,
  );
  m.quad(
    [P(-0.5, 0, -D), P(-0.5, 0, D), P(-0.5, Hc, D), P(-0.5, Hc, -D)],
    neg(r),
    uv,
    body,
  );
  m.quad(
    [P(-0.5, Hc, D), P(0.5, Hc, D), P(0.5, Hc, -D), P(-0.5, Hc, -D)],
    UP,
    uv,
    body,
  );
  // Front around the display opening [-0.44, 0.2] x [0.62, 1.6].
  flat(-0.5, 0, 0.5, 0.62, D, body);
  flat(-0.5, 1.6, 0.5, Hc, D, body);
  flat(-0.5, 0.62, -0.44, 1.6, D, body);
  flat(0.2, 0.62, 0.5, 1.6, D, body);
  // Recessed display (lit rows of cans) and its reveal.
  const dz = D - 0.06;
  flat(-0.44, 0.62, 0.2, 1.6, dz, body, 0.7, 1.5);
  const reveal = packMat(CM.metal);
  m.quad(
    [P(-0.44, 1.6, dz), P(0.2, 1.6, dz), P(0.2, 1.6, D), P(-0.44, 1.6, D)],
    [0, -1, 0],
    uv,
    reveal,
  );
  m.quad(
    [P(-0.44, 0.62, D), P(0.2, 0.62, D), P(0.2, 0.62, dz), P(-0.44, 0.62, dz)],
    UP,
    uv,
    reveal,
  );
  m.quad(
    [
      P(-0.44, 0.62, dz),
      P(-0.44, 0.62, D),
      P(-0.44, 1.6, D),
      P(-0.44, 1.6, dz),
    ],
    r,
    uv,
    reveal,
  );
  m.quad(
    [P(0.2, 0.62, D), P(0.2, 0.62, dz), P(0.2, 1.6, dz), P(0.2, 1.6, D)],
    neg(r),
    uv,
    reveal,
  );
  // Button row under the display, header strip, coin panel, dispenser slot.
  flat(-0.42, 0.55, 0.18, 0.6, D + 0.01, packMat(CM.lamp, 1));
  flat(-0.46, 1.66, 0.46, 1.78, D + 0.005, body, 0.72, 0.74);
  flat(0.25, 0.92, 0.45, 1.4, D + 0.012, reveal);
  flat(0.3, 1.18, 0.4, 1.3, D + 0.018, packMat(CM.frame));
  flat(0.3, 1.0, 0.4, 1.06, D + 0.018, packMat(CM.frame));
  flat(-0.38, 0.1, 0.16, 0.34, D + 0.008, packMat(CM.frame));
  m.box(
    P(-0.11, 0.36, D + 0.03),
    [0.29, 0.02, 0.03],
    reveal,
    Math.atan2(n[0], n[2]),
  );
}

/** A-frame stand sign (printed, unlit) on the pavement at `p` facing `n`. */
function aFrameSign(m: CMesh, p: Vec3, n: Vec3, id: number) {
  const r: Vec3 = [n[2], 0, -n[0]];
  const mat = packMat(CM.sign, id | SIGN_FABRIC);
  const h = 0.8,
    w = 0.3,
    lean = 0.17;
  for (const d of [1, -1]) {
    const P = (x: number, y: number): Vec3 => [
      p[0] + r[0] * x + n[0] * d * lean * (1 - y / h),
      p[1] + y,
      p[2] + r[2] * x + n[2] * d * lean * (1 - y / h),
    ];
    const l = Math.hypot(h, lean);
    const nn: Vec3 = [(n[0] * d * h) / l, lean / l, (n[2] * d * h) / l];
    const q = [P(-w, 0), P(w, 0), P(w, h), P(-w, h)];
    m.quad(
      q,
      nn,
      [
        [d > 0 ? 0 : 1, 1],
        [d > 0 ? 1 : 0, 1],
        [d > 0 ? 1 : 0, 0],
        [d > 0 ? 0 : 1, 0],
      ],
      mat,
    );
    m.quad(
      q,
      [-nn[0], -nn[1], -nn[2]],
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      packMat(CM.metal),
    );
  }
}

/** A potted shrub on the pavement. */
function pottedPlant(m: CMesh, p: Vec3, rng: Rng) {
  const r = rng.range(0.18, 0.28);
  const h = rng.range(0.35, 0.6);
  m.cylinder(p, r, h, 8, packMat(CM.paint, rng.chance(0.5) ? 0x9c : 0xd5));
  blob(
    m,
    [p[0], p[1] + h + r * 0.9, p[2]],
    r * rng.range(1.4, 2.0),
    0,
    rng.nextU32(),
    rng,
  );
}

/** Yaw for CMesh.box so that its forward axis is the edge's outward normal. */
const yawOf = (e: FacadeEdge) => Math.atan2(e.n[0], e.n[2]);

/**
 * Painted steel (fire stairs, ad frames, sign lattices): CM.paint with param
 * PAINT_STEEL | seed (city-materials.wgsl paintedSteel: chipped paint, rust
 * at joints, streaks; world-space patterns). `seed & 3` picks the colour
 * (0 dark brown, 1 grey, 2 cream, 3 green); higher bits vary the wear.
 */
const PAINT_STEEL = 0x300;
const steelPaint = (seed: number) =>
  packMat(CM.paint, PAINT_STEEL | (seed & 0xff));

/**
 * Open steel switchback fire stair on a wall (LOD0): floor landings at
 * `levels` (the first is grade) at end A with a steel door and a lamp each,
 * half landings at end B, two flights per storey (outer lane up to the half
 * landing, inner lane back). Flights are C-channel stringers carrying
 * separate open treads; landings are plates with a channel edge; pipe
 * handrails with a mid rail and balusters; two round columns from the
 * foundation. Bars are tubes (8 vertices each), about 300 vertices a storey.
 * `toEnd`: end A is toward the edge's end (the stair sits near its start).
 */
function fireStair(
  m: CMesh,
  e: FacadeEdge,
  sC: number,
  o: {levels: number[]; low: number; toEnd: boolean; paint: number},
) {
  const frame = steelPaint(o.paint);
  const deck = frame;
  const rail = frame;
  const dir = o.toEnd ? 1 : -1;
  const LAND = 1.15;
  const sA = sC + dir * (STAIR_L / 2 - LAND / 2);
  const sB = sC - dir * (STAIR_L / 2 - LAND / 2);
  // Flight run between the landings' inner edges.
  const fA = sA - dir * (LAND / 2);
  const fB = sB + dir * (LAND / 2);
  const lane = STAIR_D / 2;
  const D = STAIR_D;
  const P = (s: number, out: number, y: number) => edgeAt(e, s, out, y);
  const RAIL_H = 1.0;
  // Quad in the edge frame with uv in metres (u along s or out, v up).
  const q4 = (pts: Vec3[], n: Vec3, mat: number, w: number, h: number) =>
    m.quad(
      pts,
      n,
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
      mat,
    );
  const nOut = e.n;
  const nIn: Vec3 = [-e.n[0], 0, -e.n[2]];
  const nAlong = (sg: number): Vec3 => [e.along[0] * sg, 0, e.along[2] * sg];
  // Stringer: a C-channel along (s0, y0) -> (s1, y1) at `out`, its web
  // seen from both sides, flanges toward `side` (+1 away from the wall).
  const stringer = (
    s0: number,
    y0: number,
    s1: number,
    y1: number,
    out: number,
    side: number,
  ) => {
    const len = Math.hypot(s1 - s0, y1 - y0);
    const web = [
      P(s0, out, y0 - 0.2),
      P(s1, out, y1 - 0.2),
      P(s1, out, y1 + 0.06),
      P(s0, out, y0 + 0.06),
    ];
    q4(web, nOut, frame, len, 0.26);
    q4(web, nIn, frame, len, 0.26);
    const f = out + side * 0.06;
    // Flange normals: up/down, tilted with the slope.
    const k = (y1 - y0) / (len || 1);
    const ds = (s1 - s0) / (len || 1);
    const up: Vec3 = [-e.along[0] * ds * k, Math.abs(ds), -e.along[2] * ds * k];
    q4(
      [
        P(s0, out, y0 - 0.2),
        P(s1, out, y1 - 0.2),
        P(s1, f, y1 - 0.2),
        P(s0, f, y0 - 0.2),
      ],
      [-up[0], -up[1], -up[2]],
      frame,
      len,
      0.06,
    );
  };
  // Pipe rail along a path RAIL_H above the walking line, a mid rail
  // (flights), and balusters at the listed points (indices into the path,
  // fractional).
  const railRun = (
    pts: [number, number, number][],
    posts: number[],
    mid = true,
  ) => {
    const at = (t: number): [number, number, number] => {
      const i = Math.min(pts.length - 2, Math.floor(t));
      const f = t - i;
      const a = pts[i],
        c = pts[i + 1];
      return [lerp(a[0], c[0], f), lerp(a[1], c[1], f), lerp(a[2], c[2], f)];
    };
    m.tube(
      pts.map(p => P(p[0], p[1], p[2] + RAIL_H)),
      0.024,
      rail,
    );
    if (mid)
      m.tube(
        pts.map(p => P(p[0], p[1], p[2] + 0.5)),
        0.014,
        rail,
      );
    for (const t of posts) {
      const p = at(t);
      m.tube(
        [P(p[0], p[1], p[2] + 0.04), P(p[0], p[1], p[2] + RAIL_H)],
        0.016,
        rail,
      );
    }
  };
  const landing = (
    s: number,
    y: number,
    door: boolean,
    end: number,
    last = false,
  ) => {
    const h = LAND / 2;
    const sEnd = s + end * h;
    const sIn = s - end * h;
    const T = 0.12;
    q4(
      [P(s - h, 0, y), P(s + h, 0, y), P(s + h, D, y), P(s - h, D, y)],
      UP,
      deck,
      LAND,
      D,
    );
    q4(
      [
        P(s - h, 0, y - T),
        P(s + h, 0, y - T),
        P(s + h, D, y - T),
        P(s - h, D, y - T),
      ],
      [0, -1, 0],
      frame,
      LAND,
      D,
    );
    // Channel edges on the open sides.
    q4(
      [P(s - h, D, y - T), P(s + h, D, y - T), P(s + h, D, y), P(s - h, D, y)],
      nOut,
      frame,
      LAND,
      T,
    );
    q4(
      [P(sEnd, 0, y - T), P(sEnd, D, y - T), P(sEnd, D, y), P(sEnd, 0, y)],
      nAlong(end),
      frame,
      D,
      T,
    );
    railRun(
      [
        [sEnd, 0.05, y],
        [sEnd, D - 0.03, y],
        [sIn, D - 0.03, y],
        // The top landing closes off the stairwell over the outer lane.
        ...(last ? [[sIn, lane, y] as [number, number, number]] : []),
      ],
      [1],
      false,
    );
    if (!door) return;
    steelDoor(m, P(s, 0, y), e.along, e.n, 0x90, false);
    q4(
      [
        P(s - 0.07, 0.06, y + 2.24),
        P(s + 0.07, 0.06, y + 2.24),
        P(s + 0.07, 0.06, y + 2.36),
        P(s - 0.07, 0.06, y + 2.36),
      ],
      e.n,
      packMat(CM.lamp, 1),
      0.14,
      0.12,
    );
  };
  const flight = (
    s0: number,
    y0: number,
    s1: number,
    y1: number,
    o0: number,
    o1: number,
    railAt: number,
  ) => {
    // Open treads (top and underside) between the stringers: n risers,
    // n - 1 treads, with a gap between treads.
    const n = Math.max(4, Math.round((y1 - y0) / 0.33));
    const run = (s1 - s0) / (n - 1);
    const rise = (y1 - y0) / n;
    const gap = 0.04 * Math.sign(run);
    for (let j = 1; j < n; j++) {
      const a = s0 + run * (j - 1) + gap,
        c = s0 + run * j;
      const y = y0 + rise * j;
      const t = [P(a, o0, y), P(c, o0, y), P(c, o1, y), P(a, o1, y)];
      q4(t, UP, deck, Math.abs(run), o1 - o0);
      // Undersides on the outer lane (seen from the street below).
      if (o1 > lane)
        q4(
          t.map((p): Vec3 => [p[0], p[1] - 0.035, p[2]]),
          [0, -1, 0],
          frame,
          Math.abs(run),
          o1 - o0,
        );
    }
    stringer(s0, y0, s1, y1, o0, -1);
    stringer(s0, y0, s1, y1, o1, 1);
    railRun(
      [
        [s0, railAt, y0],
        [s1, railAt, y1],
      ],
      [0.5],
    );
  };
  const L = o.levels;
  for (let k = 0; k + 1 < L.length; k++) {
    const ya = L[k],
      yb = L[k + 1];
    const mid = (ya + yb) / 2;
    flight(fA, ya, fB, mid, lane, D - 0.03, D - 0.03);
    landing(sB, mid, false, -dir);
    flight(fB, mid, fA, yb, 0.04, lane - 0.02, lane - 0.02);
    landing(sA, yb, true, dir, k + 2 === L.length);
  }
  // Two round columns at the outer corners, from the foundation up past the
  // top landing's rail.
  const top = L[L.length - 1] + RAIL_H;
  for (const s of [sA + dir * (LAND / 2 - 0.05), sB - dir * (LAND / 2 - 0.05)])
    m.tube([P(s, D - 0.05, o.low), P(s, D - 0.05, top)], 0.07, frame);
}

/**
 * The fire stair on distant shells: each storey's outer flight balustrade
 * as one outward-facing plate (the diagonal stripes that read from afar),
 * 4 vertices a storey.
 */
function fireStairShell(
  m: CMesh,
  e: FacadeEdge,
  sC: number,
  o: {levels: number[]; low: number; toEnd: boolean; paint: number},
) {
  const mat = steelPaint(o.paint);
  const dir = o.toEnd ? 1 : -1;
  const LAND = 1.15;
  const sA = sC + dir * (STAIR_L / 2 - LAND / 2);
  const sB = sC - dir * (STAIR_L / 2 - LAND / 2);
  const fA = sA - dir * (LAND / 2);
  const fB = sB + dir * (LAND / 2);
  const D = STAIR_D;
  const plate = (s0: number, y0: number, s1: number, y1: number, out: number) =>
    m.quad(
      [
        edgeAt(e, s0, out, y0 - 0.2),
        edgeAt(e, s1, out, y1 - 0.2),
        edgeAt(e, s1, out, y1 + 1.0),
        edgeAt(e, s0, out, y0 + 1.0),
      ],
      e.n,
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      mat,
    );
  const L = o.levels;
  for (let k = 0; k + 1 < L.length; k++) {
    const ya = L[k],
      yb = L[k + 1];
    const mid = (ya + yb) / 2;
    plate(fA, ya, fB, mid, D);
  }
}

/**
 * Street kit in front of one ground-floor tenant (`t`: its type, extent
 * [s0, s1] along the front edge and fascia sign id). `gy` is the pavement
 * and `head` the shopfront head. Restaurants hang a noren printed with
 * their name over the door, and put out a lit plastic-food display case
 * and stacked beer crates; a konbini has its row of recycling bins.
 */
function tenantKit(
  m: CMesh,
  e: FacadeEdge,
  t: {type: number; s0: number; s1: number; id: number},
  gy: number,
  head: number,
  rng: Rng,
) {
  const w = t.s1 - t.s0;
  const yaw = yawOf(e);
  const P = (s: number, out: number, y: number) => edgeAt(e, s, out, y);
  const dark = packMat(CM.paint, 0x91);
  if (t.type === SHOP_TYPE.restaurant && w > 1.4) {
    const nw = Math.min(1.8, w * 0.6);
    const sc = t.s0 + w * rng.range(0.35, 0.65);
    const top = Math.min(head - 0.05, gy + 2.3);
    const drop = rng.range(0.55, 0.9);
    m.tube(
      [P(sc - nw / 2 - 0.08, 0.2, top), P(sc + nw / 2 + 0.08, 0.2, top)],
      0.015,
      packMat(CM.metal),
    );
    const mat = packMat(CM.sign, t.id | SIGN_FABRIC);
    const pw = nw / 3;
    for (let k = 0; k < 3; k++) {
      const a = sc - nw / 2 + k * pw + 0.01,
        c = a + pw - 0.02;
      m.quad(
        [
          P(a, 0.2, top - drop),
          P(c, 0.2, top - drop),
          P(c, 0.2, top),
          P(a, 0.2, top),
        ],
        e.n,
        [
          [1 - k / 3, 1],
          [1 - (k + 1) / 3, 1],
          [1 - (k + 1) / 3, 0],
          [1 - k / 3, 0],
        ],
        mat,
      );
    }
    // Plastic-food display case beside the door: a dark cabinet, and lit
    // shelves of samples behind glass (M_VENDING's lit rows).
    const right = sc + nw / 2 + 0.6 <= t.s1 - 0.5;
    const ds = right ? sc + nw / 2 + 0.6 : sc - nw / 2 - 0.6;
    if (ds >= t.s0 + 0.5 && ds <= t.s1 - 0.5 && rng.chance(0.75)) {
      m.box(P(ds, 0.3, gy + 0.4), [0.45, 0.4, 0.22], dark, yaw);
      m.box(P(ds, 0.3, gy + 1.07), [0.45, 0.27, 0.22], packMat(CM.metal), yaw);
      m.quad(
        [
          P(ds - 0.42, 0.525, gy + 0.83),
          P(ds + 0.42, 0.525, gy + 0.83),
          P(ds + 0.42, 0.525, gy + 1.31),
          P(ds - 0.42, 0.525, gy + 1.31),
        ],
        e.n,
        [
          [0, 0.7],
          [0.84, 0.7],
          [0.84, 1.5],
          [0, 1.5],
        ],
        packMat(CM.vending, 2),
      );
    }
    // Beer crates stacked by the other end.
    if (rng.chance(0.55)) {
      const cs = right ? t.s0 + 0.4 : t.s1 - 0.4;
      const crate = packMat(CM.paint, 0x92);
      for (const [d, n] of [
        [-0.27, rng.int(2, 4)],
        [0.27, rng.int(1, 3)],
      ])
        m.box(
          P(cs + d, 0.3, gy + 0.155 * n),
          [0.24, 0.155 * n, 0.18],
          crate,
          yaw + (d > 0 ? rng.range(-0.15, 0.15) : 0),
        );
    }
  } else if (t.type === SHOP_TYPE.konbini) {
    // Recycling bins: one cabinet with three dark openings.
    const bs = rng.chance(0.5) ? t.s1 - 0.7 : t.s0 + 0.7;
    if (w > 1.6) {
      m.box(
        P(bs, 0.3, gy + 0.45),
        [0.55, 0.45, 0.22],
        packMat(CM.paint, 0xd0),
        yaw,
      );
      for (let k = -1; k <= 1; k++)
        flatQuad(
          m,
          P(bs + k * 0.36, 0.525, gy + 0.72),
          e.along,
          0.1,
          0.05,
          e.n,
          dark,
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
  hf?: Heightfield,
  poles: Vec2[] = [],
) {
  const rng = new Rng(b.seed);
  const fp = b.footprint;
  const base = b.base;
  const top = base + b.height;
  const aux = b.seed;
  let shop = b.density > 0.15 && b.kind !== 'house' && b.kind !== 'glass';
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

  // Midrise, pencil and apartment buildings: a tall ground floor (granite and
  // an entrance on the street faces), the body, and a solid crown with an
  // aluminium coping. Each footprint edge gets a facade role (front, street
  // side, party wall, rear), and window fields hold whole bays between corner
  // piers. New choices come from local streams.
  const H = b.floorH;
  const floors = Math.max(1, Math.round(b.height / H));
  const bodyFloors = floors - 1;
  const fr = new Rng(hash2(b.seed, 0xfa5));
  const roles = edgeRoles(b);
  const bay = facadeBay(b.style);
  const office = b.kind === 'midrise' && hashuf(b.style & 0x1fff) >= 0.4;
  // On quiet streets too, about half the midrises and pencils let the ground
  // floor to a shop, cafe or clinic.
  if (
    !shop &&
    b.front >= 0 &&
    (b.kind === 'midrise' || b.kind === 'pencil') &&
    new Rng(hash2(b.seed, 0x5409)).chance(0.5)
  )
    shop = true;
  const roofMat = packMat(CM.roof, b.style & 0xffff);
  const metal = packMat(CM.metal);
  const edgeLen = (i: number) => dist2(fp[i], fp[(i + 1) % fp.length]);
  // Stair / elevator core expressed on the front (or a street side), ending
  // in a penthouse at the roof edge.
  let core: {edge: number; atEnd: boolean} | null = null;
  if (
    (b.kind === 'pencil' || (b.kind === 'midrise' && fr.chance(0.8))) &&
    floors >= 3
  ) {
    const ok = (i: number) => edgeLen(i) >= CORE_W + 2.4;
    const front = roles.findIndex((r, i) => r === ROLE.front && ok(i));
    const sides = roles
      .map((r, i) => (r === ROLE.street && ok(i) ? i : -1))
      .filter(i => i >= 0);
    const useSide =
      b.kind !== 'pencil' && sides.length > 0 && (front < 0 || fr.chance(0.5));
    const edge = useSide ? sides[fr.int(0, sides.length)] : front;
    if (edge >= 0) core = {edge, atEnd: fr.chance(0.5)};
  }
  const setbackTop =
    !core && b.kind !== 'apartment' && b.height > 20 && rng.chance(0.35);
  // Stepped top floor on some midrises (with or without a core): the last
  // storey stands 1.6-2.6 m back behind a railed terrace, so the building
  // is not a sheer box from behind and above. Own stream; the building
  // stream is drawn exactly as before.
  const stepR = new Rng(hash2(b.seed, 0x57ea));
  const stepPoly =
    !setbackTop && b.kind === 'midrise' && bodyFloors >= 3 && stepR.chance(0.35)
      ? inset(fp, stepR.range(1.6, 2.6))
      : null;
  const setF = setbackTop
    ? Math.min(bodyFloors - 1, rng.int(1, 3))
    : stepPoly
      ? 1
      : 0;
  const mainTop = base + GROUND_H + (bodyFloors - setF) * H;
  // Top of the stepped / set-back upper storeys.
  const upperTop = mainTop + setF * H;
  // Body uv.y starts at one floor height, so the shader's floor 1 begins on
  // top of the tall ground floor.
  const vOff = base + GROUND_H - H;
  const edges = facadeEdges(fp, roles, bay, core);
  // Entrance lobby: under the core, else whole bays mid-front (shops have
  // shopfronts instead).
  let lobby: {edge: number; s0: number; s1: number} | null = null;
  if (!core && !shop) {
    const i = Math.max(0, roles.indexOf(ROLE.front));
    const e = edges[i];
    if (e.count > 0) {
      const bw = bay / e.k;
      const nb = Math.min(e.count, bw < 2.2 ? 2 : 1);
      const j = Math.floor((e.count - nb) / 2);
      lobby = {edge: i, s0: e.f0 + j * bw, s1: e.f0 + (j + nb) * bw};
    }
  }
  // Grade along each wall: the block paving (terrain + 0.16) just outside
  // it. Where the lot is cut into a slope, the paving behind rises above the
  // ground floor; the wall is solid (a retaining basement wall on a plinth)
  // up to the first floor whose windows clear the paving, so no window ever
  // sits half below grade.
  const grade = edges.map(e => {
    if (!hf || e.len < 0.05) return base;
    let g = -Infinity;
    const k = Math.max(1, Math.ceil(e.len / 2));
    for (let j = 0; j <= k; j++) {
      const q = edgeAt(e, (e.len * j) / k, 0.6, 0);
      g = Math.max(g, hf.sample(q[0], q[2]));
    }
    return Math.max(base, g + 0.21);
  });
  const solidTo = edges.map((e, i) => {
    if (e.role === ROLE.front) return b.low;
    // Lowest window sill of the role's floors (city-materials facadeRole).
    const sill = (f: number) =>
      e.role === ROLE.rear ? (f === 0 ? 1.2 : 0.95) : 0.6;
    for (let f = 0; f <= bodyFloors; f++) {
      const y = f === 0 ? base : base + GROUND_H + (f - 1) * H;
      if (y + sill(f) >= grade[i] + 0.3) return f === 0 ? b.low : y;
    }
    return mainTop;
  });
  const fmat = (e: FacadeEdge, zone: number, solid: boolean) =>
    packMat(
      CM.facade,
      facadeParam(
        b,
        shop && zone === FZ.base && e.role <= ROLE.street,
        false,
        e.role,
        zone,
        solid,
      ),
    );
  // One storey band on every edge: piers, the window field (split around the
  // lobby) and the core strip standing out of the wall.
  // Party walls never have openings; walls below grade are solid (`below`).
  // Party-wall quads (body, base) share an aux whose low byte is the wall
  // top (coping) in body-zone uv.y, in 0.25 m steps: uv.y of the coping =
  // (aux & 0xff) * 0.25 on body quads; base quads' uv.y starts GROUND_H - H
  // lower (FACADE_GROUND - floorH). The shader hashes aux >> 8 there.
  const partyAux =
    ((aux & ~0xff) |
      clamp(Math.round((mainTop + CROWN_H - vOff) * 4), 0, 255)) >>>
    0;
  const storeys = (
    es: FacadeEdge[],
    y0: number,
    y1: number,
    zone: number,
    vo: number,
    lob: typeof lobby,
    below: number[] = [],
    blank: {edge: number; s0: number; s1: number} | null = null,
  ) => {
    es.forEach((e, i) => {
      if (e.len < 0.05) return;
      const hasCore = !isNaN(e.core);
      const sA = hasCore && e.core === 0 ? CORE_W : 0;
      const sB = hasCore && e.core > 0 ? e.core : e.len;
      const field = fmat(e, zone, e.role === ROLE.party);
      const uf = (s: number) => e.u0 + (s - e.f0) * e.k;
      // Party walls carry their coping height in aux (partyAux).
      const qa = e.role === ROLE.party ? partyAux : aux;
      const cut = clamp(below[i] ?? y0, y0, y1);
      const fieldQuad = (s0: number, s1: number) => {
        if (cut > y0)
          edgeQuad(m, e, s0, s1, y0, cut, 0, uf(s0), uf(s1), vo, solid, qa);
        edgeQuad(m, e, s0, s1, cut, y1, 0, uf(s0), uf(s1), vo, field, qa);
      };
      const solid = fmat(e, zone, true);
      if (hasCore) {
        const lobbyHere = zone === FZ.base;
        edgeQuad(
          m,
          e,
          e.core,
          e.core + CORE_W,
          y0,
          y1,
          lod > 0 ? 0 : CORE_OUT,
          0,
          CORE_W,
          lobbyHere ? base : vo,
          fmat(e, lobbyHere ? FZ.lobby : FZ.core, false),
          qa,
        );
      }
      // Distant shells: one quad, the window grid running over the piers.
      if (lod > 0) {
        fieldQuad(sA, sB);
        return;
      }
      const pier = solid;
      const uEnd = e.u0 + e.count * bay;
      edgeQuad(m, e, sA, e.f0, y0, y1, 0, e.u0 - e.f0 + sA, e.u0, vo, pier, qa);
      edgeQuad(m, e, e.f1, sB, y0, y1, 0, uEnd, uEnd + sB - e.f1, vo, pier, qa);
      const hole =
        lob && lob.edge === i ? lob : blank?.edge === i ? blank : null;
      const cuts = hole
        ? [
            [e.f0, hole.s0],
            [hole.s1, e.f1],
          ]
        : [[e.f0, e.f1]];
      for (const [s0, s1] of cuts) fieldQuad(s0, s1);
      if (hole && hole === blank)
        edgeQuad(
          m,
          e,
          hole.s0,
          hole.s1,
          y0,
          y1,
          0,
          uf(hole.s0),
          uf(hole.s1),
          vo,
          solid,
          qa,
        );
      if (lob && lob.edge === i) {
        const lm = fmat(e, FZ.lobby, false);
        edgeQuad(
          m,
          e,
          lob.s0,
          lob.s1,
          y0,
          y1,
          0,
          0,
          lob.s1 - lob.s0,
          base,
          lm,
          qa,
        );
      }
    });
  };
  // Solid parapet in the crown tone, with a bright aluminium coping; LOD0
  // adds its inner face.
  const crown = (es: FacadeEdge[], poly: Vec2[], y0: number) => {
    let u = 0;
    for (const e of es) {
      const cm = fmat(e, FZ.crown, true);
      edgeQuad(
        m,
        e,
        0,
        e.len,
        y0,
        y0 + CROWN_H,
        0,
        u,
        u + e.len,
        base,
        cm,
        aux,
      );
      u += e.len;
    }
    coping(m, poly, y0 + CROWN_H, lod);
    const inner = lod === 0 ? inset(poly, 0.25) : null;
    if (inner)
      walls(m, inner.slice().reverse(), y0, y0 + CROWN_H, base, concrete, aux);
  };
  // Service decisions that shape the walls, made at every LOD from their own
  // stream: the steel fire stair (a switchback STAIR_L long on the rear, or a
  // party wall) and the back door, a blank bay on the rear ground floor.
  const bodyN = bodyFloors - setF;
  const cr = new Rng(hash2(b.seed, 0xac0));
  let stair = -1;
  let stairS = 0;
  // Dense blocks pack buildings back to back, so their rears and party
  // walls are mostly hidden: service detail thins out with density.
  const svc = b.density < 0.3 ? 1 : b.density < 0.55 ? 0.5 : 0.25;
  const stairP =
    (b.kind === 'pencil' ? 0.8 : b.kind === 'midrise' ? 0.65 : 0.35) * svc;
  if (cr.chance(stairP) && bodyN >= 2 && bodyN <= 7) {
    let best = -1;
    edges.forEach((e, i) => {
      if (e.role < ROLE.party || e.len < STAIR_L + 0.8) return;
      const score = e.len + (e.role === ROLE.rear ? 100 : 0);
      if (score > best) {
        best = score;
        stair = i;
      }
    });
    if (stair >= 0) {
      const e = edges[stair];
      stairS = cr.chance(0.5) ? 0.4 + STAIR_L / 2 : e.len - 0.4 - STAIR_L / 2;
    }
  }
  // Steel paint colour and wear (steelPaint), the same at every LOD.
  const stairPaint = hashu(b.seed ^ 0x57a1) & 0xff;
  // Rear balconies on the upper floors of quiet midrises: homes get deep
  // ones with solid upstands and partitions, offices the narrow emergency
  // balconies (避難バルコニー) with a steel railing that the fire stair
  // serves. Along the longest rear wall, clear of the stair.
  let rearBalc: {edge: number; s0: number; s1: number} | null = null;
  if (
    b.kind === 'midrise' &&
    bodyN >= 2 &&
    svc === 1 &&
    new Rng(hash2(b.seed, 0xbac9)).chance(office ? 0.5 : 0.6)
  ) {
    let best = -1;
    edges.forEach((e, i) => {
      if (e.role !== ROLE.rear || e.count < 3) return;
      if (best < 0 || e.len > edges[best].len) best = i;
    });
    if (best >= 0) {
      const e = edges[best];
      let s0 = e.f0 - 0.3,
        s1 = e.f1 + 0.3;
      if (stair === best) {
        if (stairS < e.len / 2) s0 = Math.max(s0, stairS + STAIR_L / 2 + 0.2);
        else s1 = Math.min(s1, stairS - STAIR_L / 2 - 0.2);
      }
      if (s1 - s0 > 3) rearBalc = {edge: best, s0, s1};
    }
  }
  let backDoor: {edge: number; s0: number; s1: number} | null = null;
  {
    const i = edges.findIndex(e => e.role === ROLE.rear && e.count >= 2);
    if (i >= 0 && solidTo[i] <= base + GROUND_H) {
      const e = edges[i];
      const bw = bay / e.k;
      // The bay nearest a third of the way along, clear of the stair.
      let bestJ = -1;
      let bestD = Infinity;
      for (let j = 0; j < e.count; j++) {
        const c = e.f0 + (j + 0.5) * bw;
        if (i === stair && Math.abs(c - stairS) < STAIR_L / 2 + bw / 2)
          continue;
        const d = Math.abs(c - e.len / 3);
        if (d < bestD) {
          bestD = d;
          bestJ = j;
        }
      }
      if (bestJ >= 0)
        backDoor = {
          edge: i,
          s0: e.f0 + bestJ * bw,
          s1: e.f0 + (bestJ + 1) * bw,
        };
    }
  }
  storeys(
    edges,
    b.low,
    base + GROUND_H,
    FZ.base,
    base,
    lobby,
    solidTo,
    backDoor,
  );
  storeys(edges, base + GROUND_H, mainTop, FZ.body, vOff, null, solidTo);
  // (Distant shells skip the terrace parapet under a stepped top floor.)
  if (!(stepPoly && lod > 0)) crown(edges, fp, mainTop);
  // Ad on an exposed party wall (quieter blocks, where it stands clear of
  // the neighbours): a printed vinyl or a lit billboard in a steel frame
  // high on the wall. The panel is drawn at every LOD (it reads from afar).
  let partyAd: {edge: number; s: number; y: number; hw: number} | null = null;
  {
    const pa = new Rng(hash2(b.seed, 0xad5));
    const cands = edges
      .map((e, i) => (e.role === ROLE.party && e.len >= 7 ? i : -1))
      .filter(i => i >= 0);
    if (cands.length && bodyN >= 3 && pa.chance(0.35 * svc)) {
      const i = cands[pa.int(0, cands.length)];
      const e = edges[i];
      const hw = Math.min(e.len * 0.32, 4.2);
      const hh = hw / 2;
      const s = e.len * pa.range(0.4, 0.6);
      const y = mainTop - 0.6 - hh;
      const lit = pa.chance(0.4);
      const id = SIGN.billboard.first + pa.int(0, SIGN.billboard.count);
      partyAd = {edge: i, s, y, hw};
      const c = edgeAt(e, s, 0.12, y);
      const W = (ds: number, dy: number): Vec3 => [
        c[0] + e.along[0] * ds,
        c[1] + dy,
        c[2] + e.along[2] * ds,
      ];
      m.quad(
        [W(-hw, -hh), W(hw, -hh), W(hw, hh), W(-hw, hh)],
        e.n,
        [
          [1, 1],
          [0, 1],
          [0, 0],
          [1, 0],
        ],
        packMat(CM.sign, id | (lit ? 0 : SIGN_FABRIC)),
      );
      if (lod === 0) {
        // Frame (a box-section rim), stand-off brackets and, on lit ones,
        // two gooseneck lamps over the top.
        const fm = steelPaint(1 + (b.seed & 0xfc));
        const R = (ds: number, dy: number, out: number): Vec3 =>
          edgeAt(e, s + ds, out, y + dy);
        const rim = 0.06;
        m.tube(
          [
            R(-hw - rim, -hh - rim, 0.13),
            R(hw + rim, -hh - rim, 0.13),
            R(hw + rim, hh + rim, 0.13),
            R(-hw - rim, hh + rim, 0.13),
            R(-hw - rim, -hh - rim, 0.13),
          ],
          0.07,
          fm,
        );
        for (const ds of [-hw * 0.6, hw * 0.6])
          for (const dy of [-hh, hh])
            m.tube([R(ds, dy, 0), R(ds, dy, 0.11)], 0.04, fm);
        if (lit) {
          for (const ds of [-hw * 0.5, hw * 0.5]) {
            m.tube(
              [
                R(ds, hh + rim, 0.13),
                R(ds, hh + 0.45, 0.25),
                R(ds, hh + 0.4, 0.9),
              ],
              0.02,
              fm,
            );
            m.box(
              R(ds, hh + 0.33, 0.9),
              [0.12, 0.05, 0.08],
              packMat(CM.lamp, 1),
              yawOf(e),
            );
          }
          lights.add(edgeAt(e, s, 2.5, y), 9, signColor(id), LightKind.sign);
        }
      }
    }
  }
  // The core strip's sides, and the penthouse it ends in on the roof.
  let pent: {rect: Vec2[]; top: number} | null = null;
  if (core) {
    const e = edges[core.edge];
    const sideMat = fmat(e, FZ.crown, true);
    for (const [s, dir] of lod > 0
      ? []
      : [
          [e.core, -1],
          [e.core + CORE_W, 1],
        ]) {
      const q = (out: number, y: number) => edgeAt(e, s, out, y);
      m.quad(
        [q(0, b.low), q(CORE_OUT, b.low), q(CORE_OUT, mainTop), q(0, mainTop)],
        [e.along[0] * dir, 0, e.along[2] * dir],
        [
          [0, b.low - base],
          [CORE_OUT, b.low - base],
          [CORE_OUT, mainTop - base],
          [0, mainTop - base],
        ],
        sideMat,
        aux,
      );
    }
    if (lod === 0) {
      // The stair windows up the core (facadeRole FZ_CORE: 0.9 x 1.2 m, one
      // per floor) get a deep bevelled precast sill and a drip hood, so
      // they sit in the wall instead of reading as stickers on it.
      const sc = e.core + CORE_W / 2;
      const trim = packMat(CM.concrete);
      const uv1: Vec2[] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      for (let f = 1; f <= bodyFloors; f++) {
        const y = base + GROUND_H + (f - 1) * H + 0.55 * (H - 1.2);
        if (y + 1.3 > upperTop) break;
        const Q = (ds: number, out: number, dy: number) =>
          edgeAt(e, sc + ds, CORE_OUT + out, y + dy);
        m.quad(
          [
            Q(-0.58, 0.16, -0.1),
            Q(0.58, 0.16, -0.1),
            Q(0.58, 0, 0),
            Q(-0.58, 0, 0),
          ],
          [e.n[0] * 0.53, 0.85, e.n[2] * 0.53],
          uv1,
          trim,
        );
        m.quad(
          [
            Q(-0.55, 0.12, 1.24),
            Q(0.55, 0.12, 1.24),
            Q(0.55, 0, 1.36),
            Q(-0.55, 0, 1.36),
          ],
          [e.n[0] * 0.7, 0.7, e.n[2] * 0.7],
          uv1,
          trim,
        );
      }
    }
    let depth = 4.5;
    const corner = (s: number, out: number): Vec2 => {
      const p = edgeAt(e, s, out, 0);
      return [p[0], p[2]];
    };
    while (
      depth > 2 &&
      !(
        pointInPolygon(corner(e.core + 0.1, -depth), fp) &&
        pointInPolygon(corner(e.core + CORE_W - 0.1, -depth), fp)
      )
    )
      depth -= 0.5;
    const rect = [
      corner(e.core, CORE_OUT),
      corner(e.core + CORE_W, CORE_OUT),
      corner(e.core + CORE_W, -depth),
      corner(e.core, -depth),
    ];
    // On a stepped top floor the core rises through it: its front keeps its
    // windows (core zone), the other sides are solid up to the upper roof.
    const top = upperTop + CROWN_H + 2.4;
    if (upperTop > mainTop) {
      edgeQuad(
        m,
        e,
        e.core,
        e.core + CORE_W,
        mainTop,
        upperTop,
        CORE_OUT,
        0,
        CORE_W,
        vOff,
        fmat(e, FZ.core, false),
        aux,
      );
      for (let i = 1; i < 4; i++) {
        const a = rect[i],
          c = rect[(i + 1) % 4];
        const nn = edgeNormal(rect, i);
        const l = dist2(a, c);
        m.quad(
          [
            [a[0], mainTop, a[1]],
            [c[0], mainTop, c[1]],
            [c[0], upperTop, c[1]],
            [a[0], upperTop, a[1]],
          ],
          nn,
          [
            [0, mainTop - base],
            [l, mainTop - base],
            [l, upperTop - base],
            [0, upperTop - base],
          ],
          sideMat,
          aux,
        );
      }
    }
    walls(m, rect, upperTop, top, base, sideMat, aux);
    cap(m, rect, top, roofMat, aux);
    if (lod === 0) coping(m, rect, top, lod);
    // Building name on the penthouse front.
    const nid = SIGN.horizontal.first + fr.int(0, SIGN.horizontal.count);
    signPanel(
      m,
      edgeAt(e, e.core + CORE_W / 2, CORE_OUT + 0.06, top - 0.75),
      e.along,
      1.05,
      0.28,
      0.05,
      nid,
      -1,
      lod,
      false,
    );
    if (lod === 0) {
      roofHouse(m, rect, upperTop, top, 2);
      // Elevator overrun: the lift machine room stepping up at the back.
      m.box(
        edgeAt(e, e.core + CORE_W / 2, -depth + 1.0, top + 0.6),
        [0.9, 0.6, 0.95],
        sideMat,
        yawOf(e),
        aux,
      );
    }
    pent = {rect, top};
  }
  roof = fp;
  roofY = mainTop;
  let roofEdges = edges;
  if (setF > 0) {
    const s = stepPoly ?? inset(fp, rng.range(1.5, 3));
    if (s) {
      const top2 = upperTop;
      const se = facadeEdges(
        s,
        s.length === fp.length ? roles : s.map(() => ROLE.front),
        bay,
        null,
      );
      cap(m, fp, mainTop, roofMat, aux);
      storeys(se, mainTop, top2, FZ.body, vOff, null);
      crown(se, s, top2);
      roof = s;
      roofEdges = se;
      roofY = top2;
      // The terrace in front of a stepped top floor is railed.
      const ring = stepPoly && lod === 0 ? inset(fp, 0.1) : null;
      if (ring)
        guardRail(
          m,
          ring,
          mainTop + CROWN_H + 0.06,
          steelPaint(2 | (b.seed & 0xfc)),
        );
    }
  }
  cap(m, roof, roofY, roofMat, aux);

  // Draws that LOD0-only parts depend on are made at every LOD, so `fr`
  // stays in step between LODs.
  const ledgeNone = fr.chance(0.4);
  const vending = fr.chance(0.4);
  const ar = new Rng(hash2(b.seed, 0xba1));
  if (lod === 0) {
    // Ledges on the street faces only: a deep course over the base, then
    // every third floor (offices), every floor or none (homes).
    const every = office ? 3 : ledgeNone ? 0 : 1;
    for (const e of edges) {
      if (e.role > ROLE.street || e.len < 1) continue;
      const hasCore = !isNaN(e.core);
      for (let j = 0; j < bodyFloors - setF; j++) {
        if (j > 0 && (every === 0 || j % every !== 0)) continue;
        const depth = j === 0 ? 0.3 : office ? 0.35 : 0.18;
        const sA = hasCore && e.core === 0 ? CORE_W : -depth;
        const sB = hasCore && e.core > 0 ? e.core : e.len + depth;
        const y = base + GROUND_H + j * H + 0.06;
        m.beam(
          edgeAt(e, sA, depth / 2, y),
          edgeAt(e, sB, depth / 2, y),
          depth / 2,
          j === 0 ? 0.14 : 0.06,
          concrete,
          0,
          [-e.n[0], 0, -e.n[2]],
        );
      }
    }
  }

  // Balconies with solid upstands across the front of residential midrises
  // (deep shadow bands that read from afar): one slab and panel per floor.
  if (b.kind === 'midrise' && !office && fr.chance(0.7)) {
    const e = edges[Math.max(0, roles.indexOf(ROLE.front))];
    const trim = fmat(e, FZ.trim, true);
    for (let f = 1; f <= bodyFloors - setF && e.count > 0; f++) {
      const y = base + GROUND_H + (f - 1) * H;
      // Distant shells: the slab's top shows over the panel below.
      if (lod > 0)
        edgeQuad(
          m,
          e,
          e.f0,
          e.f1,
          y - 0.12,
          y + 1.1,
          1.0,
          0,
          1,
          base,
          trim,
          aux,
        );
      else
        m.beam(
          edgeAt(e, e.f0, 0.5, y - 0.06),
          edgeAt(e, e.f1, 0.5, y - 0.06),
          0.5,
          0.06,
          concrete,
          0,
          [-e.n[0], 0, -e.n[2]],
        );
      if (lod === 0)
        edgeQuad(
          m,
          e,
          e.f0,
          e.f1,
          y,
          y + 1.1,
          1.0,
          0,
          e.f1 - e.f0,
          base,
          trim,
          aux,
        );
      if (lod > 0) continue;
      m.beam(
        edgeAt(e, e.f0, 1.0, y + 1.12),
        edgeAt(e, e.f1, 1.0, y + 1.12),
        0.06,
        0.03,
        concrete,
        0,
        [-e.n[0], 0, -e.n[2]],
      );
      if (ar.chance(0.5)) {
        const s = lerp(e.f0 + 0.6, e.f1 - 0.6, ar.next());
        m.box(
          edgeAt(e, s, 0.4, y + 0.28),
          [0.4, 0.275, 0.145],
          packMat(CM.paint, 0xe0),
          Math.atan2(e.n[0], e.n[2]),
        );
      }
    }
  }

  // Balconies on apartments.
  if (b.kind === 'apartment' && lod === 0) {
    for (let i = 0; i < fp.length; i++) {
      if (!b.frontage[i]) continue;
      const a = fp[i],
        c = fp[(i + 1) % fp.length];
      const len = dist2(a, c);
      if (len < 6) continue;
      const n = edgeNormal(fp, i);
      const ia: Vec2 = [lerp(a[0], c[0], 0.05), lerp(a[1], c[1], 0.05)];
      const ic: Vec2 = [lerp(a[0], c[0], 0.95), lerp(a[1], c[1], 0.95)];
      for (let f = 1; f <= bodyFloors; f++) {
        const y = base + GROUND_H + (f - 1) * H;
        const o0: Vec3 = [ia[0] + n[0] * 0.6, y, ia[1] + n[2] * 0.6];
        const o1: Vec3 = [ic[0] + n[0] * 0.6, y, ic[1] + n[2] * 0.6];
        const inward: Vec3 = [-n[0], 0, -n[2]];
        m.beam(o0, o1, 0.6, 0.08, concrete, 0, inward);
        m.beam(
          [ia[0] + n[0] * 1.15, y + 0.55, ia[1] + n[2] * 1.15],
          [ic[0] + n[0] * 1.15, y + 0.55, ic[1] + n[2] * 1.15],
          0.04,
          0.5,
          packMat(CM.paint, (b.style >> 4) & 0xff),
          aux,
          inward,
        );
      }
      break;
    }
  }

  // Entrance: canopy with a downlight pool, mailbox bank and intercom; a
  // name sign on the core even on quiet streets, and sometimes a vending
  // machine.
  const entrance = core
    ? {edge: core.edge, s: edges[core.edge].core + CORE_W / 2, out: CORE_OUT}
    : lobby
      ? {edge: lobby.edge, s: (lobby.s0 + lobby.s1) / 2, out: 0}
      : null;
  if (entrance) {
    const e = edges[entrance.edge];
    const yaw = Math.atan2(e.n[0], e.n[2]);
    const {s, out} = entrance;
    // Toward the window field.
    const side = s < e.len / 2 ? 1 : -1;
    if (lod === 0) {
      lights.add(
        edgeAt(e, s, out + 1.4, base + 3.2),
        8,
        [1.0, 0.85, 0.65],
        LightKind.sign,
      );
      const hw = Math.min(2, s - 0.2, e.len - s - 0.2);
      m.box(
        edgeAt(e, s, out + 0.75, base + 3.6),
        [hw, 0.12, 0.75],
        concrete,
        yaw,
      );
      m.box(
        edgeAt(e, s, out + 1.49, base + 3.55),
        [hw, 0.16, 0.02],
        metal,
        yaw,
      );
      const ms = s + side * (CORE_W / 2 + 0.5);
      if (ms > 0.4 && ms < e.len - 0.4) {
        m.box(
          edgeAt(e, ms, 0.12, base + 1.2),
          [0.35, 0.3, 0.12],
          metal,
          yaw,
          0,
          false,
          true,
        );
        m.box(
          edgeAt(e, ms, 0.04, base + 1.95),
          [0.12, 0.17, 0.04],
          packMat(CM.paint, 0xd3),
          yaw,
        );
      }
      const vs = s + side * (CORE_W / 2 + 2.2);
      if (b.density < 0.1 && vending && vs > 0.8 && vs < e.len - 0.8)
        vendingMachine(m, edgeAt(e, vs, 0.4, base + 0.16), e.n, b.seed & 0xff);
      // Push bars on the glass doors, and potted plants either side.
      for (const d of [-1, 1])
        m.beam(
          edgeAt(e, s + d * 0.12, out + 0.06, base + 1.05),
          edgeAt(e, s + d * 0.62, out + 0.06, base + 1.05),
          0.018,
          0.018,
          metal,
        );
      const pr = new Rng(hash2(b.seed, 0x9a17));
      for (const d of [-1, 1]) {
        const ps = s + d * (Math.min(CORE_W, 2) / 2 + 0.55);
        if (pr.chance(0.6) && ps > 0.5 && ps < e.len - 0.5)
          pottedPlant(m, edgeAt(e, ps, out + 0.45, base + 0.16), pr);
      }
    }
    if (core && b.density < 0.1 && bodyFloors >= 3) {
      const span = Math.min(bodyFloors - 1, 3);
      const bs = core.atEnd ? e.core - 0.25 : e.core + CORE_W + 0.25;
      const h2 = span * H * 0.9;
      const y0 = base + GROUND_H + 0.4;
      const id = SIGN.vertical.first + fr.int(0, SIGN.vertical.count);
      signPanel(
        m,
        edgeAt(e, bs, 0.95, y0 + h2 / 2),
        e.n,
        0.45,
        h2 / 2,
        0.12,
        id,
        -1,
        lod,
      );
      if (lod === 0)
        for (const t of [0.1, 0.9])
          m.beam(
            edgeAt(e, bs, 0, y0 + t * h2),
            edgeAt(e, bs, 0.5, y0 + t * h2),
            0.04,
            0.04,
            metal,
          );
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
      let t = clamp(
        slots[k % slots.length] + (k >= 5 ? 0.05 : 0) + sr.range(-0.04, 0.04),
        0.04,
        0.96,
      );
      // Keep clear of the core strip.
      if (core && core.edge === i) {
        const c0 = edges[i].core;
        if (core.atEnd) t = Math.min(t, (c0 - 0.6) / len);
        else t = Math.max(t, (c0 + CORE_W + 0.6) / len);
      }
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
        // The panel runs perpendicular to the facade (wider on distant
        // shells, where a true-size blade is under a pixel edge-on).
        const k1 = lod > 0 ? BLADE_LOD1 : 1;
        const p = wallAt(t, out - halfW + halfW * k1, y0 + h2 / 2);
        const th = sr.range(0.1, 0.2);
        signPanel(m, p, n, halfW * k1, h2 / 2, th, id, -1, lod);
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
        signPanel(m, wallAt(t, out, y), n, hs, hs, hs * 0.85, sq, sq, lod);
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
          -1,
          lod,
          false,
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
        signPanel(m, p, n, 0.32, h2 / 2, 0.01, id | SIGN_FABRIC, -1, lod);
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
    // Zakkyo stack: on fronts without a blade stack, a projecting tenant
    // sign per upper floor in one column on a steel spine, at the street
    // corner (or the end away from the core).
    const zr = new Rng(hash2(b.seed, 0x2a6c));
    if (
      vertical < 2 &&
      (b.kind === 'pencil' || b.kind === 'midrise') &&
      bodyN >= 2 &&
      (office || shop || zr.chance(0.35))
    ) {
      const prev = roles[(i + fp.length - 1) % fp.length] === ROLE.street;
      const next = roles[(i + 1) % fp.length] === ROLE.street;
      let atEnd = next && !prev ? true : prev && !next ? false : zr.chance(0.5);
      if (core?.edge === i) atEnd = !core.atEnd;
      const t = atEnd ? 1 - 0.45 / len : 0.45 / len;
      const hl = 0.35 * (lod > 0 ? BLADE_LOD1 : 1);
      const hh = H * 0.4;
      const out = 0.3 + hl;
      const y0 = base + GROUND_H + 0.2;
      const yTop = base + GROUND_H + (bodyN - 1) * H + H * 0.5 + hh;
      const id0 = zr.int(0, SIGN.vertical.count);
      for (let f = 1; f <= bodyN; f++) {
        const yc = base + GROUND_H + (f - 1) * H + H * 0.5;
        // A different tenant on every floor.
        const id = SIGN.vertical.first + ((id0 + f * 7) % SIGN.vertical.count);
        signPanel(m, wallAt(t, out, yc), n, hl, hh, 0.09, id, -1, lod);
        if (lod === 0)
          m.beam(
            wallAt(t, 0, yc + hh - 0.1),
            wallAt(t, 0.32, yc + hh - 0.1),
            0.03,
            0.03,
            metal,
          );
      }
      if (lod === 0)
        m.beam(wallAt(t, 0.28, y0), wallAt(t, 0.28, yTop), 0.04, 0.04, metal);
      if (lod === 0)
        lights.add(
          wallAt(t, 1.8, (y0 + yTop) / 2),
          10,
          signColor(SIGN.vertical.first + zr.int(0, SIGN.vertical.count)),
          LightKind.sign,
        );
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
          signPanel(
            m,
            at(0.35 + hs, y0 + hs),
            n2,
            hs,
            hs,
            hs * 0.85,
            sq,
            sq,
            lod,
          );
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
            -1,
            lod,
          );
        }
      }
    }
    if (shop && len > 4) {
      // (A draw kept so the building stream stays in step.)
      rng.int(0, SIGN.horizontal.count);
      // The shopfront: the front clear of the core strip.
      let ft0 = 0,
        ft1 = 1;
      if (core?.edge === i) {
        const c0 = edges[i].core;
        if (core.atEnd) ft1 = Math.max(0.2, (c0 - 0.3) / len);
        else ft0 = Math.min(0.8, (c0 + CORE_W + 0.3) / len);
      }
      const ftAt = (t: number) => ft0 + (ft1 - ft0) * t;
      // Tenants: the shader picks a shop type per pair of bays (shopTypeAt),
      // so each run of same-type bays is one business, and its fascia sign
      // names that kind of business.
      const fe = edges[i];
      const tenants: {type: number; s0: number; s1: number; id: number}[] = [];
      {
        const bw = bay / fe.k;
        const col0 = Math.round(fe.u0 / bay);
        for (let j = 0; j < fe.count; j++) {
          const type = shopTypeAt(aux, col0 + j);
          const s0 = fe.f0 + j * bw;
          const last = tenants[tenants.length - 1];
          if (last?.type === type) last.s1 = s0 + bw;
          else tenants.push({type, s0, s1: s0 + bw, id: 0});
        }
        if (!tenants.length)
          tenants.push({
            type: SHOP_TYPE.restaurant,
            s0: ft0 * len,
            s1: ft1 * len,
            id: 0,
          });
        // The end tenants take the shopfront out to the piers.
        tenants[0].s0 = Math.min(tenants[0].s0, ft0 * len + 0.3);
        tenants[tenants.length - 1].s1 = Math.max(
          tenants[tenants.length - 1].s1,
          ft1 * len - 0.3,
        );
        for (const t of tenants) {
          const ids = TENANT_SIGNS[t.type];
          t.id = ids[sr.int(0, ids.length)];
        }
      }
      const main = tenants.reduce((p, t) =>
        t.s1 - t.s0 > p.s1 - p.s0 ? t : p,
      );
      const id = main.id;
      // Fascia box signs: depth and height vary per building.
      const halfH = sr.range(0.35, 0.6);
      const out = sr.range(0.18, 0.5);
      const y = base + GROUND_H * 0.86 + (halfH - 0.45) * 0.5;
      for (const t of tenants) {
        const w = t.s1 - t.s0;
        const halfW = Math.min(w * (w < 3 ? 0.44 : 0.4), 6);
        signPanel(
          m,
          wallAt((t.s0 + t.s1) / 2 / len, out, y),
          along,
          halfW,
          t === main ? halfH : halfH * 0.85,
          0.16,
          t.id,
          -1,
          lod,
          false,
        );
      }
      // The lit fascia washes the pavement at night.
      if (lod === 0)
        lights.add(
          wallAt((main.s0 + main.s1) / 2 / len, 1.8, y - 0.8),
          7,
          signColor(id),
          LightKind.sign,
        );
      if (lod === 0) {
        // Roll-shutter housing over the opening with its guide rails, an
        // A-frame stand sign and a plant or two by the door, then each
        // tenant's street kit.
        const st = new Rng(hash2(b.seed, 0x5f0e));
        const hy = y - halfH - 0.16;
        m.beam(
          wallAt(ftAt(0.02), 0.13, hy),
          wallAt(ftAt(0.98), 0.13, hy),
          0.13,
          0.13,
          metal,
          0,
          [-n[0], 0, -n[2]],
        );
        for (const t of [0.02, 0.98])
          m.beam(
            wallAt(ftAt(t), 0.04, base),
            wallAt(ftAt(t), 0.04, hy - 0.13),
            0.035,
            0.03,
            metal,
          );
        const gy = base + 0.16;
        if (st.chance(0.7)) {
          const t = ftAt(st.range(0.2, 0.8));
          const k = st.int(0, SIGN.square.count);
          const tn =
            tenants.find(x => t * len >= x.s0 && t * len <= x.s1) ?? main;
          const sq = TENANT_SQUARES[tn.type];
          aFrameSign(
            m,
            wallAt(t, st.range(1.1, 1.6), gy),
            n,
            sq[k % sq.length],
          );
        }
        for (const t of [0.06, 0.94])
          if (st.chance(0.4)) pottedPlant(m, wallAt(ftAt(t), 0.45, gy), st);
        const kr = new Rng(hash2(b.seed, 0x7e4a));
        for (const t of tenants) tenantKit(m, fe, t, gy, hy - 0.13, kr);
      }
      if (lod === 0) {
        const ay = base + GROUND_H * 0.62;
        // A konbini always has the flat canopy, and the brightest light on
        // the block: a cold white pool on the pavement in front.
        const konbini = tenants.find(t => t.type === SHOP_TYPE.konbini);
        const aStyle = konbini ? (sr.next(), 0.7) : sr.next();
        if (konbini)
          lights.add(
            wallAt((konbini.s0 + konbini.s1) / 2 / len, 1.6, base + 2.3),
            10,
            [3.0, 3.5, 3.9],
            LightKind.station,
          );
        if (aStyle < 0.55) {
          // Sloped fabric awning: striped canvas with a printed valance.
          const t0 = ftAt(sr.range(0.06, 0.2)),
            t1 = ftAt(1 - sr.range(0.06, 0.2));
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
          // Flat canopy: a deck with a fascia band across its front (striped
          // in the konbini's colours over a konbini, else aluminium) and a
          // pale soffit with a row of downlight cans. Up to 1.2 m deep,
          // stopping 0.35 m short of any street light pole in front.
          const t0 = ftAt(0.06),
            t1 = ftAt(0.94);
          let R = 1.2;
          for (const p of poles) {
            const dx = p[0] - a[0],
              dz = p[1] - a[1];
            const s = (dx * along[0] + dz * along[2]) / len;
            const o = dx * n[0] + dz * n[2];
            if (s > t0 - 0.5 / len && s < t1 + 0.5 / len && o > 0 && o < 2)
              R = Math.min(R, o - 0.35);
          }
          R = Math.max(0.5, R);
          const w = (t1 - t0) * len;
          const C = (t: number, out: number, y: number) => wallAt(t, out, y);
          const deck = packMat(CM.paint, (b.seed >> 8) & 0xff);
          const quad = (q: Vec3[], nn: Vec3, mat: number, uw = w, vh = 1) =>
            m.quad(
              q,
              nn,
              [
                [0, 0],
                [uw, 0],
                [uw, vh],
                [0, vh],
              ],
              mat,
            );
          const yT = ay + 0.12,
            yB = ay - 0.06,
            yF = ay - 0.26;
          quad(
            [C(t0, 0, yT), C(t1, 0, yT), C(t1, R, yT), C(t0, R, yT)],
            UP,
            deck,
          );
          quad(
            [C(t0, 0, yB), C(t1, 0, yB), C(t1, R, yB), C(t0, R, yB)],
            [0, -1, 0],
            packMat(CM.paint, 0xd0),
          );
          // Fascia: on a konbini the stripes run along the band (uv.x up).
          const fasciaQ = [
            C(t0, R, yF),
            C(t1, R, yF),
            C(t1, R, yT),
            C(t0, R, yT),
          ];
          if (konbini)
            m.quad(
              fasciaQ,
              n,
              [
                [0, 0],
                [0, w],
                [3, w],
                [3, 0],
              ],
              packMat(CM.sign, (konbini.id & 0xff) | SIGN_STRIPES),
            );
          else quad(fasciaQ, n, metal);
          for (const [t, sg] of [
            [t0, -1],
            [t1, 1],
          ] as const)
            quad(
              [C(t, 0, yF), C(t, R, yF), C(t, R, yT), C(t, 0, yT)],
              [along[0] * sg, 0, along[2] * sg],
              metal,
              R,
              yT - yF,
            );
          // Downlight cans in the soffit (lit at night, cool white over a
          // konbini, warm elsewhere).
          const cans = Math.max(2, Math.round(w / 1.25));
          const lamp = packMat(CM.lamp, konbini ? 1 : 0);
          for (let k = 0; k < cans; k++) {
            const t = lerp(t0, t1, (k + 0.5) / cans);
            const dt = 0.09 / len;
            const y = yB - 0.01;
            quad(
              [
                C(t - dt, R * 0.55 - 0.09, y),
                C(t + dt, R * 0.55 - 0.09, y),
                C(t + dt, R * 0.55 + 0.09, y),
                C(t - dt, R * 0.55 + 0.09, y),
              ],
              [0, -1, 0],
              lamp,
              1,
            );
          }
        }
        // Nobori: cloth banners on poles in front of the shop.
        if (b.density > 0.3 && sr.chance(0.3)) {
          const count = sr.int(2, 4);
          for (let f = 0; f < count; f++) {
            const t = ftAt(0.15 + (0.7 * (f + 0.5)) / count);
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
      signPanel(m, p, along, w, w * 0.5, 0.15, id, -1, lod);
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
        signPanel(m, p, n, hh * 0.26, hh, 0.25, vid, -1, lod);
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
          signPanel(m, p, along, w, hh, 0.15, bid, -1, lod);
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

  // Service sides (LOD0): a concrete plinth under every wall but the front,
  // downpipes from rain heads with an offset, meters, AC condensers on
  // brackets with refrigerant and condensate lines, sills and heads on the
  // rear's punched windows, the back door, and the steel fire stair. Party
  // walls stay blank (no openings, no AC): tie-rod plates, a vent and a
  // downpipe (the shader's partyWall() paints the demolished neighbour's
  // ghost roofline).
  if (lod === 0) {
    const steelGrey = packMat(CM.paint, 0x90);
    const acMat = packMat(CM.paint, 0xe0);
    const pipeMat = packMat(CM.paint, 0xd2);
    const dark = packMat(CM.paint, 0x91);
    const wallTop = mainTop + CROWN_H;
    const plinth = (i: number) =>
      edges[i].role !== ROLE.front && edges[i].len >= 0.5;
    // Paving level just outside each wall.
    const paving = (i: number) => Math.max(base, grade[i] - 0.05);
    edges.forEach((e, i) => {
      if (!plinth(i)) return;
      const top = Math.max(base + 0.35, grade[i] + 0.25);
      const ex0 = plinth((i + edges.length - 1) % edges.length) ? 0.05 : 0;
      const ex1 = plinth((i + 1) % edges.length) ? 0.05 : 0;
      const P = (s: number, out: number, y: number) => edgeAt(e, s, out, y);
      const uv: Vec2[] = [
        [0, 0],
        [e.len, 0],
        [e.len, 1],
        [0, 1],
      ];
      m.quad(
        [
          P(-ex0, 0.05, b.low),
          P(e.len + ex1, 0.05, b.low),
          P(e.len + ex1, 0.05, top),
          P(-ex0, 0.05, top),
        ],
        e.n,
        uv,
        concrete,
      );
      m.quad(
        [
          P(-ex0, 0, top),
          P(e.len + ex1, 0, top),
          P(e.len + ex1, 0.05, top),
          P(-ex0, 0.05, top),
        ],
        UP,
        uv,
        concrete,
      );
    });
    // Downpipe from a rain head under the coping down to grade: a swan-neck
    // offset back to the wall under the head, an optional jog sideways by
    // `jog` at height `jy`, and a shoe kicking out at the foot. Ivory PVC,
    // so it reads as a light line with a shadow on the grey render.
    const downpipe = (
      e: FacadeEdge,
      s: number,
      ground: number,
      jog = 0,
      jy = 0,
    ) => {
      const yHead = wallTop - 0.55;
      if (svc === 1)
        m.box(
          edgeAt(e, s, 0.2, yHead),
          [0.16, 0.17, 0.12],
          steelGrey,
          yawOf(e),
          0,
          false,
          true,
        );
      const o = 0.09;
      const pts: Vec3[] = [
        edgeAt(e, s, 0.2, yHead - 0.17),
        edgeAt(e, s, 0.2, yHead - 0.35),
        edgeAt(e, s, o, yHead - 0.6),
        ...(jog !== 0
          ? [edgeAt(e, s, o, jy + 0.3), edgeAt(e, s + jog, o, jy - 0.1)]
          : []),
        edgeAt(e, s + jog, o, ground + 0.35),
        edgeAt(e, s + jog, 0.24, ground + 0.12),
      ];
      m.tube(pts, 0.065, pipeMat);
    };
    const inStair = (i: number, s: number, pad = 0) =>
      i === stair && Math.abs(s - stairS) < STAIR_L / 2 + pad;
    // Party wall kit: a gas riser and a water line as pipe runs with
    // clamps at the floor lines, and on some walls a corrugated steel sheet
    // patched over old damage. Clear of the ad and the stair.
    const partyKit = (e: FacadeEdge, i: number, ground: number) => {
      const pr = new Rng(hash2(b.seed, 0x9a27 + i));
      const P = (s: number, out: number, y: number) => edgeAt(e, s, out, y);
      const clear = (s: number, pad: number) =>
        !inStair(i, s, pad) &&
        !(partyAd?.edge === i && Math.abs(s - partyAd.s) < partyAd.hw + pad);
      const yTop = wallTop - 0.5;
      const gasS = pr.chance(0.5)
        ? pr.range(0.8, 1.6)
        : e.len - pr.range(0.8, 1.6);
      if (clear(gasS, 0.3) && pr.chance(0.6)) {
        const gas = packMat(CM.paint, pr.chance(0.5) ? 0x92 : 0xd2);
        m.tube(
          [
            P(gasS, 0.07, ground + 1.1),
            P(gasS, 0.07, yTop),
            P(gasS + 0.3, 0.07, yTop),
            P(gasS + 0.3, 0, yTop),
          ],
          0.03,
          gas,
        );
      }
      if (bodyN >= 2 && pr.chance(0.4)) {
        // Water / drain line along a floor line, then down to grade.
        const f = pr.int(1, bodyN);
        const y = base + GROUND_H + f * H - 0.35;
        const sa = e.len * pr.range(0.3, 0.55);
        const sb = sa + (pr.chance(0.5) ? 1 : -1) * pr.range(1.5, 3);
        if (sb > 0.4 && sb < e.len - 0.4 && clear(sa, 0.2) && clear(sb, 0.2))
          m.tube(
            [
              P(sa, 0, y),
              P(sa, 0.06, y),
              P(sb, 0.06, y),
              P(sb, 0.06, ground + 0.15),
            ],
            0.035,
            steelGrey,
          );
      }
      if (bodyN >= 2 && pr.chance(0.35)) {
        // Corrugated sheet over one or two floors, ribs vertical.
        const w = Math.min(e.len - 1.2, pr.range(2.4, 4.8));
        const s0 = pr.range(0.6, e.len - 0.6 - w);
        const f = pr.int(1, bodyN);
        const y0 = Math.max(base + GROUND_H + (f - 1) * H, grade[i] + 0.4);
        const y1 = Math.min(y0 + H * pr.range(1, 2), mainTop);
        if (clear(s0, 0.2) && clear(s0 + w, 0.2) && clear(s0 + w / 2, 0)) {
          const sheet = packMat(CM.paint, 0xf8);
          const o = 0.035;
          m.quad(
            [P(s0, o, y0), P(s0 + w, o, y0), P(s0 + w, o, y1), P(s0, o, y1)],
            e.n,
            [
              [0, 0],
              [w, 0],
              [w, y1 - y0],
              [0, y1 - y0],
            ],
            sheet,
          );
          // Flashing over the top edge.
          flatQuad(
            m,
            P(s0 + w / 2, o + 0.01, y1),
            e.along,
            w / 2 + 0.03,
            0.04,
            e.n,
            steelGrey,
          );
        }
      }
    };
    let meters = false;
    edges.forEach((e, i) => {
      if (e.role < ROLE.party || e.len < 3) return;
      const yaw = yawOf(e);
      const ground = paving(i);
      // Downpipes at the corners (moved off the stair), and on long rears
      // one more at a bay joint, with an offset over a floor line.
      const pipes = e.role === ROLE.rear ? [0.3, e.len - 0.3] : [0.3];
      for (const s0 of pipes) {
        const s = inStair(i, s0, 0.3)
          ? s0 < e.len / 2
            ? stairS + STAIR_L / 2 + 0.3
            : stairS - STAIR_L / 2 - 0.3
          : s0;
        if (s > 0.2 && s < e.len - 0.2) downpipe(e, s, ground);
      }
      if (e.role === ROLE.rear && e.count >= 4 && svc === 1) {
        const bw = bay / e.k;
        const j = 1 + cr.int(0, e.count - 2);
        const s = e.f0 + j * bw;
        const jy = base + GROUND_H + cr.int(0, Math.max(1, bodyN - 1)) * H;
        const jog = (cr.chance(0.5) ? 1 : -1) * 0.35;
        if (!inStair(i, s, 0.5) && !inStair(i, s + jog, 0.5))
          downpipe(e, s, ground, jog, jy);
      }
      if (!meters && e.len > 4) {
        meters = true;
        const s0 = backDoor?.edge === i ? backDoor.s1 + 0.25 : e.f0 + 0.3;
        // A gang of gas meters on one board, the electric meter box above
        // it and its conduit.
        m.box(
          edgeAt(e, s0 + 0.45, 0.09, ground + 0.9),
          [0.6, 0.2, 0.09],
          packMat(CM.paint, 0xd4),
          yaw,
          0,
          true,
          true,
        );
        m.box(
          edgeAt(e, s0 + 0.35, 0.07, ground + 1.75),
          [0.2, 0.28, 0.07],
          packMat(CM.paint, 0xd6),
          yaw,
          0,
          true,
          true,
        );
        flatQuad(
          m,
          edgeAt(e, s0 + 0.35, 0.145, ground + 1.8),
          e.along,
          0.09,
          0.09,
          e.n,
          packMat(CM.glass, 4),
        );
        m.beam(
          edgeAt(e, s0 + 0.35, 0.03, ground + 2.03),
          edgeAt(e, s0 + 0.35, 0.03, ground + 3.6),
          0.025,
          0.025,
          steelGrey,
        );
      }
      if (e.role === ROLE.party) {
        // Tie-rod anchor plates at alternate floor lines, one vent hood.
        for (let f = 2; f <= bodyN && svc === 1; f += 2) {
          const y = base + GROUND_H + (f - 1) * H - 0.15;
          if (y < solidTo[i] && y < grade[i] + 0.5) continue;
          for (const t of [0.22, 0.78])
            flatQuad(
              m,
              edgeAt(e, e.len * t, 0.015, y),
              e.along,
              0.13,
              0.13,
              e.n,
              dark,
            );
        }
        if (bodyN >= 2 && svc === 1) {
          // Kitchen exhaust: a flush louvre under a sloped weather cowl.
          const f = cr.int(1, bodyN + 1);
          const s = lerp(e.len * 0.35, e.len * 0.65, cr.next());
          const y = base + GROUND_H + (f - 1) * H + 2.4;
          flatQuad(m, edgeAt(e, s, 0.01, y), e.along, 0.17, 0.15, e.n, metal);
          for (const dy of [-0.08, 0, 0.08])
            flatQuad(
              m,
              edgeAt(e, s, 0.015, y + dy),
              e.along,
              0.14,
              0.018,
              e.n,
              dark,
            );
          const c = (ds: number, out: number, dy: number) =>
            edgeAt(e, s + ds, out, y + dy);
          const nl = Math.hypot(0.16, 0.12);
          m.quad(
            [
              c(-0.19, 0.16, 0.06),
              c(0.19, 0.16, 0.06),
              c(0.19, 0, 0.18),
              c(-0.19, 0, 0.18),
            ],
            [(e.n[0] * 0.12) / nl, 0.16 / nl, (e.n[2] * 0.12) / nl],
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
            metal,
          );
        }
        if (svc === 1) partyKit(e, i, ground);
        return;
      }
      // Rear: deep precast sills under the punched windows (facadeRole:
      // rear windows are 0.45 x 0.45 of bay and floor), shadowing the wall
      // below, and on homes a roller-shutter box over half of them,
      // skipping the stair column of glass block, the back door bay, floors
      // behind a rear balcony and floors below grade. Security grilles (面格子:
      // aluminium bars in a frame) on most ground-floor windows and some
      // upper ones.
      const bw = bay / e.k;
      const hw = 0.225 * bw;
      const col0 = Math.round(e.u0 / bay);
      const trimMat = packMat(CM.concrete);
      const alu = packMat(CM.paint, 0xd3);
      const gr = new Rng(hash2(b.seed, 0x6e1 + i));
      let grilles = 0;
      const glassBlock = (f: number, j: number) =>
        f >= 1 && (col0 + j + 1000 + (aux >>> 4)) % 11 === 0;
      const uv: Vec2[] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      const behindBalc = (f: number, s: number) =>
        f >= 1 && rearBalc?.edge === i && s > rearBalc.s0 && s < rearBalc.s1;
      for (let f = 0; f <= bodyN && svc === 1 && b.kind !== 'apartment'; f++) {
        const y0 = f === 0 ? base : base + GROUND_H + (f - 1) * H;
        if (y0 < solidTo[i]) continue;
        const fh = f === 0 ? GROUND_H : H;
        const sill = y0 + 0.55 * fh * 0.55;
        const head = sill + 0.45 * fh;
        for (let j = 0; j < e.count; j++) {
          if (glassBlock(f, j)) continue;
          const s = e.f0 + (j + 0.5) * bw;
          if (behindBalc(f, s)) continue;
          if (
            f === 0 &&
            backDoor?.edge === i &&
            s > backDoor.s0 &&
            s < backDoor.s1
          )
            continue;
          const Q = (ds: number, out: number, y: number) =>
            edgeAt(e, s + ds, out, y);
          const w = hw + 0.08;
          // Sill: one steep bevelled face 15 cm out and 9 cm down (it
          // catches the light and throws a shadow line under the window).
          m.quad(
            [
              Q(-w, 0.15, sill - 0.09),
              Q(w, 0.15, sill - 0.09),
              Q(w, 0, sill),
              Q(-w, 0, sill),
            ],
            [e.n[0] * 0.5, 0.86, e.n[2] * 0.5],
            uv,
            trimMat,
          );
          if (!office && f >= 1 && hashuf(aux ^ (j * 31 + f * 977)) < 0.45) {
            // Roller-shutter box over the opening (front and underside).
            const sb = (out: number, y: number, ds: number) =>
              Q(ds * (hw + 0.05), out, y);
            m.quad(
              [
                sb(0.2, head, -1),
                sb(0.2, head, 1),
                sb(0.2, head + 0.26, 1),
                sb(0.2, head + 0.26, -1),
              ],
              e.n,
              uv,
              alu,
            );
            m.quad(
              [
                sb(0, head, -1),
                sb(0, head, 1),
                sb(0.2, head, 1),
                sb(0.2, head, -1),
              ],
              [0, -1, 0],
              uv,
              alu,
            );
          }
          if (
            grilles >= 1 ||
            inStair(i, s, 0.3) ||
            !gr.chance(f === 0 ? 0.8 : 0.3)
          )
            continue;
          grilles++;
          const gh = (head - sill) / 2;
          const gy = sill + gh;
          const nb = 3;
          for (let k = 0; k <= nb; k++)
            flatQuad(
              m,
              Q(-hw + (2 * hw * k) / nb, 0.06, gy),
              e.along,
              0.014,
              gh,
              e.n,
              alu,
            );
          for (const dy of [-gh, gh])
            flatQuad(
              m,
              Q(0, 0.065, gy + dy),
              e.along,
              hw + 0.01,
              0.02,
              e.n,
              alu,
            );
        }
      }
      // AC condensers on brackets under rear windows, where the shader
      // bleeds rust below a bracket (city-materials facadeMat: a third of
      // the cells, by cellSeed): each unit's insulated refrigerant line
      // runs over to a duct cover that carries the column's lines down the
      // wall into the ground; a condensate drain hangs below each.
      const acCell = (f: number, j: number) => {
        const c = hashu(
          (aux ^
            hashu(
              (Math.imul(col0 + j + 1000, 73856093) ^
                Math.imul(f + 1000, 19349663)) >>>
                0,
            )) >>>
            0,
        );
        return hashuf(c ^ 0xac1) < 0.3;
      };
      let units = 0;
      const maxUnits = Math.round(3 * svc);
      // The duct cover runs just clear of the windows.
      const dS = Math.max(0.55, hw + 0.12);
      for (let j = 0; j < e.count; j++) {
        const s = e.f0 + (j + 0.5) * bw;
        if (inStair(i, s, 0.6) || inStair(i, s + dS, 0.3)) continue;
        let topY = -Infinity;
        for (let f = 1; f <= bodyN && units < maxUnits; f++) {
          const y0 = base + GROUND_H + (f - 1) * H;
          if (
            y0 < solidTo[i] ||
            behindBalc(f, s) ||
            glassBlock(f, j) ||
            !acCell(f, j)
          )
            continue;
          const y = y0 + 0.55 * H * 0.55 - 0.42;
          m.box(
            edgeAt(e, s, 0.3, y),
            [0.4, 0.275, 0.145],
            acMat,
            yaw,
            0,
            true,
            true,
          );
          const sh = (ds: number, out: number) =>
            edgeAt(e, s + ds, out, y - 0.28);
          m.quad(
            [sh(-0.42, 0), sh(0.42, 0), sh(0.42, 0.47), sh(-0.42, 0.47)],
            [0, -1, 0],
            uv,
            steelGrey,
          );
          const g = (ds: number, dy: number) =>
            edgeAt(e, s + ds, 0.447, y + dy);
          m.quad(
            [g(-0.31, -0.19), g(0.07, -0.19), g(0.07, 0.19), g(-0.31, 0.19)],
            e.n,
            uv,
            packMat(CM.frame),
          );
          m.tube(
            [
              edgeAt(e, s + 0.4, 0.3, y - 0.12),
              edgeAt(e, s + dS, 0.3, y - 0.12),
              edgeAt(e, s + dS, 0.07, y - 0.12),
            ],
            0.03,
            pipeMat,
          );
          const dl = 0.3 + 0.6 * hashuf(units * 7 + aux);
          const dq = (ds: number, dy: number) =>
            edgeAt(e, s - 0.3 + ds, 0.25, y - 0.28 + dy);
          m.quad(
            [dq(-0.01, -dl), dq(0.01, -dl), dq(0.01, 0), dq(-0.01, 0)],
            e.n,
            uv,
            dark,
          );
          topY = Math.max(topY, y - 0.12);
          units++;
        }
        if (topY > -Infinity) {
          const ground = paving(i);
          m.tube(
            [
              edgeAt(e, s + dS, 0.07, topY + 0.04),
              edgeAt(e, s + dS, 0.07, ground + 0.35),
              edgeAt(e, s + dS, 0, ground + 0.45),
            ],
            0.05,
            pipeMat,
          );
        }
      }
      if (backDoor?.edge === i) {
        // Steel back door in a frame, a small canopy with a lamp, a step.
        const s = (backDoor.s0 + backDoor.s1) / 2;
        const y = ground;
        steelDoor(
          m,
          edgeAt(e, s, 0, y),
          e.along,
          e.n,
          cr.chance(0.5) ? 0x90 : 0x80,
          true,
        );
        m.box(edgeAt(e, s, 0.2, y + 0.05), [0.6, 0.05, 0.2], concrete, yaw);
        // Condensers on blocks beside it.
        const n2 = svc === 1 ? cr.int(1, 3) : 0;
        for (let k = 0; k < n2; k++) {
          const sc = backDoor.s1 + 0.7 + k * 0.9;
          if (sc > e.len - 0.6 || inStair(i, sc, 0.6)) break;
          m.box(edgeAt(e, sc, 0.42, y + 0.4), [0.4, 0.28, 0.15], acMat, yaw);
        }
      }
    });
    if (rearBalc) {
      // Rear balconies: a slab per upper floor, a balustrade panel (homes:
      // solid upstand in the trim tone, with frosted partitions between
      // flats; offices: ribbed steel sheet) under a pipe rail, end panels,
      // and AC units on some.
      const e = edges[rearBalc.edge];
      const {s0, s1} = rearBalc;
      const D = office ? 0.95 : 1.25;
      const into: Vec3 = [-e.n[0], 0, -e.n[2]];
      const rail = steelPaint(1 | (b.seed & 0xfc));
      const panel = office ? packMat(CM.paint, 0xf8) : fmat(e, FZ.trim, true);
      const P = (s: number, out: number, y: number) => edgeAt(e, s, out, y);
      const quv: Vec2[] = [
        [0, 0],
        [s1 - s0, 0],
        [s1 - s0, 1.0],
        [0, 1.0],
      ];
      const br = new Rng(hash2(b.seed, 0xbac3));
      for (let f = 1; f <= bodyN; f++) {
        const y = base + GROUND_H + (f - 1) * H;
        if (y < solidTo[rearBalc.edge]) continue;
        m.beam(
          P(s0, D / 2, y - 0.09),
          P(s1, D / 2, y - 0.09),
          D / 2,
          0.11,
          concrete,
          0,
          into,
        );
        m.quad(
          [
            P(s0, D, y + 0.06),
            P(s1, D, y + 0.06),
            P(s1, D, y + 1.06),
            P(s0, D, y + 1.06),
          ],
          e.n,
          quv,
          panel,
          aux,
        );
        m.tube(
          [P(s0, D - 0.02, y + 1.1), P(s1, D - 0.02, y + 1.1)],
          0.045,
          rail,
        );
        if (!office) {
          // Partitions (隔て板) between flats, every three bays.
          const pw = (bay / e.k) * 3;
          for (let s = s0 + pw; s < s1 - 0.8; s += pw)
            flatQuad(
              m,
              P(s, D / 2, y + 0.9),
              [e.n[0], 0, e.n[2]],
              D / 2 - 0.05,
              0.85,
              e.along,
              packMat(CM.glass, 4),
            );
        }
        // End panels.
        for (const [s, sg] of [
          [s0, -1],
          [s1, 1],
        ] as const)
          m.quad(
            [
              P(s, 0, y + 0.02),
              P(s, D, y + 0.02),
              P(s, D, y + 1.06),
              P(s, 0, y + 1.06),
            ],
            [e.along[0] * sg, 0, e.along[2] * sg],
            [
              [0, 0],
              [D, 0],
              [D, 1.04],
              [0, 1.04],
            ],
            panel,
            aux,
          );
        if (br.chance(0.35)) {
          const s = lerp(s0 + 0.7, s1 - 0.7, br.next());
          m.box(P(s, 0.45, y + 0.3), [0.4, 0.28, 0.15], acMat, yawOf(e));
        }
      }
    }
    if (stair >= 0)
      fireStair(m, edges[stair], stairS, {
        levels: [
          paving(stair),
          ...Array.from({length: bodyN}, (_, f) => base + GROUND_H + f * H),
        ].filter((y, k) => k === 0 || y > paving(stair) + 1.6),
        low: b.low,
        toEnd: stairS < edges[stair].len / 2,
        paint: stairPaint,
      });
  } else if (stair >= 0) {
    const g = Math.max(base, grade[stair] - 0.05);
    fireStairShell(m, edges[stair], stairS, {
      levels: [
        g,
        ...Array.from({length: bodyN}, (_, f) => base + GROUND_H + f * H),
      ].filter((y, k) => k === 0 || y > g + 1.6),
      low: b.low,
      toEnd: stairS < edges[stair].len / 2,
      paint: stairPaint,
    });
  }

  // Roof: the penthouse (over the core, or a stair house in the corner away
  // from the front), a square FRP water tank on a steel stand, a mesh fence,
  // an antenna and AC rows. Placement uses its own stream and is the same at
  // both LODs (LOD1 merges small parts into boxes).
  {
    const rr = new Rng(hash2(b.seed, 0x700e));
    const area = polygonArea(roof);
    const box = obb(roof);
    const U = box.u;
    const V: Vec2 = [-U[1], U[0]];
    // CMesh.box: forward (h[2]) runs along U, right (h[0]) along V.
    const yaw = Math.atan2(U[0], U[1]);
    const at = (su: number, sv: number): Vec2 => [
      box.c[0] + U[0] * su + V[0] * sv,
      box.c[1] + U[1] * su + V[1] * sv,
    ];
    const toObb = (q: Vec2): Vec2 => {
      const dx = q[0] - box.c[0],
        dz = q[1] - box.c[1];
      return [dx * U[0] + dz * U[1], dx * V[0] + dz * V[1]];
    };
    const taken: number[][] = [];
    const fits = (su: number, sv: number, hu: number, hv: number) => {
      for (const [a, c] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ])
        if (!pointInPolygon(at(su + a * (hu + 0.5), sv + c * (hv + 0.5)), roof))
          return false;
      return !taken.some(
        t =>
          Math.abs(su - t[0]) < hu + t[2] + 0.5 &&
          Math.abs(sv - t[1]) < hv + t[3] + 0.5,
      );
    };
    const crownMat = fmat(edges[0], FZ.crown, true);
    // Where an antenna can stand.
    let mast: Vec3 | null = null;
    if (pent) {
      const q = pent.rect.map(toObb);
      const u0 = Math.min(...q.map(p => p[0])),
        u1 = Math.max(...q.map(p => p[0]));
      const v0 = Math.min(...q.map(p => p[1])),
        v1 = Math.max(...q.map(p => p[1]));
      taken.push([(u0 + u1) / 2, (v0 + v1) / 2, (u1 - u0) / 2, (v1 - v0) / 2]);
      const c = centroid(pent.rect);
      mast = [c[0], pent.top, c[1]];
    } else if (b.height > 13) {
      const fe = edges[Math.max(0, roles.indexOf(ROLE.front))];
      const fm = edgeAt(fe, fe.len / 2, 0, 0);
      let best: Vec2 | null = null;
      let bestD = -1;
      for (const [a, c] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]) {
        const su = a * (box.hu - 2.1),
          sv = c * (box.hv - 2.1);
        const q = at(su, sv);
        const d = Math.hypot(q[0] - fm[0], q[1] - fm[2]);
        if (d > bestD && fits(su, sv, 1.6, 1.6)) {
          bestD = d;
          best = [su, sv];
        }
      }
      if (best) {
        const q = at(best[0], best[1]);
        const hh = Math.max(1.5, (H - 0.2) / 2);
        m.box([q[0], roofY + hh, q[1]], [1.6, hh, 1.6], crownMat, yaw, aux);
        taken.push([best[0], best[1], 1.6, 1.6]);
        mast = [q[0], roofY + hh * 2, q[1]];
        if (lod === 0) {
          const [su, sv] = best;
          let rect = [
            at(su - 1.6, sv - 1.6),
            at(su + 1.6, sv - 1.6),
            at(su + 1.6, sv + 1.6),
            at(su - 1.6, sv + 1.6),
          ];
          if (polygonArea(rect) * polygonArea(fp) < 0) rect = rect.reverse();
          // The door faces the middle of the roof.
          let door = 0;
          let bestDot = -Infinity;
          rect.forEach((a, i) => {
            const nn = edgeNormal(rect, i);
            const d = nn[0] * (box.c[0] - q[0]) + nn[2] * (box.c[1] - q[1]);
            if (d > bestDot) {
              bestDot = d;
              door = i;
            }
          });
          coping(m, rect, roofY + hh * 2, lod);
          roofHouse(m, rect, roofY, roofY + hh * 2, door);
        }
      }
    }
    // FRP panel water tank (3.0 x 2.4 x 2.0 m) high on a 2.4 m steel stand
    // in a corner: four tube legs, a top frame, a diagonal brace on every
    // side and a ladder up past the top. The stand is dark painted steel,
    // so it reads against the white tank and the grey roof from the air.
    if (
      b.height > 12 &&
      rr.chance(b.kind === 'pencil' ? 0.5 : b.kind === 'midrise' ? 0.9 : 0.55)
    ) {
      let sa = rr.chance(0.5) ? 1 : -1,
        sb = rr.chance(0.5) ? 1 : -1;
      // Prefer a back corner, so the stand shows in front of the tank from
      // the street and the air.
      if (b.front >= 0) {
        const fe = edges[b.front];
        const f = toObb([fe.a[0] + fe.n[0] * 30, fe.a[1] + fe.n[2] * 30]);
        if (Math.abs(f[0]) > 4) sa = f[0] > 0 ? -1 : 1;
        if (Math.abs(f[1]) > 4) sb = f[1] > 0 ? -1 : 1;
      }
      const TU = 1.5,
        TV = 1.2;
      // Corners first (stepping in where a corner is clipped), then the
      // middle; small roofs take a smaller tank.
      const spots = (hu: number, hv: number): Vec2[] => {
        const r: Vec2[] = [];
        for (const d of [0.7, 1.6, 2.6])
          for (const [a, c] of [
            [sa, sb],
            [-sa, sb],
            [sa, -sb],
            [-sa, -sb],
          ])
            r.push([a * (box.hu - hu - d), c * (box.hv - hv - d)]);
        r.push([0, 0]);
        return r;
      };
      let k = 1;
      let spot = spots(TU, TV).find(p => fits(p[0], p[1], TU, TV));
      if (!spot) {
        k = 0.75;
        spot = spots(TU * k, TV * k).find(p =>
          fits(p[0], p[1], TU * k, TV * k),
        );
      }
      if (spot) {
        const hu = TU * k,
          hv = TV * k;
        taken.push([spot[0], spot[1], hu, hv]);
        const q = at(spot[0], spot[1]);
        const ty = roofY + 2.4 * k;
        const th = 1.0 * k;
        m.box(
          [q[0], ty + th, q[1]],
          [hv, th, hu],
          packMat(CM.paint, 0xd1),
          yaw,
        );
        const steel = steelPaint(
          (rr.int(0, 64) << 2) | (rr.chance(0.6) ? 0 : 3),
        );
        // Legs just inside the tank's corners.
        const lu = hu - 0.12,
          lv = hv - 0.12;
        const leg = (a: number, c: number, y: number): Vec3 => {
          const p = at(spot[0] + a * lu, spot[1] + c * lv);
          return [p[0], y, p[1]];
        };
        if (lod > 0) {
          // Distant shells: the stand as one diagonal frame.
          const p0 = leg(-1, -1, roofY),
            p1 = leg(1, 1, roofY);
          const nn: Vec3 = [p1[2] - p0[2], 0, p0[0] - p1[0]];
          const l = Math.hypot(nn[0], nn[2]) || 1;
          for (const sg of [l, -l])
            m.quad(
              [p0, p1, [p1[0], ty, p1[2]], [p0[0], ty, p0[2]]],
              [nn[0] / sg, 0, nn[2] / sg],
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
              steel,
            );
        } else {
          const corners = [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ];
          for (const [a, c] of corners)
            m.tube([leg(a, c, roofY), leg(a, c, ty)], 0.075, steel);
          // Top frame (a ring beam under the tank) and a zig-zag of braces:
          // one diagonal per side.
          m.tube(
            [...corners, corners[0]].map(([a, c]) => leg(a, c, ty - 0.06)),
            0.06,
            steel,
          );
          m.tube(
            [...corners, corners[0]].map(([a, c], j) =>
              leg(a, c, j % 2 ? ty - 0.15 : roofY + 0.15),
            ),
            0.045,
            steel,
          );
          // Ladder up the side (rails and rungs) to the manhole on top.
          const lad = (d: number, y: number): Vec3 => {
            const p = at(spot[0] + hu + 0.25, spot[1] + d);
            return [p[0], y, p[1]];
          };
          const yTop = ty + th * 2 + 0.9;
          for (const d of [-0.22, 0.22])
            m.tube([lad(d, roofY), lad(d, yTop)], 0.022, steel);
          const along: Vec3 = [V[0], 0, V[1]];
          const out: Vec3 = [U[0], 0, U[1]];
          for (let y = roofY + 0.5; y < yTop - 0.2; y += 0.6)
            flatQuad(m, lad(0, y), along, 0.22, 0.02, out, steel);
        }
      }
    }
    // Green mesh fence set in from the parapet.
    const fence = rr.chance(0.25);
    const fenceRing = fence && lod === 0 ? inset(roof, 0.5) : null;
    if (fenceRing) {
      const green = packMat(CM.paint, 0x6b);
      // Rails: one tube round the ring each.
      for (const [h, r] of [
        [0.1, 0.02],
        [1.8, 0.03],
      ])
        m.tube(
          [...fenceRing, fenceRing[0]].map((q): Vec3 => [
            q[0],
            roofY + h,
            q[1],
          ]),
          r,
          green,
        );
      for (let i = 0; i < fenceRing.length; i++) {
        const a = fenceRing[i],
          c = fenceRing[(i + 1) % fenceRing.length];
        const len = dist2(a, c);
        const posts = Math.max(1, Math.round(len / 4));
        for (let k = 0; k < posts; k++) {
          const t = k / posts;
          const x = lerp(a[0], c[0], t),
            z = lerp(a[1], c[1], t);
          m.beam([x, roofY, z], [x, roofY + 1.8, z], 0.03, 0.03, green);
        }
      }
    }
    // Steel guard rail on the parapet coping (midrises, and some other roofs
    // without a fence): posts, a mid rail and a top rail that break the
    // skyline.
    const kr = new Rng(hash2(b.seed, 0x7a11));
    const guard =
      !fence &&
      (kr.chance(b.density < 0.3 ? 0.55 : 0.2) || b.kind === 'midrise');
    // (Drawn at every LOD so kr stays in step for the sign below.)
    const railPaint = steelPaint([1, 2, 3, 1][kr.int(0, 4)] | (b.seed & 0xfc));
    const guardRing = guard && lod === 0 ? inset(roof, 0.1) : null;
    if (guardRing) guardRail(m, guardRing, roofY + CROWN_H + 0.06, railPaint);
    // A tenant / building-name sign on a lattice frame behind the front
    // parapet, beside the penthouse (quiet streets; dense ones get their
    // rooftop signs with the other signs). On a stepped top floor it
    // stands on the upper roof, behind that floor's front.
    const signEdge =
      b.front < 0
        ? null
        : roof === fp
          ? edges[b.front]
          : stepPoly
            ? roofEdges.reduce((p, e) => {
                const f = edges[b.front].n;
                const d = (x: FacadeEdge) => x.n[0] * f[0] + x.n[2] * f[2];
                return d(e) > d(p) ? e : p;
              })
            : null;
    if (
      signEdge &&
      b.kind !== 'apartment' &&
      b.density <= 0.35 &&
      b.height < 45 &&
      kr.chance(office ? 0.55 : 0.3)
    ) {
      const e = signEdge;
      let s0 = 0.8,
        s1 = e.len - 0.8;
      if (core?.edge === b.front) {
        // Where the core strip meets this edge.
        const ce = edges[b.front];
        const cp = edgeAt(ce, ce.core, 0, 0);
        const cs =
          (cp[0] - e.a[0]) * e.along[0] + (cp[2] - e.a[1]) * e.along[2];
        if (core.atEnd) s1 = Math.min(s1, cs - 0.6);
        else s0 = Math.max(s0, cs + CORE_W + 0.6);
      }
      const hw = Math.min((s1 - s0) * 0.42, 3.2);
      const sc = (s0 + s1) / 2;
      const hh = hw / 3.2;
      const out = -1.3;
      const yb = roofY + CROWN_H + 1.1;
      const corners = [
        edgeAt(e, sc - hw, out + 0.3, 0),
        edgeAt(e, sc + hw, out + 0.3, 0),
        edgeAt(e, sc + hw, out - 2.1, 0),
        edgeAt(e, sc - hw, out - 2.1, 0),
      ].map((q): Vec2 => [q[0], q[2]]);
      const qs = corners.map(toObb);
      const u0 = Math.min(...qs.map(q => q[0])),
        u1 = Math.max(...qs.map(q => q[0]));
      const v0 = Math.min(...qs.map(q => q[1])),
        v1 = Math.max(...qs.map(q => q[1]));
      const free =
        hw >= 1.2 &&
        corners.every(q => pointInPolygon(q, roof)) &&
        !taken.some(
          t =>
            Math.abs((u0 + u1) / 2 - t[0]) < (u1 - u0) / 2 + t[2] &&
            Math.abs((v0 + v1) / 2 - t[1]) < (v1 - v0) / 2 + t[3],
        );

      if (free) {
        taken.push([
          (u0 + u1) / 2,
          (v0 + v1) / 2,
          (u1 - u0) / 2,
          (v1 - v0) / 2,
        ]);
        const id = SIGN.horizontal.first + kr.int(0, SIGN.horizontal.count);
        signPanel(
          m,
          edgeAt(e, sc, out, yb + hh),
          e.along,
          hw,
          hh,
          0.08,
          id,
          -1,
          lod,
          false,
        );
        const steel = steelPaint((b.seed >> 8) & 0xfc);
        const top = yb + hh * 2;
        // The bare back of the board: a grey steel sheet, seen from the
        // roof, the rear and the air.
        const B = (ds: number, y: number): Vec3 =>
          edgeAt(e, sc + ds, out - 0.08, y);
        m.quad(
          [B(hw, yb), B(-hw, yb), B(-hw, top), B(hw, top)],
          [-e.n[0], 0, -e.n[2]],
          [
            [0, 0],
            [hw * 2, 0],
            [hw * 2, hh * 2],
            [0, hh * 2],
          ],
          packMat(CM.paint, 0x90),
        );
        const F = (sl: number, y: number, o2 = out - 0.2) =>
          edgeAt(e, sl, o2, y);
        // Exposed steel truss standing clear above the parapet and up the
        // back of the board: posts about every metre with X bracing in
        // each panel, chords at the foot, under and over the board, two
        // main legs with raking backstays. Distant shells get the legs and
        // one X.
        const ylo = roofY + 0.3,
          yhi = yb - 0.08;
        const legs = [sc - hw * 0.85, sc + hw * 0.85];
        for (const sl of legs) m.tube([F(sl, roofY), F(sl, top)], 0.08, steel);
        if (lod > 0) {
          m.tube([F(legs[0], ylo), F(legs[1], yhi)], 0.05, steel);
          m.tube([F(legs[1], ylo), F(legs[0], yhi)], 0.05, steel);
        } else {
          const np = Math.max(2, Math.round((legs[1] - legs[0]) / 1.1));
          const pw = (legs[1] - legs[0]) / np;
          for (let k = 1; k < np; k++)
            m.tube(
              [F(legs[0] + k * pw, ylo), F(legs[0] + k * pw, top)],
              0.04,
              steel,
            );
          for (let k = 0; k < np; k++) {
            const s0 = legs[0] + k * pw,
              s1 = s0 + pw;
            m.tube([F(s0, ylo), F(s1, yhi), F(s0, top)], 0.028, steel);
            m.tube([F(s1, ylo), F(s0, yhi), F(s1, top)], 0.028, steel);
          }
          for (const y of [ylo, yhi, (yhi + top) / 2, top])
            m.tube([F(legs[0], y), F(legs[1], y)], 0.05, steel);
          for (const sl of legs)
            m.tube([F(sl, roofY, out - 2.0), F(sl, top - 0.1)], 0.06, steel);
        }
      }
    }
    // Antenna mast with crossbars on the penthouse or stair house.
    const mastH = rr.range(4, 6);
    const bars = rr.int(2, 4);
    if (rr.chance(0.25) && mast && lod === 0) {
      m.beam(mast, [mast[0], mast[1] + mastH, mast[2]], 0.04, 0.04, metal);
      for (let k = 0; k < bars; k++) {
        const y = mast[1] + mastH - 0.3 - k * 0.7;
        const w = 0.9 - k * 0.2;
        m.beam(
          [mast[0] - U[0] * w, y, mast[2] - U[1] * w],
          [mast[0] + U[0] * w, y, mast[2] + U[1] * w],
          0.015,
          0.015,
          metal,
        );
      }
    }
    // A row of AC condensers on steel sleepers near a roof edge, fans toward
    // the middle, their refrigerant lines gathered in one insulated run
    // that turns down into the roof at a gooseneck (big roofs get
    // roofField's banks instead). LOD1: the row as one box.
    const nUnits = rr.int(4, 12);
    rr.chance(0.6);
    const flip = rr.range(-1, 1) < 0 ? -1 : 1;
    const shift = rr.range(-1, 1);
    if (area < 400) {
      const pitch = 1.02;
      // Row frame in the OBB: centre (su, sv), `ax` = 0 runs along U, 1
      // along V; `side` is the roof edge it backs onto.
      let row: {
        su: number;
        sv: number;
        n: number;
        side: number;
        ax: number;
      } | null = null;
      for (let n = 3 + (nUnits % 3); n >= 3 && !row; n--) {
        const L = (n * pitch) / 2;
        for (const ax of [0, 1]) {
          const ha = ax ? box.hv : box.hu,
            hb = ax ? box.hu : box.hv;
          const room = Math.max(0, ha - L - 0.7);
          for (const back of [1.35, 2.2, 3.2]) {
            for (const side of [flip, -flip]) {
              const ob = side * (hb - back);
              const oa = [shift * room, 0, room, -room].find(a =>
                ax ? fits(ob, a, 0.45, L) : fits(a, ob, L, 0.45),
              );
              if (oa !== undefined) {
                row = ax
                  ? {su: ob, sv: oa, n, side, ax}
                  : {su: oa, sv: ob, n, side, ax};
                break;
              }
            }
            if (row) break;
          }
          if (row) break;
        }
      }
      if (row) {
        const {su, sv, n, side, ax} = row;
        const L = (n * pitch) / 2;
        taken.push(ax ? [su, sv, 0.45, L] : [su, sv, L, 0.45]);
        const y0 = roofY + 0.12;
        // Along the row (A) and toward its roof edge (B), as world vectors.
        const A: Vec2 = ax ? V : U;
        const Bv: Vec2 = ax ? U : V;
        const ryaw = ax ? yaw + Math.PI / 2 : yaw;
        const P = (da: number, db: number, y: number): Vec3 => {
          const p = at(su, sv);
          return [
            p[0] + A[0] * da + Bv[0] * db * side,
            y,
            p[1] + A[1] * da + Bv[1] * db * side,
          ];
        };
        // (Distant shells leave the row out: a metre-high box is a pixel.)
        if (lod === 0) {
          const toMid: Vec3 = [-Bv[0] * side, 0, -Bv[1] * side];
          const alongA: Vec3 = [A[0], 0, A[1]];
          for (let k = 0; k < n; k++) {
            const da = -L + pitch * (k + 0.5);
            m.box(
              P(da, 0, y0 + 0.42),
              [0.35, 0.42, 0.47],
              packMat(CM.paint, 0xe0 + (k & 3)),
              ryaw,
            );
            flatQuad(
              m,
              P(da - 0.08, -0.355, y0 + 0.45),
              alongA,
              0.29,
              0.29,
              toMid,
              packMat(CM.frame),
            );
          }

          m.tube(
            [
              P(-L + 0.3, 0.5, y0 + 0.3),
              P(L + 0.45, 0.5, y0 + 0.3),
              P(L + 0.45, 0.5, y0 + 0.75),
              P(L + 0.75, 0.5, y0 + 0.75),
              P(L + 0.75, 0.5, roofY),
            ],
            0.06,
            packMat(CM.paint, 0xd2),
          );
          // The power feed: a covered cable tray on low stools across the
          // roof from the row to the penthouse or stair house.
          if (mast) {
            const c0 = at(su, sv);
            const dx = mast[0] - c0[0],
              dz = mast[2] - c0[1];
            const ta = dx * A[0] + dz * A[1];
            const tb = (dx * Bv[0] + dz * Bv[1]) * side;
            const ea = ta > 0 ? L + 0.3 : -L - 0.3;
            const corner = P(ea, tb, roofY + 0.2);
            if (
              Math.abs(tb) > 2.5 &&
              pointInPolygon([corner[0], corner[2]], roof)
            ) {
              const end = P(ta - Math.sign(ta - ea) * 1.9, tb, roofY + 0.2);
              const tray = packMat(CM.paint, 0x90);
              const pts = [P(ea, -0.2, roofY + 0.2), corner, end];
              for (let k = 0; k + 1 < pts.length; k++)
                m.beam(pts[k], pts[k + 1], 0.13, 0.06, tray, 0, [0, -1, 0]);
            }
          }
        }
      }
    }
    // Solar array on low roofs.
    if (b.height < 25 && rr.chance(0.2) && lod === 0) {
      for (let k = 0; k < 4; k++) {
        const su = -box.hu * 0.3 + k * 2.2,
          sv = box.hv * 0.35;
        if (fits(su, sv, 0.8, 1.0)) {
          const q = at(su, sv);
          m.box(
            [q[0], roofY + 0.5, q[1]],
            [1.0, 0.04, 0.8],
            packMat(CM.glass, 4),
            yaw,
          );
        }
      }
    }
    roofField(m, roof, roofY, null, b.seed, lod, crownMat, aux, taken);
  }
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
  const pts: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    pts.push([
      lerp(a[0], b[0], t),
      lerp(a[1], b[1], t) - sag * 4 * t * (1 - t),
      lerp(a[2], b[2], t),
    ]);
  }
  m.tube(pts, 0.012 * Math.SQRT2, packMat(CM.wire));
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
  // Street lights, and the poles near this tile (shop canopies keep clear).
  const n = Math.ceil(size / TILE_SIZE);
  const tx0 = (tile % n) * TILE_SIZE - size / 2,
    tz0 = Math.floor(tile / n) * TILE_SIZE - size / 2;
  const poles: Vec2[] = [];
  streetLightSpots(L, ctx.geom, hf, (p, dir, kind, sodium) => {
    if (inTile(p[0], p[2])) streetLight(m, p, dir, kind, sodium);
    if (
      p[0] > tx0 - 40 &&
      p[0] < tx0 + TILE_SIZE + 40 &&
      p[2] > tz0 - 40 &&
      p[2] < tz0 + TILE_SIZE + 40
    )
      poles.push([p[0], p[2]]);
  });
  for (const bi of ctx.tileBuildings[tile] ?? [])
    building(L.buildings[bi], m, lod, lights, L.params.signDensity, hf, poles);

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
          const x = lerp(a[0], c[0], t) + n[0] * 0.4;
          const z = lerp(a[1], c[1], t) + n[2] * 0.4;
          const p: Vec3 = [x, sidewalkY(hf, x, z, b.base), z];
          vendingMachine(m, p, n, (b.id + k) & 0xff);
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
