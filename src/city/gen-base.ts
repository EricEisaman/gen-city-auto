// Always-resident city geometry: road strips, junctions, bridges, sidewalk
// slabs, parks, elevated rail viaducts and expressways. Also produces the
// street light list and the land-use raster used by the terrain shader.

import {Rng, hash2} from '../math/random.ts';
import {
  dist2,
  lerp,
  pointInPolygon,
  pointSegment,
  polygonArea,
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
import {Heightfield, SEA_LEVEL} from './terrain.ts';

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
export function roadMask(
  L: CityLayout,
  visible = false,
  geom?: RoadGeom,
): Uint8Array {
  const hf = L.terrain.heights;
  const n = hf.n;
  const mask = new Uint8Array(n * n);
  const S = hf.size / 2;
  // With `geom` (the lab's visible mask), chain ends at junctions that get
  // no plate (roads(): at most one arm shown) stop under the strip's end
  // instead of painting the junction area as asphalt-coloured ground.
  const ends = new Map<number, number>();
  if (visible && geom && L.hidden)
    L.junctions.forEach(j => {
      if (j.arms.filter(a => !L.hidden!.chains[a.chain]).length <= 1)
        for (const a of j.arms) ends.set(a.chain * 2 + a.end, 1);
    });
  for (const [ci, c] of L.chains.entries()) {
    if (visible && L.hidden?.chains[ci]) continue;
    const half = ROAD_WIDTH[c.kind] / 2 + 1;
    let sMin = -Infinity;
    let sMax = Infinity;
    if (geom && ends.size) {
      const arc = geom.arc[ci];
      const [s0, s1] = geom.setbacks[ci];
      if (ends.has(ci * 2)) sMin = s0 + half;
      if (ends.has(ci * 2 + 1)) sMax = arc[arc.length - 1] - s1 - half;
    }
    for (let i = 0; i + 1 < c.pts.length; i++) {
      const a = c.pts[i];
      const b = c.pts[i + 1];
      const len = dist2(a, b);
      const steps = Math.ceil(len / 2);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        if (geom && ends.size) {
          const sa = geom.arc[ci][i] + t * len;
          if (sa < sMin || sa > sMax) continue;
        }
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

/**
 * Kerbs on carriageway edges that no block curb lines (gen-base blocks()
 * kerbs every edge it borders), sampled with the strip:
 * - Open edges (no visible block beyond, no other road, no plate: the city
 *   edge, block-less land, the lab's hidden blocks): a kerb face (CM.curb,
 *   uv x metres along, y metres up) up 0.15 m, a footway verge of the
 *   sidewalk width (CM.sidewalk 1 band, uv as the curb band, kind bits 0 so
 *   no tactile line) and a concrete skirt down to the ground, so the road
 *   never shows a raw edge or the carved terrain trench beside it.
 * - Parallel roads whose carriageways meet or overlap by up to 1.5 m (two
 *   chains of one boulevard): a raised median between them, kerbs both
 *   sides and a precast top (CM.curb 1), stopping 8 m short of either
 *   strip end; built by the lower chain index only.
 * - Strip ends with no junction plate (dead ends; lab junctions with hidden
 *   arms): a kerb and skirt across the end.
 */
function roadEdges(
  L: CityLayout,
  geom: RoadGeom,
  m: CMesh,
  land: Landing,
  ci: number,
  pts: Vec2[],
  hs: number[],
  along: number[],
  ends: [boolean, boolean],
) {
  const hf = L.terrain.heights;
  const c = L.chains[ci];
  const w = ROAD_WIDTH[c.kind];
  const kerb = packMat(CM.curb);
  const precast = packMat(CM.curb, 1);
  const vw = Math.min(SIDEWALK[c.kind], 2.5) + 0.3;
  const band = packMat(CM.sidewalk, 1);
  const bandAux = Math.min(255, Math.round(vw / 0.02)) << 8;
  const n = pts.length;
  const len = along[n - 1];
  const dirAt = (i: number): Vec2 => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  for (const side of [1, -1]) {
    const edge = offsetLine(pts, (side * w) / 2);
    type Kind = 'open' | 'median' | null;
    const kinds: Kind[] = [];
    const med: {c: Vec2; o: Vec2; mw: number; h: number}[] = [];
    for (let i = 0; i < n; i++) {
      const d = dirAt(i);
      // Outward: left of the chain for side +1 (offsetLine's +).
      const o: Vec2 = [-d[1] * side, d[0] * side];
      const e = edge[i];
      const px = e[0] + o[0] * 0.7;
      const pz = e[1] + o[1] * 0.7;
      const elevated =
        hs[i] - Math.max(hf.sample(pts[i][0], pts[i][1]), SEA_LEVEL) > 2.5;
      let k: Kind = null;
      const bi = land.blockAt(px, pz);
      const other = land.otherRoad(e[0], e[1], ci, 1.6);
      if (elevated || (bi >= 0 && !L.hidden?.blocks[bi])) k = null;
      else if (other) {
        const oc = L.chains[other.ci];
        const par = Math.abs(other.dir[0] * d[0] + other.dir[1] * d[1]);
        // Signed distance from this edge to the other's near edge, outward.
        const t =
          (other.p[0] - e[0]) * o[0] +
          (other.p[1] - e[1]) * o[1] -
          ROAD_WIDTH[oc.kind] / 2;
        if (
          par > 0.96 &&
          t > -1.5 &&
          t < 1.6 &&
          ci < other.ci &&
          along[i] > 8 &&
          along[i] < len - 8
        ) {
          k = 'median';
          const mw = Math.max(0.9, Math.abs(t) + 0.5);
          med[i] = {
            c: [e[0] + (o[0] * t) / 2, e[1] + (o[1] * t) / 2],
            o,
            mw,
            h: hs[i],
          };
        }
      } else if (!land.onPlate(px, pz)) k = 'open';
      kinds.push(k);
    }
    // Runs of each kind (at least two samples).
    for (let i = 0; i < n;) {
      const k = kinds[i];
      let j = i;
      while (j + 1 < n && kinds[j + 1] === k) j++;
      if (k && j > i) {
        if (k === 'open') verge(i, j);
        else median(i, j);
      }
      i = j + 1;
    }
    function verge(i0: number, i1: number) {
      let pk = -1;
      for (let i = i0; i <= i1; i++) {
        const d = dirAt(i);
        const o: Vec2 = [-d[1] * side, d[0] * side];
        const e = edge[i];
        const h = hs[i];
        const top = h + 0.15;
        const f: Vec2 = [e[0] + o[0] * vw, e[1] + o[1] * vw];
        const g = Math.min(hf.sample(f[0], f[1]), top) - 0.3;
        const nIn: Vec3 = [-o[0], 0, -o[1]];
        const nOut: Vec3 = [o[0], 0, o[1]];
        const s = along[i];
        const ids = [
          m.vertex([e[0], h - 0.05, e[1]], nIn, s, 0, kerb),
          m.vertex([e[0], top, e[1]], nIn, s, 0.2, kerb),
          m.vertex([e[0], top, e[1]], UP, s, 0, band, bandAux),
          m.vertex([f[0], top, f[1]], UP, s, vw, band, bandAux),
          m.vertex([f[0], top, f[1]], nOut, s, top - g, precast),
          m.vertex([f[0], g, f[1]], nOut, s, 0, precast),
        ];
        if (pk >= 0) {
          const nn = [nIn, UP, nOut];
          for (let q = 0; q < 3; q++) {
            const a = pk + q * 2;
            const b = ids[q * 2];
            m.triFacing(a, b, b + 1, nn[q]);
            m.triFacing(a, b + 1, a + 1, nn[q]);
          }
        }
        pk = ids[0];
      }
    }
    function median(i0: number, i1: number) {
      let pk = -1;
      for (let i = i0; i <= i1; i++) {
        const {c: mc, o, mw, h} = med[i];
        const top = h + 0.15;
        const A: Vec2 = [mc[0] - (o[0] * mw) / 2, mc[1] - (o[1] * mw) / 2];
        const B: Vec2 = [mc[0] + (o[0] * mw) / 2, mc[1] + (o[1] * mw) / 2];
        const nA: Vec3 = [-o[0], 0, -o[1]];
        const nB: Vec3 = [o[0], 0, o[1]];
        const s = along[i];
        const ids = [
          m.vertex([A[0], h - 0.05, A[1]], nA, s, 0, kerb),
          m.vertex([A[0], top, A[1]], nA, s, 0.2, kerb),
          m.vertex([A[0], top, A[1]], UP, s, 0, band, bandAux),
          m.vertex([mc[0], top, mc[1]], UP, s, mw / 2, band, bandAux),
          m.vertex([mc[0], top, mc[1]], UP, s, mw / 2, band, bandAux),
          m.vertex([B[0], top, B[1]], UP, s, 0, band, bandAux),
          m.vertex([B[0], top, B[1]], nB, s, 0.2, kerb),
          m.vertex([B[0], h - 0.05, B[1]], nB, s, 0, kerb),
        ];
        if (pk >= 0) {
          const nn = [nA, UP, UP, nB];
          for (let q = 0; q < 4; q++) {
            const a = pk + q * 2;
            const b = ids[q * 2];
            m.triFacing(a, b, b + 1, nn[q]);
            m.triFacing(a, b + 1, a + 1, nn[q]);
          }
        }
        pk = ids[0];
        // Noses: the run's ends closed across.
        if (i === i0 || i === i1) {
          const d = dirAt(i);
          const sg = i === i0 ? -1 : 1;
          const nn: Vec3 = [d[0] * sg, 0, d[1] * sg];
          m.quad(
            [
              [A[0], h - 0.05, A[1]],
              [B[0], h - 0.05, B[1]],
              [B[0], top, B[1]],
              [A[0], top, A[1]],
            ],
            nn,
            [
              [0, 0],
              [mw, 0],
              [mw, 0.2],
              [0, 0.2],
            ],
            kerb,
          );
        }
      }
    }
  }
  // Strip ends without a plate: kerb and skirt across the end.
  for (const end of [0, 1] as const) {
    if (!ends[end]) continue;
    const i = end === 0 ? 0 : n - 1;
    const d = dirAt(i);
    const sg = end === 0 ? -1 : 1;
    const out: Vec2 = [d[0] * sg, d[1] * sg];
    const l: Vec2 = [-d[1], d[0]];
    const h = hs[i];
    const P = (u: number, y: number, f = 0): Vec3 => [
      pts[i][0] + (l[0] * u * w) / 2 + out[0] * f,
      y,
      pts[i][1] + (l[1] * u * w) / 2 + out[1] * f,
    ];
    const g = Math.min(hf.sample(pts[i][0], pts[i][1]), h) - 0.3;
    m.quad(
      [P(-1, h - 0.05), P(1, h - 0.05), P(1, h + 0.15), P(-1, h + 0.15)],
      [-out[0], 0, -out[1]],
      [
        [0, 0],
        [w, 0],
        [w, 0.2],
        [0, 0.2],
      ],
      kerb,
    );
    m.quad(
      [
        P(-1, h + 0.15),
        P(1, h + 0.15),
        P(1, h + 0.15, 0.3),
        P(-1, h + 0.15, 0.3),
      ],
      UP,
      [
        [0, 0],
        [w, 0],
        [w, 0.3],
        [0, 0.3],
      ],
      precast,
    );
    m.quad(
      [P(-1, h + 0.15, 0.3), P(1, h + 0.15, 0.3), P(1, g, 0.3), P(-1, g, 0.3)],
      [out[0], 0, out[1]],
      [
        [0, h + 0.15 - g],
        [w, h + 0.15 - g],
        [w, 0],
        [0, 0],
      ],
      precast,
    );
  }
}

/**
 * Junction-box marking paint (`CM.paint` param): thermoplastic white on the
 * plate. Today it renders through paintColor's 0xd0-0xef service-fixture
 * branch (albedo 0.62, rough 0.7). Contract for the shader: uv.x = metres
 * along the line (continuous through the dash gaps, so wear can run along
 * it), uv.y = 0..1 across its 15 cm; aux high 16 bits = the junction's hash
 * (aux low 16 stay 0, not a tube). The ribbon floats 12 mm over the plate.
 */
export const BOX_PAINT = 0xef;

/** Height of the plate fan (triangles as positions) at (x, z), or null. */
function plateAt(tris: Vec3[][], x: number, z: number): number | null {
  for (const [a, b, c] of tris) {
    const d =
      (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]) || 1e-9;
    const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
    const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    const w = 1 - u - v;
    if (u >= -1e-4 && v >= -1e-4 && w >= -1e-4)
      return a[1] * u + b[1] * v + c[1] * w;
  }
  return null;
}

/**
 * Markings inside a signalized junction box (Tokyo practice), as paint
 * ribbons 12 mm over the plate (`BOX_PAINT`, 15 cm wide):
 * - right-turn guides (右折導流線): from each avenue approach's inner lane to
 *   the inner departure lane of the arm on its right, a straight run in, an
 *   arc just inside the junction centre and a run out; the turn's inner
 *   edge dotted (1 m on / 2 m off);
 * - the right-turn waiting box (右折待ち): the last 5 m of the run in as a
 *   solid lane-wide rectangle, where turners wait for oncoming traffic;
 * - lane lines carried across the box (2 m on / 4 m off) to the opposite
 *   arm most in line with the approach (within 3 m), for avenues.
 * Arm frame: `dir` out of the junction, `l` its left; the approach lanes
 * are on +l (the road shader's x > 0 at a chain start, x < 0 at its end).
 * A merged cluster (`members`, lead first) is marked as one box.
 */
function junctionMarkings(
  L: CityLayout,
  geom: RoadGeom,
  m: CMesh,
  members: number[],
  yAt: (x: number, z: number) => number | null,
) {
  const ji = members[0];
  const F = members
    .flatMap(k => geom.junctions[k].arms)
    .filter(a => !L.hidden?.chains[a.chain] && !geom.absorbed[a.chain])
    .map(a => {
      const c = L.chains[a.chain];
      const arc = geom.arc[a.chain];
      const total = arc[arc.length - 1];
      const [s0, s1] = geom.setbacks[a.chain];
      const q = chainAt(c, arc, a.end === 0 ? s0 : total - s1);
      const dir: Vec2 = a.end === 0 ? q.d : [-q.d[0], -q.d[1]];
      const l: Vec2 = [-dir[1], dir[0]];
      const hw = ROAD_WIDTH[c.kind] / 2;
      const per = Math.max(1, Math.floor(LANES[c.kind] / 2));
      // Lateral `lat` (+ approach side), `inset` metres into the box.
      const at = (lat: number, inset = 0.4): Vec2 => [
        q.p[0] + l[0] * lat - dir[0] * inset,
        q.p[1] + l[1] * lat - dir[1] * inset,
      ];
      return {kind: c.kind, dir, l, per, lw: (hw - 0.5) / per, at, o: q.p};
    });
  if (F.length < 3) return;
  const mat = packMat(CM.paint, BOX_PAINT);
  const aux = (hash2(ji, 0xb0c5) & 0xffff) << 16;
  const HW = 0.075;
  const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
  /** Ribbon along polyline pts (u0 = metres along at pts[0]). */
  const ribbon = (pts: Vec2[], u0: number) => {
    const ys = pts.map(q => yAt(q[0], q[1]));
    if (ys.some(y => y === null)) return;
    let u = u0;
    let prev = -1;
    let prevR = -1;
    pts.forEach((q, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / dl;
      const nz = (b[0] - a[0]) / dl;
      if (i > 0) u += Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]);
      const y = ys[i]! + 0.012;
      const vl = m.vertex(
        [q[0] + nx * HW, y, q[1] + nz * HW],
        UP,
        u,
        0,
        mat,
        aux,
      );
      const vr = m.vertex(
        [q[0] - nx * HW, y, q[1] - nz * HW],
        UP,
        u,
        1,
        mat,
        aux,
      );
      if (i > 0) {
        m.triFacing(prev, prevR, vr, UP);
        m.triFacing(prev, vr, vl, UP);
      }
      prev = vl;
      prevR = vr;
    });
  };
  /** Curve samples every ~0.25 m with their cumulative length. */
  const sample = (f: (t: number) => Vec2, len: number) => {
    const k = Math.max(4, Math.ceil(len / 0.25));
    const pts: Vec2[] = [];
    const s: number[] = [];
    for (let i = 0; i <= k; i++) {
      const p = f(i / k);
      s.push(
        i
          ? s[i - 1] + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1])
          : 0,
      );
      pts.push(p);
    }
    return {pts, s};
  };
  /** The part of a sampled curve between lengths a and b (2.5 m pieces max). */
  const piece = (c: {pts: Vec2[]; s: number[]}, a: number, b: number) => {
    const at = (x: number): Vec2 => {
      let i = 1;
      while (i < c.s.length - 1 && c.s[i] < x) i++;
      const t = (x - c.s[i - 1]) / (c.s[i] - c.s[i - 1] || 1);
      const p = c.pts[i - 1];
      const q = c.pts[i];
      return [lerp(p[0], q[0], t), lerp(p[1], q[1], t)];
    };
    const n = Math.max(1, Math.ceil((b - a) / 2.5));
    ribbon(
      Array.from({length: n + 1}, (_, i) => at(a + ((b - a) * i) / n)),
      a,
    );
  };
  const dashed = (
    c: {pts: Vec2[]; s: number[]},
    on: number,
    off: number,
    from = 0,
    to = Infinity,
  ) => {
    const end = Math.min(to, c.s[c.s.length - 1]);
    for (let a = from; a + 0.3 < end; a += on + off)
      piece(c, a, Math.min(a + on, end));
  };
  /** Cubic from p (heading t0) to q (heading t1), bent through the corner. */
  const turn = (p: Vec2, t0: Vec2, q: Vec2, t1: Vec2, f: number) => {
    const den = t0[0] * t1[1] - t0[1] * t1[0];
    let c0: Vec2;
    let c1: Vec2;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const x =
      Math.abs(den) > 0.2
        ? ((q[0] - p[0]) * t1[1] - (q[1] - p[1]) * t1[0]) / den
        : -1;
    if (x > 0 && x < d * 1.5) {
      const X: Vec2 = [p[0] + t0[0] * x, p[1] + t0[1] * x];
      c0 = [lerp(p[0], X[0], f), lerp(p[1], X[1], f)];
      c1 = [lerp(q[0], X[0], f), lerp(q[1], X[1], f)];
    } else {
      c0 = [p[0] + (t0[0] * d) / 3, p[1] + (t0[1] * d) / 3];
      c1 = [q[0] - (t1[0] * d) / 3, q[1] - (t1[1] * d) / 3];
    }
    const B = (t: number): Vec2 => {
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const e = t * t * t;
      return [
        a * p[0] + b * c0[0] + c * c1[0] + e * q[0],
        a * p[1] + b * c0[1] + c * c1[1] + e * q[1],
      ];
    };
    return {B, len: d * 1.3};
  };
  type ArmF = (typeof F)[number];
  const rightTurn = (A: ArmF, B: ArmF) => {
    const t0: Vec2 = [-A.dir[0], -A.dir[1]];
    // The path of the inner lane's centre (its edges are the guides): a
    // straight run in to the waiting box, a circular arc just inside the
    // centre of the junction, a straight run out.
    const half = Math.min(A.lw, B.lw) / 2 - 0.1;
    const P = A.at(0.15 + A.lw / 2);
    const Q = B.at(-0.15 - B.lw / 2);
    const t1 = B.dir;
    const den = t0[0] * t1[1] - t0[1] * t1[0];
    const dP = ((Q[0] - P[0]) * t1[1] - (Q[1] - P[1]) * t1[0]) / den;
    const dQ = -((Q[0] - P[0]) * t0[1] - (Q[1] - P[1]) * t0[0]) / den;
    if (Math.abs(den) < 0.3 || dP < 6 || dQ < 2) return;
    const T = Math.min(dP - 5.5, dQ * 0.9, dP * 0.6);
    const X: Vec2 = [P[0] + t0[0] * dP, P[1] + t0[1] * dP];
    const a0: Vec2 = [X[0] - t0[0] * T, X[1] - t0[1] * T];
    const a1: Vec2 = [X[0] + t1[0] * T, X[1] + t1[1] * T];
    const path: Vec2[] = [];
    const seg = (p: Vec2, q: Vec2) => {
      const k = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1])));
      for (let i = path.length ? 1 : 0; i <= k; i++)
        path.push([lerp(p[0], q[0], i / k), lerp(p[1], q[1], i / k)]);
    };
    seg(P, a0);
    // Arc a0 -> a1 as a quadratic through X (close to circular here).
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      const u = 1 - t;
      path.push([
        u * u * a0[0] + 2 * u * t * X[0] + t * t * a1[0],
        u * u * a0[1] + 2 * u * t * X[1] + t * t * a1[1],
      ]);
    }
    seg(path[path.length - 1], Q);
    const sides = [-half, half].map(d => {
      const pts = path.map((q, i): Vec2 => {
        const a = path[Math.max(0, i - 1)];
        const b = path[Math.min(path.length - 1, i + 1)];
        const dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [
          q[0] - ((b[1] - a[1]) / dl) * d,
          q[1] + ((b[0] - a[0]) / dl) * d,
        ];
      });
      const s = [0];
      for (let i = 1; i < pts.length; i++)
        s.push(
          s[i - 1] +
            Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
        );
      return {pts, s};
    });
    // Waiting box: the last 5 m of the run in, drawn solid, with a bar at
    // each end (path points are 1 m apart on the straight).
    const kIn = Math.max(1, Math.ceil(dP - T));
    const ib = Math.max(1, Math.round(kIn * (1 - 0.5 / (dP - T))));
    const ia = Math.max(0, ib - 5);
    // Both sides solid along the box; the inner side (+, the turn's centre
    // side) dotted the rest of the way as the guide line.
    for (const c of sides) piece(c, c.s[ia], c.s[ib]);
    const g = sides[1];
    dashed(g, 1, 2, 0, g.s[ia] - 1);
    dashed(g, 1, 2, g.s[ib] + 1);
    for (const i of [ia, ib]) {
      const p = sides[0].pts[i];
      const q = sides[1].pts[i];
      const dx = q[0] - p[0];
      const dz = q[1] - p[1];
      const dl = Math.hypot(dx, dz) || 1;
      // Overlap the side lines by half their width.
      ribbon(
        [
          [p[0] - (dx / dl) * HW, p[1] - (dz / dl) * HW],
          [q[0] + (dx / dl) * HW, q[1] + (dz / dl) * HW],
        ],
        0,
      );
    }
  };
  for (const A of F) {
    if (A.kind < 2) continue;
    const t0: Vec2 = [-A.dir[0], -A.dir[1]];
    // Right turn: the arm best matching the approach's right (-l).
    let B = null;
    let best = 0.7;
    for (const b of F)
      if (b !== A && dot(b.dir, [-A.l[0], -A.l[1]]) > best) {
        best = dot(b.dir, [-A.l[0], -A.l[1]]);
        B = b;
      }
    if (B && B.kind >= 1 && dist2(A.o, B.o) < 45) rightTurn(A, B);
    // Lane lines across the box to the opposite arm (the one most in line
    // with this one, within 3 m: two parallel chains are two roads).
    let C = null;
    let off = 3;
    for (const c of F) {
      if (c === A || c.kind < 2 || dot(c.dir, t0) < 0.94) continue;
      const o = Math.abs(dot([c.o[0] - A.o[0], c.o[1] - A.o[1]], A.l));
      if (o < off) {
        off = o;
        C = c;
      }
    }
    if (C) {
      for (let k = 1; k < Math.min(A.per, C.per); k++) {
        const c = turn(A.at(k * A.lw), t0, C.at(-k * C.lw), C.dir, 0.5);
        dashed({...sample(c.B, c.len)}, 2, 4);
      }
    }
  }
}

