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
  SIGNAL_LUM,
  SODIUM,
  LED,
  landing,
  sidewalkY,
  avenueTreeS,
  bandSurfaceAt,
  signalLums,
  signalSpots,
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
  TENANT_NOBORI,
  TENANT_SIGNS,
  TENANT_SQUARES,
  SIGN_WAY_SHIFT,
  GUIDE_DIR,
  GUIDE_FACES,
  guideFace,
  isShopSign,
  signColor,
  signGlow,
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
    m.beam(
      [a[0], y + h / 2, a[1]],
      [b[0], y + h / 2, b[1]],
      0.18,
      h / 2,
      mat,
      0,
      undefined,
      CHAMFER,
    );
  }
}

/**
 * A sign panel: box whose two big faces show atlas sign `id` (id may carry
 * SIGN_* flags). With `sideId` the two end faces show that sign too (cube
 * light boxes); otherwise they are a metal frame. Distant shells (`lod` > 0)
 * get only the two sign faces (and lit cube sides, and with `shellUnder`
 * the underside), so far and shell views keep their colour.
 */
/**
 * Colourway offset (SIGN_WAYS) for the shop signs of the building being
 * generated: set from its seed at the top of building(), so each building
 * paints the shared sign words in its own mix of colour schemes.
 */
let signVariant = 0;