function roads(
  L: CityLayout,
  geom: RoadGeom,
  m: CMesh,
  lights: LightList,
  piers: CMesh,
  settled: Float32Array,
) {
  const hf = L.terrain.heights;
  // The rendered terrain (lowered under the roads), for keeping plates above.
  const ground = new Heightfield(hf.size, hf.cell, settled);
  const land = landing(L, geom);
  // Chain end -> junction; a junction gets no plate when at most one of its
  // arms is shown (the lab's site edge: the plate would be a jagged apron
  // over the hidden arms' mouths), and those chain ends get an end kerb.
  const endJunction = new Map<number, number>();
  L.junctions.forEach((j, ji) =>
    j.arms.forEach(a => endJunction.set(a.chain * 2 + a.end, ji)),
  );
  const noPlate = (ji: number) =>
    !!L.hidden &&
    L.junctions[ji].arms.filter(a => !L.hidden!.chains[a.chain]).length <= 1;
  const plateless = (ci: number, end: number) => {
    const ji = endJunction.get(ci * 2 + end) ?? -1;
    return ji < 0 || noPlate(ji);
  };
  L.chains.forEach((c, ci) => {
    if (L.hidden?.chains[ci] || geom.absorbed[ci]) return;
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
      // Lanes, and the chain seed for the shader's resurfacing sections.
      LANES[c.kind] | ((hash2(ci, 0x5eed) & 0xffffff) << 8),
    );
    roadEdges(L, geom, m, land, ci, pts, hs, along, [
      plateless(ci, 0),
      plateless(ci, 1),
    ]);
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
  // Junction surfaces: a two-ring fan whose rim takes each arm's end height
  // (no step where the plate meets the strips), plus the slivers between
  // kerb-return fillets and the strip edges.
  geom.junctions.forEach((jg, ji) => {
    const j = L.junctions[ji];
    if (L.hidden?.junctions[ji] || noPlate(ji)) return;
    const mat = packMat(
      CM.asphaltPlain,
      (hash2(ji, 7) & 0xff) | (j.signal ? 0x100 : 0),
    );
    // Interior vertices never dip under the carved terrain (which follows
    // the nearest road, not the plate's interpolation).
    // aux: the plate centre in quarter metres (shader round 3: oil and
    // rubber gather round it), the cluster's centroid for a merged one.
    let pc: Vec2 = j.p;
    if (jg.low && jg.plate.length) {
      pc = [0, 0];
      for (const q of jg.plate) {
        pc[0] += q[0] / jg.plate.length;
        pc[1] += q[1] / jg.plate.length;
      }
    }
    const paux =
      ((Math.round(pc[0] * 4) + 32768) & 0xffff) |
      (((Math.round(pc[1] * 4) + 32768) & 0xffff) << 16);
    const vert = (q: Vec2, h: number, rim = false) =>
      m.vertex(
        [q[0], rim ? h : Math.max(h, ground.sample(q[0], q[1]) + 0.07), q[1]],
        UP,
        q[0],
        q[1],
        mat,
        paux,
      );
    const n = jg.plate.length;
    if (n >= 3 && !jg.low) {
      const cx = j.p[0],
        cz = j.p[1];
      const ch = jg.centerH;
      const center = vert([cx, cz], ch);
      const mid = jg.plate.map((q, i) =>
        vert(
          [(cx + q[0]) / 2, (cz + q[1]) / 2],
          ch + (jg.plateH[i] - ch) * 0.5,
        ),
      );
      const rim = jg.plate.map((q, i) => vert(q, jg.plateH[i], true));
      const fan: [number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const k = (i + 1) % n;
        m.triFacing(center, mid[i], mid[k], UP);
        m.triFacing(mid[i], rim[i], rim[k], UP);
        m.triFacing(mid[i], rim[k], mid[k], UP);
        fan.push(
          [center, mid[i], mid[k]],
          [mid[i], rim[i], rim[k]],
          [mid[i], rim[k], mid[k]],
        );
      }
      if (j.signal) {
        const tris = fan.map(t => t.map(v => m.pos(v)));
        junctionMarkings(L, geom, m, [ji], (x, z) => plateAt(tris, x, z));
      }
    } else if (n >= 3) {
      // Merged cluster: the hull may overlap strips (it sits 8 mm under
      // them) and spans uneven ground, so it is tessellated to 6 m and
      // follows the terrain wherever that is higher.
      let cx = 0,
        cz = 0;
      for (const q of jg.plate) {
        cx += q[0] / n;
        cz += q[1] / n;
      }
      const P = jg.plate.map((q, i): Vec3 => [q[0], jg.plateH[i], q[1]]);
      const C: Vec3 = [cx, jg.centerH, cz];
      const tris: Vec3[][] = P.map((p, i) => [C, p, P[(i + 1) % n]]);
      const cache = new Map<string, number>();
      const vid = (p: Vec3) => {
        const key = `${p[0].toFixed(2)},${p[2].toFixed(2)}`;
        let v = cache.get(key);
        if (v === undefined) {
          // Under a strip it overlaps, stay 1 cm below that strip.
          let y = p[1] - 0.008;
          const r = land.nearest(p[0], p[2], 0);
          if (r && !geom.absorbed[r.ci]) {
            const c = L.chains[r.ci];
            const ar = geom.arc[r.ci];
            const [s0, s1] = geom.setbacks[r.ci];
            const t1 = ar[ar.length - 1] - s1;
            if (
              r.d < ROAD_WIDTH[c.kind] / 2 + 0.1 &&
              r.s > s0 - 0.5 &&
              r.s < t1 + 0.5
            )
              y = Math.min(
                y,
                chainAt(c, ar, Math.max(s0, Math.min(t1, r.s))).h + 0.01,
              );
          }
          y = Math.max(y, ground.sample(p[0], p[2]) + 0.07);
          v = m.vertex([p[0], y, p[2]], UP, p[0], p[2], mat, paux);
          cache.set(key, v);
        }
        return v;
      };
      const fan: Vec3[][] = [];
      for (const t of subdivide3(tris, 6)) {
        const ids = [vid(t[0]), vid(t[1]), vid(t[2])];
        m.triFacing(ids[0], ids[1], ids[2], UP);
        fan.push(ids.map(v => m.pos(v)));
      }
      const members = jg.members ?? [ji];
      if (members.some(k => L.junctions[k].signal))
        junctionMarkings(L, geom, m, members, (x, z) => plateAt(fan, x, z));
    }
    for (const s of jg.slivers) {
      const ids = s.pts.map((q, i) =>
        m.vertex([q[0], s.h[i], q[1]], UP, q[0], q[1], mat, paux),
      );
      for (let i = 1; i + 1 < ids.length; i++)
        m.triFacing(ids[0], ids[i], ids[i + 1], UP);
    }
  });
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Keep the terrain under the road surface. Block grading (a plane through
 * the curb heights, relaxed inward) and the carve's nearest-road rule leave
 * terrain cells that stand above the road at curbs and between close
 * parallel roads; the terrain's raster "road" colour then pokes through the
 * strips as saw-edged dark blobs. Vertices under the carriageway drop below
 * it, and those under the first metres of sidewalk to the road level (so a
 * bilinear terrain cell cannot rise above the curb line). Only lowers,
 * and only the rendered copy: sidewalks and props keep the graded field
 * (lowering it would let unlowered cells poke through 9 m sidewalk
 * triangles).
 */
function settleRoadbed(L: CityLayout): Float32Array {
  const hf = L.terrain.heights;
  const data = hf.data.slice();
  const n = hf.n;
  const S = hf.size / 2;
  const cell = hf.cell;
  for (const c of L.chains) {
    const half = ROAD_WIDTH[c.kind] / 2;
    const reach = half + Math.min(cell * 0.8, SIDEWALK[c.kind]);
    for (let i = 0; i + 1 < c.pts.length; i++) {
      if (c.bridge[i] || c.bridge[i + 1]) continue;
      const a = c.pts[i];
      const b = c.pts[i + 1];
      const x0 = Math.max(
        0,
        Math.floor((Math.min(a[0], b[0]) - reach + S) / cell),
      );
      const x1 = Math.min(
        n - 1,
        Math.ceil((Math.max(a[0], b[0]) + reach + S) / cell),
      );
      const z0 = Math.max(
        0,
        Math.floor((Math.min(a[1], b[1]) - reach + S) / cell),
      );
      const z1 = Math.min(
        n - 1,
        Math.ceil((Math.max(a[1], b[1]) + reach + S) / cell),
      );
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz || 1;
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          const x = gx * cell - S;
          const z = gz * cell - S;
          const t = Math.max(
            0,
            Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2),
          );
          const d = Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
          if (d > reach) continue;
          const h = lerp(c.heights[i], c.heights[i + 1], t);
          const k = gz * n + gx;
          data[k] = Math.min(data[k], h + (d < half + 0.5 ? -0.08 : 0));
        }
      }
    }
  }
  return data;
}

/** A fill point: position, and a fixed height when it lies on the ring. */
type FillPt = {p: Vec2; h?: number};

/**
 * Triangulate polygon `ring` (with optional per-point heights) clipped to a
 * `cell` grid: about one vertex per cell (bisecting ear-clipped triangles
 * instead turns long skinny ears into fans of tiny triangles). Points on the ring keep a
 * height interpolated along it (so they meet strips built on the ring
 * exactly); interior points have none (the caller samples the terrain).
 */
function gridFill(ring: FillPt[], cell: number): FillPt[][] {
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const {p} of ring) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[1]);
    z1 = Math.max(z1, p[1]);
  }
  const out: FillPt[][] = [];
  const clip = (poly: FillPt[], ax: 0 | 1, v: number, keepBelow: boolean) => {
    const res: FillPt[] = [];
    const inside = (q: FillPt) => (keepBelow ? q.p[ax] <= v : q.p[ax] >= v);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia) res.push(a);
      if (ia !== ib) {
        const t = (v - a.p[ax]) / (b.p[ax] - a.p[ax]);
        const p: Vec2 = [lerp(a.p[0], b.p[0], t), lerp(a.p[1], b.p[1], t)];
        p[ax] = v;
        res.push({
          p,
          h:
            a.h !== undefined && b.h !== undefined
              ? lerp(a.h, b.h, t)
              : undefined,
        });
      }
    }
    return res;
  };
  const gx0 = Math.floor(x0 / cell);
  const gz0 = Math.floor(z0 / cell);
  for (let gz = gz0; gz * cell < z1; gz++) {
    // One row strip, then its cells.
    let row = clip(ring, 1, gz * cell, false);
    row = clip(row, 1, (gz + 1) * cell, true);
    if (row.length < 3) continue;
    for (let gx = gx0; gx * cell < x1; gx++) {
      let c = clip(row, 0, gx * cell, false);
      c = clip(c, 0, (gx + 1) * cell, true);
      // Drop repeated points (clip corners).
      c = c.filter(
        (q, i) => dist2(q.p, c[(i + c.length - 1) % c.length].p) > 1e-4,
      );
      if (c.length < 3) continue;
      const pts = c.map(q => q.p);
      if (Math.abs(polygonArea(pts)) < 1e-3) continue;
      const idx = triangulate(pts);
      for (let i = 0; i < idx.length; i += 3)
        out.push([c[idx[i]], c[idx[i + 1]], c[idx[i + 2]]]);
    }
  }
  return out;
}

/**
 * Emit gridFill() triangles, shared vertices, world-xz uv; points without a
 * ring height sit `lift` above the terrain. `uvOf` overrides uv and aux.
 */
function fillMesh(
  m: CMesh,
  hf: Heightfield,
  tris: FillPt[][],
  mat: number,
  lift: number,
  uvOf?: (p: Vec2) => [number, number, number],
  yOf?: (p: Vec2) => number,
) {
  const cache = new Map<string, number>();
  const vid = (q: FillPt) => {
    const k = `${q.p[0].toFixed(2)},${q.p[1].toFixed(2)}`;
    let v = cache.get(k);
    if (v === undefined) {
      const [u, w, aux] = uvOf ? uvOf(q.p) : [q.p[0], q.p[1], 0];
      v = m.vertex(
        [
          q.p[0],
          q.h ?? (yOf ? yOf(q.p) : hf.sample(q.p[0], q.p[1]) + lift),
          q.p[1],
        ],
        UP,
        u,
        w,
        mat,
        aux,
      );
      cache.set(k, v);
    }
    return v;
  };
  for (const t of tris) m.triFacing(vid(t[0]), vid(t[1]), vid(t[2]), UP);
}

/**
 * Longest-edge bisection in x/z of 3D triangles until edges are short
 * (heights interpolate linearly; shared edges split identically).
 */
function subdivide3(tris: Vec3[][], maxEdge: number): Vec3[][] {
  const out: Vec3[][] = [];
  const stack = tris.slice();
  const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
  while (stack.length) {
    const t = stack.pop()!;
    const e = [d(t[0], t[1]), d(t[1], t[2]), d(t[2], t[0])];
    const mx = Math.max(...e);
    if (mx <= maxEdge || out.length > 20000) {
      out.push(t);
      continue;
    }
    const i = e.indexOf(mx);
    const a = t[i],
      b = t[(i + 1) % 3],
      c = t[(i + 2) % 3];
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    stack.push([a, mid, c], [mid, b, c]);
  }
  return out;
}

/** Kerb face height above the road surface (curb top = road + this). */
const CURB_UP = 0.15;
/** Curb sampling along an edge. */
const CURB_STEP = 9;

/**
 * Block surfaces. Each paved block is a curb band (a strip of up to 2.5 m
 * inside the curb line whose outer edge follows the road surface, uv x =
 * metres along the curb, y = metres in from it; aux per the road contract:
 * road kind, crossing apron, planting strip, tree pit, band width) and the
 * interior plaza inside it (coarser, mostly under buildings). Curb faces
 * are one shared-vertex strip per edge, from road - 0.05 to the band edge.
 * Corners at junctions follow the kerb-return fillets of the road geometry.
 */