/** Sign material param for atlas id `id` (plus flags) on the current building. */
function shopSignParam(id: number) {
  return isShopSign(id & 0xff) && !(id & SIGN_STRIPES)
    ? id | (signVariant << SIGN_WAY_SHIFT)
    : id;
}

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
  shellUnder = false,
) {
  const n: Vec3 = [along[2], 0, -along[0]];
  const P = (s: number, t: number, k: number): Vec3 => [
    c[0] + along[0] * s * halfLen + n[0] * k * thick,
    c[1] + t * halfH,
    c[2] + along[2] * s * halfLen + n[2] * k * thick,
  ];
  const mat = packMat(CM.sign, shopSignParam(id));
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
  const frame = packMat(CM.metal);
  if (lod > 0 && sideId < 0) {
    // (`shellUnder`: the underside too, so a box sign over a shopfront
    // keeps its depth on shells.)
    if (shellUnder)
      m.quad(
        [P(-1, -1, 1), P(1, -1, 1), P(1, -1, -1), P(-1, -1, -1)],
        [0, -1, 0],
        uv01,
        frame,
      );
    return;
  }
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
  const side = sideId >= 0 ? packMat(CM.sign, shopSignParam(sideId)) : frame;
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
/** Bevel on LOD0 base-course ledges, bands, parapets and coping. */
const CHAMFER = 0.02;
/** Bevel on the stair core strip's outer vertical corners (LOD0). */
const CORNER_BEVEL = 0.03;
const FZ = {body: 0, base: 1, lobby: 2, crown: 3, core: 4, trim: 5} as const;
/** Facade roles of footprint edges (param bits 21-22). */
const ROLE = {front: 0, street: 1, party: 2, rear: 3} as const;
/** Ground floor height of midrise, pencil and apartment buildings. */
const GROUND_H = 4.2;
/** Solid parapet (crown) height above the roof. */
const CROWN_H = 1.0;
/**
 * The demolished neighbour's ghost on a party wall: how far the wall it
 * stood against stands proud of the wall above its roofline, and how far
 * short of the wall's ends the ghost relief stops.
 */
const GHOST_STEP = 0.025;
const GHOST_END = 0.1;
/** Warm white of the floodlamps over a party-wall ad (LightKind.station). */
const FLOOD: Vec3 = [0.6, 0.5, 0.36];
/** Warm bulkhead / security lamps on service walls (LightKind.station). */
const WALL_LAMP: Vec3 = [0.45, 0.35, 0.22];

/**
 * Billboard design for one of a building's billboards (`slot`: 0 party-wall
 * ad, 1 rooftop billboard, 2 billboard on a rooftop frame). Not drawn at
 * random (8 designs repeat often): a colouring of a 28 m lattice, (i + 3j)
 * mod 8, under which no two cells closer than about 80 m share a design, so
 * the same ad does not turn up on the building across the street.
 */
const BILLBOARD_CELL = 28;
function billboardId(b: Building, slot: number) {
  const c = centroid(b.footprint);
  const i = Math.floor(c[0] / BILLBOARD_CELL),
    j = Math.floor(c[1] / BILLBOARD_CELL);
  const n = SIGN.billboard.count;
  return SIGN.billboard.first + ((((i + 3 * j + [0, 4, 2][slot]) % n) + n) % n);
}
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

/** The shaders' hash21 (common.wgsl), in f32 steps. */
function hash21(x: number, y: number) {
  const f = Math.fround;
  const fr = (v: number) => f(v - Math.floor(v));
  let p0 = fr(f(x * f(0.1031))),
    p1 = fr(f(y * f(0.1031))),
    p2 = p0;
  const d = f(
    f(p0 * f(p1 + f(33.33))) +
      f(p1 * f(p2 + f(33.33))) +
      f(p2 * f(p0 + f(33.33))),
  );
  p0 = f(p0 + d);
  p1 = f(p1 + d);
  p2 = f(p2 + d);
  return fr(f(f(p0 + p1) * p2));
}

/**
 * The demolished neighbour's ghost on a party wall (city-materials.wgsl
 * partyWall): null where the wall has none, else its old roofline `top(u)`
 * in body-zone uv (uv.y = y - vOff) and whether it was a gable. `partyAux`
 * is the party-wall quads' aux.
 */
function partyGhost(partyAux: number) {
  const aux = hashu(partyAux >>> 8);
  const ab = aux & 255;
  const gh = hashuf(aux ^ 0x6057);
  if (gh >= 0.75) return null;
  const h0 = 5.4 + 3.2 * hashuf(aux ^ 0x6058);
  const segW = 3.5 + 3.0 * hashuf(aux ^ 0x6059);
  const gable = gh < 0.28;
  const top = (u: number) =>
    gable
      ? h0 + Math.max(0, 2.4 - Math.abs(u - segW * 1.6) * 0.55)
      : h0 + Math.floor(hash21(Math.floor(u / segW), ab) * 3) * 0.9 - 0.9;
  return {top, segW, gable, h0, ab};
}

/** Window bay width of a facade style (facadeStyle in city-materials.wgsl). */
function facadeBay(style: number) {
  const h = hashu(Math.imul(style & 0x1fff, 747796405) + 1);
  return 1.5 + 1.7 * hashuf(h ^ 0x1234);
}

/**
 * Window opening of a facade style on the street faces (facadeStyle in
 * city-materials.wgsl): width and height as fractions of the bay and the
 * floor, ribbon (strip) windows, and the facade family.
 */
function facadeWindows(style: number, kind: number) {
  const h = hashu(Math.imul(style & 0x1fff, 747796405) + 1);
  let winW = 0.42 + 0.38 * hashuf(h ^ 0x22);
  let winH = 0.42 + 0.24 * hashuf(h ^ 0x33);
  const strip = hashuf(h ^ 0x44) < (kind === 0 ? 0.6 : 0.28);
  const fam = hashuf(h ^ 0x66);
  let family =
    fam < 0.12 ? 4 : fam < 0.28 ? 3 : fam < 0.44 ? 2 : fam < 0.62 ? 1 : 0;
  if (strip) {
    winW = 1;
    family = 1;
  }
  if (family === 2) {
    winW = 0.62;
    winH = 0.72;
  }
  if (family === 3) winW = Math.min(winW, 0.5);
  return {winW, winH, strip, family};
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

/**
 * LOD0 surround of a punched opening that the facade shader paints on an
 * unbroken wall (the stair glass-block windows): a precast frame around the
 * jambs and head of [s0, s1] x [y0, y1], its outer edge on the wall plane
 * (`out`) and its inner edge FRAME_D proud (one shared 8-vertex ring, so
 * no side faces are needed), and a sloped precast sill under it.
 * The shader's opening() draws the recess inside the opening, from the wall
 * plane back to the glass REVEAL_GLASSBLOCK deep; the frame's inner edge
 * sits exactly on the opening outline, so the two compose into one reveal
 * (FRAME_D proud + REVEAL_GLASSBLOCK recessed) and the shader's jamb and
 * head sun shadows start where the frame's own shadows end. This supplies
 * the silhouette, the shadow-map and AO response at grazing angles. 12
 * vertices (the 2-quad sill and hood it replaces had 8).
 */
/** Mirrors REVEAL_GLASSBLOCK in city-materials.wgsl (glass depth, m). */
export const REVEAL_GLASSBLOCK = 0.15;
const FRAME_D = 0.05;
const FRAME_W = 0.07;
function openingFrame(
  m: CMesh,
  e: FacadeEdge,
  out: number,
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  mat: number,
) {
  const D = FRAME_D;
  const W = FRAME_W;
  const P = (s: number, o: number, y: number) => edgeAt(e, s, out + o, y);
  const yt = y1 + W;
  const V = (s: number, o: number, y: number) =>
    m.vertex(P(s, o, y), e.n, s - s0, y - y0, mat);
  const o0 = V(s0 - W, 0, y0);
  const o1 = V(s1 + W, 0, y0);
  const o2 = V(s1 + W, 0, yt);
  const o3 = V(s0 - W, 0, yt);
  const i0 = V(s0, D, y0);
  const i1 = V(s1, D, y0);
  const i2 = V(s1, D, y1);
  const i3 = V(s0, D, y1);
  for (const [a, b, c, d] of [
    [o0, i0, i3, o3],
    [o3, i3, i2, o2],
    [i1, o1, o2, i2],
  ]) {
    m.triFacing(a, b, c, e.n);
    m.triFacing(a, c, d, e.n);
  }
  // Sill: one steep weathered quad 12 cm out, past the jambs (lit from
  // above, a shadow line under it).
  const sa = s0 - W - 0.05;
  const sb = s1 + W + 0.05;
  m.quad(
    [
      P(sa, 0.12, y0 - 0.08),
      P(sb, 0.12, y0 - 0.08),
      P(sb, 0, y0),
      P(sa, 0, y0),
    ],
    [e.n[0] * 0.55, 0.83, e.n[2] * 0.55],
    [
      [0, 0],
      [sb - sa, 0],
      [sb - sa, 0.15],
      [0, 0.15],
    ],
    mat,
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
      0,
      undefined,
      CHAMFER,
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
    const C = CHAMFER;
    m.quad(
      [D(-ex, -0.08), D(1 + ex, -0.08), D(1 + ex, 0.06 - C), D(-ex, 0.06 - C)],
      n,
      [
        [0, 0],
        [len, 0],
        [len, 1],
        [0, 1],
      ],
      packMat(CM.metal),
    );
    // Cap: its top and inner face (the outer face is the drip edge).
    const T = (t: number, out: number, h: number): Vec3 => [
      lerp(a[0], c[0], t) + n[0] * out,
      y + h,
      lerp(a[1], c[1], t) + n[2] * out,
    ];
    const uvc: Vec2[] = [
      [0, 0],
      [len, 0],
      [len, 0.34],
      [0, 0.34],
    ];
    m.quad(
      [
        T(-ex, -0.27, 0.06),
        T(1 + ex, -0.27, 0.06),
        T(1 + ex, 0.07 - C, 0.06),
        T(-ex, 0.07 - C, 0.06),
      ],
      UP,
      uvc,
      packMat(CM.metal),
    );
    // 45-degree bevel between the cap and the drip face.
    m.quad(
      [
        T(-ex, 0.07, 0.06 - C),
        T(1 + ex, 0.07, 0.06 - C),
        T(1 + ex, 0.07 - C, 0.06),
        T(-ex, 0.07 - C, 0.06),
      ],
      [n[0] * Math.SQRT1_2, Math.SQRT1_2, n[2] * Math.SQRT1_2],
      [
        [0, 0],
        [len, 0],
        [len, C * Math.SQRT2],
        [0, C * Math.SQRT2],
      ],
      packMat(CM.metal),
    );
    m.quad(
      [
        T(1 + ex, -0.27, 0),
        T(-ex, -0.27, 0),
        T(-ex, -0.27, 0.06),
        T(1 + ex, -0.27, 0.06),
      ],
      [-n[0], 0, -n[2]],
      uvc,
      packMat(CM.metal),
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
      // Supply duct off the handler's end: a closed run on two stands that
      // turns down into a curbed roof penetration (it used to stop open-ended
      // in mid air).
      const len = Math.min(10, box.hu - s[0] - 4);
      const f = at(s[0] + 3 + len, s[1]);
      if (
        len > 2 &&
        pointInPolygon(f, roof) &&
        !(hole && pointInPolygon(f, hole))
      ) {
        const dm = packMat(CM.metal);
        const mid = at(s[0] + 3 + len / 2 - 0.2, s[1]);
        m.box([mid[0], y + 1.4, mid[1]], [0.45, 0.35, len / 2 - 0.2], dm, yaw);
        // Elbow down into the curb.
        const end = at(s[0] + 3 + len - 0.45, s[1]);
        m.box([end[0], y + 0.95, end[1]], [0.5, 0.8, 0.5], dm, yaw);
        m.box(
          [end[0], y + 0.15, end[1]],
          [0.75, 0.15, 0.75],
          packMat(CM.concrete),
          yaw,
        );
        for (const t of [0.3, 0.7]) {
          const p = at(s[0] + 3 + len * t, s[1]);
          for (const sd of [-1, 1]) {
            const q = at(s[0] + 3 + len * t, s[1] + sd * 0.4);
            m.beam([q[0], y, q[1]], [q[0], y + 1.05, q[1]], 0.03, 0.03, dm);
          }
          m.box([p[0], y + 1.03, p[1]], [0.5, 0.025, 0.04], dm, yaw);
        }
      }
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
 * `n`: a cabinet in vending colour `col` (red, blue or white) whose front
 * door stands proud on a bevelled edge, a recessed lit display of four
 * shelves of sample drinks on metal ledges, a lit button row, the coin and
 * note panel, the dispenser slot and a lit header strip. Vending uv.y in
 * [0.7, 1.5] lights up (M_VENDING), so unlit parts keep uv.y above it.

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
    u1 = 1,
  ) =>
    m.quad(
      [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)],
      n,
      [
        [0, v0],
        [u1, v0],
        [u1, v1],
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
  // Cabinet (back, sides, top) behind the door plane C.
  const C = D - 0.05;
  m.quad(
    [P(0.5, 0, -D), P(-0.5, 0, -D), P(-0.5, Hc, -D), P(0.5, Hc, -D)],
    neg(n),
    uv,
    body,
  );
  m.quad(
    [P(0.5, 0, C), P(0.5, 0, -D), P(0.5, Hc, -D), P(0.5, Hc, C)],
    r,
    uv,
    body,
  );
  m.quad(
    [P(-0.5, 0, -D), P(-0.5, 0, C), P(-0.5, Hc, C), P(-0.5, Hc, -D)],
    neg(r),
    uv,
    body,
  );
  // Top: a cap overhanging the cabinet a little (a shadow line under it).
  m.box(
    P(0, Hc + 0.03, 0.01),
    [0.52, 0.03, D + 0.02],
    body,
    Math.atan2(n[0], n[2]),
  );
  // The door: its face at D, bevelled back to the cabinet edge on all four
  // sides, so a bright rim catches the light round the machine.
  const X0 = 0.47,
    Y0 = 0.05,
    Y1 = Hc - 0.04;
  const bev = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, nn: Vec3) =>
    m.quad([a, b, c, d], nn, uv, body);
  const k = Math.SQRT1_2;
  bev(P(-X0, Y1, D), P(X0, Y1, D), P(0.5, Hc, C), P(-0.5, Hc, C), [
    n[0] * k,
    k,
    n[2] * k,
  ]);
  bev(P(-0.5, 0, C), P(0.5, 0, C), P(X0, Y0, D), P(-X0, Y0, D), [
    n[0] * k,
    -k,
    n[2] * k,
  ]);
  bev(P(X0, Y0, D), P(0.5, 0, C), P(0.5, Hc, C), P(X0, Y1, D), [
    (n[0] + r[0]) * k,
    0,
    (n[2] + r[2]) * k,
  ]);
  bev(P(-0.5, 0, C), P(-X0, Y0, D), P(-X0, Y1, D), P(-0.5, Hc, C), [
    (n[0] - r[0]) * k,
    0,
    (n[2] - r[2]) * k,
  ]);
  // Door face around the display opening [-0.42, 0.18] x [0.66, 1.56].
  const DX0 = -0.42,
    DX1 = 0.18,
    DY0 = 0.66,
    DY1 = 1.56;
  flat(-X0, Y0, X0, DY0, D, body);
  flat(-X0, DY1, X0, Y1, D, body);
  flat(-X0, DY0, DX0, DY1, D, body);
  flat(DX1, DY0, X0, DY1, D, body);
  // Recessed display: four shelves of lit samples (M_VENDING draws the
  // drinks and button strips in uv.y [0.7, 1.5], 0.2 per shelf) on metal
  // ledges at the shelf edges, and its reveal.
  const dz = D - 0.1;
  flat(DX0, DY0, DX1, DY1, dz, body, 0.7, 1.5);
  const reveal = packMat(CM.metal);
  for (let k = 1; k < 4; k++) {
    const y = DY0 + (k * (DY1 - DY0)) / 4;
    const lip = (z0: number, z1: number, y0: number, y1: number, nn: Vec3) =>
      m.quad(
        [P(DX0, y0, z0), P(DX1, y0, z0), P(DX1, y1, z1), P(DX0, y1, z1)],
        nn,
        uv,
        reveal,
      );
    lip(dz + 0.06, dz, y, y, UP);
    lip(dz + 0.06, dz + 0.06, y - 0.012, y, n);
  }
  m.quad(
    [P(DX0, DY1, dz), P(DX1, DY1, dz), P(DX1, DY1, D), P(DX0, DY1, D)],
    [0, -1, 0],
    uv,
    reveal,
  );
  m.quad(
    [P(DX0, DY0, dz), P(DX0, DY0, D), P(DX0, DY1, D), P(DX0, DY1, dz)],
    r,
    uv,
    reveal,
  );
  m.quad(
    [P(DX1, DY0, D), P(DX1, DY0, dz), P(DX1, DY1, dz), P(DX1, DY1, D)],
    neg(r),
    uv,
    reveal,
  );
  // Button row under the display, header strip, coin panel, dispenser slot.
  flat(DX0 + 0.02, 0.58, DX1 - 0.02, 0.63, D + 0.01, packMat(CM.lamp, 1));
  flat(-0.44, 1.64, 0.44, 1.75, D + 0.005, body, 0.72, 0.74);
  flat(0.24, 0.92, 0.43, 1.4, D + 0.012, reveal);
  flat(0.29, 1.18, 0.39, 1.3, D + 0.018, packMat(CM.frame));
  flat(0.29, 1.0, 0.39, 1.06, D + 0.018, packMat(CM.frame));
  flat(-0.38, 0.12, 0.16, 0.36, D + 0.008, packMat(CM.frame));
  m.box(
    P(-0.11, 0.38, D + 0.03),
    [0.29, 0.02, 0.03],
    reveal,
    Math.atan2(n[0], n[2]),
  );
}

/** A-frame stand sign (printed, unlit) on the pavement at `p` facing `n`. */
function aFrameSign(m: CMesh, p: Vec3, n: Vec3, id: number) {
  const r: Vec3 = [n[2], 0, -n[0]];
  const mat = packMat(CM.sign, shopSignParam(id | SIGN_FABRIC));
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

/** Local prop frame at `p` facing `n`: x to the right, y up, z out. */
function propFrame(p: Vec3, n: Vec3) {
  const r: Vec3 = [n[2], 0, -n[0]];
  return (x: number, y: number, z: number): Vec3 => [
    p[0] + r[0] * x + n[0] * z,
    p[1] + y,
    p[2] + r[2] * x + n[2] * z,
  ];
}

/** Open tapered round shell from radius r0 at c.y to r1 at c.y + h. */
function frustum(
  m: CMesh,
  c: Vec3,
  r0: number,
  r1: number,
  h: number,
  sides: number,
  mat: number,
) {
  const slope = (r0 - r1) / h;
  const l = Math.hypot(1, slope);
  const ids: number[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const cx = Math.cos(a),
      cz = Math.sin(a);
    const nn: Vec3 = [cx / l, slope / l, cz / l];
    const u = (i / sides) * Math.PI * 2 * r1;
    ids.push(
      m.vertex([c[0] + cx * r0, c[1], c[2] + cz * r0], nn, u, 0, mat),
      m.vertex([c[0] + cx * r1, c[1] + h, c[2] + cz * r1], nn, u, h, mat),
    );
  }
  for (let i = 0; i < sides; i++) {
    const a = (i + 0.5) / sides;
    const nn: Vec3 = [Math.cos(a * Math.PI * 2), 0, Math.sin(a * Math.PI * 2)];
    m.triFacing(ids[i * 2], ids[i * 2 + 1], ids[i * 2 + 3], nn);
    m.triFacing(ids[i * 2], ids[i * 2 + 3], ids[i * 2 + 2], nn);
  }
}

/**
 * A potted plant on the pavement: a tapered glazed pot with a rolled lip
 * and dark soil, and either a bushy shrub (a foliage core in crossed leaf
 * cards) or a small standard tree (a stem with a leaf-card crown).
 */
function pottedPlant(m: CMesh, p: Vec3, rng: Rng) {
  const r = rng.range(0.2, 0.3);
  const h = rng.range(0.4, 0.62);
  const pot = packMat(CM.paint, [0xd5, 0x9c, 0x91, 0xa4, 0x90][rng.int(0, 5)]);
  frustum(m, p, r * 0.72, r, h, 8, pot);
  // Rolled lip, and the soil just under it.
  m.cylinder([p[0], p[1] + h - 0.06, p[2]], r * 1.1, 0.07, 8, pot, false);
  const soil = packMat(CM.bark);
  const ring = [0, 1, 2, 3, 4, 5].map(j =>
    m.vertex(
      [
        p[0] + Math.cos((j * Math.PI) / 3) * r * 1.02,
        p[1] + h - 0.05,
        p[2] + Math.sin((j * Math.PI) / 3) * r * 1.02,
      ],
      UP,
      0,
      0,
      soil,
    ),
  );
  for (let j = 1; j < 5; j++) m.triFacing(ring[0], ring[j], ring[j + 1], UP);
  const aux = rng.nextU32();
  const sp = rng.int(0, 3);
  if (rng.chance(0.65)) {
    const R = r * rng.range(1.2, 1.6);
    const c: Vec3 = [p[0], p[1] + h + R * 0.7, p[2]];
    blob(m, c, R * 0.62, 0, aux, rng, sp);
    leafCards(m, c, R, 7, aux, rng, 0.7, sp);
  } else {
    const th = rng.range(0.7, 1.1);
    m.tube(
      [
        [p[0], p[1] + h - 0.05, p[2]],
        [p[0] + rng.range(-0.05, 0.05), p[1] + h + th, p[2]],
      ],
      0.025,
      packMat(CM.bark),
    );
    const R = r * rng.range(1.3, 1.7);
    const c: Vec3 = [p[0], p[1] + h + th + R * 0.4, p[2]];
    blob(m, c, R * 0.55, 0, aux, rng, sp);
    leafCards(m, c, R, 7, aux, rng, 0.7, sp);
  }
}

/**
 * A bin cabinet in a prop frame `P` (propFrame): x in [x - hx, x + hx],
 * y in [0, h], z in [-hz, hz], its two front vertical corners chamfered (a
 * highlight line down each), no top (a lid covers it) and no back (it
 * stands against a wall): 5 quads, as many vertices as the plain box.
 */
function binCabinet(
  m: CMesh,
  P: (x: number, y: number, z: number) => Vec3,
  x: number,
  hx: number,
  h: number,
  hz: number,
  mat: number,
) {
  const ch = 0.035;
  const o = P(0, 0, 0);
  const dir = (q: Vec3): Vec3 => [q[0] - o[0], 0, q[2] - o[2]];
  const r = dir(P(1, 0, 0)),
    f = dir(P(0, 0, 1));
  const k = Math.SQRT1_2;
  const face = (a: Vec2, b: Vec2, nn: Vec3) => {
    const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
    m.quad(
      [P(a[0], 0, a[1]), P(b[0], 0, b[1]), P(b[0], h, b[1]), P(a[0], h, a[1])],
      nn,
      [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
      mat,
    );
  };
  const x0 = x - hx,
    x1 = x + hx;
  face([x0 + ch, hz], [x1 - ch, hz], f);
  face([x1 - ch, hz], [x1, hz - ch], [(r[0] + f[0]) * k, 0, (r[2] + f[2]) * k]);
  face([x0, hz - ch], [x0 + ch, hz], [(f[0] - r[0]) * k, 0, (f[2] - r[2]) * k]);
  face([x1, hz - ch], [x1, -hz], r);
  face([x0, -hz], [x0, hz - ch], [-r[0], 0, -r[2]]);
}

/**
 * Konbini recycling station: `count` bins side by side centred on `p`
 * against the wall (facing `n`), each a pale cabinet with a sloped
 * coloured lid holding a dark round-ish mouth, and a matching label band
 * (cans, bottles, PET, burnable).
 */
const BIN_COLS = [0x5a, 0x79, 0xa4, 0x30];
function recyclingBins(m: CMesh, p: Vec3, n: Vec3, count: number) {
  const P = propFrame(p, n);
  const body = packMat(CM.paint, 0xd0);
  const dark = packMat(CM.paint, 0x91);
  const W = 0.4;
  const uv: Vec2[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (let k = 0; k < count; k++) {
    const x = (k - (count - 1) / 2) * (W + 0.04);
    const lid = packMat(CM.paint, BIN_COLS[k % BIN_COLS.length]);
    // Cabinet with chamfered corners (its top is under the lid).
    binCabinet(m, P, x, W / 2, 0.8, 0.21, body);
    // Sloped lid: low at the front, up to the back.
    const L = (sx: number, y: number, z: number) =>
      P(x + sx * (W / 2 + 0.01), y, z);
    const nl = Math.hypot(0.44, 0.16);
    const ln: Vec3 = [(n[0] * 0.16) / nl, 0.44 / nl, (n[2] * 0.16) / nl];
    m.quad(
      [
        L(-1, 0.8, 0.22),
        L(1, 0.8, 0.22),
        L(1, 0.96, -0.22),
        L(-1, 0.96, -0.22),
      ],
      ln,
      uv,
      lid,
    );
    m.quad(
      [L(-1, 0.8, 0.22), L(1, 0.8, 0.22), L(1, 0.76, 0.22), L(-1, 0.76, 0.22)],
      n,
      uv,
      lid,
    );
    for (const s of [-1, 1]) {
      const a = m.vertex(L(s, 0.8, 0.22), [n[2] * s, 0, -n[0] * s], 0, 0, body);
      const b = m.vertex(
        L(s, 0.8, -0.22),
        [n[2] * s, 0, -n[0] * s],
        0,
        0,
        body,
      );
      const c = m.vertex(
        L(s, 0.96, -0.22),
        [n[2] * s, 0, -n[0] * s],
        0,
        0,
        body,
      );
      m.triFacing(a, b, c, [n[2] * s, 0, -n[0] * s]);
    }
    // The mouth, an octagon-ish dark hole on the lid (cans / bottles) or a
    // slot (paper).
    const hc = (dx: number, dz: number) => {
      const z = 0.02 + dz;
      return P(x + dx, 0.88 - (z / 0.22) * 0.08 + 0.006, z);
    };
    if (k % 4 === 3)
      m.quad(
        [hc(-0.13, -0.03), hc(0.13, -0.03), hc(0.13, 0.03), hc(-0.13, 0.03)],
        ln,
        uv,
        dark,
      );
    else {
      const ids = [0, 1, 2, 3, 4, 5].map(j => {
        const a = (j / 6) * Math.PI * 2;
        return m.vertex(
          hc(Math.cos(a) * 0.08, Math.sin(a) * 0.08),
          ln,
          0,
          0,
          dark,
        );
      });
      for (let j = 1; j < 5; j++) m.triFacing(ids[0], ids[j], ids[j + 1], ln);
    }
    // Label band.
    m.quad(
      [
        P(x - W / 2 + 0.03, 0.56, 0.215),
        P(x + W / 2 - 0.03, 0.56, 0.215),
        P(x + W / 2 - 0.03, 0.68, 0.215),
        P(x - W / 2 + 0.03, 0.68, 0.215),
      ],
      n,
      uv,
      lid,
    );
  }
}

/**
 * Mamachari (a city bicycle) standing at `p`, pointing along `dir`: two
 * wheels, a step-through frame in colour `col`, a chain guard, a rear
 * carrier, a saddle, swept-back bars and (with `basket`) the front basket.
 */
function bicycle(m: CMesh, p: Vec3, dir: Vec3, col: number, basket: boolean) {
  const sd: Vec3 = [dir[2], 0, -dir[0]];
  const B = (x: number, y: number, s = 0): Vec3 => [
    p[0] + dir[0] * x + sd[0] * s,
    p[1] + y,
    p[2] + dir[2] * x + sd[2] * s,
  ];
  const tyre = packMat(CM.wire);
  const frame = packMat(CM.paint, col);
  const metal = packMat(CM.metal);
  const R = 0.31;
  for (const wx of [-0.52, 0.52]) {
    const ring: Vec3[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ring.push(B(wx + Math.cos(a) * R, 0.33 + Math.sin(a) * R));
    }
    m.tube(ring, 0.022, tyre);
  }
  // Step-through frame: head tube, a low curved down tube to the bottom
  // bracket, seat tube; chain and seat stays to the rear axle.
  m.tube(
    [B(0.36, 0.95), B(0.33, 0.7), B(0.12, 0.38), B(-0.06, 0.3), B(-0.22, 0.86)],
    0.022,
    frame,
  );
  m.tube([B(-0.52, 0.33), B(-0.06, 0.3)], 0.015, frame);
  m.tube([B(-0.52, 0.33), B(-0.19, 0.74)], 0.015, frame);
  // Fork and stem.
  m.tube([B(0.52, 0.33), B(0.35, 0.72), B(0.34, 1.02)], 0.016, metal);
  // Swept-back handlebar.
  m.tube(
    [B(0.2, 1.02, -0.27), B(0.34, 1.03, 0), B(0.2, 1.02, 0.27)],
    0.014,
    metal,
  );
  // Saddle and carrier.
  const yaw = Math.atan2(dir[0], dir[2]);
  m.box(B(-0.24, 0.9), [0.08, 0.035, 0.13], packMat(CM.paint, 0x91), yaw);
  m.quad(
    [
      B(-0.7, 0.72, -0.1),
      B(-0.34, 0.72, -0.1),
      B(-0.34, 0.72, 0.1),
      B(-0.7, 0.72, 0.1),
    ],
    UP,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    metal,
  );
  m.tube([B(-0.52, 0.33), B(-0.52, 0.71)], 0.01, metal);
  // Chain guard.
  m.quad(
    [
      B(-0.5, 0.26, 0.05),
      B(0.02, 0.22, 0.05),
      B(0.02, 0.38, 0.05),
      B(-0.5, 0.4, 0.05),
    ],
    sd,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    frame,
  );
  if (basket) m.box(B(0.6, 0.86), [0.18, 0.12, 0.15], tyre, yaw);
}

/**
 * Nobori: a tall printed cloth banner on a white pole stuck in a weighted
 * base, at `p` with the cloth facing `n` (both faces printed with vertical
 * sign `id`).
 */
function nobori(m: CMesh, p: Vec3, n: Vec3, id: number) {
  const P = propFrame(p, n);
  const pole = packMat(CM.paint, 0xd5);
  m.cylinder(p, 0.17, 0.12, 4, packMat(CM.paint, 0x91));
  m.tube([P(0, 0.1, 0), P(0, 2.45, 0)], 0.018, pole);
  m.tube([P(0, 2.4, 0), P(0.48, 2.4, 0)], 0.012, pole);
  const mat = packMat(CM.sign, shopSignParam(id | SIGN_FABRIC));
  const q = [
    P(0.03, 0.55, 0),
    P(0.48, 0.55, 0),
    P(0.48, 2.38, 0),
    P(0.03, 2.38, 0),
  ];
  m.quad(
    q,
    n,
    [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
    mat,
  );
  m.quad(
    q,
    [-n[0], 0, -n[2]],
    [
      [1, 1],
      [0, 1],
      [0, 0],
      [1, 0],
    ],
    mat,
  );
}

/**
 * Umbrella stand by a door: an open steel drum with `count` closed
 * umbrellas (mostly clear vinyl, a few coloured) leaning out of it.
 */
function umbrellaStand(m: CMesh, p: Vec3, rng: Rng, count: number) {
  m.cylinder(p, 0.15, 0.48, 7, packMat(CM.metal), false);
  for (let k = 0; k < count; k++) {
    const a = rng.range(0, Math.PI * 2);
    const lean = rng.range(0.06, 0.16);
    const at = (t: number): Vec3 => [
      p[0] + Math.cos(a) * (0.05 + lean * t),
      p[1] + 0.12 + 0.85 * t,
      p[2] + Math.sin(a) * (0.05 + lean * t),
    ];
    const col = rng.chance(0.6)
      ? 0xd0
      : [0x5a, 0xa4, 0x91, 0x79][rng.int(0, 4)];
    m.tube([at(0), at(0.95)], 0.01, packMat(CM.metal));
    m.tube([at(0.3), at(0.75)], 0.035, packMat(CM.paint, col));
  }
}

/**
 * Boutique clothes rail on the pavement: two posts and a rail along `along`
 * at `p`, hung with `count` garments in assorted colours (double-sided
 * cloth cards turned across the rail).
 */
function clothesRail(m: CMesh, p: Vec3, along: Vec3, rng: Rng, count: number) {
  const metal = packMat(CM.metal);
  const L = 1.1;
  const A = (s: number, y: number, o = 0): Vec3 => [
    p[0] + along[0] * s - along[2] * o,
    p[1] + y,
    p[2] + along[2] * s + along[0] * o,
  ];
  m.tube(
    [A(-L / 2, 0.02), A(-L / 2, 1.45), A(L / 2, 1.45), A(L / 2, 0.02)],
    0.014,
    metal,
  );
  for (const s of [-L / 2, L / 2])
    m.tube([A(s, 0.02, -0.25), A(s, 0.02, 0.25)], 0.014, metal);
  const uv: Vec2[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const cols = [0x2e, 0x91, 0xd5, 0x5a, 0x9c, 0xa4, 0x35, 0x90, 0x38];
  for (let k = 0; k < count; k++) {
    const s =
      -L / 2 +
      0.1 +
      ((L - 0.2) * (k + rng.range(-0.2, 0.2))) / Math.max(1, count - 1);
    const len = rng.range(0.55, 0.95);
    const hw = rng.range(0.2, 0.26);
    const mat = packMat(CM.paint, cols[rng.int(0, cols.length)]);
    const q = [
      A(s, 1.38 - len, -hw),
      A(s, 1.38 - len, hw),
      A(s, 1.4, hw * 0.8),
      A(s, 1.4, -hw * 0.8),
    ];
    m.quad(q, along, uv, mat);
    m.quad(q, [-along[0], 0, -along[2]], uv, mat);
  }
}

/** Unit square uv. */
const uv01: Vec2[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** Washing: white and pale sheets and towels, a few colours. */
const LAUNDRY = [0xd5, 0xd5, 0xd0, 0x9c, 0x5a, 0xa4, 0xcf, 0x91];

/** Yaw for CMesh.box so that its forward axis is the edge's outward normal. */
const yawOf = (e: FacadeEdge) => Math.atan2(e.n[0], e.n[2]);

/**
 * Split-AC outdoor unit (0.8 x 0.55 x 0.29 m, light grey, a dark fan grille
 * on its left) standing `out` metres in front of facade edge `e` at `s`,
 * its foot at `y`. `bracket`: hung on a steel shelf bracket off the wall
 * (else it stands on a slab); `line` runs its insulated refrigerant line
 * from its right side back into the wall.
 */
function acUnit(
  m: CMesh,
  e: FacadeEdge,
  s: number,
  out: number,
  y: number,
  bracket: boolean,
  line: boolean,
) {
  const yaw = yawOf(e);
  m.box(
    edgeAt(e, s, out, y + 0.275),
    [0.4, 0.275, 0.145],
    packMat(CM.paint, 0xe0),
    yaw,
    0,
    true,
    true,
  );
  const g = (ds: number, dy: number) => edgeAt(e, s + ds, out + 0.147, y + dy);
  m.quad(
    [g(-0.33, 0.09), g(0.05, 0.09), g(0.05, 0.47), g(-0.33, 0.47)],
    e.n,
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    packMat(CM.frame),
  );
  const steel = packMat(CM.paint, 0x90);
  if (bracket) {
    // Shelf bracket: the steel shelf under the unit and two raking struts
    // from the wall below to its front edge.
    const b = (ds: number, o: number, dy: number) =>
      edgeAt(e, s + ds, o, y + dy);
    m.quad(
      [
        b(-0.42, 0, -0.01),
        b(0.42, 0, -0.01),
        b(0.42, out + 0.15, -0.01),
        b(-0.42, out + 0.15, -0.01),
      ],
      [0, -1, 0],
      uv01,
      steel,
    );
    for (const ds of [-0.3, 0.3])
      m.quad(
        [
          b(ds - 0.02, 0, -0.4),
          b(ds + 0.02, 0, -0.4),
          b(ds + 0.02, out + 0.14, -0.02),
          b(ds - 0.02, out + 0.14, -0.02),
        ],
        [e.n[0] * 0.7, -0.7, e.n[2] * 0.7],
        uv01,
        steel,
      );
  }
  if (line)
    m.tube(
      [
        edgeAt(e, s + 0.46, out - 0.05, y + 0.15),
        edgeAt(e, s + 0.46, 0.03, y + 0.3),
      ],
      0.03,
      packMat(CM.paint, 0xd2),
    );
}

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
 * Pavement slots in front of a shopfront: the wall lane (things standing
 * against the glass) and the kerb lane (things further out), each a list
 * of taken [s0, s1] ranges along the front edge.
 */
interface Pavement {
  len: number;
  wall: number[][];
  kerb: number[][];
  /** Street light / signal poles to keep clear of (kerb lane). */
  poles: Vec2[];
  e: FacadeEdge;
}

/** Reserves [s - hw, s + hw] in a lane if it is free (and clear of poles). */
function take(
  pv: Pavement,
  lane: 'wall' | 'kerb' | 'both',
  s: number,
  hw: number,
  out = 1.2,
) {
  if (s - hw < 0.25 || s + hw > pv.len - 0.25) return false;
  const lanes = lane === 'both' ? [pv.wall, pv.kerb] : [pv[lane]];
  if (lanes.some(l => l.some(([a, c]) => s + hw > a && s - hw < c)))
    return false;
  if (lane !== 'wall') {
    const q = edgeAt(pv.e, s, out, 0);
    if (pv.poles.some(p => Math.hypot(p[0] - q[0], p[1] - q[2]) < hw + 0.6))
      return false;
  }
  for (const l of lanes) l.push([s - hw, s + hw]);
  return true;
}

/** Bright, slightly faded frame paints for bicycles. */
const BIKE_COLS = [0xd5, 0x91, 0x5a, 0xa4, 0x79, 0x30, 0x9c, 0xc4];

/**
 * Street kit in front of one ground-floor tenant (`t`: its type, extent
 * [s0, s1] along the front edge and fascia sign id). `gy` is the pavement
 * and `head` the shopfront head; `pv` hands out pavement slots.
 * Restaurants hang a noren printed with their name over the door, put out
 * a lit plastic-food display case, stacked beer crates and a nobori
 * banner; a konbini has its recycling station, an umbrella stand and
 * banners; a boutique a clothes rail and plants; offices plants. Staff
 * and customers' bicycles stand in front of most of them.
 */
function tenantKit(
  m: CMesh,
  e: FacadeEdge,
  t: {type: number; s0: number; s1: number; id: number},
  gy: number,
  head: number,
  rng: Rng,
  pv: Pavement,
) {
  const w = t.s1 - t.s0;
  const yaw = yawOf(e);
  const P = (s: number, out: number, y: number) => edgeAt(e, s, out, y);
  const dark = packMat(CM.paint, 0x91);
  const mid = (t.s0 + t.s1) / 2;
  // A spot inside the tenant's frontage, `f` of the way along it.
  const at = (f: number) => t.s0 + w * f;
  const banner = () => {
    // Nobori: 1-2 cloth banners out by the kerb, printed with a shop word.
    const k = rng.chance(0.25) ? 2 : 1;
    for (let j = 0; j < k; j++) {
      const s = at(rng.range(0.15, 0.85));
      if (!take(pv, 'kerb', s, 0.3, 1.5)) continue;
      const tn: Vec3 = [
        e.n[0] * Math.cos(0.3) + e.along[0] * Math.sin(0.3) * (j ? -1 : 1),
        0,
        e.n[2] * Math.cos(0.3) + e.along[2] * Math.sin(0.3) * (j ? -1 : 1),
      ];
      const ids = TENANT_NOBORI[t.type];
      if (ids.length) nobori(m, P(s, 1.5, gy), tn, ids[rng.int(0, ids.length)]);
    }
  };
  const bikes = (n: number) => {
    // Parked bicycles side by side, nose to the shop.
    const s0 = at(rng.range(0.1, 0.6));
    for (let j = 0; j < n; j++) {
      const s = s0 + j * 0.62;
      if (s > t.s1 || !take(pv, 'both', s, 0.28, 0.9)) break;
      const lean = rng.range(-0.12, 0.12);
      const dir: Vec3 = [
        -e.n[0] * Math.cos(lean) + e.along[0] * Math.sin(lean),
        0,
        -e.n[2] * Math.cos(lean) + e.along[2] * Math.sin(lean),
      ];
      bicycle(
        m,
        P(s, 0.95, gy),
        dir,
        BIKE_COLS[rng.int(0, BIKE_COLS.length)],
        rng.chance(0.8),
      );
    }
  };
  const plants = () => {
    for (const f of [0.08, 0.92])
      if (rng.chance(0.55)) {
        const s = at(f);
        if (take(pv, 'wall', s, 0.35)) pottedPlant(m, P(s, 0.45, gy), rng);
      }
  };
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
    const mat = packMat(CM.sign, shopSignParam(t.id | SIGN_FABRIC));
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
    // The door under the noren stays clear.
    take(pv, 'wall', sc, nw / 2);
    // Plastic-food display case beside the door: a dark cabinet, and lit
    // shelves of samples behind glass (M_VENDING's lit rows).
    const right = sc + nw / 2 + 0.6 <= t.s1 - 0.5;
    const ds = right ? sc + nw / 2 + 0.6 : sc - nw / 2 - 0.6;
    if (
      ds >= t.s0 + 0.5 &&
      ds <= t.s1 - 0.5 &&
      rng.chance(0.75) &&
      take(pv, 'wall', ds, 0.5)
    ) {
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
    const cs = right ? t.s0 + 0.4 : t.s1 - 0.4;
    if (rng.chance(0.65) && take(pv, 'wall', cs, 0.55)) {
      const crate = packMat(CM.paint, 0x92);
      for (const [d, n] of [
        [-0.27, rng.int(2, 5)],
        [0.27, rng.int(1, 4)],
      ])
        m.box(
          P(cs + d, 0.3, gy + 0.155 * n),
          [0.24, 0.155 * n, 0.18],
          crate,
          yaw + (d > 0 ? rng.range(-0.15, 0.15) : 0),
        );
    }
    banner();
    if (rng.chance(0.3)) bikes(1);
  } else if (t.type === SHOP_TYPE.konbini) {
    // Recycling station at one end, an umbrella stand by the door, banners
    // and customers' bicycles out front.
    const n = w > 3 ? 4 : 3;
    const half = n * 0.22;
    const bs = rng.chance(0.5) ? t.s1 - half - 0.2 : t.s0 + half + 0.2;
    if (w > 1.6 && take(pv, 'wall', bs, half))
      recyclingBins(m, P(bs, 0.32, gy), e.n, n);
    const us = mid + rng.range(-0.3, 0.3) * w;
    if (take(pv, 'wall', us, 0.25))
      umbrellaStand(m, P(us, 0.35, gy), rng, rng.int(3, 6));
    banner();
    bikes(rng.int(1, 3));
  } else if (t.type === SHOP_TYPE.boutique) {
    const rs = at(rng.range(0.25, 0.75));
    if (w > 2 && take(pv, 'wall', rs, 0.65))
      clothesRail(m, P(rs, 0.55, gy), e.along, rng, rng.int(4, 8));
    plants();
    if (rng.chance(0.5)) bikes(1);
  } else {
    plants();
    if (rng.chance(0.4)) {
      const us = at(rng.range(0.3, 0.7));
      if (take(pv, 'wall', us, 0.25))
        umbrellaStand(m, P(us, 0.35, gy), rng, rng.int(2, 4));
    }
    if (rng.chance(0.4)) bikes(rng.int(1, 3));
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
  cover: number[] = [],
  flush: number[] = [],
) {
  const rng = new Rng(b.seed);
  signVariant = b.seed >>> 28;
  const fp = b.footprint;
  // Whether edge i is hidden up to height y by a neighbour (edgeCover).
  const hid = (i: number, y: number) => (cover[i] ?? -Infinity) >= y;
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
  // Whether wall i of `es` is drawn up to y1 (party and rear walls flush
  // against a taller neighbour are not).
  const drawn = (es: FacadeEdge[], i: number, y1: number) =>
    es[i].len >= 0.05 &&
    !(
      es === edges &&
      es[i].role >= ROLE.party &&
      (flush[i] ?? -Infinity) >= y1 + 0.05
    );
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
      // (Party and rear walls flush against a taller neighbour are never
      // seen.)
      if (
        es === edges &&
        e.role >= ROLE.party &&
        (flush[i] ?? -Infinity) >= y1 + 0.05
      )
        return;
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
        // (LOD0: its outer corners are bevelled, see the core sides below.)
        const cb = lod > 0 ? 0 : CORNER_BEVEL;
        edgeQuad(
          m,
          e,
          e.core + cb,
          e.core + CORE_W - cb,
          y0,
          y1,
          lod > 0 ? 0 : CORE_OUT,
          cb,
          CORE_W - cb,
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
    for (const [i, e] of es.entries()) {
      const cm = fmat(e, FZ.crown, true);
      const y1 = y0 + CROWN_H;
      if (drawn(es, i, y1))
        edgeQuad(m, e, 0, e.len, y0, y1, 0, u, u + e.len, base, cm, aux);
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
      pa.int(0, SIGN.billboard.count); // (kept: the stream stays in step)
      const id = billboardId(b, 0);
      partyAd = {edge: i, s, y, hw};
      // Gooseneck floodlamps along the top edge (3 on short boards, else 4).
      const nf = hw > 3 ? 4 : 3;
      const floods = Array.from(
        {length: nf},
        (_, k) => hw * (((k + 0.5) / nf) * 2 - 1) * 0.92,
      );
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
        packMat(CM.sign, shopSignParam(id | (lit ? 0 : SIGN_FABRIC))),
      );
      if (lod === 0) {
        // Frame (a box-section rim), stand-off brackets and a row of
        // gooseneck floodlamps over the top edge.
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
        for (const ds of floods) {
          m.tube(
            [
              R(ds, hh + rim, 0.13),
              R(ds, hh + 0.5, 0.3),
              R(ds, hh + 0.48, 0.85),
            ],
            0.025,
            fm,
          );
          // Lamp head: a short lit drum hanging from the arm's end.
          m.tube(
            [R(ds, hh + 0.47, 0.9), R(ds, hh + 0.33, 0.97)],
            0.09,
            packMat(CM.lamp, 0),
          );
        }
        if (lit)
          lights.add(edgeAt(e, s, 2.5, y), 9, signColor(id), LightKind.sign);
      }
      // The floodlamps' light (at every LOD: the board stays floodlit on
      // shells): warm white, omnidirectional (point lights have no cone),
      // so it sits out in front of the board just under its top edge: the
      // board is brightest at the top and falls off downward, with a
      // little spill on the wall over it. One light per pair of lamps.
      for (let k = 0; k < floods.length; k += 2) {
        const ds =
          k + 1 < floods.length ? (floods[k] + floods[k + 1]) / 2 : floods[k];
        lights.add(
          edgeAt(e, s + ds, 1.3, y + hh - 0.3),
          Math.max(4, hh * 2 + 0.5),
          FLOOD,
          LightKind.station,
        );
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
      const o1 = CORE_OUT - CORNER_BEVEL;
      m.quad(
        [q(0, b.low), q(o1, b.low), q(o1, mainTop), q(0, mainTop)],
        [e.along[0] * dir, 0, e.along[2] * dir],
        [
          [0, b.low - base],
          [o1, b.low - base],
          [o1, mainTop - base],
          [0, mainTop - base],
        ],
        sideMat,
        aux,
      );
      // The bevel on its outer corner (a highlight line up the strip).
      const r = (y: number) => edgeAt(e, s - dir * CORNER_BEVEL, CORE_OUT, y);
      const bw = CORNER_BEVEL * Math.SQRT2;
      m.quad(
        [q(o1, b.low), r(b.low), r(mainTop), q(o1, mainTop)],
        [
          (e.along[0] * dir + e.n[0]) * Math.SQRT1_2,
          0,
          (e.along[2] * dir + e.n[2]) * Math.SQRT1_2,
        ],
        [
          [o1, b.low - base],
          [o1 + bw, b.low - base],
          [o1 + bw, mainTop - base],
          [o1, mainTop - base],
        ],
        sideMat,
        aux,
      );
    }
    if (lod === 0) {
      // The stair windows up the core (city-materials stairBay: 0.9 x 1.2 m
      // from 0.3 floor heights up, one per floor) get a precast surround
      // and sill, so they sit in the wall instead of reading as stickers.
      const sc = e.core + CORE_W / 2;
      const hw = Math.min(0.45, CORE_W * 0.3);
      for (let f = 1; f <= bodyFloors; f++) {
        const y = vOff + f * H + 0.3 * H;
        if (y + 1.2 + FRAME_W > upperTop) break;
        openingFrame(m, e, CORE_OUT, sc - hw, sc + hw, y, y + 1.2, concrete);
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
  // Balconies across the front of residential midrises (below).
  const frontBalc = b.kind === 'midrise' && !office && fr.chance(0.7);
  const ar = new Rng(hash2(b.seed, 0xba1));
  if (lod === 0) {
    // Ledges on the street faces only: a deep course over the base, then
    // every third floor (offices), every floor or none (homes).
    const every = office ? 3 : ledgeNone ? 0 : 1;
    for (const e of edges) {
      if (e.role > ROLE.street || e.len < 1) continue;
      const hasCore = !isNaN(e.core);
      // (Window sill courses take over above the base course.)
      const sills =
        b.kind !== 'apartment' &&
        e.count > 0 &&
        !(frontBalc && e.role === ROLE.front);
      for (let j = 0; j < bodyFloors - setF; j++) {
        if (j > 0 && (sills || every === 0 || j % every !== 0)) continue;
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
          // (Only the deep base course: one per wall, the floor ledges and
          // balcony slabs are too many for the vertex budget.)
          j === 0 ? CHAMFER : 0,
        );
      }
    }
  }

  // Balconies with solid upstands across the front of residential midrises
  // (deep shadow bands that read from afar): one slab and panel per floor.
  if (frontBalc) {
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
      if (ar.chance(0.5))
        acUnit(
          m,
          e,
          lerp(e.f0 + 0.6, e.f1 - 0.6, ar.next()),
          0.4,
          y,
          false,
          false,
        );
    }
  }

  // Window sills and heads on the street faces (LOD0): under each window
  // row a precast sill course whose sloped top steps out 9 cm to a drip
  // edge, and over it a soffit lip, so every row draws a lit line over a
  // shadow line (one run per floor over the window field; they replace the
  // floor-line ledges above the base course). Heights follow facadeStyle
  // in city-materials.wgsl.
  if (lod === 0 && b.kind !== 'apartment') {
    const win = facadeWindows(b.style, KIND_INDEX[b.kind]);
    const sillMat = packMat(CM.concrete);
    const lipMat = fmat(edges[0], FZ.trim, true);
    edges.forEach((e, i) => {
      if (e.role > ROLE.street || e.count === 0) return;
      if (frontBalc && e.role === ROLE.front) return;
      const sillY = (1 - win.winH) * H * 0.55;
      const headY = sillY + win.winH * H;
      const nUp: Vec3 = [e.n[0] * 0.55, 0.83, e.n[2] * 0.55];
      const down: Vec3 = [0, -1, 0];
      // A run [s0, s1] of sill (and lip) at floor base y.
      const run = (s0: number, s1: number, y: number) => {
        const Q = (s: number, out: number, dy: number) =>
          edgeAt(e, s, out, y + dy);
        const uvq: Vec2[] = [
          [0, 0],
          [s1 - s0, 0],
          [s1 - s0, 1],
          [0, 1],
        ];
        // Sill: a steep weathered top 15 cm out (lit from above and from
        // the street) over its underside (a shadow line from below).
        const D = 0.15;
        m.quad(
          [
            Q(s0, D, sillY - 0.1),
            Q(s1, D, sillY - 0.1),
            Q(s1, 0, sillY),
            Q(s0, 0, sillY),
          ],
          nUp,
          uvq,
          sillMat,
        );
        m.quad(
          [
            Q(s0, 0, sillY - 0.1),
            Q(s1, 0, sillY - 0.1),
            Q(s1, D, sillY - 0.1),
            Q(s0, D, sillY - 0.1),
          ],
          down,
          uvq,
          sillMat,
        );
        // Soffit lip over the head: its underside and drip face, uv in
        // metres on the wall's grid (a 0..1 v squeezed a whole tile course
        // into the 9 cm face).
        if (headY < H - 0.14) {
          const v0 = y + headY + 0.02 - vOff;
          const ua = e.u0 + (s0 - e.f0) * e.k;
          const ub = e.u0 + (s1 - e.f0) * e.k;
          m.quad(
            [
              Q(s0, 0, headY + 0.02),
              Q(s1, 0, headY + 0.02),
              Q(s1, 0.14, headY + 0.02),
              Q(s0, 0.14, headY + 0.02),
            ],
            down,
            [
              [ua, v0],
              [ub, v0],
              [ub, v0 - 0.14],
              [ua, v0 - 0.14],
            ],
            lipMat,
            aux,
          );
          m.quad(
            [
              Q(s0, 0.14, headY + 0.02),
              Q(s1, 0.14, headY + 0.02),
              Q(s1, 0.14, headY + 0.11),
              Q(s0, 0.14, headY + 0.11),
            ],
            e.n,
            [
              [ua, v0],
              [ub, v0],
              [ub, v0 + 0.09],
              [ua, v0 + 0.09],
            ],
            lipMat,
            aux,
          );
        }
      };
      // (Up to the sixth floor: higher rows are only seen from afar.)
      for (let f = 1; f <= Math.min(bodyN, 6); f++) {
        const y = base + GROUND_H + (f - 1) * H;
        if (y >= solidTo[i]) run(e.f0 - 0.05, e.f1 + 0.05, y);
      }
    });
  }

  // Street-face services (LOD0): split-AC units on shelf brackets beside
  // some windows (tenants without a balcony), a PVC drain pipe down the
  // corner pier from a rain hopper under the coping, and the electric meter
  // box with its conduit at grade by the shopfront. Clear of the blade sign
  // slots on the front.
  if (lod === 0 && b.kind !== 'apartment') {
    const sv = new Rng(hash2(b.seed, 0x5e7c));
    const pvc = packMat(CM.paint, 0xd2);
    const wallTop = mainTop + CROWN_H;
    const win = facadeWindows(b.style, KIND_INDEX[b.kind]);
    edges.forEach((e, i) => {
      if (e.role > ROLE.street || e.len < 3) return;
      const front = e.role === ROLE.front;
      const signSlot = (s: number) =>
        i === b.front &&
        [0.1, 0.9, 0.5, 0.3, 0.7].some(t => Math.abs(s - t * e.len) < 0.9);
      const bw = bay / e.k;
      // Between windows (punched) or on the spandrel under the sill
      // course (ribbon windows).
      const sillY = (1 - win.winH) * H * 0.55;
      let units = 0;
      const maxUnits = 2;
      if (!(frontBalc && front))
        for (let f = 1; f <= bodyN && units < maxUnits; f++) {
          const y0 = base + GROUND_H + (f - 1) * H;
          if (y0 < solidTo[i]) continue;
          for (let j = 0; j < e.count && units < maxUnits; j++) {
            if (!sv.chance(office ? 0.1 : 0.14)) continue;
            const s =
              e.f0 + (j + (win.strip ? 0.5 : sv.chance(0.5) ? 0 : 1)) * bw;
            if (s < 0.6 || s > e.len - 0.6 || signSlot(s)) continue;
            const y = win.strip ? y0 + sillY - 0.75 : y0 + sillY + 0.05;
            if (y < y0 + 0.1) continue;
            acUnit(m, e, s, 0.3, y, true, true);
            units++;
          }
        }
      // Drain pipe down one corner pier (away from the core strip).
      const ps = !isNaN(e.core) && e.core < e.len / 2 ? e.len - 0.3 : 0.3;
      if (sv.chance(front ? 0.6 : 0.85) && !signSlot(ps)) {
        const g = Math.max(base, grade[i] - 0.05);
        m.box(
          edgeAt(e, ps, 0.16, wallTop - 0.45),
          [0.14, 0.15, 0.1],
          packMat(CM.paint, 0x90),
          yawOf(e),
          0,
          false,
          true,
        );
        m.tube(
          [
            edgeAt(e, ps, 0.16, wallTop - 0.6),
            edgeAt(e, ps, 0.08, wallTop - 0.85),
            edgeAt(e, ps, 0.08, g + 0.3),
            edgeAt(e, ps, 0.2, g + 0.08),
          ],
          0.055,
          pvc,
        );
      }
      // Electric meter box with a window and its conduit into the wall,
      // on the street side (or the front's far pier).
      if (front || !sv.chance(0.5)) {
        const ms = front
          ? ps < e.len / 2
            ? e.len - 0.32
            : 0.32
          : ps < e.len / 2
            ? 1.0
            : e.len - 1.0;
        const g = Math.max(base, grade[i] - 0.05);
        if (!front || !shop || e.len > 6) {
          m.box(
            edgeAt(e, ms, 0.07, g + 1.55),
            [0.17, 0.24, 0.07],
            packMat(CM.paint, 0xd6),
            yawOf(e),
            0,
            true,
            true,
          );
          flatQuad(
            m,
            edgeAt(e, ms, 0.145, g + 1.6),
            e.along,
            0.08,
            0.08,
            e.n,
            packMat(CM.glass, 4),
          );
          m.tube(
            [
              edgeAt(e, ms, 0.04, g + 1.79),
              edgeAt(e, ms, 0.04, base + GROUND_H - 0.2),
            ],
            0.02,
            packMat(CM.paint, 0x90),
          );
        }
      }
    });
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
    // The canopy light (at every LOD: shells keep the lit entrance).
    lights.add(
      edgeAt(e, s, out + 1.4, base + 3.2),
      8,
      [1.0, 0.85, 0.65],
      LightKind.sign,
    );
    if (lod === 0) {
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
          // Mounting: steel cantilever arms over the top and under the foot
          // of the panel, out to its far edge (they read in silhouette past
          // the sign), a raking strut from the wall up to the top arm, and
          // the sign's power conduit from its foot back to the wall and
          // down to the shopfront head.
          const steel = packMat(CM.metal);
          const inner = out - halfW;
          const ya = p[1] + h2 / 2 + 0.06;
          for (const y of [ya, p[1] - h2 / 2 - 0.06])
            m.beam(
              wallAt(t, 0, y),
              wallAt(t, out + halfW - 0.03, y),
              0.05,
              0.05,
              steel,
            );
          m.tube(
            [
              wallAt(t, 0, ya - Math.min(1.1, out * 1.1)),
              wallAt(t, out, ya - 0.03),
            ],
            0.03,
            steel,
          );
          const yb = p[1] - h2 / 2 + 0.1;
          const yj = Math.min(yb - 0.3, base + GROUND_H + 0.45);
          const down = yb - yj > 0.6;
          m.tube(
            [
              wallAt(t, inner, yb - 0.1),
              wallAt(t, 0.05, yb - 0.25),
              ...(down ? [wallAt(t, 0.05, yj + 0.1)] : []),
            ],
            0.02,
            packMat(CM.paint, 0x90),
          );
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
        lights.add(
          wallAt(t, 1.95, lightY),
          8,
          signGlow(id, signVariant),
          LightKind.sign,
        );
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
        // Each sign lights the wall around it in its own colour: a small,
        // dim light just in front of it (tight falloff, so the brick still
        // reads under the tint). Same at every LOD, so shells match.
        const c = signGlow(id, signVariant);
        lights.add(
          wallAt(t, 1.0, yc),
          3.5,
          [c[0] * 0.45, c[1] * 0.45, c[2] * 0.45],
          LightKind.sign,
        );
        if (lod === 0)
          for (const dy of [hh - 0.1, -hh + 0.1])
            m.beam(
              wallAt(t, 0, yc + dy),
              wallAt(t, 0.32, yc + dy),
              0.045,
              0.045,
              metal,
            );
      }
      if (lod === 0) {
        // The steel spine, and beside it the signs' power conduit down to
        // a junction box over the shopfront.
        m.beam(wallAt(t, 0.28, y0), wallAt(t, 0.28, yTop), 0.05, 0.05, metal);
        const dt = (0.14 / len) * (atEnd ? -1 : 1);
        m.tube(
          [wallAt(t + dt, 0.05, yTop - 0.2), wallAt(t + dt, 0.05, y0 + 0.1)],
          0.022,
          packMat(CM.paint, 0x90),
        );
        m.box(
          wallAt(t + dt, 0.05, y0),
          [0.1, 0.12, 0.05],
          packMat(CM.paint, 0xd4),
          Math.atan2(n[0], n[2]),
        );
      }
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
          if (lod === 0) {
            // Cantilever arms over and under it and a raking strut.
            const steel = packMat(CM.metal);
            const ya = y0 + h2 + 0.06;
            for (const y of [ya, y0 - 0.06])
              m.beam(at(0, y), at(0.22 + 2 * halfW, y), 0.05, 0.05, steel);
            m.tube(
              [
                at(0, ya - Math.min(1.1, 0.25 + halfW)),
                at(0.25 + halfW, ya - 0.03),
              ],
              0.03,
              steel,
            );
          }
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
          true,
        );
      }
      // The lit fascia washes the pavement at night (at every LOD).
      lights.add(
        wallAt((main.s0 + main.s1) / 2 / len, 1.8, y - 0.8),
        7,
        signGlow(main.id, signVariant),
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
        // Pavement slots: the core strip and its entrance, and the vending
        // machines and bicycle row fillProps stands on this frontage, are
        // taken before the tenants' kit goes down.
        const pv: Pavement = {len, wall: [], kerb: [], poles, e: fe};
        if (core?.edge === i) {
          const c0 = edges[i].core;
          pv.wall.push([c0 - 0.9, c0 + CORE_W + 0.9]);
          if (b.density < 0.1 && vending) {
            const vs = core.atEnd
              ? c0 - 2.2 + CORE_W / 2
              : c0 + CORE_W / 2 + 2.2;
            pv.wall.push([vs - 0.6, vs + 0.6]);
          }
        }
        if (b.density >= 0.1) {
          const h = hash2(b.id, 55);
          if (h % 3 === 0)
            for (let k = 0; k < 1 + ((h >> 4) % 3); k++) {
              const s = (0.15 + k * 0.09) * len;
              pv.wall.push([s - 0.6, s + 0.6]);
            }
          if (h % 5 === 1 && len > 6) {
            const count = 2 + ((h >> 6) % 2);
            pv.wall.push([
              0.55 * len - 0.4,
              (0.55 + (0.35 * (count - 1)) / count) * len + 0.4,
            ]);
            pv.kerb.push(pv.wall[pv.wall.length - 1]);
          }
        }
        if (st.chance(0.7)) {
          const t = ftAt(st.range(0.2, 0.8));
          const k = st.int(0, SIGN.square.count);
          const tn =
            tenants.find(x => t * len >= x.s0 && t * len <= x.s1) ?? main;
          const sq = TENANT_SQUARES[tn.type];
          const out = st.range(1.1, 1.6);
          if (take(pv, 'kerb', t * len, 0.4, out))
            aFrameSign(m, wallAt(t, out, gy), n, sq[k % sq.length]);
        }
        for (const t of [0.06, 0.94])
          if (st.chance(0.4) && take(pv, 'wall', ftAt(t) * len, 0.35))
            pottedPlant(m, wallAt(ftAt(t), 0.45, gy), st);
        const kr = new Rng(hash2(b.seed, 0x7e4a));
        for (const t of tenants) tenantKit(m, fe, t, gy, hy - 0.13, kr, pv);
      }
      // A konbini always has the flat canopy, and the brightest light on
      // the block: a cold white pool on the pavement in front (at every
      // LOD, so the pool stays when the building drops to its shell).
      const konbini = tenants.find(t => t.type === SHOP_TYPE.konbini);
      if (konbini)
        lights.add(
          wallAt((konbini.s0 + konbini.s1) / 2 / len, 1.6, base + 2.3),
          10,
          [3.0, 3.5, 3.9],
          LightKind.station,
        );
      if (lod === 0) {
        const ay = base + GROUND_H * 0.62;
        const aStyle = konbini ? (sr.next(), 0.7) : sr.next();
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
          else quad(fasciaQ, n, packMat(CM.metal, 0x2000 | (b.style & 0x1fff)));
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
      } else {
        // Distant shells keep the awning (its canvas) or the canopy (its
        // deck and fascia), so the shopfront is not a flat card: the same
        // choice and extent as LOD0, from a copy of the sign stream (which
        // LOD0 goes on drawing). 4 or 8 vertices.
        const cr2: Rng = Object.assign(Object.create(Rng.prototype), sr);
        const ay = base + GROUND_H * 0.62;
        const aStyle = konbini ? (cr2.next(), 0.7) : cr2.next();
        if (aStyle < 0.55) {
          const t0 = ftAt(cr2.range(0.06, 0.2)),
            t1 = ftAt(1 - cr2.range(0.06, 0.2));
          const reach = cr2.range(1.0, 1.5);
          const drop = reach * cr2.range(0.35, 0.55);
          const span = (t1 - t0) * len * 2;
          const nl = Math.hypot(drop, reach - 0.15);
          m.quad(
            [
              wallAt(t0, 0.15, ay),
              wallAt(t1, 0.15, ay),
              wallAt(t1, reach, ay - drop),
              wallAt(t0, reach, ay - drop),
            ],
            [(n[0] * drop) / nl, (reach - 0.15) / nl, (n[2] * drop) / nl],
            [
              [0, 0],
              [span, 0],
              [span, 1],
              [0, 1],
            ],
            packMat(CM.sign, ((id * 3 + 1) & 0xff) | SIGN_STRIPES),
          );
        } else if (aStyle < 0.85) {
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
          const yT = ay + 0.12,
            yF = ay - 0.26;
          m.quad(
            [
              wallAt(t0, 0, yT),
              wallAt(t1, 0, yT),
              wallAt(t1, R, yT),
              wallAt(t0, R, yT),
            ],
            UP,
            [
              [0, 0],
              [w, 0],
              [w, 1],
              [0, 1],
            ],
            packMat(CM.paint, (b.seed >> 8) & 0xff),
          );
          const fq = [
            wallAt(t0, R, yF),
            wallAt(t1, R, yF),
            wallAt(t1, R, yT),
            wallAt(t0, R, yT),
          ];
          if (konbini)
            m.quad(
              fq,
              n,
              [
                [0, 0],
                [0, w],
                [3, w],
                [3, 0],
              ],
              packMat(CM.sign, (konbini.id & 0xff) | SIGN_STRIPES),
            );
          else
            m.quad(
              fq,
              n,
              [
                [0, 0],
                [w, 0],
                [w, 1],
                [0, 1],
              ],
              packMat(CM.metal, 0x2000 | (b.style & 0x1fff)),
            );
        }
      }
    }
    const billboard =
      b.density > 0.4 && b.height < 60 && rng.chance(0.1 * signDensity);
    if (billboard) {
      rng.int(0, SIGN.billboard.count); // (kept: the stream stays in step)
      const id = billboardId(b, 1);
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
          sr.int(0, SIGN.billboard.count); // (kept: the stream stays in step)
          const bid = billboardId(b, 2);
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
      if (!plinth(i) || hid(i, grade[i] + 0.3)) return;
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
    // The party wall that gets the big fixtures (the AC bank and the
    // lamp): the longest one open to the sky.
    let kitEdge = -1;
    edges.forEach((e, i) => {
      if (
        e.role === ROLE.party &&
        e.len >= 4 &&
        !hid(i, wallTop) &&
        (kitEdge < 0 || e.len > edges[kitEdge].len)
      )
        kitEdge = i;
    });
    const partyKit = (e: FacadeEdge, i: number, ground: number) => {
      const pr = new Rng(hash2(b.seed, 0x9a27 + i));
      const P = (s: number, out: number, y: number) => edgeAt(e, s, out, y);
      const clear = (s: number, pad: number) =>
        !inStair(i, s, pad) &&
        !(partyAd?.edge === i && Math.abs(s - partyAd.s) < partyAd.hw + pad);
      const yTop = wallTop - 0.5;
      let sheet0: [number, number, number, number] | null = null;
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
          sheet0 = [s0 - 0.5, s0 + w + 0.5, y0 - 0.3, y1 + 0.3];
        }
      }
      // Big fixtures that read from across the block (own stream).
      const kr = new Rng(hash2(b.seed, 0x9a3c + i));
      const G = GHOST_STEP;
      const inSheet = (s0: number, s1: number, y0: number, y1: number) =>
        !!sheet0 &&
        s1 > sheet0[0] &&
        s0 < sheet0[1] &&
        y1 > sheet0[2] &&
        y0 < sheet0[3];
      // A soil stack from a vent over the coping down to a gully at grade
      // (ivory PVC), clear of the gas riser, the stair and the ad.
      // (Below the ad only where it is out of the way.)
      const clearBelow = (s: number, pad: number, y1: number) =>
        !inStair(i, s, pad) &&
        !(
          partyAd?.edge === i &&
          Math.abs(s - partyAd.s) < partyAd.hw + pad &&
          y1 > partyAd.y - partyAd.hw / 2 - 0.4
        );
      const stackS =
        [
          e.len *
            (gasS < e.len / 2 ? kr.range(0.62, 0.8) : kr.range(0.2, 0.38)),
          0.45,
          e.len - 0.45,
        ].find(
          s =>
            clear(s, 0.3) &&
            Math.abs(s - gasS) > 0.5 &&
            !inSheet(s - 0.1, s + 0.1, ground, wallTop),
        ) ?? -9;
      const so = G + 0.1;
      if (stackS > 0)
        m.tube(
          [
            P(stackS, so, wallTop + 0.55),
            P(stackS, so, Math.max(ground, cover[i] ?? -Infinity) + 0.3),
            P(stackS, so + 0.12, ground + 0.08),
          ],
          0.055,
          pipeMat,
        );
      // The rest on the building's longest open party wall only.
      if (i !== kitEdge) return;
      // A bank of split-AC condensers on steel shelves on the lower
      // floors, their lines gathered into one duct cover that runs down to
      // grade (the flats behind a party wall have nowhere else to put
      // them).
      if (bodyN >= 2) {
        const cols = 2;
        let rows = bodyN >= 3 && kr.chance(0.4) ? 2 : 1;
        const f0 = 1;
        const span = cols * 0.95 + 0.6;
        let acS = -1;
        // (Fewer rows where an ad hangs low over the wall.)
        for (let t = 0; t < 8 && acS < 0; t++) {
          if (t === 4 && rows > 1) rows--;
          const c = kr.range(0.8, Math.max(0.81, e.len - span - 0.8));
          const yLo = base + GROUND_H + (f0 - 1) * H;
          const yHi = base + GROUND_H + (f0 - 1 + rows) * H;
          if (
            clearBelow(c - 0.3, 0.2, yHi + 0.6) &&
            clearBelow(c + span, 0.2, yHi + 0.6) &&
            clearBelow(c + span / 2, 0.2, yHi + 0.6) &&
            Math.abs(c + span / 2 - stackS) > span / 2 + 0.3 &&
            Math.abs(c + span / 2 - gasS) > span / 2 + 0.3 &&
            !inSheet(c - 0.3, c + span, yLo, yHi) &&
            yHi < wallTop - 0.5
          )
            acS = c;
        }
        if (acS >= 0) {
          let topY = -Infinity;
          const sD = acS + span - 0.1;
          for (let r = 0; r < rows; r++)
            for (let k = 0; k < cols; k++) {
              const y = base + GROUND_H + (f0 - 1 + r) * H + 0.9;
              if (hid(i, y + 0.6) || y < grade[i] + 2.2) continue;
              const s = acS + 0.42 + k * 0.95;
              acUnit(m, e, s, G + 0.32, y, false, false);
              // Its steel shelf, and the refrigerant line from its side
              // over to the duct.
              m.quad(
                [
                  P(s - 0.43, G, y - 0.01),
                  P(s + 0.43, G, y - 0.01),
                  P(s + 0.43, G + 0.48, y - 0.01),
                  P(s - 0.43, G + 0.48, y - 0.01),
                ],
                [0, -1, 0],
                uv01,
                steelGrey,
              );
              m.tube(
                [
                  P(s + 0.42, G + 0.3, y + 0.15),
                  P(sD, G + 0.3, y + 0.15),
                  P(sD, G + 0.08, y + 0.15),
                ],
                0.025,
                pipeMat,
              );
              topY = Math.max(topY, y + 0.15);
            }
          if (topY > -Infinity)
            m.tube(
              [P(sD, G + 0.06, topY + 0.1), P(sD, G + 0.06, ground + 0.12)],
              0.06,
              pipeMat,
            );
        }
      }
      // A security bulkhead lamp on a short arm over the lower wall, its
      // warm pool down the wall and on the paving.
      {
        const ls = e.len * kr.range(0.3, 0.7);
        const ly = Math.max(grade[i], base) + 3.1;
        if (
          clearBelow(ls, 0.3, ly + 0.3) &&
          !hid(i, ly + 0.3) &&
          !inSheet(ls - 0.2, ls + 0.2, ly - 0.2, ly + 0.2)
        ) {
          m.tube(
            [P(ls, 0, ly + 0.05), P(ls, G + 0.2, ly + 0.05)],
            0.025,
            steelGrey,
          );
          m.tube(
            [P(ls - 0.12, G + 0.25, ly), P(ls + 0.12, G + 0.25, ly)],
            0.075,
            packMat(CM.lamp, 0),
          );
          lights.add(P(ls, 0.7, ly - 0.25), 8, WALL_LAMP, LightKind.station);
        }
      }
    };
    // Relief on the demolished neighbour's ghost (partyWall() in
    // city-materials.wgsl paints it; partyGhost mirrors its old roofline):
    // a galvanised flashing strip standing proud along the old roofline,
    // broken stubs of its floor slabs, cut-off pipe and cable stubs, and a
    // bricked-up doorway with its frame where a floor once met ours.
    const ghost = partyGhost(partyAux);
    // How far the wall surface at (s, y) on party wall e stands out: the
    // ghost's raised panel (ghostRelief) is GHOST_STEP proud under the old
    // roofline. Flush fixtures there sit on it.
    const ghostOut = (e: FacadeEdge, s: number, y: number) => {
      if (!ghost || svc < 1 || e.role !== ROLE.party) return 0;
      const uEnd = e.u0 + e.count * bay;
      const u =
        s < e.f0
          ? e.u0 - (e.f0 - s)
          : s > e.f1
            ? uEnd + (s - e.f1)
            : e.u0 + (s - e.f0) * e.k;
      return y < ghost.top(u) + vOff + 0.05 ? GHOST_STEP : 0;
    };
    const ghostRelief = (e: FacadeEdge, i: number) => {
      if (!ghost || svc < 1) return;
      const gr = new Rng(hash2(b.seed, 0x6a05 + i));
      const uEnd = e.u0 + e.count * bay;
      const uOf = (s: number) =>
        s < e.f0
          ? e.u0 - (e.f0 - s)
          : s > e.f1
            ? uEnd + (s - e.f1)
            : e.u0 + (s - e.f0) * e.k;
      const topY = (s: number) => ghost.top(uOf(s)) + vOff;
      const clear = (s: number, pad: number) =>
        !inStair(i, s, pad) &&
        !(partyAd?.edge === i && Math.abs(s - partyAd.s) < partyAd.hw + pad);
      const into: Vec3 = [-e.n[0], 0, -e.n[2]];
      const ok = (s: number, y: number) =>
        y < wallTop - 0.25 && y > grade[i] + 0.3 && !hid(i, y) && clear(s, 0.2);
      // The old roofline, sampled every 5 cm and simplified to its steps
      // and slopes.
      const pts: [number, number][] = [];
      for (let s = GHOST_END; s <= e.len - GHOST_END + 1e-6; s += 0.05) {
        const y = topY(s);
        const n = pts.length;
        if (n >= 2) {
          const [s0, y0] = pts[n - 2],
            [s1, y1] = pts[n - 1];
          if (Math.abs((y1 - y0) / (s1 - s0) - (y - y1) / (s - s1)) < 1e-3) {
            pts[n - 1] = [s, y];
            continue;
          }
        }
        pts.push([s, y]);
      }
      // The wall the neighbour stood against stands GHOST_STEP proud of
      // the weathered wall above its roofline (render and waterproofing
      // left behind when it came down): the same party-wall surface (same
      // material, aux and uv, so the shader's ghost paint lines up) under
      // the old roofline, a lip along the profile and end caps short of the
      // corners. Its foot sits on the plinth (or the neighbour's cover).
      const yFoot = Math.max(
        base + 0.35,
        grade[i] + 0.25,
        cover[i] ?? -Infinity,
        b.low,
      );
      const yCap = wallTop - 0.3;
      const yZone = base + GROUND_H;
      const bodyMat = fmat(e, FZ.body, true);
      const baseMat = fmat(e, FZ.base, true);
      const G = GHOST_STEP;
      const pv = (s: number, y: number): Vec2 => [uOf(s), y];
      const panel = (s0: number, s1: number, ya: number, yb: number) => {
        // Trapezoid over [s0, s1] from yFoot to the profile (ya at s0, yb at
        // s1), split at the ground-floor line into its two zones.
        const lo = (
          y: number,
          vo: number,
          mat: number,
          top: [number, number],
        ) =>
          m.quad(
            [
              edgeAt(e, s0, G, y),
              edgeAt(e, s1, G, y),
              edgeAt(e, s1, G, top[1]),
              edgeAt(e, s0, G, top[0]),
            ],
            e.n,
            [
              [pv(s0, y)[0], y - vo],
              [pv(s1, y)[0], y - vo],
              [pv(s1, y)[0], top[1] - vo],
              [pv(s0, y)[0], top[0] - vo],
            ],
            mat,
            partyAux,
          );
        if (yFoot < yZone)
          lo(yFoot, base, baseMat, [Math.min(ya, yZone), Math.min(yb, yZone)]);
        const y0 = Math.max(yFoot, yZone);
        if (ya > y0 + 0.01 && yb > y0 + 0.01) lo(y0, vOff, bodyMat, [ya, yb]);
      };
      if (pts.length >= 2 && !hid(i, yCap)) {
        for (let k = 0; k + 1 < pts.length; k++) {
          const [s0, y0] = pts[k],
            [s1, y1] = pts[k + 1];
          const ya = Math.min(y0, yCap),
            yb = Math.min(y1, yCap);
          if (ya < yFoot + 0.3 || yb < yFoot + 0.3) continue;
          panel(s0, s1, ya, yb);
          // Lip along the profile, its normal in the wall plane.
          const ds = s1 - s0,
            dy = yb - ya;
          const l = Math.hypot(ds, dy) || 1;
          const nn: Vec3 = [
            (-e.along[0] * dy) / l,
            ds / l,
            (-e.along[2] * dy) / l,
          ];
          m.quad(
            [
              edgeAt(e, s0, 0, ya),
              edgeAt(e, s1, 0, yb),
              edgeAt(e, s1, G, yb),
              edgeAt(e, s0, G, ya),
            ],
            nn,
            [
              [uOf(s0), ya - vOff],
              [uOf(s1), yb - vOff],
              [uOf(s1), yb - vOff + G],
              [uOf(s0), ya - vOff + G],
            ],
            bodyMat,
            partyAux,
          );
        }
        // End caps.
        for (const [s, y, sg] of [
          [pts[0][0], pts[0][1], -1],
          [pts[pts.length - 1][0], pts[pts.length - 1][1], 1],
        ] as const) {
          const yt = Math.min(y, yCap);
          if (yt < yFoot + 0.3) continue;
          m.quad(
            sg < 0
              ? [
                  edgeAt(e, s, 0, yFoot),
                  edgeAt(e, s, G, yFoot),
                  edgeAt(e, s, G, yt),
                  edgeAt(e, s, 0, yt),
                ]
              : [
                  edgeAt(e, s, G, yFoot),
                  edgeAt(e, s, 0, yFoot),
                  edgeAt(e, s, 0, yt),
                  edgeAt(e, s, G, yt),
                ],
            [e.along[0] * sg, 0, e.along[2] * sg],
            [
              [uOf(s), yFoot - vOff],
              [uOf(s) + G, yFoot - vOff],
              [uOf(s) + G, yt - vOff],
              [uOf(s), yt - vOff],
            ],
            bodyMat,
            partyAux,
          );
        }
      }
      const flash = packMat(CM.paint, 0x90);
      for (let k = 0; k + 1 < pts.length; k++) {
        const [s0, y0] = pts[k],
          [s1, y1] = pts[k + 1];
        if (!ok(s0, y0) || !ok(s1, y1)) continue;
        m.beam(
          edgeAt(e, s0, 0.035, y0 + 0.02),
          edgeAt(e, s1, 0.035, y1 + 0.02),
          0.035,
          0.045,
          flash,
          0,
          into,
        );
      }
      // The old floor slabs' cut edges: a continuous ledge 4.5 cm proud of
      // the ghost along each old floor line (2.7 m storeys) wherever the
      // neighbour stood above it, so each throws a shadow line.
      const slab = packMat(CM.concrete);
      for (let fl = 1; fl < 4; fl++) {
        const y = vOff + fl * 2.7 + 0.12;
        const ledge = (s0: number, s1: number) => {
          if (s1 - s0 < 0.6) return;
          const o = (G + 0.045) / 2;
          m.beam(
            edgeAt(e, s0, o, y),
            edgeAt(e, s1, o, y),
            o,
            0.06,
            slab,
            0,
            into,
          );
        };
        let r0 = -1;
        const step = 0.25;
        for (let s = GHOST_END + 0.15; s <= e.len - GHOST_END; s += step) {
          const good = ok(s, y) && topY(s) > y + 0.3 && y > yFoot + 0.2;
          if (good && r0 < 0) r0 = s;
          else if (!good && r0 >= 0) {
            ledge(r0, s - step);
            r0 = -1;
          }
        }
        if (r0 >= 0) ledge(r0, e.len - GHOST_END - 0.15);
      }
      // And a few broken stubs of the slabs standing deeper.
      let stubs = 0;
      for (let fl = 1; fl < 4 && stubs < 3; fl++) {
        const y = vOff + fl * 2.7 + 0.12;
        let s = gr.range(0.3, 1.2);
        while (s < e.len - 0.6 && stubs < 3) {
          const l = gr.range(0.4, 1.6);
          const s1 = Math.min(e.len - 0.3, s + l);
          if (
            ok(s, y) &&
            ok(s1, y) &&
            topY(s) > y + 0.4 &&
            topY(s1) > y + 0.4
          ) {
            const d = gr.range(0.04, 0.1);
            m.beam(
              edgeAt(e, s, d, y),
              edgeAt(e, s1, d, y),
              d,
              0.11,
              slab,
              0,
              into,
            );
            stubs++;
          }
          s = s1 + gr.range(0.3, 2.2);
        }
      }
      // Cut pipe and cable stubs, one capped.
      for (let k = 0; k < 3; k++) {
        const s = gr.range(0.6, e.len - 0.6);
        const fl = gr.int(0, 3);
        const y = vOff + fl * 2.7 + gr.range(0.5, 2.2);
        if (!ok(s, y) || topY(s) < y + 0.3) continue;
        if (k === 2) {
          m.tube(
            [
              edgeAt(e, s, 0, y),
              edgeAt(e, s, 0.12, y),
              edgeAt(e, s + 0.05, 0.16, y - 0.3),
            ],
            0.012,
            packMat(CM.wire),
          );
        } else {
          const r = k === 0 ? 0.05 : 0.03;
          m.tube(
            [edgeAt(e, s, 0, y), edgeAt(e, s, 0.16, y)],
            r,
            k === 0 ? packMat(CM.paint, 0xd2) : flash,
          );
          if (k === 0)
            m.box(
              edgeAt(e, s, 0.18, y),
              [r + 0.01, r + 0.01, 0.025],
              flash,
              yawOf(e),
              0,
              false,
            );
        }
      }
      // Bricked-up doorway on the old first floor: a concrete frame standing
      // proud round a painted-over infill.
      const dy = vOff + 2.7 + 0.24;
      const ds = gr.range(1.2, e.len - 1.2);
      if (
        gr.chance(0.7) &&
        ok(ds - 0.6, dy) &&
        ok(ds + 0.6, dy + 2.2) &&
        topY(ds) > dy + 2.5
      ) {
        const fm = slab;
        for (const sx of [-0.5, 0.5])
          m.beam(
            edgeAt(e, ds + sx, 0.04, dy),
            edgeAt(e, ds + sx, 0.04, dy + 2.1),
            0.04,
            0.06,
            fm,
            0,
            into,
          );
        m.beam(
          edgeAt(e, ds - 0.56, 0.05, dy + 2.15),
          edgeAt(e, ds + 0.56, 0.05, dy + 2.15),
          0.05,
          0.08,
          fm,
          0,
          into,
        );
        const q = (sx: number, y: number) => edgeAt(e, ds + sx, G + 0.015, y);
        m.quad(
          [q(-0.44, dy), q(0.44, dy), q(0.44, dy + 2.07), q(-0.44, dy + 2.07)],
          e.n,
          uv01,
          fmat(e, FZ.trim, true),
          aux,
        );
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
        if (s > 0.2 && s < e.len - 0.2 && !hid(i, wallTop))
          downpipe(e, s, ground);
      }
      if (e.role === ROLE.rear && e.count >= 4 && svc === 1) {
        const bw = bay / e.k;
        const j = 1 + cr.int(0, e.count - 2);
        const s = e.f0 + j * bw;
        const jy = base + GROUND_H + cr.int(0, Math.max(1, bodyN - 1)) * H;
        const jog = (cr.chance(0.5) ? 1 : -1) * 0.35;
        if (!inStair(i, s, 0.5) && !inStair(i, s + jog, 0.5))
          if (!hid(i, wallTop)) downpipe(e, s, ground, jog, jy);
      }
      if (!meters && e.len > 4 && !hid(i, ground + 2.2)) {
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
          if ((y < solidTo[i] && y < grade[i] + 0.5) || hid(i, y + 0.2))
            continue;
          for (const t of [0.22, 0.78])
            flatQuad(
              m,
              edgeAt(e, e.len * t, 0.015 + ghostOut(e, e.len * t, y), y),
              e.along,
              0.13,
              0.13,
              e.n,
              dark,
            );
        }
        if (svc === 1 && !hid(i, wallTop)) partyKit(e, i, ground);
        ghostRelief(e, i);
        if (bodyN >= 2 && svc === 1) {
          // Kitchen exhaust: a flush louvre under a sloped weather cowl.
          const f = cr.int(1, bodyN + 1);
          const s = lerp(e.len * 0.35, e.len * 0.65, cr.next());
          const y = base + GROUND_H + (f - 1) * H + 2.4;
          if (hid(i, y + 0.3)) return;
          const go = ghostOut(e, s, y + 0.2);
          flatQuad(
            m,
            edgeAt(e, s, go + 0.01, y),
            e.along,
            0.17,
            0.15,
            e.n,
            metal,
          );
          for (const dy of [-0.08, 0, 0.08])
            flatQuad(
              m,
              edgeAt(e, s, go + 0.015, y + dy),
              e.along,
              0.14,
              0.018,
              e.n,
              dark,
            );
          const c = (ds: number, out: number, dy: number) =>
            edgeAt(e, s + ds, out + go, y + dy);
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
        const fh = f === 0 ? GROUND_H : H;
        if (y0 < solidTo[i] || hid(i, y0 + fh)) continue;
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
            hid(i, y0 + H * 0.5) ||
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
        // Its canopy lamp lights the door and the yard.
        lights.add(edgeAt(e, s, 0.7, y + 2.1), 7, WALL_LAMP, LightKind.station);
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
        if (y < solidTo[rearBalc.edge] || hid(rearBalc.edge, y + 1.1)) continue;
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
        // AC units: one or two per flat (homes: between partitions; offices
        // per three bays), off on some.
        const fw = (bay / e.k) * 3;
        for (let a = s0; a < s1 - 1.2; a += fw) {
          const b1 = Math.min(s1, a + fw);
          const k = br.chance(0.4) ? 0 : br.chance(0.2) ? 2 : 1;
          // On the slab, or wall-hung on a bracket clear above the
          // balustrade (seen from the street).
          for (let j = 0; j < k; j++) {
            const hung = br.chance(0.5);
            acUnit(
              m,
              e,
              lerp(a + 0.55, b1 - 0.55, k === 1 ? br.next() : j),
              0.3,
              y + (hung ? 1.25 : 0.02),
              hung,
              hung,
            );
          }
        }
        // Laundry poles on about a third of the flats' balconies (homes):
        // two poles on hangers under the slab above, with washing on some.
        if (!office && f < bodyN && br.chance(0.3)) {
          const l0 = s0 + 0.3 + br.range(0, Math.max(0, s1 - s0 - 4)),
            l1 = Math.min(s1 - 0.3, l0 + br.range(2.2, 3.6));
          const hy = y + 2.0;
          const pole = packMat(CM.paint, 0xd3);
          for (const o of [0.55, 0.85]) {
            m.tube([P(l0, o, hy), P(l1, o, hy)], 0.014, pole);
            for (const s of [l0 + 0.15, l1 - 0.15])
              m.tube([P(s, o, hy), P(s, o, y + H - 0.12)], 0.008, pole);
          }
          const nw = br.int(0, 6);
          for (let k = 0; k < nw; k++) {
            const s = lerp(l0 + 0.2, l1 - 0.6, br.next());
            const w = br.range(0.35, 0.7),
              h = br.range(0.4, 0.8);
            const o = br.chance(0.5) ? 0.55 : 0.85;
            const mat = packMat(CM.paint, LAUNDRY[br.int(0, LAUNDRY.length)]);
            const q = [
              P(s, o, hy - h),
              P(s + w, o, hy - h),
              P(s + w, o, hy),
              P(s, o, hy),
            ];
            m.quad(q, e.n, uv01, mat);
            m.quad(q, [-e.n[0], 0, -e.n[2]], uv01, mat);
          }
        }
      }
    }
    if (stair >= 0 && !hid(stair, base + GROUND_H + (bodyN - 1) * H + 1))
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
        // (Its underside shows from the street below the stand.)
        m.box(
          [q[0], ty + th, q[1]],
          [hv, th, hu],
          packMat(CM.paint, 0xd1),
          yaw,
          0,
          lod > 0,
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
          // Supply pipe: down a leg from the tank's floor, then along
          // the roof's axes to the penthouse (or toward the middle).
          const gq: Vec2 = mast
            ? toObb([mast[0], mast[2]])
            : [spot[0] * -0.3, spot[1] * -0.3];
          const yp = roofY + 0.3;
          const A2 = (su: number, sv: number, y: number): Vec3 => {
            const p = at(su, sv);
            return [p[0], y, p[1]];
          };
          const su0 = spot[0] + lu * Math.sign(gq[0] - spot[0] || 1),
            sv0 = spot[1] + lv * Math.sign(gq[1] - spot[1] || 1);
          m.tube(
            [
              A2(su0, sv0, ty),
              A2(su0, sv0, yp),
              A2(gq[0], sv0, yp),
              A2(gq[0], gq[1], yp),
            ],
            0.065,
            packMat(CM.paint, 0xd2),
          );
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
    const mastUp = rr.chance(0.25);
    if (mastUp && mast && lod === 0) {
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
    // TV aerials and satellite dishes (LOD0): a Yagi on a short pole on the
    // penthouse when it has no mast (every Yagi in the city points the same
    // way, at the broadcast tower), and on some roofs a dish on a stand
    // aimed up to the south-west.
    if (lod === 0 && mast) {
      const ar2 = new Rng(hash2(b.seed, 0xa7e1));
      const metalM = packMat(CM.metal);
      if (!mastUp && ar2.chance(0.6)) {
        const p: Vec3 = [mast[0] + U[0] * 0.6, mast[1], mast[2] + U[1] * 0.6];
        const top = p[1] + ar2.range(1.4, 2.2);
        m.tube([p, [p[0], top, p[2]]], 0.025, metalM);
        const dx = Math.cos(0.6),
          dz = Math.sin(0.6);
        const B = (t: number, w: number): Vec3 => [
          p[0] + dx * t - dz * w,
          top - 0.1,
          p[2] + dz * t + dx * w,
        ];
        m.tube([B(-0.6, 0), B(1.0, 0)], 0.022, metalM);
        for (let k = 0; k < 4; k++) {
          const t = -0.4 + k * 0.38;
          const w = 0.32 - k * 0.04;
          m.tube([B(t, -w), B(t, w)], 0.013, metalM);
        }
      }
      if (ar2.chance(0.6)) {
        // Dish (60 cm) on a pole by the penthouse, facing south-west and up.
        const p: Vec3 = [
          mast[0] - U[0] * 0.9 + V[0] * 0.5,
          mast[1],
          mast[2] - U[1] * 0.9 + V[1] * 0.5,
        ];
        const c: Vec3 = [p[0], p[1] + 0.75, p[2]];
        m.tube([p, c], 0.025, metalM);
        const f: Vec3 = [-0.62, 0.5, -0.6];
        const fl = Math.hypot(f[0], f[1], f[2]);
        const F: Vec3 = [f[0] / fl, f[1] / fl, f[2] / fl];
        const R: Vec3 = [F[2], 0, -F[0]];
        const rl = Math.hypot(R[0], R[2]);
        R[0] /= rl;
        R[2] /= rl;
        const Up: Vec3 = [
          F[1] * R[2] - F[2] * R[1],
          F[2] * R[0] - F[0] * R[2],
          F[0] * R[1] - F[1] * R[0],
        ];
        const dishMat = packMat(CM.paint, 0xd5);
        const ctr = m.vertex(
          [c[0] - F[0] * 0.06, c[1] - F[1] * 0.06, c[2] - F[2] * 0.06],
          F,
          0,
          0,
          dishMat,
        );
        const rim = Array.from({length: 8}, (_, k) => {
          const a = (k / 8) * Math.PI * 2;
          const x = Math.cos(a) * 0.36,
            y = Math.sin(a) * 0.36;
          return m.vertex(
            [
              c[0] + R[0] * x + Up[0] * y,
              c[1] + R[1] * x + Up[1] * y,
              c[2] + R[2] * x + Up[2] * y,
            ],
            [
              F[0] + (R[0] * x + Up[0] * y) * 0.8,
              F[1] + (R[1] * x + Up[1] * y) * 0.8,
              F[2] + (R[2] * x + Up[2] * y) * 0.8,
            ],
            0,
            0,
            dishMat,
          );
        });
        for (let k = 0; k < 8; k++) {
          // Both sides (the back is the same shell).
          m.triFacing(ctr, rim[k], rim[(k + 1) % 8], F);
          m.triFacing(ctr, rim[(k + 1) % 8], rim[k], [-F[0], -F[1], -F[2]]);
        }
        m.tube(
          [
            [c[0] - Up[0] * 0.28, c[1] - Up[1] * 0.28, c[2] - Up[2] * 0.28],
            [c[0] + F[0] * 0.38, c[1] + F[1] * 0.38, c[2] + F[2] * 0.38],
          ],
          0.012,
          metalM,
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

/**
 * Crown shape per species, as fractions of the tree height: clear trunk to
 * the crown, the crown ellipsoid's horizontal and vertical radii, and
 * `flare` (radius x (1 + flare) at the top, x (1 - flare) at the bottom:
 * > 0 a vase that widens as it rises, < 0 an ovoid narrowing upward).
 */
const TREE_SHAPE = [
  // zelkova: broad vase, a full rounded dome wider at the top.
  {trunk: 0.38, rx: 0.3, ry: 0.27, flare: 0.18},
  // ginkgo: upright ovoid narrowing to a blunt point.
  {trunk: 0.3, rx: 0.21, ry: 0.35, flare: -0.32},
  // columnar (pruned street tree): narrow stacked column.
  {trunk: 0.22, rx: 0.14, ry: 0.4, flare: -0.08},
];

/** LOD0 crown leaf cards (4 vertices each). */
const CROWN_CARDS = 62;

export function tree(m: CMesh, p: Vec3, h: number, lod: number, rng: Rng) {
  // Take exactly one value from the caller's stream, so whatever is placed
  // after a tree does not depend on its species or LOD; the crown is built
  // from a local stream.
  const aux = rng.nextU32();
  const lr = new Rng(aux ^ hash2(Math.floor(p[0] * 8), Math.floor(p[2] * 8)));
  const sp = treeSpecies(p[0], p[2]);
  const S = TREE_SHAPE[sp];
  const trunkH = h * S.trunk;
  const r0 = 0.12 + h * 0.012;
  const rx = h * S.rx;
  const ry = h * S.ry;
  // Crown centre: its lower tenth hangs below the top of the clear trunk.
  const c: Vec3 = [p[0], p[1] + trunkH + ry * 0.8, p[2]];
  trunk(
    m,
    [p[0], p[1] - SINK, p[2]],
    r0,
    trunkH + SINK + ry * (sp === TREE.zelkova ? 0.5 : 1.1),
    lod === 0 ? 8 : 4,
    aux,
  );
  if (lod !== 0) {
    // Far LOD: LOD0's crown mass kept (round 4's eight loose cards read as
    // spindly palm fronds in shell-day): a closed low-poly shell of the
    // ellipsoid in the same leaf material (its leaf-texture alpha opens
    // small gaps onto its own darker far side) and three of LOD0's cards
    // breaking the outline. 32 vertices, as before.
    crownShell(m, c, rx * 0.9, ry * 0.9, S.flare, aux, sp);
    crownCards(m, c, rx, ry, S.flare, 3, h * 0.13, aux, lr, sp, 0.75);
    return;
  }
  // A full rounded crown (Tokyo street zelkova / ginkgo, pruned into a dome
  // or ovoid; round 3's lobes on bare limbs read as palms): three short
  // scaffold limbs hidden inside and 62 overlapping leaf cards through the
  // crown ellipsoid, most of them in its outer shell so the outline is
  // leaves all round with only small sky gaps, the surface pushed in and
  // out by three broad bulges so it is not a perfect ball. No solid core
  // (its flat facets showed through as olive discs). 272 vertices, round
  // 3's lobes were ~306.
  const fork: Vec3 = [p[0], p[1] + trunkH * 0.95, p[2]];
  const a0 = lr.range(0, Math.PI * 2);
  for (let k = 0; k < 3; k++) {
    const a = a0 + (k * Math.PI * 2) / 3;
    m.tube(
      [
        fork,
        [
          c[0] + Math.cos(a) * rx * 0.5,
          c[1] + ry * lr.range(0, 0.35),
          c[2] + Math.sin(a) * rx * 0.5,
        ],
      ],
      r0 * 0.4,
      packMat(CM.bark),
      aux,
    );
  }
  crownCards(m, c, rx, ry, S.flare, CROWN_CARDS, h * 0.085, aux, lr, sp, 0);
}

/**
 * LOD1 crown mass: a closed six-sided, three-ring ellipsoid shell (radii
 * rx, ry; flare as crownCards) in the leaf material, both windings, 20
 * vertices. uv alternates 0.32 / 0.68 per column and ring, so each face
 * maps the dense middle of the leaf texture (mostly opaque, a few gaps);
 * normals are the ellipsoid's bent up like the cards'.
 */
function crownShell(
  m: CMesh,
  c: Vec3,
  rx: number,
  ry: number,
  flare: number,
  aux: number,
  species: number,
) {
  const mat = packMat(CM.leaves, species);
  const N = 6;
  const yaw = (aux & 0xff) / 40;
  const nrm = (d: Vec3): Vec3 => {
    const n: Vec3 = [d[0], d[1] + 0.3, d[2]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  const vert = (u: number, a: number, uu: number, vv: number) => {
    const s = Math.sqrt(1 - u * u);
    const d: Vec3 = [s * Math.cos(a), u, s * Math.sin(a)];
    const w = rx * (1 + flare * u);
    return m.vertex(
      [c[0] + d[0] * w, c[1] + u * ry, c[2] + d[2] * w],
      nrm(d),
      uu,
      vv,
      mat,
      aux,
    );
  };
  const rows = [-0.62, 0.08, 0.7];
  const ring = rows.map((u, r) =>
    Array.from({length: N}, (_, i) =>
      vert(
        u,
        yaw + ((i + (r & 1) * 0.5) / N) * Math.PI * 2,
        i & 1 ? 0.68 : 0.32,
        r & 1 ? 0.68 : 0.32,
      ),
    ),
  );
  const bottom = vert(-1, 0, 0.5, 0.5);
  const top = vert(1, 0, 0.5, 0.5);
  const two = (a: number, b: number, d: number) => {
    m.tri(a, b, d);
    m.tri(a, d, b);
  };
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    two(bottom, ring[0][i], ring[0][j]);
    two(top, ring[rows.length - 1][i], ring[rows.length - 1][j]);
    for (let r = 0; r + 1 < rows.length; r++) {
      // Rings staggered by half a column (odd rows): zig-zag strip.
      const lo = ring[r];
      const hi = ring[r + 1];
      if (r & 1) {
        two(lo[i], hi[i], hi[j]);
        two(lo[i], hi[j], lo[j]);
      } else {
        two(lo[i], hi[i], lo[j]);
        two(lo[j], hi[i], hi[j]);
      }
    }
  }
}

/**
 * `count` alpha leaf cards (the tree leaf path, CM.leaves `species`)
 * through a crown ellipsoid at c (radii rx, ry; the horizontal radius x
 * (1 + flare * height)), stratified over height, card centres biased to
 * the outer shell (`inner`..1 of the radius; 0 = 0.45) and the surface
 * modulated by three broad bulges (about +-15 %). Card half size about
 * `size`. Normals are the ellipsoid's outward normal bent a little up, so
 * the crown shades as one rounded mass.
 */
function crownCards(
  m: CMesh,
  c: Vec3,
  rx: number,
  ry: number,
  flare: number,
  count: number,
  size: number,
  aux: number,
  rng: Rng,
  species: number,
  inner: number,
) {
  const mat = packMat(CM.leaves, species);
  const lo = inner || 0.45;
  const bulge: Vec3[] = [0, 1, 2].map(() => {
    const u = rng.range(-0.6, 0.9);
    const th = rng.range(0, Math.PI * 2);
    const s = Math.sqrt(1 - u * u);
    return [s * Math.cos(th), u, s * Math.sin(th)];
  });
  for (let k = 0; k < count; k++) {
    const u = Math.max(
      -0.92,
      Math.min(0.95, ((k + rng.range(0, 1)) / count) * 2 - 1),
    );
    const th = rng.range(0, Math.PI * 2);
    const s = Math.sqrt(1 - u * u);
    const dir: Vec3 = [s * Math.cos(th), u, s * Math.sin(th)];
    let b = 0.92;
    for (const q of bulge) {
      const d = dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2];
      b += Math.max(0, d) ** 3 * 0.25;
    }
    // Shell-biased depth (sqrt pulls toward 1).
    const f = lo + (1 - lo) * Math.sqrt(rng.range(0, 1));
    const wide = rx * (1 + flare * u) * b * f;
    const q: Vec3 = [
      c[0] + dir[0] * wide,
      c[1] + dir[1] * ry * b * f,
      c[2] + dir[2] * wide,
    ];
    const yaw = rng.range(0, Math.PI);
    const tilt = rng.range(-0.6, 0.6);
    const ax: Vec3 = [Math.cos(yaw), 0, Math.sin(yaw)];
    const ay: Vec3 = [
      -Math.sin(yaw) * Math.sin(tilt),
      Math.cos(tilt),
      Math.cos(yaw) * Math.sin(tilt),
    ];
    const sz = size * rng.range(0.8, 1.15);
    const ids = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, v]) => {
      const pp: Vec3 = [
        q[0] + (ax[0] * a + ay[0] * v) * sz,
        q[1] + (ax[1] * a + ay[1] * v) * sz,
        q[2] + (ax[2] * a + ay[2] * v) * sz,
      ];
      let nn: Vec3 = [
        (pp[0] - c[0]) / rx,
        (pp[1] - c[1]) / ry + 0.3,
        (pp[2] - c[2]) / rx,
      ];
      const l = Math.hypot(nn[0], nn[1], nn[2]) || 1;
      nn = [nn[0] / l, nn[1] / l, nn[2] / l];
      return m.vertex(pp, nn, (a + 1) / 2, (1 - v) / 2, mat, aux);
    });
    // Double-sided: emit both windings.
    m.tri(ids[0], ids[1], ids[2]);
    m.tri(ids[0], ids[2], ids[3]);
    m.tri(ids[0], ids[2], ids[1]);
    m.tri(ids[0], ids[3], ids[2]);
  }
}

/**
 * Tapered tree trunk (n sides) from base c up `height`: a root flare over
 * the bottom 0.6 m, tapering to 55 % of r at the top. UV for the bark
 * shader: u = metres around (at that ring's radius), v = metres up; aux
 * carries the tree's hash like the crown.
 */
function trunk(
  m: CMesh,
  c: Vec3,
  r: number,
  height: number,
  n: number,
  aux: number,
) {
  const mat = packMat(CM.bark);
  const rings: [number, number][] =
    n > 4
      ? [
          [0, r * 1.35],
          [SINK + 0.6, r],
          [height, r * 0.55],
        ]
      : [
          [0, r],
          [height, r * 0.6],
        ];
  const ids: number[][] = rings.map(([y, rr]) => {
    const row: number[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      const nn: Vec3 = [Math.cos(a), 0.12, Math.sin(a)];
      row.push(
        m.vertex(
          [c[0] + Math.cos(a) * rr, c[1] + y, c[2] + Math.sin(a) * rr],
          nn,
          (i / n) * Math.PI * 2 * rr,
          y,
          mat,
          aux,
        ),
      );
    }
    return row;
  });
  for (let k = 0; k + 1 < ids.length; k++)
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * Math.PI * 2 + 0.3;
      const fn: Vec3 = [Math.cos(a), 0, Math.sin(a)];
      m.triFacing(ids[k][i], ids[k + 1][i], ids[k + 1][i + 1], fn);
      m.triFacing(ids[k][i], ids[k + 1][i + 1], ids[k][i + 1], fn);
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
  /** Vertical stretch (1 = the usual slightly flattened ball). */
  tall = 1,
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
        [c[0] + v[0] * d, c[1] + v[1] * d * 0.85 * tall, c[2] + v[2] * d],
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
/** CM.metal param: galvanised street-light column (shader pole streaks). */
const LAMP_METAL = 0x10;
/** CM.paint param: grey signal / sign column (streaks, dirt, stickers). */
const POLE_PAINT = 0x93;

/**
 * CM.paint param of a pole's base flange plate (POLE_FLANGE, round 6):
 * dark grey-black so the 0.4 m plate and its four bright anchor bolts read
 * against the paving and the grey column at eye distance: the shared matt
 * black 0x91 (albedo 0.06, rough 0.7). Lathe uv as the footing (u metres
 * around, v metres up the profile from the plate's foot).
 */
const POLE_FLANGE = 0x91;
/**
 * CM.paint param of a pole's ID / management-number plate (POLE_ID, round
 * 6): a 9 x 22 cm aluminium plate at 1.65 m on the walk side of signal
 * and avenue lamp columns. Box uv in metres per face (the front face is
 * the one facing away from the road). Fallback: the 0xd0-0xef service
 * paint (albedo 0.62, rough 0.7); intended: white plate, a dark number
 * line and a green or blue band at the top.
 */
const POLE_ID = 0xe9;
/**
 * CM.paint param of the white border round a vehicle signal's black
 * backplate (SIGNAL_BORDER, round 6): a box 1.6 x 0.76 m just behind the
 * 1.52 x 0.68 m backplate, so a 4 cm rim shows round it from the front
 * and the whole board from behind. Box uv in metres per face. Fallback:
 * the 0xd0-0xef service paint (albedo 0.62); intended: retroreflective
 * white (albedo ~0.8, rough ~0.4, a faint sparkle toward the camera at
 * night), grime along the bottom edge.
 */
const SIGNAL_BORDER = 0xe8;

/**
 * Foot of a steel street pole of radius r at paving point p (LOD0), one
 * lathe of `sides`: a concrete footing collar (CM.concrete) 64 cm across
 * standing 8 cm proud of the paving, a 0.41 m base flange plate 3.5 cm
 * thick (dark paint POLE_FLANGE, so it reads against both) and a flared
 * base cover over the bottom 0.6 m (the column's `mat`). `full` adds four
 * anchor bolts standing 5 cm on the flange (bare galvanised boxes, bright
 * on the dark plate), a handhole door facing `back` (unit 2D) at 0.95 m,
 * the column's ID plate above it at 1.65 m and a clamp band at each of
 * `bands` (heights above the paving), these in `plain` (not the column's
 * material: its uv-driven foot dirt would land on them). Round 3's foot
 * (a 29 cm plate 2.5 cm thick, 4 cm nut squares) vanished at eye
 * distance. About 90 vertices, 200 when full.
 * Lathe uv: u = metres around, v = metres up the profile (collar from 0,
 * metal from 0); the pole's own cylinder: u metres around, v metres up
 * from SINK under the paving.
 */
function poleFoot(
  m: CMesh,
  p: Vec3,
  r: number,
  mat: number,
  plain: number,
  sides: number,
  back: Vec2,
  bands: number[],
  full: boolean,
) {
  const conc = packMat(CM.concrete);
  const flange = packMat(CM.paint, POLE_FLANGE);
  // Profile rows: radius, height, normal (radial, up), material. A strip
  // joins two rows of the same material (a change is a seam: the same
  // ring twice).
  const FR = 0.205;
  const FT = 0.115;
  const rows: [number, number, number, number, number][] = [
    [0.32, -0.06, 1, 0, conc],
    [0.32, 0.055, 1, 0.15, conc],
    [0.295, 0.08, 0.3, 0.95, conc],
    [FR, 0.08, 0, 1, conc],
    [FR, 0.08, 1, 0, flange],
    [FR, FT, 0.8, 0.6, flange],
    [r * 1.3, FT, 0, 1, flange],
    [r * 1.3, FT, 0.5, 0.85, mat],
    [r * 1.12, 0.6, 1, 0.12, mat],
  ];
  let v = 0;
  const ids = rows.map(([rr, y, nr, ny, mt], k) => {
    if (k && rows[k - 1][4] === mt)
      v += Math.hypot(rr - rows[k - 1][0], y - rows[k - 1][1]);
    else v = 0;
    const row: number[] = [];
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      row.push(
        m.vertex(
          [p[0] + c * rr, p[1] + y, p[2] + sn * rr],
          [c * nr, ny, sn * nr],
          (i / sides) * Math.PI * 2 * rr,
          v,
          mt,
        ),
      );
    }
    return row;
  });
  for (let k = 0; k + 1 < rows.length; k++) {
    if (rows[k][4] !== rows[k + 1][4]) continue; // material seam
    for (let i = 0; i < sides; i++) {
      const a = ((i + 0.5) / sides) * Math.PI * 2;
      const n: Vec3 = [
        Math.cos(a) * (rows[k][2] + rows[k + 1][2]),
        rows[k][3] + rows[k + 1][3],
        Math.sin(a) * (rows[k][2] + rows[k + 1][2]),
      ];
      m.triFacing(ids[k][i], ids[k + 1][i], ids[k + 1][i + 1], n);
      m.triFacing(ids[k][i], ids[k + 1][i + 1], ids[k][i + 1], n);
    }
  }
  if (!full) return;
  // Anchor bolts: nut and stud as one 5 x 5 x 5 cm box at each diagonal,
  // set square to the radius, bare galvanised.
  const bolt = packMat(CM.metal);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    m.box(
      [p[0] + Math.cos(a) * 0.155, p[1] + FT + 0.025, p[2] + Math.sin(a) * 0.155],
      [0.025, 0.025, 0.025],
      bolt,
      a,
    );
  }
  const yaw = Math.atan2(back[0], back[1]);
  m.box(
    [p[0] + back[0] * (r + 0.008), p[1] + 0.95, p[2] + back[1] * (r + 0.008)],
    [0.055, 0.12, 0.012],
    plain,
    yaw,
  );
  // ID plate, flat on the column (back face inside it).
  m.box(
    [p[0] + back[0] * (r + 0.004), p[1] + 1.65, p[2] + back[1] * (r + 0.004)],
    [0.045, 0.11, 0.01],
    packMat(CM.paint, POLE_ID),
    yaw,
    0,
    true,
    true,
  );
  for (const y of bands)
    m.cylinder([p[0], p[1] + y, p[2]], r + 0.02, 0.08, sides, plain, false);
}

function streetLight(
  m: CMesh,
  p: Vec3,
  dir: Vec2,
  kind: number,
  sodium: boolean,
  lod: number,
) {
  const h = kind >= 2 ? 9 : 6.5;
  const reach = kind >= 2 ? 2.2 : 1.2;
  const top: Vec3 = [p[0], p[1] + h, p[2]];
  const head: Vec3 = [
    p[0] + dir[0] * reach,
    p[1] + h - 0.1,
    p[2] + dir[1] * reach,
  ];
  if (lod > 0) {
    // Distant tiles: the pole and arm as one bent tube (widened to a
    // minimum on-screen width) and the lamp head as its lit underside and
    // its top, 20 vertices instead of 42.
    m.tube(
      [[p[0], p[1] - SINK, p[2]], top, head],
      0.13,
      packMat(CM.metal, LAMP_METAL),
    );
    const r: Vec3 = [dir[1], 0, -dir[0]];
    const H = (x: number, z: number, y: number): Vec3 => [
      head[0] + r[0] * x + dir[0] * z,
      head[1] + y,
      head[2] + r[2] * x + dir[1] * z,
    ];
    const lamp = packMat(CM.lamp, sodium ? 0 : 1);
    for (const [y, nn] of [
      [-0.2, [0, -1, 0]],
      [-0.04, UP],
    ] as const)
      m.quad(
        [
          H(-0.3, -0.18, y),
          H(0.3, -0.18, y),
          H(0.3, 0.18, y),
          H(-0.3, 0.18, y),
        ],
        nn as Vec3,
        uv01,
        lamp,
      );
    return;
  }
  m.cylinder(
    [p[0], p[1] - SINK, p[2]],
    0.09,
    h + SINK,
    kind >= 2 ? 8 : 6,
    packMat(CM.metal, LAMP_METAL),
    false,
  );
  // Avenue lights get the footing, flange and nuts and handhole (budget:
  // the 6.5 m lamps of narrow streets are the bulk of all poles).
  if (kind >= 2)
    poleFoot(
      m,
      p,
      0.09,
      packMat(CM.metal, LAMP_METAL),
      packMat(CM.metal),
      8,
      [-dir[0], -dir[1]],
      [],
      true,
    );
  // Arm-joint collar over the column top (it also caps the open tube).
  if (kind >= 2)
    m.cylinder(
      [p[0], p[1] + h - 0.28, p[2]],
      0.125,
      0.32,
      8,
      packMat(CM.metal),
      true,
    );
  m.beam(top, head, 0.05, 0.05, packMat(CM.metal));
  m.box(
    [head[0], head[1] - 0.12, head[2]],
    [0.3, 0.08, 0.18],
    packMat(CM.lamp, sodium ? 0 : 1),
    Math.atan2(dir[0], dir[1]),
  );
}

/**
 * Flat one-sided disc facing horizontal `f` (unit 2D), centre c; uv 0..1
 * over its square.
 */
function disc(
  m: CMesh,
  c: Vec3,
  f: Vec2,
  r: number,
  sides: number,
  mat: number,
) {
  const n: Vec3 = [f[0], 0, f[1]];
  // Right-hand axis seen from the front.
  const rx = -f[1];
  const rz = f[0];
  const mid = m.vertex(c, n, 0.5, 0.5, mat);
  const ring: number[] = [];
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const u = Math.cos(a);
    const v = Math.sin(a);
    ring.push(
      m.vertex(
        [c[0] + rx * u * r, c[1] + v * r, c[2] + rz * u * r],
        n,
        0.5 + u * 0.5,
        0.5 - v * 0.5,
        mat,
      ),
    );
  }
  for (let i = 0; i < sides; i++) m.triFacing(mid, ring[i], ring[i + 1], n);
}

/**
 * A sign panel facing horizontal `f`: a box in `back` (sides, rear) plus a
 * face quad in `front` with uv 0..1 (u left to right, v top to bottom as
 * seen by the reader). `hw`, `hh`, `hd`: half width, height, depth.
 */
function signBoard(
  m: CMesh,
  c: Vec3,
  f: Vec2,
  hw: number,
  hh: number,
  hd: number,
  front: number,
  back: number,
  uvr: [number, number, number, number] = [0, 0, 1, 1],
) {
  // The box's skipped -z face is the front (the quad covers it).
  m.box(c, [hw, hh, hd], back, Math.atan2(-f[0], -f[1]), 0, false, true);
  const rx = -f[1];
  const rz = f[0];
  const fc: Vec3 = [
    c[0] + f[0] * (hd + 0.002),
    c[1],
    c[2] + f[1] * (hd + 0.002),
  ];
  const P = (u: number, v: number): Vec3 => [
    fc[0] + rx * u * hw,
    fc[1] + v * hh,
    fc[2] + rz * u * hw,
  ];
  m.quad(
    [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)],
    [f[0], 0, f[1]],
    [
      [uvr[0], uvr[3]],
      [uvr[2], uvr[3]],
      [uvr[2], uvr[1]],
      [uvr[0], uvr[1]],
    ],
    front,
  );
}

/** Signal param: lamp | group << 2 | phase << 3 (bits 3-10) | upper 0x800. */
const signalParam = (lamp: number, group: number, phase: number) =>
  lamp | (group << 2) | ((phase & 0xff) << 3);

/**
 * Pedestrian signal head facing `f`, centre at c: a grey box with two black
 * lens faces, each carrying its pictogram as lit geometry (M_SIGNAL lamp 3,
 * upper = 0x800 standing red man, lower = walking green man; the figure is
 * what glows, as on the real heads), each under a short hood.
 */
function pedSignal(m: CMesh, c: Vec3, f: Vec2, group: number, phase: number) {
  const yaw = Math.atan2(f[0], f[1]);
  const grey = packMat(CM.paint, 0x90);
  m.box(c, [0.22, 0.4, 0.12], grey, yaw);
  for (const [dy, upper] of [
    [0.19, true],
    [-0.19, false],
  ] as const) {
    const lc: Vec3 = [c[0] + f[0] * 0.122, c[1] + dy, c[2] + f[1] * 0.122];
    signBoardFace(m, lc, f, 0.17, 0.17, packMat(CM.paint, 0x91));
    pictogram(
      m,
      [lc[0] + f[0] * 0.004, lc[1], lc[2] + f[1] * 0.004],
      f,
      upper,
      packMat(CM.signal, signalParam(3, group, phase) | (upper ? 0x800 : 0)),
    );
    hood(m, lc, f, 0.17, 0.17, 0.12, grey);
  }
}

// Pedestrian pictograms in face units (u right, v up, metres), as quads and
// a round head: the standing man (arms down, feet together) and the
// walking man (mid-stride, arms swinging).
const STAND: number[][] = [
  // torso, legs, arms
  [-0.035, -0.035, 0.035, -0.035, 0.035, 0.065, -0.035, 0.065],
  [-0.034, -0.135, -0.006, -0.135, -0.006, -0.03, -0.034, -0.03],
  [0.006, -0.135, 0.034, -0.135, 0.034, -0.03, 0.006, -0.03],
  [-0.058, -0.03, -0.04, -0.03, -0.04, 0.06, -0.058, 0.055],
  [0.04, -0.03, 0.058, -0.03, 0.058, 0.055, 0.04, 0.06],
];
const WALK: number[][] = [
  [-0.02, -0.03, 0.03, -0.03, 0.045, 0.065, -0.008, 0.065],
  [-0.075, -0.135, -0.05, -0.135, 0.005, -0.025, -0.022, -0.025],
  [0.045, -0.135, 0.075, -0.13, 0.03, -0.025, 0.0, -0.025],
  [-0.06, -0.02, -0.04, -0.03, 0.0, 0.06, -0.018, 0.064],
  [0.03, 0.055, 0.045, 0.045, 0.085, -0.01, 0.07, -0.02],
];
function pictogram(m: CMesh, c: Vec3, f: Vec2, stand: boolean, mat: number) {
  const n: Vec3 = [f[0], 0, f[1]];
  const rx = -f[1];
  const rz = f[0];
  const P = (u: number, v: number): Vec3 => [
    c[0] + rx * u,
    c[1] + v,
    c[2] + rz * u,
  ];
  const uv = (u: number, v: number): Vec2 => [0.5 + u / 0.34, 0.5 - v / 0.34];
  for (const q of stand ? STAND : WALK) {
    const pts = [0, 2, 4, 6].map(k => P(q[k], q[k + 1]));
    m.quad(
      pts,
      n,
      [0, 2, 4, 6].map(k => uv(q[k], q[k + 1])),
      mat,
    );
  }
  const hc = stand ? [0, 0.105] : [0.025, 0.105];
  const mid = m.vertex(P(hc[0], hc[1]), n, ...uv(hc[0], hc[1]), mat);
  const ring: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const u = hc[0] + Math.cos(a) * 0.032;
    const v = hc[1] + Math.sin(a) * 0.032;
    ring.push(m.vertex(P(u, v), n, ...uv(u, v), mat));
  }
  for (let i = 0; i < 6; i++) m.triFacing(mid, ring[i], ring[(i + 1) % 6], n);
}

/**
 * Hood over a lamp face centred at c facing f: an arc over the top (the
 * upper 200 degrees of a circle of radius r, or a box's top and sides for
 * a square face of half size hw x hh) reaching `depth` forward, grey
 * outside, black inside.
 */
function hood(
  m: CMesh,
  c: Vec3,
  f: Vec2,
  hw: number,
  hh: number,
  depth: number,
  mat: number,
  round = false,
) {
  const rx = -f[1];
  const rz = f[0];
  const ring: [number, number, number, number][] = [];
  if (round) {
    for (let i = 0; i <= 6; i++) {
      const a = -0.17 + (i / 6) * (Math.PI + 0.34);
      ring.push([Math.cos(a) * hw, Math.sin(a) * hh, Math.cos(a), Math.sin(a)]);
    }
  } else {
    ring.push(
      [hw, -hh * 0.3, 1, 0],
      [hw, hh, 0.7, 0.7],
      [-hw, hh, -0.7, 0.7],
      [-hw, -hh * 0.3, -1, 0],
    );
  }
  const black = packMat(CM.paint, 0x91);
  // Square hoods (pedestrian heads) are outside only: their inside barely
  // shows past the lit figure.
  for (const inside of round ? [false, true] : [false]) {
    const s = inside ? -1 : 1;
    const rows = [0, 1].map(k =>
      ring.map(([u, v, nu, nv]) => {
        // Forward end droops 1 cm per 10 cm.
        const d = k * depth;
        const p: Vec3 = [
          c[0] + rx * u + f[0] * d,
          c[1] + v - d * 0.1,
          c[2] + rz * u + f[1] * d,
        ];
        return m.vertex(
          p,
          [rx * nu * s, nv * s, rz * nu * s],
          u,
          d,
          inside ? black : mat,
        );
      }),
    );
    for (let i = 0; i + 1 < ring.length; i++) {
      const nu = (ring[i][2] + ring[i + 1][2]) * s;
      const nv = (ring[i][3] + ring[i + 1][3]) * s;
      const n: Vec3 = [rx * nu, nv, rz * nu];
      m.triFacing(rows[0][i], rows[1][i], rows[1][i + 1], n);
      m.triFacing(rows[0][i], rows[1][i + 1], rows[0][i + 1], n);
    }
  }
}

/** A lone face quad (uv 0..1) facing `f`. */
function signBoardFace(
  m: CMesh,
  c: Vec3,
  f: Vec2,
  hw: number,
  hh: number,
  mat: number,
  uvr: [number, number, number, number] = [0, 0, 1, 1],
) {
  const rx = -f[1];
  const rz = f[0];
  const P = (u: number, v: number): Vec3 => [
    c[0] + rx * u * hw,
    c[1] + v * hh,
    c[2] + rz * u * hw,
  ];
  m.quad(
    [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)],
    [f[0], 0, f[1]],
    [
      [uvr[0], uvr[3]],
      [uvr[2], uvr[3]],
      [uvr[2], uvr[1]],
      [uvr[0], uvr[1]],
    ],
    mat,
  );
}

/**
 * Japanese horizontal signal on its pole: grey head with three dark lenses
 * (the lit one glows), a 30 cm visor over each and a black backplate
 * 14 cm proud all round; the intersection-name plate above it; the
 * junction luminaire arm at SIGNAL_LUM.h toward the box centre with its
 * head(s) `lums` (signalLums; shared pole);
 * one or two regulatory plates on the column; optionally the controller
 * cabinet.
 */
function signal(
  m: CMesh,
  p: Vec3,
  armDir: Vec2,
  reach: number,
  phase: number,
  group: number,
  name: number,
  lums: [Vec3, Vec2, number, boolean][],
) {
  const grey = packMat(CM.paint, 0x90);
  // Column: the shader's pole paint (streaks, foot dirt, sticker scraps
  // by cylinder uv, y metres up from the sunk foot).
  const column = packMat(CM.paint, POLE_PAINT);
  m.cylinder(
    [p[0], p[1] - SINK, p[2]],
    0.12,
    SIGNAL_LUM.h + 0.25 + SINK,
    12,
    column,
    false,
  );
  // Footing, flange and handhole on the side away from the road; clamp
  // bands where the pedestrian head and push button are strapped on.
  poleFoot(
    m,
    p,
    0.12,
    column,
    grey,
    12,
    [-armDir[0], -armDir[1]],
    [2.45, 3.15],
    true,
  );
  const top: Vec3 = [p[0], p[1] + 5.8, p[2]];
  const end: Vec3 = [
    p[0] + armDir[0] * reach,
    p[1] + 5.8,
    p[2] + armDir[1] * reach,
  ];
  m.beam(top, end, 0.06, 0.06, grey);
  // Arm-joint collars: the mast arm's clamp sleeve, and the luminaire
  // arm's at the column top (capping it).
  m.cylinder([p[0], p[1] + 5.6, p[2]], 0.17, 0.38, 10, grey, false);
  m.cylinder(
    [p[0], p[1] + SIGNAL_LUM.h - 0.18, p[2]],
    0.16,
    0.45,
    10,
    grey,
    true,
  );
  // Head faces back toward oncoming traffic (perpendicular to the arm).
  const face: Vec2 = [armDir[1], -armDir[0]];
  const fyaw = Math.atan2(face[0], face[1]);
  const hc: Vec3 = [
    end[0] - armDir[0] * 0.7,
    end[1] - 0.12,
    end[2] - armDir[1] * 0.7,
  ];
  m.box(hc, [0.62, 0.2, 0.12], grey, fyaw);
  // Backplate: a matt black board 14 cm proud of the head all round (so
  // the head reads as a dark slab with three lenses at eye distance, and
  // against the sky), just behind its face; a 4 cm white retroreflective
  // border round it (SIGNAL_BORDER: the board behind, 4 cm larger).
  m.box(
    [hc[0] - face[0] * 0.04, hc[1], hc[2] - face[1] * 0.04],
    [0.76, 0.34, 0.02],
    packMat(CM.paint, 0x91),
    fyaw,
  );
  m.box(
    [hc[0] - face[0] * 0.05, hc[1], hc[2] - face[1] * 0.05],
    [0.8, 0.38, 0.012],
    packMat(CM.paint, SIGNAL_BORDER),
    fyaw,
    0,
    true,
    true,
  );
  for (let k = 0; k < 3; k++) {
    const off = (k - 1) * 0.4;
    const lp: Vec3 = [
      hc[0] - armDir[0] * off + face[0] * 0.125,
      hc[1],
      hc[2] - armDir[1] * off + face[1] * 0.125,
    ];
    // Lamp 0 green/blue, 1 yellow, 2 red: dark glass unless lit.
    disc(
      m,
      lp,
      face,
      0.15,
      10,
      packMat(CM.signal, signalParam(k, group, phase)),
    );
    // Tubular visor over the top of each lamp, 30 cm deep (it reads as a
    // peak over each lens from the kerb).
    hood(m, lp, face, 0.18, 0.18, 0.3, grey, true);
  }
  // Louvred back: slats behind the backing frame, angled down (they shed
  // the sun and rain and read as ribs from behind).
  for (let k = 0; k < 5; k++) {
    const y = hc[1] - 0.17 + k * 0.085;
    const b0 = 0.115;
    const P = (u: number, dy: number, back: number): Vec3 => [
      hc[0] - armDir[0] * u - face[0] * back,
      y + dy,
      hc[2] - armDir[1] * u - face[1] * back,
    ];
    m.quad(
      [
        P(-0.6, -0.03, b0 + 0.035),
        P(0.6, -0.03, b0 + 0.035),
        P(0.6, 0.03, b0),
        P(-0.6, 0.03, b0),
      ],
      [-face[0] * 0.7, 0.7, -face[1] * 0.7],
      [
        [0, 0],
        [1.2, 0],
        [1.2, 0.07],
        [0, 0.07],
      ],
      packMat(CM.paint, 0x91),
    );
  }
  // Intersection-name plate on the arm, 0.3 m above the head.
  signBoard(
    m,
    [hc[0], hc[1] + 0.2 + 0.3 + 0.14, hc[2]],
    face,
    0.5,
    0.14,
    0.015,
    packMat(CM.roadSign, 24 + (name & 7)),
    packMat(CM.roadSign, (24 + (name & 7)) | 0x100),
  );
  // Junction luminaires (shared pole): the arm toward the box centre and a
  // flat LED head at each of its heads (signalLums).
  const lt: Vec3 = [p[0], p[1] + SIGNAL_LUM.h, p[2]];
  m.beam(lt, lums[lums.length - 1][0], 0.05, 0.05, grey);
  for (const [h, dir] of lums) {
    m.box(
      [h[0], h[1] - 0.1, h[2]],
      [0.35, 0.06, 0.15],
      packMat(CM.lamp, 1),
      Math.atan2(dir[1], -dir[0]),
    );
  }
  // Regulatory plates strapped to the column, facing the approach like
  // the head: a 0.6 m disc at 3.75 m (designated direction, no parking or
  // no entry), on half the poles the pedestrian-crossing square above it.
  const rh = hash2(name * 4 + Math.round(p[0] * 4), Math.round(p[2] * 4));
  const kind = [3, 3, 2, 5][rh & 3];
  const pc: Vec3 = [p[0] + face[0] * 0.17, p[1] + 3.75, p[2] + face[1] * 0.17];
  disc(m, pc, face, 0.3, 12, packMat(CM.roadSign, kind));
  disc(
    m,
    [pc[0] - face[0] * 0.012, pc[1], pc[2] - face[1] * 0.012],
    [-face[0], -face[1]],
    0.3,
    12,
    packMat(CM.roadSign, kind | 0x100),
  );
  const square = (rh >>> 2) & 1;
  for (const dy of square ? [-0.15, 0.15, 0.57, 0.87] : [-0.15, 0.15])
    m.tube(
      [
        [p[0], pc[1] + dy, p[2]],
        [pc[0] - face[0] * 0.015, pc[1] + dy, pc[2] - face[1] * 0.015],
      ],
      0.02,
      grey,
    );
  if (square)
    signBoard(
      m,
      [pc[0], pc[1] + 0.72, pc[2]],
      face,
      0.3,
      0.3,
      0.01,
      packMat(CM.roadSign, 4),
      packMat(CM.roadSign, 4 | 0x100),
    );
}

/**
 * Overhead guide sign (案内標識) on an F-type pole at `p`: column, arm at
 * 7.2 m reaching `reach` toward the road (`inward`), a panel of half size
 * hw x hh (bottom at 5 m, centred `at` metres out) facing traffic `f`. The
 * face is guide face `face` of the sign atlas (signs.ts GUIDE_FACES: an
 * M_SIGN billboard cell, a quarter of it by uv); the back and edges are
 * `CM.roadSign` 16 | 0x100 (galvanised grey). LOD1 keeps panel and column.
 */
function guideSign(
  m: CMesh,
  p: Vec3,
  inward: Vec2,
  f: Vec2,
  reach: number,
  at: number,
  face: number,
  lod: number,
  hw = 2.2,
  hh = 1.1,
) {
  const grey = packMat(CM.paint, 0x90);
  m.cylinder(
    [p[0], p[1] - SINK, p[2]],
    0.18,
    7.6 + SINK,
    lod === 0 ? 8 : 4,
    packMat(CM.paint, POLE_PAINT),
    lod === 0,
  );
  const pc: Vec3 = [
    p[0] + inward[0] * at,
    p[1] + 5 + hh,
    p[2] + inward[1] * at,
  ];
  const gf = guideFace(face);
  // signBoard's u runs from the reader's right to left: mirror the rect.
  const uv: [number, number, number, number] = [
    gf.uv[2],
    gf.uv[1],
    gf.uv[0],
    gf.uv[3],
  ];
  const front = packMat(CM.sign, gf.id);
  const back = packMat(CM.roadSign, 16 | 0x100);
  if (lod !== 0) {
    // Far: just the two faces (18 vertices with the column).
    signBoardFace(
      m,
      [pc[0] + f[0] * 0.04, pc[1], pc[2] + f[1] * 0.04],
      f,
      hw,
      hh,
      front,
      uv,
    );
    signBoardFace(
      m,
      [pc[0] - f[0] * 0.04, pc[1], pc[2] - f[1] * 0.04],
      [-f[0], -f[1]],
      hw,
      hh,
      back,
    );
    return;
  }
  signBoard(m, pc, f, hw, hh, 0.04, front, back, uv);
  // Back (what the sign shows from the junction, round 3's blank slab):
  // five horizontal stiffener ribs 10 cm deep across the panel and two
  // vertical hanger channels over them up to the arm, in grey paint
  // against the galvanised back so the ribs and their shadows read.
  const rib = packMat(CM.paint, 0x90);
  const B = (u: number, y: number, d: number): Vec3 => [
    pc[0] + inward[0] * u - f[0] * d,
    pc[1] + y,
    pc[2] + inward[1] * u - f[1] * d,
  ];
  for (let k = 0; k < 5; k++) {
    const y = (-0.8 + k * 0.4) * hh;
    m.beam(B(-(hw - 0.06), y, 0.09), B(hw - 0.06, y, 0.09), 0.05, 0.035, rib);
  }
  for (const u of [-0.55, 0.55])
    m.beam(
      B(u * hw, -hh + 0.05, 0.17),
      B(u * hw, 7.3 - 5 - hh, 0.17),
      0.05,
      0.05,
      rib,
    );
  const behind = 0.08;
  for (const y of [7.2, 6.9]) {
    m.beam(
      [p[0] - f[0] * behind, p[1] + y, p[2] - f[1] * behind],
      [
        p[0] + inward[0] * reach - f[0] * behind,
        p[1] + y,
        p[2] + inward[1] * reach - f[1] * behind,
      ],
      0.06,
      0.06,
      grey,
    );
  }
}

/**
 * Regulatory sign post at p facing f: a disc (kind 0-3, 5) at 2.3-2.8 m,
 * optionally a 0.6 m pedestrian-crossing square (kind 4) above it.
 */
function regSign(
  m: CMesh,
  p: Vec3,
  f: Vec2,
  kind: number,
  square: boolean,
  h: number,
) {
  const top = h + (square ? 0.75 : 0.32);
  m.cylinder(
    [p[0], p[1] - SINK, p[2]],
    0.03,
    top + SINK,
    5,
    packMat(CM.paint, POLE_PAINT),
    true,
  );
  const c: Vec3 = [p[0] + f[0] * 0.04, p[1] + h, p[2] + f[1] * 0.04];
  disc(m, c, f, 0.3, 12, packMat(CM.roadSign, kind));
  disc(
    m,
    [c[0] - f[0] * 0.02, c[1], c[2] - f[1] * 0.02],
    [-f[0], -f[1]],
    0.3,
    12,
    packMat(CM.roadSign, kind | 0x100),
  );
  if (square)
    signBoard(
      m,
      [c[0], c[1] + 0.68, c[2]],
      f,
      0.3,
      0.3,
      0.01,
      packMat(CM.roadSign, 4),
      packMat(CM.roadSign, 4 | 0x100),
    );
}

/** Planter (outer width) and the kerb's top width, height above the paving. */
const PLANTER = {w: 0.9, kerb: 0.09, h: 0.18} as const;
/** Clipped hedge top above the paving. */
const HEDGE_H = 0.95;

/** Smooth 1D value noise in 0..1 (cubic fade between integer hashes). */
function vnoise1(x: number, seed: number) {
  const i = Math.floor(x);
  const f = x - i;
  const a = (hash2(seed, i) & 0xffff) / 0xffff;
  const b = (hash2(seed, i + 1) & 0xffff) / 0xffff;
  return a + (b - a) * f * f * (3 - 2 * f);
}

/**
 * Planting-strip hedge run along `pts` (paving-level points on the planter's
 * road-side face) with `out` (unit 2D normal toward the back per point).
 *
 * LOD0: a precast concrete planter kerb (`CM.curb` param 1: uv x metres
 * along, y metres up/across) and a lumpy clipped leaf mass (`CM.hedge` 0):
 * a 6-point rounded profile per sample whose points are pushed in and out
 * along their normals by a hash (lumps every sample, 2.6 m), overhanging
 * the kerb top, with leaf cards (the tree leaf path, `CM.leaves`) on the
 * shoulders (3 per side per sample), standing proud of each outer face
 * (2) and round the run ends for a broken, lighter-tipped outline. Hedge uv: x metres along,
 * y metres up from the planter soil (the shader's AO darkens toward 0).
 *
 * LOD1: one smooth 4-point green strip (no kerb, no cards).
 */
function hedgeRun(
  m: CMesh,
  pts: Vec3[],
  out: Vec2[],
  seed: number,
  lod: number,
) {
  if (pts.length < 2) return;
  const mat = packMat(CM.hedge, 0);
  const kerb = packMat(CM.curb, 1);
  const W = PLANTER.w;
  const K = PLANTER.kerb;
  const KH = PLANTER.h;
  const along: number[] = [0];
  for (let i = 1; i < pts.length; i++)
    along.push(
      along[i - 1] +
        Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]),
    );
  // Point at (x back from the front face, y up from the paving) of sample i.
  const P = (i: number, x: number, y: number): Vec3 => [
    pts[i][0] + out[i][0] * x,
    pts[i][1] + y,
    pts[i][2] + out[i][1] * x,
  ];
  const N = (i: number, x: number, y: number): Vec3 => {
    const l = Math.hypot(x, y) || 1;
    return [(out[i][0] * x) / l, y / l, (out[i][1] * x) / l];
  };
  // Quads between consecutive samples' profiles; face normals from the 2D
  // profile segment (outward = (-dy, dx) * sign).
  const strip = (rows: number[][], prof: number[][], sign = 1) => {
    for (let i = 0; i + 1 < rows.length; i++) {
      const a = rows[i];
      const c = rows[i + 1];
      for (let j = 0; j + 1 < a.length; j++) {
        const dx = prof[j + 1][0] - prof[j][0];
        const dy = prof[j + 1][1] - prof[j][1];
        const n = N(i, -dy * sign, dx * sign);
        m.triFacing(a[j], c[j], c[j + 1], n);
        m.triFacing(a[j], c[j + 1], a[j + 1], n);
      }
    }
  };
  if (lod !== 0) {
    const prof: [number, number, number, number][] = [
      [0, -0.05, -1, 0],
      [0.05, HEDGE_H, -0.6, 0.8],
      [W - 0.05, HEDGE_H, 0.6, 0.8],
      [W, -0.05, 1, 0],
    ];
    const rows = pts.map((_, i) =>
      prof.map(([x, y, nx, ny], k) =>
        m.vertex(
          P(i, x, y),
          N(i, nx, ny),
          along[i],
          k === 0 || k === 3 ? 0 : HEDGE_H,
          mat,
        ),
      ),
    );
    strip(rows, prof);
    return;
  }
  // Planter kerbs, front (x 0..K) and back (W-K..W): outer foot, outer top
  // (rounded arris), inner top.
  for (const back of [false, true]) {
    const s = back ? -1 : 1;
    const x0 = back ? W : 0;
    const kp = [
      [x0, -0.06],
      [x0, KH],
      [x0 + s * K, KH],
    ];
    const rows = pts.map((_, i) => [
      m.vertex(P(i, x0, -0.06), N(i, -s, 0), along[i], 0, kerb),
      m.vertex(P(i, x0, KH), N(i, -s, 1), along[i], KH + 0.06, kerb),
      m.vertex(P(i, x0 + s * K, KH), [0, 1, 0], along[i], KH + 0.06 + K, kerb),
    ]);
    strip(rows, kp, s);
  }
  // Leaf mass: base tucked over the kerb tops, sides bulging past them.
  const prof: [number, number, number, number][] = [
    [K * 0.6, KH - 0.01, -1, -0.4],
    [-0.04, 0.5, -1, 0.1],
    [0.14, HEDGE_H, -0.55, 0.85],
    [W - 0.14, HEDGE_H, 0.55, 0.85],
    [W + 0.04, 0.5, 1, 0.1],
    [W - K * 0.6, KH - 0.01, 1, -0.4],
  ];
  const rows = pts.map((_, i) =>
    prof.map(([x, y, nx, ny], k) => {
      // Low-frequency swell (+-12-15 cm, 3-5 m bulges, each side and the top
      // on its own noise) plus a little per-sample lumpiness, pushed along
      // the normal; the base stays tucked on the kerb.
      const hv = hash2(seed + i * 7, k);
      const side = k < 3 ? 0 : 1;
      const swell = vnoise1(along[i] / 3.6 + side * 17.3, seed) * 2 - 1;
      const amp = k === 0 || k === 5 ? 0.015 : k === 1 || k === 4 ? 0.15 : 0.12;
      const d =
        swell * amp + ((hv & 0xff) / 255 - 0.4) * 2 * (k % 5 ? 0.035 : 0.01);
      const l = Math.hypot(nx, ny);
      const lift =
        k === 2 || k === 3
          ? (vnoise1(along[i] / 4.4 + 41.7, seed) * 2 - 1) * 0.15 +
            (((hv >>> 8) & 0xff) / 255 - 0.5) * 0.06
          : 0;
      return m.vertex(
        P(i, x + (nx / l) * d, y + (ny / l) * d + lift),
        N(i, nx, ny),
        along[i],
        y - KH,
        mat,
      );
    }),
  );
  strip(rows, prof);
  // End caps: the profile fanned from its centre; the kerb end returns.
  for (const i of [0, pts.length - 1]) {
    const j = i === 0 ? 1 : pts.length - 2;
    const dx = pts[i][0] - pts[j][0];
    const dz = pts[i][2] - pts[j][2];
    const dl = Math.hypot(dx, dz) || 1;
    const n: Vec3 = [dx / dl, 0, dz / dl];
    const ring = rows[i].map(v => m.pos(v));
    const ids = ring.map(q =>
      m.vertex(q, n, q[0] * n[2] - q[2] * n[0], q[1] - pts[i][1], mat),
    );
    const c = P(i, W / 2, KH + 0.3);
    const cv = m.vertex(c, n, 0, 0.3, mat);
    for (let k = 0; k + 1 < ids.length; k++)
      m.triFacing(cv, ids[k], ids[k + 1], n);
    m.triFacing(cv, ids[ids.length - 1], ids[0], n);
    // Kerb across the end: outer face and top.
    const e = (x: number, y: number, o: number): Vec3 => {
      const q = P(i, x, y);
      return [q[0] + n[0] * o, q[1], q[2] + n[2] * o];
    };
    m.quad(
      [e(0, -0.06, 0), e(W, -0.06, 0), e(W, KH, 0), e(0, KH, 0)],
      n,
      [
        [0, 0],
        [W, 0],
        [W, KH + 0.06],
        [0, KH + 0.06],
      ],
      kerb,
    );
    m.quad(
      [e(0, KH, 0), e(W, KH, 0), e(W, KH, -K), e(0, KH, -K)],
      [0, 1, 0],
      [
        [0, KH + 0.06],
        [W, KH + 0.06],
        [W, KH + 0.06 + K],
        [0, KH + 0.06 + K],
      ],
      kerb,
    );
  }
  // Leaf-card shell (the tree leaf path, CM.leaves), lighter than the
  // clipped mass (new growth at the tips): per segment two fringe tufts on
  // each top shoulder, tilted up and out and half past the hull so the
  // edges break into leaves against the sky and the walk, and one on a
  // side every other segment. Placed on the swollen hull.
  const leaf = packMat(CM.leaves, 0);
  const card = (
    c: Vec3,
    ax: Vec3,
    ay: Vec3,
    n: Vec3,
    hw: number,
    hh: number,
  ) => {
    const ids = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([u, v]) =>
      m.vertex(
        [
          c[0] + ax[0] * u * hw + ay[0] * v * hh,
          c[1] + ax[1] * u * hw + ay[1] * v * hh,
          c[2] + ax[2] * u * hw + ay[2] * v * hh,
        ],
        n,
        (u + 1) / 2,
        (1 - v) / 2,
        leaf,
        seed,
      ),
    );
    // Double-sided, as the tree cards.
    m.tri(ids[0], ids[1], ids[2]);
    m.tri(ids[0], ids[2], ids[3]);
    m.tri(ids[0], ids[2], ids[1]);
    m.tri(ids[0], ids[3], ids[2]);
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const hv = hash2(seed ^ 0x1eaf, i);
    const fr = (b: number) => ((hv >>> b) & 0xff) / 255;
    const dx = pts[i + 1][0] - pts[i][0];
    const dz = pts[i + 1][2] - pts[i][2];
    const dl = Math.hypot(dx, dz) || 1;
    const ax: Vec3 = [dx / dl, 0, dz / dl];
    const o = out[i];
    /** Hull profile point k at fraction t of this segment. */
    const hull = (k: number, t: number): Vec3 => {
      const a = m.pos(rows[i][k]);
      const b = m.pos(rows[i + 1][k]);
      return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    };
    const rnd = (n: number) => (hash2(hv, n) & 0xffff) / 0xffff;
    /** A card at c leaning `lean` out over side s, yawed off the run. */
    const tuft = (
      c: Vec3,
      s: number,
      yaw: number,
      up: number,
      out: number,
      hw: number,
      hh: number,
      ny: number,
    ) => {
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const bx: Vec3 = [ax[0] * cy + o[0] * sy, 0, ax[2] * cy + o[1] * sy];
      const bo: Vec2 = [-ax[0] * sy + o[0] * cy, -ax[2] * sy + o[1] * cy];
      const ay: Vec3 = [bo[0] * s * out, up, bo[1] * s * out];
      const al = Math.hypot(ay[0], ay[1], ay[2]) || 1;
      const nl = Math.hypot(0.6, ny);
      card(
        c,
        bx,
        [ay[0] / al, ay[1] / al, ay[2] / al],
        [(o[0] * s * 0.6) / nl, ny / nl, (o[1] * s * 0.6) / nl],
        hw,
        hh,
      );
    };
    for (const [k, s] of [
      [2, -1],
      [3, 1],
    ] as const) {
      // Top edge: three tufts per shoulder, standing up and leaning out
      // past the hull, yawed 25-60 degrees off the run (so a view along
      // the hedge does not see them edge-on): the top outline breaks into
      // leaves against the sky and the walk instead of a chamfered box.
      for (let j = 0; j < 3; j++) {
        const t = (j + 0.15 + rnd(k * 16 + j) * 0.7) / 3;
        const c = hull(k, t);
        tuft(
          [
            c[0] + o[0] * s * 0.07,
            c[1] + 0.06 + rnd(k * 16 + j + 4) * 0.06,
            c[2] + o[1] * s * 0.07,
          ],
          s,
          (j & 1 ? 1 : -1) * (0.45 + rnd(k * 16 + j + 8) * 0.6),
          0.87,
          0.5,
          0.3 + rnd(k * 16 + j + 12) * 0.12,
          0.24,
          0.85,
        );
      }
      // Outer faces: two near-upright sprays per side standing just
      // proud of the clipped face (5-9 cm), yawed 12-35 degrees off it, so
      // the face is not a smooth slab and its outline breaks along the run.
      // (Round 5's planter-rim sprays leaned out over the kerb: their thin
      // shadows striped the planter wall at low sun.)
      const mid = k === 2 ? 1 : 4;
      for (let j = 0; j < 2; j++) {
        const t = (j + 0.15 + rnd(k * 16 + j + 40) * 0.7) / 2;
        const c = hull(mid, t);
        const po = 0.05 + rnd(k * 16 + j + 52) * 0.04;
        tuft(
          [
            c[0] + o[0] * s * po,
            c[1] - 0.04 + rnd(k * 16 + j + 56) * 0.14,
            c[2] + o[1] * s * po,
          ],
          s,
          (j & 1 ? 1 : -1) * (0.2 + rnd(k * 16 + j + 44) * 0.4),
          0.95,
          0.25,
          0.36 + rnd(k * 16 + j + 48) * 0.1,
          0.26,
          0.3,
        );
      }
    }
    // One on a side every other segment, alternating sides.
    const side = hv & 1 ? 1 : -1;
    if (!(i & 1)) {
      const c = hull(side > 0 ? 4 : 1, 0.3 + fr(20) * 0.4);
      card(
        [c[0] + o[0] * side * 0.04, c[1] - 0.05, c[2] + o[1] * side * 0.04],
        ax,
        [0, 1, 0],
        [o[0] * side, 0.2, o[1] * side],
        0.42,
        0.3,
      );
    }
  }
  // Run ends (the flat cap read as a cut box at a gap): a spray over the
  // cap face and tufts on its two top corners and the top middle, leaning
  // out past the cap.
  for (const i of [0, pts.length - 1]) {
    const j = i === 0 ? 1 : pts.length - 2;
    const dx = pts[i][0] - pts[j][0];
    const dz = pts[i][2] - pts[j][2];
    const dl = Math.hypot(dx, dz) || 1;
    const n: Vec3 = [dx / dl, 0, dz / dl];
    const across: Vec3 = [out[i][0], 0, out[i][1]];
    const at = (q: Vec3, d: number, up: number): Vec3 => [
      q[0] + n[0] * d,
      q[1] + up,
      q[2] + n[2] * d,
    ];
    const lean: Vec3 = [n[0] * 0.5, 0.87, n[2] * 0.5];
    const nu: Vec3 = [n[0] * 0.6, 0.8, n[2] * 0.6];
    card(at(P(i, W / 2, 0.55), 0.07, 0), across, [0, 1, 0], n, 0.44, 0.3);
    for (const k of [2, 3]) {
      const q = m.pos(rows[i][k]);
      card(at(q, 0.05, 0.05), across, lean, nu, 0.3, 0.24);
    }
    card(at(P(i, W / 2, HEDGE_H), 0.04, 0.08), across, lean, nu, 0.34, 0.24);
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

/** A street face (footprint edge a -> c, normal n); drops land at y. */
interface Front {
  a: Vec2;
  c: Vec2;
  n: Vec3;
  y: number;
}

/**
 * Service drops from a utility pole at `p` to the nearest street face
 * within reach: a pair of sagging lines from under the crossarm to
 * a hook bracket on the facade, near its corner (Tokyo's overhead
 * electricity and telephone service).
 */
function serviceDrops(m: CMesh, p: Vec3, fronts: Front[]) {
  let best: {q: Vec3; d: number; f: Front} | null = null;
  for (const f of fronts) {
    const dx = f.c[0] - f.a[0],
      dz = f.c[1] - f.a[1];
    const l2 = dx * dx + dz * dz;
    if (l2 < 4) continue;
    const l = Math.sqrt(l2);
    // On the corner pier nearer the pole.
    const t0 = ((p[0] - f.a[0]) * dx + (p[2] - f.a[1]) * dz) / l2;
    const t = t0 < 0.5 ? 0.35 / l : 1 - 0.35 / l;
    const q: Vec3 = [
      f.a[0] + dx * t + f.n[0] * 0.08,
      f.y,
      f.a[1] + dz * t + f.n[2] * 0.08,
    ];
    // The pole must stand in front of the face.
    const side = (p[0] - q[0]) * f.n[0] + (p[2] - q[2]) * f.n[2];
    const d = Math.hypot(p[0] - q[0], p[2] - q[2]);
    if (side > 1 && d < 14 && (!best || d < best.d)) best = {q, d, f};
  }
  if (!best) return;
  const {q, f} = best;
  m.box(
    q,
    [0.06, 0.06, 0.08],
    packMat(CM.paint, 0x90),
    Math.atan2(f.n[0], f.n[2]),
  );
  for (const [dy, dq] of [
    [7.6, 0.03],
    [7.4, -0.03],
  ])
    wireSag(
      m,
      [p[0], p[1] + dy, p[2]],
      [q[0] + f.n[2] * dq, q[1] + 0.04 - Math.abs(dq), q[2] - f.n[0] * dq],
      0.35,
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

/** Buildings by NB_CELL cell (bounding boxes), for neighbour lookups. */
const NB_CELL = 16;
const nbGrids = new WeakMap<CityLayout, Map<number, number[]>>();
function neighbourGrid(L: CityLayout) {
  let g = nbGrids.get(L);
  if (g) return g;
  g = new Map();
  L.buildings.forEach((b, i) => {
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const q of b.footprint) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      z0 = Math.min(z0, q[1]);
      z1 = Math.max(z1, q[1]);
    }
    for (let x = Math.floor(x0 / NB_CELL); x <= Math.floor(x1 / NB_CELL); x++)
      for (
        let z = Math.floor(z0 / NB_CELL);
        z <= Math.floor(z1 / NB_CELL);
        z++
      ) {
        const k = x * 65536 + z;
        const l = g!.get(k);
        if (l) l.push(i);
        else g!.set(k, [i]);
      }
  });
  nbGrids.set(L, g);
  return g;
}

/**
 * How high each footprint edge of building `bi` is hidden by neighbours
 * standing against it (absolute y; -Infinity where any of it is open):
 * samples `off` metres in front of the edge at fractions `ts`, each
 * covered to the top of the building it falls in, the edge to the lowest
 * of them. 1 m out: a gap too narrow to see into, where service kit would
 * never be seen (or would stick into the neighbour); 0.3 m out, sampled
 * to the corners: walls flush against a neighbour, not drawn at all.
 */
function edgeCover(
  L: CityLayout,
  bi: number,
  off = 1.0,
  ts = [0.15, 0.5, 0.85],
): number[] {
  const b = L.buildings[bi];
  const fp = b.footprint;
  const g = neighbourGrid(L);
  return fp.map((a, i) => {
    const c = fp[(i + 1) % fp.length];
    const n = edgeNormal(fp, i);
    let cover = Infinity;
    for (const t of ts) {
      const q: Vec2 = [
        lerp(a[0], c[0], t) + n[0] * off,
        lerp(a[1], c[1], t) + n[2] * off,
      ];
      const k = Math.floor(q[0] / NB_CELL) * 65536 + Math.floor(q[1] / NB_CELL);
      let top = -Infinity;
      for (const j of g.get(k) ?? []) {
        const o = L.buildings[j];
        if (j !== bi && pointInPolygon(q, o.footprint))
          top = Math.max(top, o.base + o.height);
      }
      cover = Math.min(cover, top);
      if (cover === -Infinity) break;
    }
    return cover;
  });
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

/**
 * Utility poles and wire spans under a viaduct or expressway: true when the
 * line a -> b (ground points) keeps `h` metres of headroom under every deck
 * it passes, sampled every 2 m. Spans that would run into a deck are left
 * out (the poles either side become dead ends) instead of ending mid-air at
 * the fascia.
 */
function clearOfDecks(ctx: TileContext, a: Vec3, b: Vec3, h: number) {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 2));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const y = lerp(a[1], b[1], t);
    if (deckClearance(ctx, lerp(a[0], b[0], t), lerp(a[2], b[2], t), y) < h)
      return false;
  }
  return true;
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

const chainEnds = new WeakMap<CityLayout, Map<number, number>>();
/** Junction at a chain's end (-1 if none). */
function guideJunction(L: CityLayout, ci: number, end: 0 | 1) {
  let g = chainEnds.get(L);
  if (!g) {
    g = new Map();
    L.junctions.forEach((j, ji) =>
      j.arms.forEach(a => g!.set(a.chain * 2 + a.end, ji)),
    );
    chainEnds.set(L, g);
  }
  return g.get(ci * 2 + end) ?? -1;
}

/**
 * Paving height `u` metres in from the kerb of chain point `q` on side `l`
 * (unit 2D, away from the road): the curb band (gen-base blocks()) runs
 * from the kerb top (road + 0.17) to the graded ground at its inner edge
 * (band width min(SIDEWALK, 2.5)); beyond it the plaza follows the ground.
 * sidewalkY() alone (ground + 0.16) buries props in the band where the
 * road stands above the ground.
 */
function bandY(
  hf: Heightfield,
  q: {p: Vec2; h: number},
  l: Vec2,
  kind: number,
  u: number,
) {
  const half = ROAD_WIDTH[kind] / 2;
  const bw = Math.min(SIDEWALK[kind], 2.5);
  const at = (d: number) =>
    hf.sample(q.p[0] + l[0] * (half + d), q.p[1] + l[1] * (half + d)) + 0.16;
  if (u >= bw)
    return sidewalkY(
      hf,
      q.p[0] + l[0] * (half + u),
      q.p[1] + l[1] * (half + u),
      q.h,
    );
  let top = q.h + 0.02 + 0.15;
  const g0 = at(0);
  if (Math.abs(top - g0) > 0.6) top = g0;
  return lerp(top, at(bw), u / bw);
}

/**
 * Planting-strip hedges along avenues and arterials, both sides, both LODs
 * (hedgeRun): the planter's road-side face 0.38 m behind the kerb (behind
 * the fence), sampled every 2.6 m (LOD0) or 26 m (LOD1); gaps at bus
 * stops, a 2 m driveway gap every 35-50 m, none within 8 m of a junction
 * mouth. Runs belong to the tile of their samples' start points.
 */
function hedges(
  ctx: TileContext,
  tile: number,
  m: CMesh,
  land: ReturnType<typeof landing>,
  inTile: (x: number, z: number) => boolean,
  lod: number,
) {
  const L = ctx.layout;
  const hf = L.terrain.heights;
  const step = lod === 0 ? 2.6 : 26;
  for (const ci of ctx.tileChains[tile] ?? []) {
    const c = L.chains[ci];
    if (c.kind < Road.avenue || c.bridge.some(b => b)) continue;
    const arc = ctx.geom.arc[ci];
    const total = arc[arc.length - 1];
    const [s0, s1] = ctx.geom.setbacks[ci];
    const W = ROAD_WIDTH[c.kind];
    for (const side of [-1, 1]) {
      // Bus stops (as buildTile places them).
      const stops: number[] = [];
      for (
        let s = s0 + 40 + (hash2(ci, side) % 120);
        s < total - s1 - 20;
        s += 300
      ) {
        const q = chainAt(c, arc, s);
        const o = (W / 2 + SIDEWALK[c.kind] * 0.6) * side;
        if (land.ok(q.p[0] - q.d[1] * o, q.p[1] + q.d[0] * o, ci))
          stops.push(s);
      }
      const ho = W / 2 + 0.38;
      let gapAt = s0 + 8 + 35 + (hash2(ci * 2 + side, 0x4ed) % 16);
      let run: {p: Vec3; o: Vec2; mine: boolean}[] = [];
      const flush = () => {
        let k = 0;
        while (k < run.length - 1) {
          if (!run[k].mine) {
            k++;
            continue;
          }
          let e = k;
          while (e < run.length - 1 && run[e].mine) e++;
          hedgeRun(
            m,
            run.slice(k, e + 1).map(r => r.p),
            run.slice(k, e + 1).map(r => r.o),
            hash2(ci * 2 + side, Math.round(run[k].p[0] * 4)),
            lod,
          );
          k = e;
        }
        run = [];
      };
      for (let s = s0 + 8; s <= total - s1 - 8; s += step) {
        if (s > gapAt) {
          // Stop the run just short of the gap and resume 2 m on.
          flush();
          s = gapAt + 2;
          gapAt += 35 + (hash2(ci * 2 + side, Math.floor(s)) % 16);
        }
        if (stops.some(b => Math.abs(b - s) < 4.8)) {
          flush();
          continue;
        }
        const q = chainAt(c, arc, s);
        const l: Vec2 = [-q.d[1] * side, q.d[0] * side];
        const x = q.p[0] + l[0] * ho;
        const z = q.p[1] + l[1] * ho;
        const bx = x + l[0] * PLANTER.w;
        const bz = z + l[1] * PLANTER.w;
        if (!land.ok(x, z, ci) || !land.ok(bx, bz, ci)) {
          flush();
          continue;
        }
        run.push({
          p: [x, bandY(hf, q, l, c.kind, 0.38), z],
          o: l,
          mine: inTile(x, z),
        });
      }
      flush();
    }
  }
}

/**
 * Small utility covers set in the sidewalk (NTT, water, gas, duct): the
 * lid's own material, CM.hedge param 2 (round 4 borrowed the tree grate,
 * param 1, at uv 1.1..1.6). Contract for the shader (hedgeMat param 2):
 * - uv 0..1 over the lid: u along the road, v across it from the kerb
 *   side; round lids map their bounding square (the lid is the disc
 *   |uv - 0.5| <= 0.5). The lid's size in metres is the uv's world-space
 *   derivative.
 * - aux high 16 bits: bits 0-1 kind (0 NTT telecom, 1 water meter /
 *   valve, 2 gas valve, 3 common-duct hatch), bit 2 round, bits 3-15 a
 *   hash for the casting pattern, stencil glyph and wear.
 * - Sizes (along x across, metres): NTT 0.6 x 0.6 or 0.8 x 0.5; water
 *   round 0.4 or 0.4 x 0.25; gas round 0.26-0.3; duct 0.9 x 0.6.
 * - Intended look (judge round 4): cast iron, metal ~0.8, rough ~0.5, a
 *   tread / chequer normal, a rust and dirt ring at the edge, a stencilled
 *   glyph; wet in rain.
 * The lid sits 3 mm over the band's actual surface (bandSurfaceAt), no
 * sides and no separate frame: the shader draws the dark seating gap in
 * the lid's outer ~12 mm (and the frame ring inside it).
 */
const WALK_COVER_MAT = packMat(CM.hedge, 2);

/**
 * Small utility covers (square, oblong and round) in the sidewalk every
 * 10-20 m (both sides
 * of avenues and boulevards, one side of streets and lanes, picked per
 * cover), in the walk's free zone: in the kerb-side slab strip of streets
 * (between the kerb and the tactile line), between the tree pits on avenues
 * and boulevards, beyond the tactile line on lanes. Hash-placed (no tile
 * RNG draws); kept 9 m (avenues 5 m) from junction mouths, clear of tree
 * pits, 1 m from lamp poles and
 * utility poles, on sidewalk only (landing). LOD0 only, 4 vertices each
 * (round 11).
 */
function walkCovers(
  ctx: TileContext,
  m: CMesh,
  ci: number,
  land: ReturnType<typeof landing>,
  inTile: (x: number, z: number) => boolean,
  poles: Vec2[],
) {
  const L = ctx.layout;
  const hf = L.terrain.heights;
  const c = L.chains[ci];
  const arc = ctx.geom.arc[ci];
  const total = arc[arc.length - 1];
  const [s0, s1] = ctx.geom.setbacks[ci];
  const W = ROAD_WIDTH[c.kind];
  const SW = SIDEWALK[c.kind];
  // Lid centre's distance from the kerb (range) and the farthest its edge
  // may reach, per road kind: all inside the curb band (bandY is exact
  // there; the plaza beyond is a 14 m grid that wanders off the terrain).
  // Lanes: beyond the tactile line; streets: the slab strip by the kerb;
  // avenues and boulevards: between the tree pits, behind the tactile line.
  const zone: [number, number, number][] = [
    [1.05, 1.25, 1.5],
    [0.5, 0.8, 1.05],
    [2.05, 2.2, 2.42],
    [2.05, 2.2, 2.42],
  ];
  const upSide = hash2(ci, 3) % 2 ? 1 : -1;
  // Avenue trees (as the tile's tree loop places them), per side.
  const trees = new Map<number, number[]>();
  if (c.kind >= Road.avenue)
    for (const side of [-1, 1]) {
      const list: number[] = [];
      for (let t = s0 + 10; t < total - s1 - 8; t += 13)
        list.push(avenueTreeS(L, ctx.geom, ci, side, t));
      trees.set(side, list);
    }
  // Clear of the signal poles at the mouths (kerb side, up to 7 m back);
  // avenue covers stand behind them.
  const end = c.kind >= Road.avenue ? 5 : 9;
  let s = s0 + end + (hash2(ci, 0xc0e1) % 6);
  for (let k = 0; s < total - s1 - end; k++) {
    const h = hash2(ci * 64 + k, 0xc07e);
    const step = 10 + (h % 11);
    const sides = c.kind >= Road.avenue ? [-1, 1] : [(h >>> 4) & 1 ? 1 : -1];
    for (const side of sides) {
      const hs = hash2(h, side + 7);
      const ss = s + ((hs & 0xff) / 255 - 0.5) * 3;
      // Clear of the street's utility poles (kerb side, every 28 m).
      if (
        c.kind <= Road.street &&
        side === upSide &&
        Math.abs(((ss - s0 - 4) % 28) - 14) > 12.8
      )
        continue;
      // 3/7 NTT, 2/7 water, 1/7 gas, 1/7 duct hatch; half sizes along /
      // across the road (two shapes each for NTT and water; water and gas
      // valves round).
      const kind = [0, 0, 0, 1, 1, 2, 3][(hs >>> 8) % 7];
      const alt = (hs >>> 12) & 1;
      const round = kind === 2 || (kind === 1 && !alt);
      const gasR = 0.13 + ((hs >>> 13) & 3) * 0.006;
      const ha = [alt ? 0.4 : 0.3, 0.2, gasR, 0.45][kind];
      const [z0, z1, zMax] = zone[c.kind];
      const u = z0 + (((hs >>> 16) & 0xff) / 255) * (z1 - z0);
      const hc = Math.min(
        [alt ? 0.25 : 0.3, alt ? 0.125 : 0.2, gasR, 0.3][kind],
        zMax - u,
      );
      if (u + hc > SW - 0.15 || (round && hc < ha)) continue;
      // 1.6 m along from a tree (its 1.2 m pit and the cover's half).
      if ((trees.get(side) ?? []).some(t => Math.abs(t - ss) < 0.75 + ha))
        continue;
      const q = chainAt(c, arc, ss);
      const l: Vec2 = [-q.d[1] * side, q.d[0] * side];
      const x = q.p[0] + l[0] * (W / 2 + u);
      const z = q.p[1] + l[1] * (W / 2 + u);
      if (!inTile(x, z)) continue;
      const P = (a: number, b: number): Vec2 => [
        x + q.d[0] * a + l[0] * b,
        z + q.d[1] * a + l[1] * b,
      ];
      const corners = [P(-ha, -hc), P(ha, -hc), P(ha, hc), P(-ha, hc)];
      if (
        corners.some(p => !land.ok(p[0], p[1], ci)) ||
        poles.some(p => Math.hypot(p[0] - x, p[1] - z) < 1.0)
      )
        continue;
      // On the band mesh's own surface (exact), else the analytic band.
      const Y = (a: number, b: number, dy: number): Vec3 => {
        const p = P(a, b);
        const y =
          bandSurfaceAt(ctx.geom, p[0], p[1]) ?? bandY(hf, q, l, c.kind, u + b);
        return [p[0], y + dy, p[1]];
      };
      const aux =
        ((kind | (round ? 4 : 0) | ((hs >>> 18) << 3)) & 0xffff) << 16;
      // Outline (unit offsets, counter-clockwise from above): the lid's
      // corners or a 10-gon. No separate seating ring: the shader draws
      // the dark gap in the lid's outer ~12 mm (budget).
      const shape: Vec2[] = round
        ? Array.from({length: 10}, (_, i): Vec2 => [
            Math.cos((i / 10) * Math.PI * 2),
            Math.sin((i / 10) * Math.PI * 2),
          ])
        : [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ];
      const lid = shape.map(([a, b]) =>
        m.vertex(
          Y(a * ha, b * hc, 0.003),
          UP,
          (a + 1) / 2,
          (b + 1) / 2,
          WALK_COVER_MAT,
          aux,
        ),
      );
      if (round) {
        const cv = m.vertex(Y(0, 0, 0.003), UP, 0.5, 0.5, WALK_COVER_MAT, aux);
        for (let i = 0; i < lid.length; i++)
          m.triFacing(cv, lid[i], lid[(i + 1) % lid.length], UP);
      } else {
        m.triFacing(lid[0], lid[1], lid[2], UP);
        m.triFacing(lid[0], lid[2], lid[3], UP);
      }
    }
    s += step;
  }
}

/**
 * CM.paint param of the junction's signal controller cabinet (CABINET,
 * round 6): Tokyo's grey-green (paintColor's hashed fallback for 0xab is
 * 0.44 / 0.53 / 0.47). Box uv in metres per face; the front (+uv.x along
 * the 0.6 m width, uv.y up from the body's foot) faces the road. Intended
 * shading: door seam and hinge line 4 cm in from the edges, louvre band at
 * the top of the sides, a few sticker and flyer-scrape scraps on the
 * front, rain streaks down from the hood, foot splash.
 */
const CABINET = 0xab;
/**
 * walkCovers' aux flag (bit 0, low half; the cover kind / hash stay in the
 * high half): a steel gutter grate (グレーチング) in the carriageway along
 * the kerb, not a sidewalk lid. Until coverMat reads it the grate renders
 * as a common-duct hatch (kind 3).
 */
const GRATE = 1;

/**
 * Street-edge fixtures of signalized junction ji (round 6): the ground
 * controller cabinet (one per junction, 0.6 x 0.4 x 1.2 m on a 10 cm
 * plinth, behind one signal pole, facing the road; LOD1: the body box
 * only) and, LOD0, 3-5 bollards along each kerb return (the corner radius
 * the tile's walkers wait at), 0.4 m in from the kerb, clear of `poles`.
 * `spots`: the junction's signal poles (signalSpots: pole, arm direction
 * over the road, arm index).
 */
function junctionFixtures(
  ctx: TileContext,
  m: CMesh,
  ji: number,
  land: ReturnType<typeof landing>,
  spots: [Vec3, Vec2, number][],
  poles: Vec2[],
  lod: number,
) {
  const L = ctx.layout;
  const hf = L.terrain.heights;
  const j = L.junctions[ji];
  const jg = ctx.geom.junctions[ji];
  const groundY = (x: number, z: number) =>
    bandSurfaceAt(ctx.geom, x, z) ?? sidewalkY(hf, x, z, j.h);
  const clear = (x: number, z: number, r: number) =>
    !poles.some(q => Math.hypot(q[0] - x, q[1] - z) < r);
  // Cabinet: behind a signal pole (hashed first choice), 0.85 m further
  // from the road and 0.9 m further from the box than the pole.
  const n = spots.length;
  const h0 = hash2(ji, 0xcab);
  for (let t = 0; t < n; t++) {
    const [p, armDir, k] = spots[(h0 + t) % n];
    const a = jg.arms[k];
    const x = p[0] - armDir[0] * 0.85 + a.dir[0] * 0.9;
    const z = p[2] - armDir[1] * 0.85 + a.dir[1] * 0.9;
    const P = (u: number, v: number): Vec2 => [
      x + a.dir[0] * u + armDir[0] * v,
      z + a.dir[1] * u + armDir[1] * v,
    ];
    if (
      [P(-0.45, -0.35), P(0.45, -0.35), P(0.45, 0.35), P(-0.45, 0.35)].some(
        q => !land.ok(q[0], q[1], a.chain),
      )
    )
      continue;
    const y = groundY(x, z);
    const yaw = Math.atan2(armDir[0], armDir[1]);
    const paint = packMat(CM.paint, CABINET);
    if (lod !== 0) {
      m.box([x, y + 0.65, z], [0.3, 0.65, 0.2], paint, yaw);
      break;
    }
    m.box([x, y + 0.04, z], [0.34, 0.06, 0.24], packMat(CM.concrete), yaw);
    m.box([x, y + 0.7, z], [0.3, 0.6, 0.2], paint, yaw);
    // Rain hood, overhanging 3 cm all round.
    m.box([x, y + 1.32, z], [0.33, 0.02, 0.23], paint, yaw, 0, false);
    poles.push([x, z]);
    break;
  }
  if (lod !== 0) return;
  // Corner bollards: stainless posts, the column's pole uv (metres up from
  // SINK under the paving: the shader's foot dirt).
  const post = packMat(CM.metal, LAMP_METAL);
  jg.corners.forEach(({pts, block}, ci) => {
    const s = [0];
    for (let i = 1; i < pts.length; i++)
      s.push(s[i - 1] + dist2(pts[i - 1], pts[i]));
    const len = s[s.length - 1];
    if (len < 2.5) return;
    const curb = L.blocks[block].curb;
    const hb = hash2(ji * 8 + ci, 0xb011);
    const count = Math.min(3 + (hb % 3), 1 + Math.floor((len * 0.7) / 1.3));
    for (let b = 0; b < count; b++) {
      const at = len * (0.15 + (0.7 * (b + 0.5)) / count);
      let i = 1;
      while (i < s.length - 1 && s[i] < at) i++;
      const f = (at - s[i - 1]) / (s[i] - s[i - 1] || 1);
      const a = pts[i - 1];
      const c = pts[i];
      const q: Vec2 = [lerp(a[0], c[0], f), lerp(a[1], c[1], f)];
      const dl = dist2(a, c) || 1;
      let nx = -(c[1] - a[1]) / dl;
      let nz = (c[0] - a[0]) / dl;
      if (!pointInPolygon([q[0] + nx * 0.8, q[1] + nz * 0.8], curb)) {
        nx = -nx;
        nz = -nz;
      }
      const x = q[0] + nx * 0.4;
      const z = q[1] + nz * 0.4;
      if (!land.onSidewalk(x, z) || land.onPlate(x, z) || !clear(x, z, 0.7))
        continue;
      m.cylinder(
        [x, groundY(x, z) - SINK, z],
        0.06,
        0.85 + SINK,
        6,
        post,
        true,
      );
    }
  });
}

/**
 * Steel gutter grates (round 6) in the carriageway along chain ci's kerbs
 * (streets and up, both sides, where the kerb backs onto a sidewalk):
 * every ~12 m (+-1.5 m), 1.0 x 0.3 m, set 1 cm off the kerb face, 4 mm
 * over the road surface. LOD0 only, 4 vertices each. The cover material
 * (WALK_COVER_MAT) with aux = GRATE | (3 | hash << 3) << 16; uv 0..1 over
 * the grate, u along the road, v across it from the kerb face (0) out.
 * Intended shading (coverMat on GRATE): galvanised bearing bars every
 * ~3 cm across the run (along v), a cross bar every ~10 cm, dark void
 * between (the gutter below), a 2 cm angle frame, silt in the low corner.
 */
function gutterGrates(
  ctx: TileContext,
  m: CMesh,
  ci: number,
  land: ReturnType<typeof landing>,
  inTile: (x: number, z: number) => boolean,
) {
  const L = ctx.layout;
  const c = L.chains[ci];
  if (c.kind < Road.street) return;
  const arc = ctx.geom.arc[ci];
  const total = arc[arc.length - 1];
  const [s0, s1] = ctx.geom.setbacks[ci];
  const W = ROAD_WIDTH[c.kind];
  const HL = 0.5;
  const HW = 0.15;
  for (const side of [-1, 1]) {
    let k = 0;
    for (let s = s0 + 5 + (hash2(ci, side + 0x67) % 7); s < total - s1 - 5; s += 12) {
      const h = hash2(ci * 2 + (side > 0 ? 1 : 0), k++ ^ 0x6a7e);
      const ss = s + ((h & 0xff) / 255 - 0.5) * 3;
      const q = chainAt(c, arc, ss);
      const l: Vec2 = [-q.d[1] * side, q.d[0] * side];
      const off = W / 2 - 0.01 - HW;
      const x = q.p[0] + l[0] * off;
      const z = q.p[1] + l[1] * off;
      if (!inTile(x, z)) continue;
      // Backed by a sidewalk (not a median, an open edge or another road).
      const bx = q.p[0] + l[0] * (W / 2 + 0.6);
      const bz = q.p[1] + l[1] * (W / 2 + 0.6);
      if (!land.ok(bx, bz, ci) || land.onPlate(x, z)) continue;
      const y = q.h + 0.024;
      const aux = GRATE | (((3 | ((h >>> 8) << 3)) & 0xffff) << 16);
      const P = (a: number, b: number): Vec3 => [
        x + q.d[0] * a + l[0] * b,
        y,
        z + q.d[1] * a + l[1] * b,
      ];
      m.quad(
        [P(-HL, HW), P(HL, HW), P(HL, -HW), P(-HL, -HW)],
        UP,
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        WALK_COVER_MAT,
        aux,
      );
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
    if (inTile(p[0], p[2])) streetLight(m, p, dir, kind, sodium, lod);
    if (
      p[0] > tx0 - 40 &&
      p[0] < tx0 + TILE_SIZE + 40 &&
      p[2] > tz0 - 40 &&
      p[2] < tz0 + TILE_SIZE + 40
    )
      poles.push([p[0], p[2]]);
  });
  for (const bi of ctx.tileBuildings[tile] ?? [])
    building(
      L.buildings[bi],
      m,
      lod,
      lights,
      L.params.signDensity,
      hf,
      poles,
      lod === 0 ? edgeCover(L, bi) : undefined,
      lod === 0
        ? edgeCover(L, bi, 0.3, [0.02, 0.25, 0.5, 0.75, 0.98])
        : undefined,
    );

  // Street faces of this tile's buildings, for the poles' service drops.
  const fronts: Front[] = [];
  if (lod === 0)
    for (const bi of ctx.tileBuildings[tile] ?? []) {
      const b = L.buildings[bi];
      if (b.kind === 'house' || b.kind === 'station' || b.height < 7) continue;
      b.footprint.forEach((a, i) => {
        if (i !== b.front && !b.frontage[i]) return;
        const c = b.footprint[(i + 1) % b.footprint.length];
        fronts.push({
          a,
          c,
          n: edgeNormal(b.footprint, i),
          y: b.base + GROUND_H + 0.5,
        });
      });
    }

  // Every street prop placed by offset from its chain must land on a
  // sidewalk and clear of every other road (close parallel chains would
  // otherwise get each other's trees and rails in their lanes).
  const land = landing(L, ctx.geom);

  // Props along chains: utility poles + wires on small streets, trees on avenues.
  for (const ci of ctx.tileChains[tile] ?? []) {
    const c = L.chains[ci];
    if (c.bridge.some(b => b) || ctx.geom.absorbed[ci]) continue;
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
        if (!land.ok(x, z, ci)) {
          prev = null;
          continue;
        }
        const p: Vec3 = [x, sidewalkY(hf, x, z, q.h), z];
        const here = inTile(p[0], p[2]);
        if (here && lod === 0 && clearOfDecks(ctx, p, p, 10.2)) {
          utilityPole(m, p);
          serviceDrops(m, p, fronts);
        }
        if (prev && lod === 0 && here && clearOfDecks(ctx, prev, p, 9.3)) {
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
        for (let s0t = s0 + 10; s0t < total - s1 - 8; s0t += 13) {
          // Shifted clear of lamp heads (NaN: dropped, as off the walk).
          const s = avenueTreeS(L, ctx.geom, ci, side, s0t);
          const q = chainAt(c, arc, Number.isNaN(s) ? s0t : s);
          const l: Vec2 = [-q.d[1], q.d[0]];
          const x = q.p[0] + l[0] * off;
          const z = q.p[1] + l[1] * off;
          const p: Vec3 = [
            x,
            bandY(
              hf,
              q,
              [l[0] * side, l[1] * side],
              c.kind,
              SIDEWALK[c.kind] * 0.55,
            ),
            z,
          ];
          // The tile owning the nominal spot builds it (shifted or not),
          // so each tile's stream of tree draws stays as before.
          const n0 = chainAt(c, arc, s0t);
          if (!inTile(n0.p[0] - n0.d[1] * off, n0.p[1] + n0.d[0] * off))
            continue;
          const th = rng.range(6, 9);
          if (
            Number.isNaN(s) ||
            s >= total - s1 - 8 ||
            !land.ok(x, z, ci) ||
            deckClearance(ctx, p[0], p[2], p[1]) < th + 1
          ) {
            rng.nextU32(); // as tree() would, so the next trees keep theirs
            continue;
          }
          tree(m, p, th, lod, rng);
          if (lod === 0) {
            // Cast-iron grate in its 1.2 m pit, square to the kerb.
            // Cast-iron grate in its 1.2 m pit, square to the kerb, set in
            // a 9 cm precast frame standing 2.5 cm proud of the paving.
            const d = q.d;
            const P = (u: number, v: number, r = 0.6, y = 0.02): Vec3 => [
              x + d[0] * u * r + l[0] * v * r,
              p[1] + y,
              z + d[1] * u * r + l[1] * v * r,
            ];
            m.quad(
              [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)],
              [0, 1, 0],
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
              packMat(CM.hedge, 1),
            );
            const fr = packMat(CM.curb, 1);
            const C: [number, number][] = [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1],
            ];
            const inner = C.map(([u, v]) =>
              m.vertex(P(u, v, 0.6, 0.025), UP, u * 0.6, v * 0.6, fr),
            );
            const outer = C.map(([u, v]) =>
              m.vertex(P(u, v, 0.69, 0.025), UP, u * 0.69, v * 0.69, fr),
            );
            for (let k = 0; k < 4; k++) {
              const k1 = (k + 1) & 3;
              m.triFacing(inner[k], outer[k], outer[k1], UP);
              m.triFacing(inner[k], outer[k1], inner[k1], UP);
            }
          }
        }
      }
    }
    if (lod === 0) {
      walkCovers(ctx, m, ci, land, inTile, poles);
      gutterGrates(ctx, m, ci, land, inTile);
    }
  }

  // Overhead guide signs before signalized junctions (LOD1 keeps panel and
  // column: the one road prop that must read at 300 m).
  for (const ci of ctx.tileChains[tile] ?? []) {
    const c = L.chains[ci];
    if (c.kind < Road.avenue || c.bridge.some(b => b)) continue;
    const arc = ctx.geom.arc[ci];
    const total = arc[arc.length - 1];
    const [s0, s1] = ctx.geom.setbacks[ci];
    const len = total - s0 - s1;
    if (len < 30) continue;
    for (const end of [0, 1] as const) {
      if (len < 70) break;
      const ji = guideJunction(L, ci, end);
      if (ji < 0 || !L.junctions[ji].signal || L.hidden?.junctions[ji])
        continue;
      const h = hash2(ci * 2 + end, 0x5197);
      if (c.kind === Road.avenue && h % 2) continue;
      const back = 60 + ((h >>> 4) % 30);
      const s = end === 0 ? s0 + back : total - s1 - back;
      const q = chainAt(c, arc, s);
      const l: Vec2 = [-q.d[1], q.d[0]];
      // Incoming traffic toward this end keeps left; the sign faces it.
      const side = end === 1 ? 1 : -1;
      const f: Vec2 = end === 1 ? [-q.d[0], -q.d[1]] : [q.d[0], q.d[1]];
      const W = ROAD_WIDTH[c.kind];
      const off = W / 2 + 0.6;
      const x = q.p[0] + l[0] * off * side;
      const z = q.p[1] + l[1] * off * side;
      if (!inTile(x, z) || !land.ok(x, z, ci)) continue;
      const p: Vec3 = [x, sidewalkY(hf, x, z, q.h), z];
      const inward: Vec2 = [-l[0] * side, -l[1] * side];
      guideSign(
        m,
        p,
        inward,
        f,
        W / 2 - 0.5,
        off - W / 4,
        (h >>> 8) % GUIDE_DIR,
        lod,
      );
    }
    // Direction-and-distance signs for traffic leaving the junction, 35-50
    // m past it on the departing side, facing back toward the junction.
    for (const end of [0, 1] as const) {
      const ji = guideJunction(L, ci, end);
      if (ji < 0 || !L.junctions[ji].signal || L.hidden?.junctions[ji])
        continue;
      const h = hash2(ci * 2 + end, 0xd157);
      if (c.kind === Road.avenue && h % 3 === 0) continue;
      const fwd = Math.min(35 + ((h >>> 4) % 16), len * 0.5);
      const s = end === 0 ? s0 + fwd : total - s1 - fwd;
      const q = chainAt(c, arc, s);
      const l: Vec2 = [-q.d[1], q.d[0]];
      // Departing traffic runs away from this end and keeps left.
      const side = end === 0 ? 1 : -1;
      const f: Vec2 = end === 0 ? [-q.d[0], -q.d[1]] : [q.d[0], q.d[1]];
      const W = ROAD_WIDTH[c.kind];
      const off = W / 2 + 0.6;
      const x = q.p[0] + l[0] * off * side;
      const z = q.p[1] + l[1] * off * side;
      if (!inTile(x, z) || !land.ok(x, z, ci)) continue;
      const p: Vec3 = [x, sidewalkY(hf, x, z, q.h), z];
      const inward: Vec2 = [-l[0] * side, -l[1] * side];
      guideSign(
        m,
        p,
        inward,
        f,
        4.3,
        2.4,
        GUIDE_DIR + ((h >>> 8) % (GUIDE_FACES.length - GUIDE_DIR)),
        lod,
        1.6,
        0.8,
      );
    }
  }

  hedges(ctx, tile, m, land, inTile, lod);

  // LOD1 signals (junctions with an avenue or arterial arm): each pole,
  // its arm and the head's drop as one bent tube
  // (12 vertices; the vertex shader keeps it at least ~0.7 px wide) and the
  // head as a box, so the junction keeps its poles, mast arms and heads at
  // range.
  if (lod !== 0)
    for (const ji of ctx.tileJunctions[tile] ?? []) {
      const j = L.junctions[ji];
      if (!j.signal) continue;
      // Junctions on avenues and arterials only (the ones read from afar).
      if (j.arms.every(a => L.chains[a.chain].kind < Road.avenue)) continue;
      const spots: [Vec3, Vec2, number][] = [];
      signalSpots(L, ctx.geom, hf, ji, (p, armDir, reach, k) => {
        spots.push([p, armDir, k]);
        const y = p[1] + 5.8;
        m.tube(
          [
            [p[0], p[1] - SINK, p[2]],
            [p[0], y, p[2]],
            [p[0] + armDir[0] * reach, y - 0.15, p[2] + armDir[1] * reach],
          ],
          0.16,
          packMat(CM.paint, 0x90),
        );
        // The head as a plain dark slab (its backplate's size) hanging
        // under the arm end, facing the approach and back: 8 vertices.
        const hx = p[0] + armDir[0] * (reach - 0.7);
        const hz = p[2] + armDir[1] * (reach - 0.7);
        const H = (u: number, v: number, f: number): Vec3 => [
          hx + armDir[0] * u * 0.76 + armDir[1] * f,
          y - 0.12 + v * 0.34,
          hz + armDir[1] * u * 0.76 - armDir[0] * f,
        ];
        for (const f of [0.1, -0.1])
          m.quad(
            [H(-1, -1, f), H(1, -1, f), H(1, 1, f), H(-1, 1, f)],
            [armDir[1] * Math.sign(f), 0, -armDir[0] * Math.sign(f)],
            uv01,
            packMat(CM.paint, 0x91),
          );
      });
      junctionFixtures(ctx, m, ji, land, spots, [], lod);
    }

  // Traffic signals (LOD0): vehicle heads with name plates and the
  // junction luminaire on each pole, pedestrian signals at both ends of
  // every crossing, a controller cabinet, regulatory signs at the corners.
  if (lod === 0)
    for (const ji of ctx.tileJunctions[tile] ?? []) {
      const j = L.junctions[ji];
      if (!j.signal) continue;
      const jg = ctx.geom.junctions[ji];
      const phase = hash2(ji, 17) & 0xff;
      // Signal and pedestrian-signal poles (the corner bollards keep clear)
      // and the spots for the controller cabinet.
      const jpoles: Vec2[] = [];
      const spots: [Vec3, Vec2, number][] = [];
      signalSpots(L, ctx.geom, hf, ji, (p, armDir, reach, k) => {
        jpoles.push([p[0], p[2]]);
        spots.push([p, armDir, k]);
        const a = jg.arms[k];
        const group = Math.round((a.angle / Math.PI) * 2) & 1;
        const lums: [Vec3, Vec2, number, boolean][] = [];
        signalLums(L, ji, p, armDir, k, (h, d, r, pool) =>
          lums.push([h, d, r, pool]),
        );
        signal(m, p, armDir, reach, phase, group, ji, lums);
        // Pedestrian signals across this arm's crossing: one on the signal
        // pole, one on its own pole at the far corner, each facing across.
        const l: Vec2 = [-a.dir[1], a.dir[0]];
        pedSignal(
          m,
          [p[0] - l[0] * 0.2, p[1] + 2.8, p[2] - l[1] * 0.2],
          [-l[0], -l[1]],
          group,
          phase,
        );
        m.box(
          [p[0] - l[0] * 0.15, p[1] + 1.25, p[2] - l[1] * 0.15],
          [0.1, 0.15, 0.06],
          packMat(CM.paint, 0x92),
          Math.atan2(-l[0], -l[1]),
        );
        // Far corner, level with the signal pole along the arm.
        const along = (p[0] - j.p[0]) * a.dir[0] + (p[2] - j.p[1]) * a.dir[1];
        let fx = NaN;
        let fz = NaN;
        for (const extra of [0, 1.2, 2.4]) {
          const off = a.width / 2 + 0.8 + extra;
          const x = j.p[0] + a.dir[0] * along - l[0] * off;
          const z = j.p[1] + a.dir[1] * along - l[1] * off;
          if (land.ok(x, z, a.chain)) {
            fx = x;
            fz = z;
            break;
          }
        }
        if (!isNaN(fx)) {
          jpoles.push([fx, fz]);
          const fp: Vec3 = [fx, sidewalkY(hf, fx, fz, j.h), fz];
          m.cylinder(
            [fp[0], fp[1] - SINK, fp[2]],
            0.07,
            3.4 + SINK,
            6,
            packMat(CM.paint, 0x90),
            true,
          );
          pedSignal(
            m,
            [fp[0] + l[0] * 0.2, fp[1] + 2.8, fp[2] + l[1] * 0.2],
            l,
            group,
            phase,
          );
          m.box(
            [fp[0] + l[0] * 0.11, fp[1] + 1.25, fp[2] + l[1] * 0.11],
            [0.1, 0.15, 0.06],
            packMat(CM.paint, 0x92),
            Math.atan2(l[0], l[1]),
          );
        }
        // Regulatory sign beyond the crossing on the approach's kerb side,
        // facing approaching traffic: speed limit on avenues and up, no
        // parking on small streets; some also carry the crossing square.
        const hs = hash2(ji * 8 + k, 0x7e9);
        const kind = L.chains[a.chain].kind;
        const rs = a.setback + 7 + (hs % 5);
        const rx = j.p[0] + a.dir[0] * rs - l[0] * (a.width / 2 + 0.5);
        const rz = j.p[1] + a.dir[1] * rs - l[1] * (a.width / 2 + 0.5);
        if (hs % 3 !== 0 && land.ok(rx, rz, a.chain)) {
          regSign(
            m,
            [rx, sidewalkY(hf, rx, rz, j.h), rz],
            a.dir,
            kind >= Road.avenue ? (hs >>> 3) & 1 : 2,
            ((hs >>> 5) & 3) === 0,
            2.3 + ((hs >>> 7) % 6) * 0.1,
          );
        }
      });
      junctionFixtures(ctx, m, ji, land, spots, jpoles, lod);
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
        const count = 2 + ((h >> 6) % 2);
        for (let k = 0; k < count; k++) {
          const t = 0.55 + k * (0.35 / count);
          const x = lerp(a[0], c[0], t) + n[0] * 0.9;
          const z = lerp(a[1], c[1], t) + n[2] * 0.9;
          const base: Vec3 = [x, sidewalkY(hf, x, z, b.base), z];
          // Nose to the wall, a little askew.
          const lean = (((h >> (k + 3)) & 7) - 3.5) * 0.03;
          const dir: Vec3 = [
            -n[0] * Math.cos(lean) + n[2] * Math.sin(lean),
            0,
            -n[2] * Math.cos(lean) - n[0] * Math.sin(lean),
          ];
          bicycle(
            m,
            base,
            dir,
            BIKE_COLS[(h + k * 37) % BIKE_COLS.length],
            ((h >> k) & 3) !== 0,
          );
        }
      }
    }
    // Guardrails along arterial curbs, hedges in the planting strip behind
    // them, bus stops, bollards at corners.
    for (const ci of ctx.tileChains[tile] ?? []) {
      const c = L.chains[ci];
      if (c.kind < Road.avenue || c.bridge.some(b => b)) continue;
      const arc = ctx.geom.arc[ci];
      const total = arc[arc.length - 1];
      const [s0, s1] = ctx.geom.setbacks[ci];
      const W = ROAD_WIDTH[c.kind];
      for (const side of [-1, 1]) {
        const off = (W / 2 + 0.3) * side;
        let prev: Vec3 | null = null;
        for (let s = s0 + 6; s < total - s1 - 6; s += 2) {
          const q = chainAt(c, arc, s);
          const l: Vec2 = [-q.d[1], q.d[0]];
          const x = q.p[0] + l[0] * off;
          const z = q.p[1] + l[1] * off;
          const p: Vec3 = [x, sidewalkY(hf, x, z, q.h), z];
          if (!inTile(p[0], p[2]) || !land.ok(x, z, ci)) {
            prev = null;
            continue;
          }
          // Gaps for crossings / driveways.
          if (hash2(ci * 7 + side, Math.floor(s / 24)) % 5 === 0) {
            prev = null;
            continue;
          }
          m.tube(
            [
              [p[0], p[1] - SINK, p[2]],
              [p[0], p[1] + 0.8, p[2]],
            ],
            0.042,
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
        const stops: number[] = [];
        for (
          let s = s0 + 40 + (hash2(ci, side) % 120);
          s < total - s1 - 20;
          s += 300
        ) {
          const q = chainAt(c, arc, s);
          const l: Vec2 = [-q.d[1], q.d[0]];
          const o = (W / 2 + SIDEWALK[c.kind] * 0.6) * side;
          const x = q.p[0] + l[0] * o;
          const z = q.p[1] + l[1] * o;
          if (!land.ok(x, z, ci)) continue;
          stops.push(s);
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
          if (!land.ok(x, z, -1)) continue;
          const bp: Vec3 = [x, sidewalkY(hf, x, z, j.h) - SINK, z];
          m.cylinder(bp, 0.07, 0.8 + SINK, 4, packMat(CM.paint, 0xd8), true);
        }
      }
    }
  }
  void SODIUM;
  void LED;
  return {mesh: m, lights: lights.data};
}