function blocks(L: CityLayout, m: CMesh, geom: RoadGeom) {
  const hf = L.terrain.heights;
  const land = landing(L, geom);
  const lift = 0.16;
  // Crossing aprons: near the mouth corners of junctions with crossings.
  const mouths = new Map<number, Vec2[]>();
  const mkey = (x: number, z: number) =>
    (Math.floor(z / 16) + 4096) * 8192 + Math.floor(x / 16) + 4096;
  geom.junctions.forEach((jg, ji) => {
    if (jg.arms.length < 3 || !L.junctions[ji].signal) return;
    for (const q of jg.outline) {
      const k = mkey(q[0], q[1]);
      const l = mouths.get(k);
      if (l) l.push(q);
      else mouths.set(k, [q]);
    }
  });
  const nearMouth = (q: Vec2, r: number) => {
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const p of mouths.get(mkey(q[0] + dx * 16, q[1] + dz * 16)) ?? [])
          if (dist2(p, q) < r) return true;
    return false;
  };
  /** Road surface beside a curb point, and what the band there carries. */
  const roadside = (q: Vec2) => {
    const r = land.nearest(q[0], q[1], 2.5);
    if (!r) return null;
    const c = L.chains[r.ci];
    const arc = geom.arc[r.ci];
    const total = arc[arc.length - 1];
    const [s0, s1] = geom.setbacks[r.ci];
    // Inside a junction the plate rim takes the arm end's height.
    const s = Math.max(s0, Math.min(total - s1, r.s));
    const h = chainAt(c, arc, s).h + 0.02;
    let bits = c.kind & 3;
    const apron = nearMouth(q, 7);
    if (apron) bits |= 4;
    if (c.kind >= 2 && !apron && r.s > s0 + 8 && r.s < total - s1 - 8) {
      // Bus stops (see buildTile) interrupt the planting strip.
      let stop = false;
      for (
        let b = s0 + 40 + (hash2(r.ci, r.side) % 120);
        b < total - s1 - 20;
        b += 300
      )
        if (Math.abs(b - r.s) < 4.8) stop = true;
      if (!stop) bits |= 8;
      // Avenue trees every 13 m from s0 + 10 (shifted clear of lamps).
      const k = Math.round((r.s - s0 - 10) / 13);
      for (let kk = k - 1; kk <= k + 1; kk++) {
        if (kk < 0) continue;
        const ts = avenueTreeS(L, geom, r.ci, r.side, s0 + 10 + kk * 13);
        if (ts < total - s1 - 8 && Math.abs(ts - r.s) < 4.5) bits |= 16;
      }
    }
    return {h, kind: c.kind, bits};
  };
  for (const [bi, b] of L.blocks.entries()) {
    if (L.hidden?.blocks[bi]) continue;
    const poly = b.curb;
    const n = poly.length;
    const fil = geom.fillets.get(bi);
    // Outer ring: per sharp vertex, its fillet arc (or itself).
    const corner = poly.map((q, i) => {
      const f = fil?.get(i);
      return f
        ? {pts: f.pts, h: f.h as (number | null)[]}
        : {pts: [q], h: [null]};
    });
    const ring: Vec2[] = corner.flatMap(c => c.pts);
    if (b.park) {
      parkBlock(L, m, b, ring);
      continue;
    }
    const area = Math.abs(polygonArea(poly));
    const orient = polygonArea(poly) > 0 ? 1 : -1;
    // Per sharp edge i (vertex i -> i+1): road kind and band width.
    const edges = poly.map((a, i) => {
      const c = poly[(i + 1) % n];
      const mid: Vec2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      const r = roadside(mid);
      const kind = r ? r.kind : 1;
      const len = dist2(a, c) || 1;
      const d: Vec2 = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
      // Inward normal (inside is left of a CCW polygon).
      const nrm: Vec2 = [-d[1] * orient, d[0] * orient];
      return {d, nrm, len, bw: Math.min(SIDEWALK[kind], 2.5)};
    });
    // Inner ring: the edges' inset lines meet at mitred corners.
    const inner: Vec2[] = poly.map((q, i) => {
      const A = edges[(i + n - 1) % n];
      const B = edges[i];
      const pa: Vec2 = [q[0] + A.nrm[0] * A.bw, q[1] + A.nrm[1] * A.bw];
      const pb: Vec2 = [q[0] + B.nrm[0] * B.bw, q[1] + B.nrm[1] * B.bw];
      const den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
      if (Math.abs(den) < 0.05)
        return [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      const t = ((pb[0] - pa[0]) * B.d[1] - (pb[1] - pa[1]) * B.d[0]) / den;
      const x: Vec2 = [pa[0] + A.d[0] * t, pa[1] + A.d[1] * t];
      const ml = dist2(x, q);
      const cap = 3 * Math.max(A.bw, B.bw);
      return ml > cap
        ? [q[0] + ((x[0] - q[0]) * cap) / ml, q[1] + ((x[1] - q[1]) * cap) / ml]
        : x;
    });
    // Inner edges that come out reversed (short edges at concave corners)
    // collapse to their midpoint; the band fans there.
    const innerAlong = (i: number) => {
      const a = inner[i];
      const c = inner[(i + 1) % n];
      return (c[0] - a[0]) * edges[i].d[0] + (c[1] - a[1]) * edges[i].d[1];
    };
    for (let it = 0; it < 4 * n; it++) {
      let worst = -1;
      let wv = -1e-3;
      for (let i = 0; i < n; i++) {
        const v = innerAlong(i);
        if (v < wv) {
          wv = v;
          worst = i;
        }
      }
      if (worst < 0) break;
      const a = inner[worst];
      const c = inner[(worst + 1) % n];
      const mid: Vec2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      inner[worst] = mid;
      inner[(worst + 1) % n] = mid;
    }
    let ok = polygonArea(inner) * orient > 0.3 * area;
    for (let i = 0; ok && i < n; i++) if (innerAlong(i) < -1e-3) ok = false;
    if (!ok) {
      fallbackBlock(L, m, ring, roadside);
      continue;
    }
    // Outer samples per edge strip: the corner arc at its start (all on the
    // corner's inner point, a fan), then the edge every <= 9 m up to the
    // next corner's arc.
    const bandMat = packMat(CM.sidewalk, 1);
    const plaza: Vec2[] = [];
    let along = 0;
    const curbTops: {p: Vec2; y: number; hr: number}[][] = [];
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      const j = (i + 1) % n;
      const outer: Vec2[] = [];
      const ins: Vec2[] = [];
      const hs: (number | null)[] = [];
      for (let k = 0; k < corner[i].pts.length; k++) {
        outer.push(corner[i].pts[k]);
        ins.push(inner[i]);
        hs.push(corner[i].h[k]);
      }
      const start = outer[outer.length - 1];
      const end = corner[j].pts[0];
      const span = dist2(start, end);
      const K = Math.max(1, Math.ceil(span / CURB_STEP));
      const P = poly[i];
      for (let k = 1; k <= K; k++) {
        const q: Vec2 = [
          lerp(start[0], end[0], k / K),
          lerp(start[1], end[1], k / K),
        ];
        const u = Math.max(
          0,
          Math.min(
            1,
            ((q[0] - P[0]) * e.d[0] + (q[1] - P[1]) * e.d[1]) / e.len,
          ),
        );
        outer.push(q);
        // The last sample meets the next corner's inner point exactly.
        ins.push(
          k === K
            ? inner[j]
            : [
                lerp(inner[i][0], inner[j][0], u),
                lerp(inner[i][1], inner[j][1], u),
              ],
        );
        hs.push(k === K ? corner[j].h[0] : null);
      }
      // Plaza ring: this edge's inner points (the next edge adds the end).
      for (let k = corner[i].pts.length - 1; k < ins.length - 1; k++)
        plaza.push(ins[k]);
      const bwBits = Math.min(255, Math.round(e.bw / 0.02)) << 8;
      const tops: {p: Vec2; y: number; hr: number}[] = [];
      let prevO = -1;
      let prevI = -1;
      let prevIn: Vec2 | null = null;
      for (let k = 0; k < outer.length; k++) {
        const q = outer[k];
        if (k > 0) along += dist2(outer[k - 1], q);
        const g = hf.sample(q[0], q[1]) + lift;
        const rs = roadside(q);
        const hr = hs[k] ?? (rs ? rs.h : g - lift + 0.05);
        let y = hr + CURB_UP;
        if (Math.abs(y - g) > 0.6) y = g;
        const aux = (rs ? rs.bits : edges[i].bw > 2 ? 3 : 1) | bwBits;
        tops.push({p: q, y, hr});
        const o = m.vertex([q[0], y, q[1]], UP, along, 0, bandMat, aux);
        let iv = prevI;
        const qi = ins[k];
        if (!prevIn || qi[0] !== prevIn[0] || qi[1] !== prevIn[1]) {
          iv = m.vertex(
            [qi[0], hf.sample(qi[0], qi[1]) + lift, qi[1]],
            UP,
            along,
            e.bw,
            bandMat,
            aux,
          );
        }
        if (prevO >= 0) {
          if (iv === prevI) m.triFacing(prevO, o, iv, UP);
          else {
            m.triFacing(prevO, o, iv, UP);
            m.triFacing(prevO, iv, prevI, UP);
          }
        }
        prevO = o;
        prevI = iv;
        prevIn = qi;
      }
      curbTops.push(tops);
    }
    // Interior plaza (param 0, world uv), coarse: the band carries the
    // terrain-following edge where it shows.
    const ringIn: FillPt[] = plaza
      .filter(
        (q, i) => dist2(q, plaza[(i + plaza.length - 1) % plaza.length]) > 0.01,
      )
      .map(p => ({p, h: hf.sample(p[0], p[1]) + lift}));
    fillMesh(m, hf, gridFill(ringIn, 14), packMat(CM.sidewalk), lift);
    blockFill(L, m, b);
    for (const tops of curbTops) curbStrip(m, tops, orient);
  }
}

/**
 * Curb face along one edge's outer samples: a shared-vertex strip from the
 * road (hr - 0.05) to the band edge, normals from the neighbouring samples
 * (smooth around kerb returns). uv: x metres along, y metres up.
 */
function curbStrip(
  m: CMesh,
  tops: {p: Vec2; y: number; hr: number}[],
  orient: number,
) {
  const cm = packMat(CM.curb);
  let along = 0;
  let pb = -1;
  let pt = -1;
  for (let k = 0; k < tops.length; k++) {
    const {p, y, hr} = tops[k];
    if (k > 0) along += dist2(tops[k - 1].p, p);
    const a = tops[Math.max(0, k - 1)].p;
    const c = tops[Math.min(tops.length - 1, k + 1)].p;
    // Outward (toward the road): right of a CCW polygon's direction.
    const n = norm([(c[1] - a[1]) * orient, 0, -(c[0] - a[0]) * orient]);
    const bot = Math.min(hr - 0.05, y - 0.2);
    const vb = m.vertex([p[0], bot, p[1]], n, along, 0, cm);
    const vt = m.vertex([p[0], y, p[1]], n, along, y - bot, cm);
    if (pb >= 0) {
      m.triFacing(pb, vb, vt, n);
      m.triFacing(pb, vt, pt, n);
    }
    pb = vb;
    pt = vt;
  }
}

/** Lawns and car parks laid over a block's paving. */
function blockFill(L: CityLayout, m: CMesh, b: CityLayout['blocks'][number]) {
  const hf = L.terrain.heights;
  const lift = 0.16;
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
}

/** Ring resampled at <= CURB_STEP, closed (first point not repeated). */
function resampleRing(ring: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const c = ring[(i + 1) % ring.length];
    const K = Math.max(1, Math.ceil(dist2(a, c) / CURB_STEP));
    for (let k = 0; k < K; k++)
      out.push([lerp(a[0], c[0], k / K), lerp(a[1], c[1], k / K)]);
  }
  return out;
}

/** A park: grass to the curb (terrain heights), curb faces as one strip. */
function parkBlock(
  L: CityLayout,
  m: CMesh,
  b: CityLayout['blocks'][number],
  ring: Vec2[],
) {
  const hf = L.terrain.heights;
  const lift = 0.16;
  const pts = resampleRing(ring);
  fillMesh(
    m,
    hf,
    gridFill(
      pts.map(p => ({p, h: hf.sample(p[0], p[1]) + lift})),
      10,
    ),
    packMat(CM.grass),
    lift,
  );
  blockFill(L, m, b);
  const orient = polygonArea(ring) > 0 ? 1 : -1;
  const tops = pts.map(p => {
    const g = hf.sample(p[0], p[1]);
    return {p, y: g + lift, hr: g - 0.25};
  });
  tops.push(tops[0]);
  curbStrip(m, tops, orient);
}

/**
 * Fallback when the band cannot be inset (thin or odd blocks): today's
 * whole-block paving, as band material with uv.y = distance to the curb.
 */
function fallbackBlock(
  L: CityLayout,
  m: CMesh,
  ring: Vec2[],
  roadside: (q: Vec2) => {h: number; kind: number; bits: number} | null,
) {
  const hf = L.terrain.heights;
  const lift = 0.16;
  const pts = resampleRing(ring);
  const edgeDist = (q: Vec2) => {
    let d = Infinity;
    for (let i = 0; i < ring.length; i++)
      d = Math.min(d, pointSegment(q, ring[i], ring[(i + 1) % ring.length])[0]);
    return d;
  };
  // Kerb height above the road beside it (as blocks() does), so a sliver
  // between two roads (a boulevard's median, a traffic island) stands as a
  // kerbed island instead of lying flush with (or under) the asphalt.
  const level = (q: Vec2) => {
    const g = hf.sample(q[0], q[1]) + lift;
    const r = roadside(q);
    if (!r) return {y: g, hr: g - lift - 0.25};
    const y = r.h + CURB_UP;
    return Math.abs(y - g) > 0.6 ? {y: g, hr: g - lift - 0.25} : {y, hr: r.h};
  };
  fillMesh(
    m,
    hf,
    gridFill(
      pts.map(p => ({p, h: level(p).y})),
      10,
    ),
    packMat(CM.sidewalk, 1),
    lift,
    q => {
      const r = roadside(q);
      return [0, edgeDist(q), (r ? r.kind & 3 : 1) | (125 << 8)];
    },
    q => level(q).y,
  );
  const orient = polygonArea(ring) > 0 ? 1 : -1;
  const tops = pts.map(p => ({p, ...level(p)}));
  tops.push(tops[0]);
  curbStrip(m, tops, orient);
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
/** RC_COLUMN flag: a 1.2 m column (hw 0.6, 1.2 m of u per face, not 1.0). */
export const RC_WIDE = 0x40;
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
    // Centre cable trough between the tracks: precast lids (RC_TROUGH 'h':
    // uv.x along, so the shader's 1 m lid joints run across it) 22 cm up.
    E([-0.32, 0.22], [0.32, 0.22], 0, 1, conc(RC_TROUGH), 'h');
    E([-3.4, -0.4], [3.4, -0.4], 0, -1, conc(RC_BEAM), 'h');
    for (const s of [-1, 1]) {
      const L = (o: number, y: number): Vec2 => [s * o, y];
      E(L(0.32, 0.22), L(0.32, 0), s, 0, conc(RC_TROUGH), 'v');
      E(L(0.32, 0), L(0.6, 0), 0, 1, bed, 'bed');
      // Ballast: crown, shoulders. Off the platforms the outer shoulder
      // drops 25 cm at about 1:1.6 into a concrete cess along the trough.
      E(L(0.9, 0.15), L(3.6, 0.15), 0, 1, bed, 'bed');
      E(L(0.6, 0), L(0.9, 0.15), -s * 0.447, 0.894, bed, 'bed');
      if (st) E(L(3.6, 0.15), L(4.0, 0), s * 0.351, 0.936, bed, 'bed');
      else {
        E(L(3.6, 0.15), L(4.0, -0.1), s * 0.53, 0.848, bed, 'bed');
        E(L(4.0, -0.1), L(4.3, -0.1), 0, 1, conc(RC_PARAPET), 'h');
      }
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
        // Coping stones: a 0.4 m precast edge 3 cm proud of the paving
        // (its RC_PLATFORM uv carries the white edge line), with a lit
        // step face toward the platform.
        const pl = conc(RC_PLATFORM);
        E(L(3.75, 1.48), L(3.75, 1.2), -s, 0, pf, 'v');
        E(L(3.75, 1.48), L(4.15, 1.48), 0, 1, pl, 'plat');
        E(L(4.15, 1.48), L(4.15, 1.45), s, 0, conc(RC_PARAPET), 'v');
        if (stairOf[i] & (s < 0 ? 1 : 2)) {
          // Stair well (5.4 .. 7.6) through the platform, walled down to
          // the slab soffit, with a 1.05 m balustrade on both long sides.
          const sw = conc(RC_STATION);
          E(L(4.15, 1.45), L(5.3, 1.45), 0, 1, pl, 'plat');
          E(L(5.3, 2.5), L(5.3, 1.45), -s, 0, sw, 'v');
          E(L(5.3, 2.5), L(5.4, 2.5), 0, 1, sw, 'h');
          E(L(5.4, 2.5), L(5.4, -1.2), s, 0, pf, 'v');
          E(L(7.6, 2.5), L(7.6, -1.2), -s, 0, pf, 'v');
          E(L(7.6, 2.5), L(7.7, 2.5), 0, 1, sw, 'h');
          E(L(7.7, 2.5), L(7.7, 1.45), s, 0, sw, 'v');
          E(L(7.7, 1.45), L(9.55, 1.45), 0, 1, pl, 'plat');
        } else E(L(4.15, 1.45), L(9.55, 1.45), 0, 1, pl, 'plat');
        const fence = conc(RC_SOUNDWALL | RC_GLAZED);
        E(L(9.55, 2.65), L(9.55, 1.45), -s, 0, fence, 'v');
        E(L(9.55, 2.65), L(9.7, 2.65), 0, 1, fence, 'h');
        E(L(9.7, 2.65), L(9.7, 1.45), s, 0, fence, 'v');
        E(L(9.7, 1.45), L(9.7, -1.2), s, 0, conc(RC_FASCIA), 'v');
        E(L(9.7, -1.2), L(5.2, -1.2), 0, -1, conc(RC_BEAM), 'h');
        E(L(5.2, -0.9), L(5.2, -1.2), -s, 0, conc(RC_BEAM), 'v');
        // Longitudinal ribs under the platform slab (one between the edge
        // beam and the columns, one over the column line), 0.45 m deep.
        for (const o of [6.7, 8.2]) {
          const rb = conc(RC_BEAM);
          E(L(o - 0.2, -1.2), L(o - 0.2, -1.65), -s, 0, rb, 'v');
          E(L(o - 0.2, -1.65), L(o + 0.2, -1.65), 0, -1, rb, 'h');
          E(L(o + 0.2, -1.2), L(o + 0.2, -1.65), s, 0, rb, 'v');
        }
      } else {
        // Cable trough, parapet with a coping drip lip, fascia.
        const tr = conc(RC_TROUGH);
        E(L(4.3, 0.3), L(4.3, -0.1), -s, 0, tr, 'v');
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
        // Coping light line on every span: a 10 cm LED strip set 5 mm
        // proud of the lip's outer face, the continuous lit edge that keeps
        // the deck line readable at night from any range (lamp side faces
        // glow at x4; 10 cm is ~0.5 px at the far view, enough with TAA).
        E(L(5.435, 1.24), L(5.435, 1.14), s, 0, packMat(CM.lamp, 1), 'v');
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

  // Soundwall stretch ends: the panels stop on a steel end post and a
  // closed end face (the open panel edge read as a placement gap), with a
  // sloped half panel stepping down to the parapet.
  for (let i = e.loop ? 0 : 1; i < segs; i++) {
    const w0 = wallOf(W(i - 1) % segs) !== 0;
    const w1 = wallOf(i) !== 0;
    if (w0 === w1) continue;
    const d = fr[i].d;
    const f = w1 ? -1 : 1;
    const nf: Vec3 = [d[0] * f, 0, d[1] * f];
    const yaw = Math.atan2(d[0], d[1]);
    for (const s of [-1, 1]) {
      const lt = (o: number, y: number, a = 0): Vec3 => {
        const p = P(i, s * o, y);
        return [p[0] + d[0] * f * a, p[1], p[2] + d[1] * f * a];
      };
      m.quad(
        [lt(4.99, 2.87), lt(5.21, 2.87), lt(5.21, 1.25), lt(4.99, 1.25)],
        nf,
        [
          [0, 0],
          [0.22, 0],
          [0.22, 1.62],
          [0, 1.62],
        ],
        conc(RC_PARAPET),
        seed(i),
      );
      // Raking half panel: 2 m long, from the full height down to the
      // parapet, both faces.
      for (const o of [5.04, 5.16])
        m.quad(
          [lt(o, 2.75), lt(o, 1.25), lt(o, 1.25, 2.0), lt(o, 1.4, 2.0)],
          [
            fr[i].l[0] * s * (o > 5.1 ? 1 : -1),
            0,
            fr[i].l[1] * s * (o > 5.1 ? 1 : -1),
          ],
          [
            [0, 0],
            [0, 1.5],
            [-2 * f, 1.5],
            [-2 * f, 1.35],
          ],
          conc(RC_SOUNDWALL),
          seed(i),
        );
      const pp = lt(5.1, 2.0, 0.08);
      m.box(pp, [0.1, 0.9, 0.08], galv, yaw);
    }
  }

  // Chamfered column: four faces whose corners are bevelled by CH; the
  // bevels reuse the faces' vertices, so they shade as a rounded arris (8
  // vertices per ring, fewer than a box). Flat bevels with their own
  // vertices cost 2x (+116k in river) for a 1-2 px line, so the arris read
  // is left to the shader: the bevel is the u span
  // [k * 2hw + 2(hw - CH), (k + 1) * 2hw] of every face k (hw 0.5, or 0.6
  // with RC_WIDE), where the normal already turns through the diagonal.
  // `plinth`: a footing collar 10 cm proud up to 0.45 m above the ground,
  // with a sloped weathered top. UV as CMesh.box (u around, v = metres
  // above y0). Logged as a camera solid.
  const CH = 0.1;
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
    if (hw > 0.55) mat = packMat(CM.concrete, (mat >>> 8) | RC_WIDE);
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
          [y0, hw + 0.1],
          [g + 0.45, hw + 0.1],
          [g + 0.52, hw],
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
  // Downpipes: dark green painted steel (PAINT_STEEL | 3, chipped, rust
  // streaks), dark against the concrete.
  const pipe = packMat(CM.paint, 0x303);

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
        // Station bents carry the platform slab on a second column under a
        // cap beam (edge beam to the slab edge, 1 m deep, 0.8 m wide).
        if (inStation) {
          m.box(
            P(i, s * 7.05, -1.75),
            [2.62, 0.55, 0.4],
            conc(RC_BEAM | rs),
            yaw,
            sd,
            false,
          );
          const o: Vec2 = [q[0] + l[0] * s * 8.2, q[1] + l[1] * s * 8.2];
          const go = hf.sample(o[0], o[1]);
          if (hs[i] - 2.3 - go > 0.5)
            column(
              o,
              go - 1,
              hs[i] - 2.3,
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
        // Bridge number plate on the street face of every column, 2.6 m
        // up: a white enamel plate (the JR board look: white, dark text,
        // line-colour rule), 0.4 x 0.26 m, 6 mm proud.
        if (h > 3.5) {
          const pc = (x: number, y: number): Vec3 => [
            c[0] + l[0] * s * (hw + 0.006) + d[0] * x * s,
            g + 2.6 + y,
            c[1] + l[1] * s * (hw + 0.006) + d[1] * x * s,
          ];
          m.quad(
            [pc(-0.2, 0.13), pc(0.2, 0.13), pc(0.2, -0.13), pc(-0.2, -0.13)],
            [l[0] * s, 0, l[1] * s],
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
            packMat(CM.sign, 56 + ((ei + no) % 8)),
          );
        }
        // Drain downpipe on every 2nd bent, alternate sides: a clamp
        // bracket to the column and a gully box at its foot.
        // It stands off the street-facing (outer) face near a corner, in
        // dark painted steel, so it reads against the pale concrete from the
        // side views; a swan-neck at the top runs into the beam.
        if (no % 2 === 0 && s === (no % 4 === 0 ? 1 : -1) && h > 2) {
          const o = hw + 0.15;
          const a = hw * 0.45 * (no % 8 === 0 ? 1 : -1);
          const at = (y: number, out = o): Vec3 => [
            c[0] + l[0] * s * out + d[0] * a,
            y,
            c[1] + l[1] * s * out + d[1] * a,
          ];
          m.tube(
            [at(g + 0.25), at(cTop - 0.35), at(cTop - 0.1, hw - 0.05)],
            0.11,
            pipe,
          );
          // Clamp straps to the column at 1.8 m and two thirds up.
          for (const y of [g + 1.8, lerp(g, cTop, 0.67)]) {
            m.tube([at(y, hw - 0.02), at(y, o + 0.13)], 0.03, pipe);
          }
          const f = at(g + 0.08);
          m.box(
            [f[0], f[1], f[2]],
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
  // Gado-shita infill: about one bay in four off the roads is walled in
  // under the deck (storage, a bike park or a shop): corrugated steel or
  // precast panel side walls between the columns, a roller shutter at one
  // end and a panel wall at the other, 3.2 m high, a lit fascia sign on
  // the shutter end. Logged as a camera solid.
  for (let i = 0; i < segs; i++) {
    const j = W(i + 1);
    if (station[i] || girder[i] >= 0 || road[i] || road[j]) continue;
    if (railHash(ei + 505, i) >= 0.25) continue;
    const gs: number[] = [];
    let clear = true;
    for (const k of [i, i + 1])
      for (const o of [-4.3, 0, 4.3]) {
        const p = P(k, o, 0);
        const pq: Vec2 = [p[0], p[2]];
        if (onRoad(pq)) clear = false;
        gs.push(hf.sample(pq[0], pq[1]));
      }
    const g0 = Math.min(...gs);
    const g1 = Math.max(...gs);
    if (!clear || g1 - g0 > 0.8) continue;
    if (Math.min(hs[i], hs[j]) - 2.3 - g1 < 4.2) continue;
    const H = g1 + 3.2;
    const y0 = g0 - 0.3;
    const at = (k: number, o: number, y: number, a = 0): Vec3 => {
      const p = P(k, o, 0);
      const d = fr[W(k)].d;
      return [p[0] + d[0] * a, y, p[2] + d[1] * a];
    };
    const len = dist2(pts[i], pts[j]) || 1;
    const hv = railHash(ei + 506, i);
    const side = hv < 0.5 ? packMat(CM.paint, 0xf8) : conc(RC_STATION);
    for (const s of [-1, 1]) {
      const l = fr[i].l;
      m.quad(
        [
          at(i, s * 4.32, H),
          at(i + 1, s * 4.32, H),
          at(i + 1, s * 4.32, y0),
          at(i, s * 4.32, y0),
        ],
        [l[0] * s, 0, l[1] * s],
        [
          [0, 0],
          [len, 0],
          [len, H - y0],
          [0, H - y0],
        ],
        side,
        seed(i),
      );
    }
    // Ends, 0.55 m in from the bents (inside the column line).
    const sh = hv < 0.5 ? i : i + 1;
    for (const [k, f] of [
      [i, 1],
      [i + 1, -1],
    ] as [number, number][]) {
      const d = fr[W(k)].d;
      const shutter = k === sh;
      // Roller shutter: slats run horizontally, so its uv u is height.
      m.quad(
        [
          at(k, -4.32, H, f * 0.55),
          at(k, 4.32, H, f * 0.55),
          at(k, 4.32, y0, f * 0.55),
          at(k, -4.32, y0, f * 0.55),
        ],
        [-d[0] * f, 0, -d[1] * f],
        shutter
          ? [
              [H - y0, 0],
              [H - y0, 8.64],
              [0, 8.64],
              [0, 0],
            ]
          : [
              [0, 0],
              [8.64, 0],
              [8.64, H - y0],
              [0, H - y0],
            ],
        shutter ? packMat(CM.paint, 0xf8) : side,
        seed(k),
      );
      if (shutter) {
        // Shutter box and a lit sign band over it.
        const yaw = Math.atan2(d[0], d[1]);
        const b = at(k, 0, H + 0.25, f * 0.45);
        m.box(b, [4.3, 0.25, 0.12], packMat(CM.paint, 0xd0), yaw, 0, false);
        // A 4:1 shop/operator sign (atlas ids 32-47, uv 0..1).
        m.quad(
          [
            at(k, 1.6 * f, H + 1.0, f * 0.32),
            at(k, -1.6 * f, H + 1.0, f * 0.32),
            at(k, -1.6 * f, H + 0.6, f * 0.32),
            at(k, 1.6 * f, H + 0.6, f * 0.32),
          ],
          [-d[0] * f, 0, -d[1] * f],
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          packMat(CM.sign, 32 + ((ei * 5 + i) % 16)),
        );
      }
    }
    const a = P(i, 0, 0);
    const b = P(i + 1, 0, 0);
    solid(
      [(a[0] + b[0]) / 2, (y0 + H) / 2, (a[2] + b[2]) / 2],
      [4.32, (H - y0) / 2, len / 2 - 0.55],
      Math.atan2(b[0] - a[0], b[2] - a[2]),
    );
  }

  // Bottom flanges of the plate girders: crisp shadow lines.
  for (let i = 0; i < segs; i++) {
    if (girder[i] < 0) continue;
    const gm = packMat(CM.paint, RAIL_GIRDER | (girder[i] & 0x7f));
    for (const o of [-4.4, -3.4, 3.4, 4.4])
      m.beam(P(i, o, -2.63), P(i + 1, o, -2.63), 0.25, 0.03, gm, 0, [0, 1, 0]);
    // Height-clearance marking: a yellow/black hazard band along the bottom
    // 0.45 m of both outer webs over the road (RC_BEAM | RC_ROADSIDE paints
    // its stripes in uv.y 1.1..1.38, so the quad maps exactly that range).
    for (const s of [-1, 1]) {
      const nl: Vec3 = [fr[i].l[0] * s, 0, fr[i].l[1] * s];
      m.quad(
        [
          P(i, s * 4.415, -2.15),
          P(i + 1, s * 4.415, -2.15),
          P(i + 1, s * 4.415, -2.6),
          P(i, s * 4.415, -2.6),
        ],
        nl,
        [
          [12 * i, 1.1],
          [12 * (i + 1), 1.1],
          [12 * (i + 1), 1.38],
          [12 * i, 1.38],
        ],
        conc(RC_BEAM | RC_ROADSIDE),
        seed(i),
      );
    }
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
    // Droppers at every bent between gantries (every 12 m), 14 mm thick so
    // the minimum-width widening keeps them a solid hairline at range.
    for (let k = 0; k < segs; k++) {
      if (isGantry(k)) continue;
      m.tube(
        [P(k, c + stag(k), CW), P(k, c + stag(k), MW - 0.5 * sag(k))],
        0.007,
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
        // A 0.64 x 1.1 m dark backplate under the bottom chord with two
        // 26 cm lenses, so the aspects still cover a pixel or two at mid
        // range (lamps are not min-width tubes).
        // The back of every head carries the aspect for the opposite
        // direction (bidirectional working), so each head shows lit lenses
        // from both ends of the line. Lens boxes stand 9 cm proud: their
        // sides glow too, so a head seen from across the line is still a
        // pair of coloured points.
        const hp = P(i, c + sg * 1.45, 7.3);
        m.box(hp, [0.36, 0.6, 0.06], packMat(CM.frame), yaw);
        for (const ff of [f, -f]) {
          const a = railHash(ei * 3 + (c < 0 ? 1 : 2) + (ff === f ? 0 : 7), i);
          const [up, lo] = a < 0.7 ? [4, 5] : a < 0.9 ? [5, 5] : [3, 3];
          for (const [dy, asp] of [
            [0.27, up],
            [-0.27, lo],
          ] as [number, number][])
            m.box(
              [hp[0] + d[0] * ff * 0.1, hp[1] + dy, hp[2] + d[1] * ff * 0.1],
              [0.15, 0.15, 0.05],
              packMat(CM.lamp, asp),
              yaw,
            );
        }
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
    // Fluorescent fitting under the centre soffit in every bay (a tube
    // hung 12 cm down: its lower faces glow at x44, so it reads as a lit
    // bar from the street at a distance, not only from right below); a
    // light in every 2nd bay with headroom.
    m.tube([mid(i, t0, 0, -0.55), mid(i, t1, 0, -0.55)], 0.07, lamp);
    const c = mid(i, 0.5, 0, -0.6);
    if (i % 2 === 1 && c[1] - hf.sample(c[0], c[2]) > 5)
      lights.add(c, 11, cool, LightKind.station);
    const st = station[i] === 1;
    // Walkway lamp every 3rd bay, alternating sides, on a bracket off the
    // parapet / soundwall (mid-bay, clear of masts and bents).
    // The post rises clear of the soundwall cap (2.87) so the lantern is
    // seen from outside the viaduct too: a 0.6 x 0.16 x 0.22 m opal
    // diffuser (CM.ledLine: every face glows at x20 at night, plain grey by
    // day), about 3 px long at the far view.
    if (!st && i % 3 === 1) {
      const s = Math.floor(i / 3) & 1 ? 1 : -1;
      const wy = wallOf(i) ? 2.3 : 1.25;
      m.tube(
        [
          mid(i, 0.5, s * 5.0, wy),
          mid(i, 0.5, s * 5.0, 3.55),
          mid(i, 0.5, s * 4.55, 3.55),
        ],
        0.035,
        galv,
      );
      const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
      m.box(
        mid(i, 0.5, s * 4.55, 3.44),
        [0.11, 0.08, 0.3],
        packMat(CM.ledLine, 0),
        yaw,
        0,
        false,
      );
      lights.add(mid(i, 0.5, s * 4.55, 3.1), 10, LED, LightKind.station);
    }
    // Fascia up-light every 4th bay, alternating sides: a small lamp on a
    // bracket under the coping lip and a point light just outside the
    // fascia, so the outer face is not a black band at night.
    if (!st && i % 4 === 0) {
      const s = Math.floor(i / 4) & 1 ? 1 : -1;
      const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
      m.box(
        mid(i, 0.5, s * 5.42, -0.98),
        [0.16, 0.07, 0.22],
        lamp,
        yaw,
        0,
        false,
      );
      lights.add(mid(i, 0.5, s * 6.3, -0.4), 8, cool, LightKind.station);
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
  // A parked city bicycle at p (ground), nose along `dir`: two 6-sided
  // tyres, a step-through frame in a faded colour, bars and saddle.
  const BIKE = [0xd5, 0x91, 0x5a, 0xa4, 0x79, 0x30, 0x9c, 0xc4];
  function railBike(p: Vec3, dir: Vec3, k: number) {
    const sd: Vec3 = [dir[2], 0, -dir[0]];
    const B = (x: number, y: number, s = 0): Vec3 => [
      p[0] + dir[0] * x + sd[0] * s,
      p[1] + y,
      p[2] + dir[2] * x + sd[2] * s,
    ];
    const col = packMat(CM.paint, BIKE[k % BIKE.length]);
    for (const wx of [-0.52, 0.52]) {
      const ring: Vec3[] = [];
      for (let q = 0; q <= 6; q++) {
        const a = (q / 6) * Math.PI * 2;
        ring.push(B(wx + Math.cos(a) * 0.31, 0.33 + Math.sin(a) * 0.31));
      }
      m.tube(ring, 0.022, packMat(CM.wire));
    }
    m.tube(
      [B(0.52, 0.33), B(0.34, 0.95), B(0.12, 0.38), B(-0.22, 0.86)],
      0.022,
      col,
    );
    m.tube([B(-0.52, 0.33), B(-0.06, 0.3), B(-0.22, 0.86)], 0.016, col);
    m.tube(
      [B(0.2, 1.02, -0.27), B(0.34, 1.03), B(0.2, 1.02, 0.27)],
      0.014,
      metal,
    );
    m.box(
      B(-0.24, 0.9),
      [0.08, 0.035, 0.13],
      packMat(CM.paint, 0x91),
      Math.atan2(dir[0], dir[2]),
    );
  }

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
        // Hung on two rods 0.35 m lower than before, so the whole board
        // shows under the canopy fascia from the track and the platform
        // ends (bottom edge ~2.05 m above the platform), with a back-lit
        // clock beside it.
        const b = mid(sk, 0.15, o(6.5), CY - 0.85);
        m.box(b, [0.95, 0.27, 0.05], packMat(CM.frame), yaw);
        {
          const l = fr[sk].l;
          for (const x of [-0.7, 0.7])
            m.tube(
              [
                [b[0] + l[0] * x, b[1] + 0.27, b[2] + l[1] * x],
                [b[0] + l[0] * x, hs[sk] + CY + 0.26, b[2] + l[1] * x],
              ],
              0.015,
              metal,
            );
          const ck = [
            b[0] + l[0] * side * 1.35,
            b[1] + 0.05,
            b[2] + l[1] * side * 1.35,
          ] as Vec3;
          m.box(ck, [0.19, 0.19, 0.06], packMat(CM.frame), yaw);
          m.tube([ck, [ck[0], hs[sk] + CY + 0.3, ck[2]]], 0.012, metal);
          for (const f of [-1, 1]) {
            const A = (x: number, y: number): Vec3 => [
              ck[0] + l[0] * x + d[0] * f * 0.062,
              ck[1] + y,
              ck[2] + l[1] * x + d[1] * f * 0.062,
            ];
            flat(
              A(-0.15 * f, -0.15),
              A(0.15 * f, -0.15),
              A(0.15 * f, 0.15),
              A(-0.15 * f, 0.15),
              [d[0] * f, 0, d[1] * f],
              0.3,
              0.3,
              packMat(CM.lamp, 1),
            );
          }
        }
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
      // Platform furniture along the back fence, a bay (12 m) apart in a
      // repeating bench / vending pair / bench / waiting-board rhythm, so
      // there is something every ~12-20 m down the platform.
      const bench = packMat(CM.paint, 0x60);
      for (let k = i0; k < i1; k++) {
        const r = (((k - si) % 4) + 4) % 4;
        const yaw = Math.atan2(fr[k].d[0], fr[k].d[1]);
        if (r === 0 || r === 2) {
          // Bench: seat, back, pedestal (two on the 0 slot).
          for (const a of r === 0 ? [0.3, 0.62] : [0.5]) {
            m.box(mid(k, a, o(8.95), PL + 0.43), [0.22, 0.03, 0.9], bench, yaw);
            m.box(mid(k, a, o(9.2), PL + 0.62), [0.03, 0.2, 0.9], bench, yaw);
            m.box(mid(k, a, o(8.95), PL + 0.2), [0.2, 0.2, 0.75], metal, yaw);
          }
        } else if (r === 1) {
          for (const v of [0, 1]) {
            const c = mid(k, 0.45 + v * 0.08, o(9.15), PL + 0.9);
            // Front (the box's +x face) toward the platform.
            m.box(
              c,
              [0.38, 0.9, 0.45],
              packMat(CM.vending, (k + v + (side > 0 ? 1 : 0)) % 3),
              yaw + (side < 0 ? Math.PI : 0),
            );
          }
        }
        // Platform number signs hanging at both ends of the canopy: blue
        // plates (CM.roadSign 24+, white text line), faced both ways.
        if (k === i0 + 1 || k === i1 - 2) {
          const d = fr[k].d;
          const c = mid(k, 0.5, o(6.8), CY - 0.55);
          const l = fr[k].l;
          for (const f of [-1, 1]) {
            const A = (x: number, y: number): Vec3 => [
              c[0] + l[0] * x + d[0] * f * 0.03,
              c[1] + y,
              c[2] + l[1] * x + d[1] * f * 0.03,
            ];
            flat(
              A(-0.55 * f, 0.25),
              A(0.55 * f, 0.25),
              A(0.55 * f, -0.25),
              A(-0.55 * f, -0.25),
              [d[0] * f, 0, d[1] * f],
              1,
              1,
              packMat(CM.roadSign, 24 + ((si + (side > 0 ? 1 : 0)) % 8)),
            );
          }
          m.box(c, [0.6, 0.29, 0.025], packMat(CM.frame), yaw);
          m.tube(
            [[c[0], c[1] + 0.29, c[2]], P(k, o(6.8), CY + 0.2)],
            0.02,
            metal,
          );
        }
      }
      // Under the platform slab: a fluorescent row between the ribs (two
      // fittings a bay) and a cable duct along the edge beam.
      for (let k = i0; k < i1; k++)
        for (const t of [0.3, 0.7]) {
          const len = dist2(pts[k], pts[W(k + 1)]) || 1;
          m.tube(
            [
              mid(k, t - 0.6 / len, o(7.45), -1.32),
              mid(k, t + 0.6 / len, o(7.45), -1.32),
            ],
            0.06,
            packMat(CM.lamp, 1),
          );
        }
      {
        const ps: Vec3[] = [];
        for (let k = i0; k <= i1; k++) ps.push(P(k, o(5.62), -1.45));
        m.tube(ps, 0.16, packMat(CM.paint, 0x90));
        const ps2: Vec3[] = [];
        for (let k = i0; k <= i1; k++) ps2.push(P(k, o(5.95), -1.35));
        m.tube(ps2, 0.08, packMat(CM.paint, 0x301));
      }
      for (let k = i0; k < i1; k += 2) {
        const c = mid(k, 0.5, o(7.45), -1.2);
        lights.add([c[0], c[1] - 0.6, c[2]], 9, cool, LightKind.station);
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
        // Entrances in the middle of both long sides: a glazed vestibule
        // 1.5 m proud (curtain-wall shader) with a door frame, a deep
        // canopy lit from below with a line-colour fascia band, the station
        // name above; vertical fins and a louvre band on the solid upper
        // band; outdoor AC units at the ends; a bike rack on one side.
        const l = fr[ck + 1].l;
        const dv: Vec2 = [Math.sin(yaw), Math.cos(yaw)];
        for (const s of [-1, 1]) {
          const f = (x: number, y: number, a = 0): Vec3 => [
            cx + l[0] * s * x + dv[0] * a,
            gnd + y,
            cz + l[1] * s * x + dv[1] * a,
          ];
          const out: Vec3 = [l[0] * s, 0, l[1] * s];
          m.box(
            f(10.5, 1.3),
            [0.75, 1.6, 2.1],
            conc(RC_STATION | RC_GLAZED),
            yaw,
            seed(ck + 1),
          );
          // Door frame on the vestibule front: jambs, centre post, transom.
          const fm = packMat(CM.frame);
          for (const a of [-1.15, 0, 1.15])
            m.box(f(11.27, 1.2, a), [0.03, 1.2, 0.05], fm, yaw);
          m.box(f(11.27, 2.42, 0), [0.03, 0.05, 1.2], fm, yaw);
          // Granite threshold step.
          m.box(f(11.6, 0.08, 0), [0.35, 0.1, 1.6], conc(RC_PARAPET), yaw);
          // Canopy: steel slab, lamp underside, line-colour fascia band.
          m.box(f(11.0, 3.05), [1.75, 0.09, 2.9], metal, yaw, 0, false);
          flat(
            f(12.6, 2.95, -2.7),
            f(12.6, 2.95, 2.7),
            f(10.0, 2.95, 2.7),
            f(10.0, 2.95, -2.7),
            [0, -1, 0],
            5.4,
            2.6,
            packMat(CM.lamp, 1),
          );
          m.box(
            f(12.77, 3.05),
            [0.02, 0.16, 2.9],
            packMat(CM.paint, 0x0c),
            yaw,
          );
          if (ub > 1.4)
            m.box(f(9.9, hg + ub / 2), [0.05, 0.55, 3.6], name, yaw);
          // Fins on the upper band every 1.6 m, clear of the name board.
          if (ub > 0.8)
            for (let a = -half + 0.8; a <= half - 0.8; a += 1.6) {
              if (Math.abs(a) < 4.0) continue;
              m.box(
                f(9.97, hg + ub / 2, a),
                [0.12, ub / 2 - 0.08, 0.035],
                metal,
                yaw,
                0,
                false,
              );
            }
          // Louvre band (plant room) along the top of the glazing.
          m.box(
            f(9.8, hg - 0.25, 0),
            [0.06, 0.22, half - 0.4],
            packMat(CM.paint, 0xf8),
            yaw,
          );
          // Outdoor AC units at both ends of this side.
          for (const a of [-half + 1.0, half - 1.0])
            for (const k of [0, 1])
              m.box(
                f(10.25, 0.32 + k * 0.66, a),
                [0.17, 0.32, 0.42],
                packMat(CM.paint, 0xd0),
                yaw,
                0,
                k === 1,
              );
          // Bike parking on the +1 side: a rack rail and a row of bikes.
          if (s > 0) {
            const a0 = 3.2;
            const a1 = Math.min(half - 2.0, a0 + 6.0);
            m.tube([f(10.15, 0.42, a0), f(10.15, 0.42, a1)], 0.025, metal);
            let b = 0;
            for (let a = a0 + 0.3; a < a1; a += 0.62, b++) {
              const p = f(10.8, 0, a);
              railBike(p, out, b + si);
            }
          }
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
        // Rooftop plant: two AC condensers and a louvred vent box; a
        // vertical louvre strip and fins down the street face.
        const d0 = fr[k].d;
        const R = (x: number, a: number, y: number): Vec3 => [
          q[0] + l[0] * side * x + d0[0] * a,
          top + 0.3 + y,
          q[2] + l[1] * side * x + d0[1] * a,
        ];
        for (const a of [-3.6, -2.4])
          m.box(
            R(0.6, a, 0.42),
            [0.42, 0.42, 0.5],
            packMat(CM.paint, 0xd0),
            yaw,
          );
        m.box(R(-0.9, 3.2, 0.6), [0.8, 0.6, 1.4], packMat(CM.paint, 0xf8), yaw);
        for (let a = -5.2; a <= 5.2; a += 1.3) {
          if (Math.abs(a) < 1.8) continue;
          m.box(
            [
              q[0] + l[0] * side * 2.62 + d0[0] * a,
              ground + h * 0.55,
              q[2] + l[1] * side * 2.62 + d0[1] * a,
            ],
            [0.12, h * 0.4, 0.035],
            metal,
            yaw,
            0,
            false,
          );
        }
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
  /** Terrain heights as rendered (lowered under the roads). */
  terrainHeights: Float32Array;
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
  const settled = settleRoadbed(L);
  roads(L, geom, m, lights, piers, settled);
  blocks(L, m, geom);
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
    landUse: landUse(L, mask, L.hidden ? roadMask(L, true, geom) : undefined),
    roadMask: mask,
    geom,
    terrainHeights: settled,
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

/**
 * Where street furniture may stand: spatial lookups over road strips,
 * junction plates and block curbs, built once per layout.
 */
export interface Landing {
  /**
   * True if (x, z) is on a road surface: within ROAD_WIDTH/2 + 0.25 of any
   * chain but `own` (the prop's own chain, placed by offset from it), or on
   * a junction plate.
   */
  onCarriageway(x: number, z: number, own: number): boolean;
  /** Inside a block's curb polygon (hidden lab blocks included). */
  onSidewalk(x: number, z: number): boolean;
  /** Both tests: a sidewalk point clear of every other road. */
  ok(x: number, z: number, own: number): boolean;
  /**
   * Nearest chain within ROAD_WIDTH/2 + 0.25 + `pad` (segment i, parameter
   * t, distance d, arc length s, side +1 = left of the chain), or null.
   */
  nearest(
    x: number,
    z: number,
    pad: number,
  ): {
    ci: number;
    i: number;
    t: number;
    d: number;
    s: number;
    side: number;
  } | null;
  /** Index of the block whose curb polygon holds (x, z), or -1. */
  blockAt(x: number, z: number): number;
  /** On a junction plate's cover polygon. */
  onPlate(x: number, z: number): boolean;
  /**
   * The chain other than `own` (not hidden by the lab, not absorbed) whose
   * carriageway is nearest (x, z) within ROAD_WIDTH/2 + `pad`: its index,
   * distance d from its centre line, unit direction and centre-line point.
   */
  otherRoad(
    x: number,
    z: number,
    own: number,
    pad: number,
  ): {ci: number; d: number; dir: Vec2; p: Vec2} | null;
}

const LAND_CELL = 16;
const landings = new WeakMap<CityLayout, Landing>();

export function landing(L: CityLayout, geom: RoadGeom): Landing {
  const hit = landings.get(L);
  if (hit) return hit;
  const key = (gx: number, gz: number) => (gz + 4096) * 8192 + gx + 4096;
  const add = (
    g: Map<number, number[]>,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    v: number,
  ) => {
    for (
      let gz = Math.floor(z0 / LAND_CELL);
      gz <= Math.floor(z1 / LAND_CELL);
      gz++
    )
      for (
        let gx = Math.floor(x0 / LAND_CELL);
        gx <= Math.floor(x1 / LAND_CELL);
        gx++
      ) {
        const k = key(gx, gz);
        const l = g.get(k);
        if (l) l.push(v);
        else g.set(k, [v]);
      }
  };
  // Segments (chain * 4096 + segment), plates and blocks by cell. Segment
  // boxes are padded 3 m more than the carriageway test needs, for nearest().
  const segs = new Map<number, number[]>();
  L.chains.forEach((c, ci) => {
    const r = ROAD_WIDTH[c.kind] / 2 + 3.25;
    for (let i = 0; i + 1 < c.pts.length; i++) {
      const a = c.pts[i];
      const b = c.pts[i + 1];
      add(
        segs,
        Math.min(a[0], b[0]) - r,
        Math.min(a[1], b[1]) - r,
        Math.max(a[0], b[0]) + r,
        Math.max(a[1], b[1]) + r,
        ci * 4096 + i,
      );
    }
  });
  const box = (poly: Vec2[]) => {
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const q of poly) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      z0 = Math.min(z0, q[1]);
      z1 = Math.max(z1, q[1]);
    }
    return [x0, z0, x1, z1] as const;
  };
  const plates = new Map<number, number[]>();
  const covers: Vec2[][] = [];
  for (const jg of geom.junctions)
    for (const c of jg.cover) {
      add(plates, ...box(c), covers.length);
      covers.push(c);
    }
  const blockGrid = new Map<number, number[]>();
  // Hidden (asset lab) blocks count too: the lab keeps the city's props.
  L.blocks.forEach((b, bi) => add(blockGrid, ...box(b.curb), bi));
  const at = (g: Map<number, number[]>, x: number, z: number) =>
    g.get(key(Math.floor(x / LAND_CELL), Math.floor(z / LAND_CELL))) ?? [];
  const onCarriageway = (x: number, z: number, own: number) => {
    for (const v of at(segs, x, z)) {
      const ci = Math.floor(v / 4096);
      if (ci === own) continue;
      const c = L.chains[ci];
      const i = v % 4096;
      const a = c.pts[i];
      const b = c.pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(
        0,
        Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2),
      );
      const d = Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
      if (d < ROAD_WIDTH[c.kind] / 2 + 0.25) return true;
    }
    for (const k of at(plates, x, z))
      if (pointInPolygon([x, z], covers[k])) return true;
    return false;
  };
  const onSidewalk = (x: number, z: number) =>
    at(blockGrid, x, z).some(bi => pointInPolygon([x, z], L.blocks[bi].curb));
  const nearest = (x: number, z: number, pad: number) => {
    let best: ReturnType<Landing['nearest']> = null;
    let bd = Infinity;
    for (const v of at(segs, x, z)) {
      const ci = Math.floor(v / 4096);
      const c = L.chains[ci];
      const i = v % 4096;
      const a = c.pts[i];
      const b = c.pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(
        0,
        Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2),
      );
      const d = Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
      // Rank by distance past the kerb, so a wide road's curb beats a
      // narrow road's centre line.
      const e = d - ROAD_WIDTH[c.kind] / 2;
      if (e < pad + 0.25 && e < bd) {
        bd = e;
        const cr = dx * (z - a[1]) - dz * (x - a[0]);
        best = {
          ci,
          i,
          t,
          d,
          s: geom.arc[ci][i] + t * Math.sqrt(l2),
          side: cr >= 0 ? 1 : -1,
        };
      }
    }
    return best;
  };
  const blockAt = (x: number, z: number) => {
    for (const bi of at(blockGrid, x, z))
      if (pointInPolygon([x, z], L.blocks[bi].curb)) return bi;
    return -1;
  };
  const onPlate = (x: number, z: number) => {
    for (const k of at(plates, x, z))
      if (pointInPolygon([x, z], covers[k])) return true;
    return false;
  };
  const otherRoad = (x: number, z: number, own: number, pad: number) => {
    let best: ReturnType<Landing['otherRoad']> = null;
    let be = Infinity;
    for (const v of at(segs, x, z)) {
      const ci = Math.floor(v / 4096);
      if (ci === own || L.hidden?.chains[ci] || geom.absorbed[ci]) continue;
      const c = L.chains[ci];
      const i = v % 4096;
      const a = c.pts[i];
      const b = c.pts[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(
        0,
        Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2),
      );
      const px = a[0] + dx * t;
      const pz = a[1] + dz * t;
      const d = Math.hypot(px - x, pz - z);
      const e = d - ROAD_WIDTH[c.kind] / 2;
      if (e < pad && e < be) {
        be = e;
        const l = Math.sqrt(l2);
        best = {ci, d, dir: [dx / l, dz / l], p: [px, pz]};
      }
    }
    return best;
  };
  const out: Landing = {
    onCarriageway,
    onSidewalk,
    ok: (x, z, own) => onSidewalk(x, z) && !onCarriageway(x, z, own),
    nearest,
    blockAt,
    onPlate,
    otherRoad,
  };
  landings.set(L, out);
  return out;
}

export interface LightSpot {
  p: Vec3;
  /** Unit vector from the pole toward the road. */
  dir: Vec2;
  kind: number;
  sodium: boolean;
  /** Road axis angle (radians, atan2 of the chain tangent). */
  angle: number;
}

/**
 * Street light positions (the poles themselves are props in detail tiles),
 * computed once per layout (in the worker; kept in the RoadGeom so the main
 * thread, which has no blocks, reuses them). Spots that would stand on
 * another road or off the sidewalk are dropped.
 */
export function streetLightSpots(
  L: CityLayout,
  geom: RoadGeom,
  hf: Heightfield,
  cb: (
    p: Vec3,
    dir: Vec2,
    kind: number,
    sodium: boolean,
    angle: number,
  ) => void,
) {
  let spots = geom.lightSpots;
  if (!spots) {
    const list: LightSpot[] = [];
    const land = landing(L, geom);
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
          if (!land.ok(x, z, ci)) continue;
          list.push({
            p: [x, sidewalkY(hf, x, z, q.h), z],
            dir: [-l[0] * side, -l[1] * side],
            kind: c.kind,
            sodium,
            angle: Math.atan2(q.d[1], q.d[0]),
          });
        }
      }
    });
    geom.lightSpots = spots = list;
  }
  for (const s of spots) cb(s.p, s.dir, s.kind, s.sodium, s.angle);
}

/**
 * Signal poles of signalized junctions (Japanese horizontal heads on an arm
 * over the approach), shared by the tile props (pole, heads, luminaire) and
 * the base light list (the junction luminaire's light). `arm` indexes
 * geom.junctions[ji].arms.
 */
export function signalSpots(
  L: CityLayout,
  geom: RoadGeom,
  hf: Heightfield,
  ji: number,
  cb: (p: Vec3, armDir: Vec2, reach: number, arm: number) => void,
) {
  const j = L.junctions[ji];
  if (!j.signal || L.hidden?.junctions[ji]) return;
  // Lab site edge: no plate (see roads()), no signals.
  if (L.hidden && j.arms.filter(a => !L.hidden!.chains[a.chain]).length <= 1)
    return;
  const jg = geom.junctions[ji];
  const land = landing(L, geom);
  jg.arms.forEach((a, k) => {
    const l: Vec2 = [-a.dir[1], a.dir[0]];
    // Pole on the right corner of the approach (traffic drives on the left in
    // Tokyo, so oncoming traffic sees the pole on its left/curb side).
    // Where that corner is not sidewalk (close parallel roads), look a
    // little further out and back for one; the arm reaches further.
    if (geom.absorbed[a.chain]) return;
    for (const extra of [0, 1.2, 2.4, 3.6]) {
      for (const back of [1.5, 4, 7]) {
        const off = a.width / 2 + 0.8 + extra;
        const x = j.p[0] + a.dir[0] * (a.setback + back) + l[0] * off;
        const z = j.p[1] + a.dir[1] * (a.setback + back) + l[1] * off;
        if (!land.ok(x, z, a.chain)) continue;
        const p: Vec3 = [x, sidewalkY(hf, x, z, j.h), z];
        cb(p, [-l[0], -l[1]], Math.min(a.width * 0.45, 6) + extra, k);
        return;
      }
    }
  });
}

/** Junction luminaire on a signal pole: arm height and reach over the road. */
export const SIGNAL_LUM = {h: 9.5, reach: 2.5} as const;

/** Horizontal clearance from an avenue tree's trunk to any lamp head. */
const TREE_LAMP_CLEAR = 6.5;
const lampHeads = new WeakMap<RoadGeom, Map<number, Vec2[]>>();
const treeCache = new WeakMap<RoadGeom, Map<string, number>>();
const headKey = (x: number, z: number) =>
  (Math.floor(z / 16) + 4096) * 8192 + Math.floor(x / 16) + 4096;

/**
 * Where avenue tree `s` (nominal arc length on chain ci, `side` +-1 as the
 * tile's tree loop) actually stands: shifted along the chain by up to
 * 6 m, deterministically (smallest shift first, forward before back), so
 * its trunk is TREE_LAMP_CLEAR from every street-light and junction
 * luminaire head (a 9 m lamp head would sit inside the crown). NaN when no
 * shift clears (the tree is dropped). Shared by the tile props (tree, pit)
 * and the curb band's tree-pit bit.
 */
export function avenueTreeS(
  L: CityLayout,
  geom: RoadGeom,
  ci: number,
  side: number,
  s: number,
): number {
  let heads = lampHeads.get(geom);
  let treeShifts = treeCache.get(geom)!;
  if (!heads) {
    treeCache.set(geom, (treeShifts = new Map()));
    const g = new Map<number, Vec2[]>();
    const add = (x: number, z: number) => {
      const k = headKey(x, z);
      const l = g.get(k);
      if (l) l.push([x, z]);
      else g.set(k, [[x, z]]);
    };
    const hf = L.terrain.heights;
    streetLightSpots(L, geom, hf, (p, dir, kind) => {
      const reach = kind >= 2 ? 2.2 : 1.2;
      add(p[0] + dir[0] * reach, p[2] + dir[1] * reach);
    });
    L.junctions.forEach((_, ji) =>
      signalSpots(L, geom, hf, ji, (p, armDir) =>
        add(
          p[0] + armDir[0] * SIGNAL_LUM.reach,
          p[2] + armDir[1] * SIGNAL_LUM.reach,
        ),
      ),
    );
    lampHeads.set(geom, (heads = g));
  }
  const c = L.chains[ci];
  const arc = geom.arc[ci];
  const off = (ROAD_WIDTH[c.kind] / 2 + SIDEWALK[c.kind] * 0.55) * side;
  const clear = (t: number) => {
    const q = chainAt(c, arc, t);
    const x = q.p[0] - q.d[1] * off;
    const z = q.p[1] + q.d[0] * off;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const h of heads!.get(headKey(x + dx * 16, z + dz * 16)) ?? [])
          if (Math.hypot(h[0] - x, h[1] - z) < TREE_LAMP_CLEAR) return false;
    return true;
  };
  const key = `${ci},${side},${s.toFixed(2)}`;
  const hit = treeShifts.get(key);
  if (hit !== undefined) return hit;
  let r = NaN;
  for (let k = 0; k <= 24; k++) {
    const t = s + (k % 2 ? 0.5 : -0.5) * Math.ceil(k / 2);
    if (clear(t)) {
      r = t;
      break;
    }
  }
  treeShifts.set(key, r);
  return r;
}

/**
 * Directed road luminaire light kind (shader round 3): -(0.05 + 0.9 *
 * fract(angle / 2pi)) with `dir` the horizontal throw direction; the pool
 * is pushed forward along it and cut off behind the pole. Still < 0.5 =
 * street light.
 */
function directedKind(dir: Vec2) {
  const a = Math.atan2(dir[1], dir[0]) / (Math.PI * 2);
  return LightKind.street - (0.05 + 0.9 * (a - Math.floor(a)));
}

function streetLights(L: CityLayout, geom: RoadGeom, lights: LightList) {
  const hf = L.terrain.heights;
  streetLightSpots(L, geom, hf, (p, dir, kind, sodium) => {
    const reach = kind >= 2 ? 2.2 : 1.2;
    const h = kind >= 2 ? 9 : 6.5;
    lights.add(
      [p[0] + dir[0] * reach, p[1] + h - 0.4, p[2] + dir[1] * reach],
      kind >= 2 ? 20 : 14,
      sodium ? SODIUM : LED,
      directedKind(dir),
    );
  });
  // Junction luminaires (round pools, kind exactly 0), brighter than the
  // arterial lights so the box is the best-lit place on the road.
  const s = 1.3;
  // Each throws down its approach (the arm's outward direction), lighting
  // the queue up to the stop line.
  L.junctions.forEach((_, ji) =>
    signalSpots(L, geom, hf, ji, (p, armDir, _reach, k) => {
      lights.add(
        [
          p[0] + armDir[0] * SIGNAL_LUM.reach,
          p[1] + SIGNAL_LUM.h - 0.35,
          p[2] + armDir[1] * SIGNAL_LUM.reach,
        ],
        24,
        [LED[0] * s, LED[1] * s, LED[2] * s],
        directedKind(geom.junctions[ji].arms[k].dir),
      );
    }),
  );
}

export {Rng};
