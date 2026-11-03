// Always-resident city geometry: road strips, junctions, bridges, sidewalk
// slabs, parks, elevated rail viaducts and expressways. Also produces the
// street light list and the land-use raster used by the terrain shader.

import {release} from '../mem.ts';
import {Rng, hash2} from '../math/random.ts';
import {
  dist2,
  lerp,
  pointInPolygon,
  pointSegment,
  polygonArea,
  rowCrossings,
  smoothstep,
  type Vec2,
  type Vec3,
} from '../math/vec.ts';
import {
  CM,
  CMesh,
  FINE_TUBE,
  packMat,
  triangulate,
  VERTEX_WORDS,
} from './cmesh.ts';
import {
  LANES,
  ROAD_WIDTH,
  PIER_RADIUS,
  SIDEWALK,
  chainMedians,
  closestOnPolyline,
  elevatedHalfWidth,
  inTunnel,
  type CityLayout,
  type Elevated,
} from './layout.ts';
import {keepLeft, nearside} from './config.ts';
import {chainAt, computeRoadGeom, type RoadGeom} from './roadgeom.ts';
import {signLocaleOf} from './signs.ts';
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
    const half2In = half * half * (1 - 1e-9);
    const half2Out = half * half * (1 + 1e-9);
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
            if (mask[Z * n + X]) continue;
            // The exact distance only near the edge of the band.
            const ex = X * hf.cell - S - x;
            const ez = Z * hf.cell - S - z;
            const d2 = ex * ex + ez * ez;
            if (d2 > half2Out) continue;
            if (d2 < half2In || Math.hypot(ex, ez) < half) mask[Z * n + X] = 1;
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
  const xs: number[] = [];
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
      // pointInPolygon along the row (see rowCrossings).
      const nx = rowCrossings(b.curb, gz * hf.cell - S, xs);
      let c = 0;
      for (
        let gx = Math.max(0, Math.floor((x0 + S) / hf.cell));
        gx <= Math.min(n - 1, Math.ceil((x1 + S) / hf.cell));
        gx++
      ) {
        const x = gx * hf.cell - S;
        while (c < nx && xs[c] <= x) c++;
        if ((nx - c) & 1) out[gz * n + gx] = use;
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
 * Right-turn guides (右折導流線): from each avenue approach's inner lane to
 *   the inner departure lane of the arm on its right: a circular arc as
 *   large as the box allows, tangent to both lanes, ONE dashed line per
 *   movement (the lane's outer edge, 2 m on / 1.5 m off by arc length,
 *   each dash bent along the curve; round 4's two edges per turn with
 *   2.5 m straight dashes read as confetti from above);
 * At most six dashed lines per box (no lane lines carried across: round
 * 6).
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
  const medians = chainMedians(L);
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
      // (Mirrored where traffic keeps right: the approach lanes stay on +l
      // and the crossing turn, toward -l, becomes the left turn.)
      const sd = keepLeft(L.params);
      const l: Vec2 = [-dir[1] * sd, dir[0] * sd];
      const hw = ROAD_WIDTH[c.kind] / 2;
      const per = Math.max(1, Math.floor(LANES[c.kind] / 2));
      // Pier median: the lanes start this far out (as the road shader).
      const med = medians[a.chain];
      // Lateral `lat` (+ approach side), `inset` metres into the box.
      const at = (lat: number, inset = 0.4): Vec2 => [
        q.p[0] + l[0] * lat - dir[0] * inset,
        q.p[1] + l[1] * lat - dir[1] * inset,
      ];
      return {
        kind: c.kind,
        dir,
        l,
        per,
        med,
        lw: (hw - 0.5 - med) / per,
        at,
        o: q.p,
      };
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
    // Each dash in three or more pieces (<= 0.7 m) so it bends with the
    // curve instead of reading as a straight tick across it.
    const n = Math.max(3, Math.ceil((b - a) / 0.7));
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
  type ArmF = (typeof F)[number];
  const rightTurn = (A: ArmF, B: ArmF) => {
    const t0: Vec2 = [-A.dir[0], -A.dir[1]];
    // The path of the turning lane's centre (its outer edge is the guide): a
    // circular arc, as large as the box allows, tangent to the approach
    // lane and to the exit lane (a short straight run in or out only where
    // the box is longer one way), drawn as a rational quadratic Bezier
    // (exact circle) through the corner where the two lanes' lines meet.
    const half = Math.min(A.lw, B.lw) / 2 - 0.1;
    const P = A.at(A.med + 0.15 + A.lw / 2, 0.6);
    const Q = B.at(-B.med - 0.15 - B.lw / 2, 0.6);
    const t1 = B.dir;
    const den = t0[0] * t1[1] - t0[1] * t1[0];
    const dP = ((Q[0] - P[0]) * t1[1] - (Q[1] - P[1]) * t1[0]) / den;
    const dQ = -((Q[0] - P[0]) * t0[1] - (Q[1] - P[1]) * t0[0]) / den;
    if (Math.abs(den) < 0.3 || dP < 3 || dQ < 3) return false;
    const T = Math.min(dP, dQ);
    const X: Vec2 = [P[0] + t0[0] * dP, P[1] + t0[1] * dP];
    const a0: Vec2 = [X[0] - t0[0] * T, X[1] - t0[1] * T];
    const a1: Vec2 = [X[0] + t1[0] * T, X[1] + t1[1] * T];
    // Weight cos(half the turn) makes the conic a circular arc.
    const w = Math.sqrt(Math.max(0.05, (1 + dot(t0, t1)) / 2));
    const path: Vec2[] = [];
    // The arc alone: no straight run in or out (round 5's runs of up to
    // 2 m put straight dashes at the arc ends that read as strays).
    const ka = Math.max(8, Math.ceil((T * 1.6) / 0.5));
    for (let i = path.length ? 1 : 0; i <= ka; i++) {
      const t = i / ka;
      const u = 1 - t;
      const b0 = u * u;
      const b1 = 2 * u * t * w;
      const b2 = t * t;
      const s = b0 + b1 + b2;
      path.push([
        (b0 * a0[0] + b1 * X[0] + b2 * a1[0]) / s,
        (b0 * a0[1] + b1 * X[1] + b2 * a1[1]) / s,
      ]);
    }
    // ONE guide per movement: the lane's outer edge (the larger radius,
    // toward the corner X of the two lane lines), dashed 2 m on / 1.5 m
    // off by arc length, the dashes following the curve. (Round 4 dashed
    // both edges: eight broken arcs per box read as confetti from above.)
    const edge = (d: number) =>
      path.map((q, i): Vec2 => {
        const a = path[Math.max(0, i - 1)];
        const b = path[Math.min(path.length - 1, i + 1)];
        const dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [
          q[0] - ((b[1] - a[1]) / dl) * d,
          q[1] + ((b[0] - a[0]) / dl) * d,
        ];
      });
    const im = path.length >> 1;
    const pos = edge(half);
    const neg = edge(-half);
    const pts = dist2(pos[im], X) < dist2(neg[im], X) ? pos : neg;
    const s = [0];
    for (let i = 1; i < pts.length; i++)
      s.push(
        s[i - 1] +
          Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
      );
    // Centre the dash pattern on the curve so both ends get a whole dash.
    const total = s[s.length - 1];
    const lead = Math.max(0.2, ((total + 1.5) % 3.5) / 2);
    dashed({pts, s}, 2, 1.5, lead, total - 0.2);
    return true;
  };
  // At most MAX_ARCS dashed lines per box. (Round 5 also carried one lane
  // line across the box per arterial approach: its 2-3 straight dashes
  // read as strays beside the arc ends.)
  const MAX_ARCS = 6;
  let arcs = 0;
  for (const A of F) {
    if (A.kind < 2 || arcs >= MAX_ARCS) continue;
    // Right turn: the arm best matching the approach's right (-l).
    let B = null;
    let best = 0.7;
    for (const b of F)
      if (b !== A && dot(b.dir, [-A.l[0], -A.l[1]]) > best) {
        best = dot(b.dir, [-A.l[0], -A.l[1]]);
        B = b;
      }
    if (B && B.kind >= 1 && dist2(A.o, B.o) < 45 && rightTurn(A, B)) arcs++;
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
  const medians = chainMedians(L);
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
    // The shader's x < 0 half carries the traffic toward the strip's end:
    // mirrored across the chain where traffic keeps right.
    const ux = (w / 2) * keepLeft(L.params);
    strip(
      m,
      left.map((q, i) => [q[0], hs[i], q[1]] as Vec3),
      right.map((q, i) => [q[0], hs[i], q[1]] as Vec3),
      along.map(a => [ux, a] as Vec2),
      along.map(a => [-ux, a] as Vec2),
      mat,
      // Lanes, the pier median (quarter metres: the shader lays the lanes
      // out either side of it) and the chain seed for the shader's
      // resurfacing sections.
      LANES[c.kind] |
        (Math.round(medians[ci] * 4) << 4) |
        ((hash2(ci, 0x5eed) & 0xffffff) << 8),
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
      // The hull's heights interpolate between far corners, so on a slope
      // it can lie up to ~20 cm under an arm's mouth: a hard dark step
      // along the crosswalk. Ramp the plate up to each mouth it lies more
      // than 2 cm under: an apron from 10 cm under the strip end (at the
      // strip's height) down to 1 cm over the plate, 0.8-3.5 m in (12x
      // the drop), same material and uv, ahead of the plate for the paint.
      const ramps: Vec3[][] = [];
      for (const k of members) {
        const g = geom.junctions[k];
        g.arms.forEach((a, i) => {
          if (L.hidden?.chains[a.chain] || geom.absorbed[a.chain]) return;
          const ar = geom.arc[a.chain];
          const s = a.end ? ar[ar.length - 1] - a.setback : a.setback;
          const h = chainAt(L.chains[a.chain], ar, s).h + 0.02;
          const A = g.outline[i * 2];
          const B = g.outline[i * 2 + 1];
          const ex = B[0] - A[0];
          const ez = B[1] - A[1];
          const el = Math.hypot(ex, ez) || 1;
          // Into the box (toward the cluster centre).
          let nx = -ez / el;
          let nz = ex / el;
          if ((cx - A[0]) * nx + (cz - A[1]) * nz < 0) {
            nx = -nx;
            nz = -nz;
          }
          const cols = Math.max(2, Math.ceil(el / 3));
          const at = (t: number, d: number): Vec2 => [
            lerp(A[0], B[0], t) + nx * d,
            lerp(A[1], B[1], t) + nz * d,
          ];
          let drop = 0;
          for (let c = 0; c <= cols; c++) {
            const q = at(c / cols, 0.3);
            const y = plateAt(fan, q[0], q[1]);
            if (y !== null) drop = Math.max(drop, h - y);
          }
          if (drop < 0.02) return;
          const len = Math.min(3.5, Math.max(0.8, drop * 12));
          const rows = [-0.1, len].map(d =>
            Array.from({length: cols + 1}, (_, c) => {
              const q = at(c / cols, d);
              const py = plateAt(fan, q[0], q[1]);
              const y =
                d < 0 || py === null
                  ? h - 0.004
                  : Math.max(py + 0.01, lerp(h, py + 0.01, d / len));
              return [q[0], y, q[1]] as Vec3;
            }),
          );
          const ids = rows.map(r =>
            r.map(p => m.vertex(p, UP, p[0], p[2], mat, paux)),
          );
          for (let r = 0; r + 1 < rows.length; r++)
            for (let c = 0; c < cols; c++) {
              const quad = [
                [r, c],
                [r, c + 1],
                [r + 1, c + 1],
                [r + 1, c],
              ];
              for (const [x, y, z] of [
                [0, 1, 2],
                [0, 2, 3],
              ]) {
                const t = [quad[x], quad[y], quad[z]];
                m.triFacing(
                  ids[t[0][0]][t[0][1]],
                  ids[t[1][0]][t[1][1]],
                  ids[t[2][0]][t[2][1]],
                  UP,
                );
                ramps.push(t.map(([rr, cc]) => rows[rr][cc]));
              }
            }
        });
      }
      const surf = [...ramps, ...fan];
      if (members.some(k => L.junctions[k].signal))
        junctionMarkings(L, geom, m, members, (x, z) => plateAt(surf, x, z));
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
  // Points are shared by their coordinates to 1 cm (toFixed(2)); `exact`
  // remembers each exact point's vertex so equal points skip the key.
  const cache = new Map<string, number>();
  const exact = new Map<number, Map<number, number>>();
  const vid = (q: FillPt) => {
    let row = exact.get(q.p[0]);
    if (!row) exact.set(q.p[0], (row = new Map()));
    const e = row.get(q.p[1]);
    if (e !== undefined) return e;
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
    row.set(q.p[1], v);
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
/**
 * The curb band's triangles (as built by blocks()), on a 16 m grid, so
 * tile props lying on the band (utility covers) sit on its actual surface:
 * the band is linear between samples up to CURB_STEP apart, which bandY's
 * exact terrain/road heights miss by several cm on slopes.
 */
class BandTris {
  tris: number[] = [];
  grid = new Map<number, number[]>();
  add(a: Vec3, b: Vec3, c: Vec3) {
    const i = this.tris.length;
    this.tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const x0 = Math.floor(Math.min(a[0], b[0], c[0]) / 16);
    const x1 = Math.floor(Math.max(a[0], b[0], c[0]) / 16);
    const z0 = Math.floor(Math.min(a[2], b[2], c[2]) / 16);
    const z1 = Math.floor(Math.max(a[2], b[2], c[2]) / 16);
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const k = (z + 4096) * 8192 + x + 4096;
        const l = this.grid.get(k);
        if (l) l.push(i);
        else this.grid.set(k, [i]);
      }
  }
  at(x: number, z: number): number | null {
    const k = (Math.floor(z / 16) + 4096) * 8192 + Math.floor(x / 16) + 4096;
    const t = this.tris;
    for (const i of this.grid.get(k) ?? []) {
      const ax = t[i],
        az = t[i + 2],
        bx = t[i + 3],
        bz = t[i + 5],
        cx = t[i + 6],
        cz = t[i + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w = 1 - u - v;
      if (u >= -1e-5 && v >= -1e-5 && w >= -1e-5)
        return t[i + 1] * u + t[i + 4] * v + t[i + 7] * w;
    }
    return null;
  }
}
const bandTrisOf = new WeakMap<RoadGeom, BandTris>();

/** The curb band triangles blocks() recorded for `geom`, for tileGeom(). */
export function bandTrisData(geom: RoadGeom): Float64Array {
  return new Float64Array(bandTrisOf.get(geom)?.tris ?? []);
}

/**
 * What tile generation needs from the base build without building the base
 * mesh (several GB of transient memory across the tile workers): the road
 * geometry, the road mask and the curb band triangles that the primary
 * worker's buildBase() recorded (bandTrisData() of its geometry). The
 * lazily built lookups (landing, light spots, tree shifts) are rebuilt on
 * demand from the same inputs, so tiles come out identical. Without `band`
 * the band is attached later (attachBand), so the rest can be made while
 * the primary is still building the base.
 */
export function tileGeom(
  L: CityLayout,
  band?: Float64Array,
): {geom: RoadGeom; roadMask: Uint8Array} {
  const geom = computeRoadGeom(L);
  if (band) attachBand(geom, band);
  return {geom, roadMask: roadMask(L)};
}

/** Gives `geom` the curb band triangles of bandTrisData(). */
export function attachBand(geom: RoadGeom, band: Float64Array) {
  const bt = new BandTris();
  for (let i = 0; i < band.length; i += 9)
    bt.add(
      [band[i], band[i + 1], band[i + 2]],
      [band[i + 3], band[i + 4], band[i + 5]],
      [band[i + 6], band[i + 7], band[i + 8]],
    );
  bandTrisOf.set(geom, bt);
}

/**
 * Height of the curb band's surface at (x, z), or null where there is no
 * band (or the base mesh was not built in this realm: the tile worker
 * builds it first).
 */
export function bandSurfaceAt(
  geom: RoadGeom,
  x: number,
  z: number,
): number | null {
  return bandTrisOf.get(geom)?.at(x, z) ?? null;
}

function blocks(L: CityLayout, m: CMesh, geom: RoadGeom) {
  const hf = L.terrain.heights;
  const bandTris = new BandTris();
  bandTrisOf.set(geom, bandTris);
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
      let prevOp: Vec3 = [0, 0, 0];
      let prevIp: Vec3 = [0, 0, 0];
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
        const op: Vec3 = [q[0], y, q[1]];
        let iv = prevI;
        let ip = prevIp;
        const qi = ins[k];
        if (!prevIn || qi[0] !== prevIn[0] || qi[1] !== prevIn[1]) {
          ip = [qi[0], hf.sample(qi[0], qi[1]) + lift, qi[1]];
          iv = m.vertex(ip, UP, along, e.bw, bandMat, aux);
        }
        if (prevO >= 0) {
          m.triFacing(prevO, o, iv, UP);
          bandTris.add(prevOp, op, ip);
          if (iv !== prevI) {
            m.triFacing(prevO, iv, prevI, UP);
            bandTris.add(prevOp, ip, prevIp);
          }
        }
        prevO = o;
        prevI = iv;
        prevOp = op;
        prevIp = ip;
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

/**
 * New York rail (the city's sign locale, set by elevatedStructures): third
 * rail instead of overhead wires and masts; platforms without drinks
 * machines or car-position squares, one litter bin instead of the
 * recycling trio.
 */
let platformNyc = false;

function elevatedStructures(
  L: CityLayout,
  geom: RoadGeom,
  mask: Uint8Array,
  m: CMesh,
  lights: LightList,
  solid: Solid,
) {
  platformNyc = signLocaleOf(L.params.type) === 'nyc';
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
  const inRoad = carriageway(L, geom);
  // A pier that would stand on a lower elevated deck becomes a portal frame
  // straddling that deck, its legs out of the carriageways under it (wider
  // than the deck where that is over a road: an expressway's boulevard);
  // false (nothing built) where no span up to 20 m wider finds the legs
  // ground off the roads.
  const pier: Pier = (self, q, top, width, fallback) => {
    for (const o of L.elevated) {
      if (o === self) continue;
      const c = closestOnPolyline(o.pts, q);
      const hw = elevatedHalfWidth(o);
      if (c.d > hw + width + 0.5) continue;
      const a = o.pts[c.i];
      const b = o.pts[c.i + 1];
      const oh = lerp(o.heights[c.i], o.heights[c.i + 1], c.t);
      // A deck above this one, or one in a tunnel under the ground here.
      if (oh > top || oh < hf.sample(q[0], q[1])) continue;
      const len = dist2(a, b) || 1;
      const nx = -(b[1] - a[1]) / len;
      const nz = (b[0] - a[0]) / len;
      const mid: Vec2 = [lerp(a[0], b[0], c.t), lerp(a[1], b[1], c.t)];
      const legsAt = (span: number) =>
        [-1, 1].map(
          s => [mid[0] + nx * span * s, mid[1] + nz * span * s] as Vec2,
        );
      let span = hw + 1.6;
      while (span < hw + 21.6 && legsAt(span).some(g => inRoad(g, 1.4)))
        span += 0.5;
      const legs = legsAt(span);
      if (legs.some(g => inRoad(g, 1.4))) return false;
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
      return true;
    }
    fallback();
    return true;
  };
  L.elevated.forEach((e, ei) => {
    if (e.kind === 'rail') {
      const i0 = m.icount;
      const l0 = lights.data.length;
      railViaduct(e, ei, hf, onRoad, inRoad, pier, m, lights, solid);
      railBufferStops(e, m);
      railTunnels(e, hf, m, i0, lights, l0);
    } else {
      // Piers on the boulevard's median, out of junction boxes (0); 2
      // clear of the crossings and of any other road beside it, 1 on a
      // crossing or where another carriageway overlaps the boulevard's (a
      // layout quirk): those only where the deck would otherwise go
      // unsupported for long.
      const clear = pierClear(L, geom);
      const ok = (q: Vec2) => {
        const c = clear(q);
        return c === 0
          ? 0
          : c === 2 && !inRoad(q, PIER_RADIUS + 0.3, false)
            ? 2
            : 1;
      };
      const legOk = (g: Vec2) => !inRoad(g, 0.9);
      expressway(e, hf, pier, m, lights, ok, legOk, solid);
    }
  });
}

/**
 * Whether q is on a carriageway or within r of one: inside a junction plate
 * or within half the road width plus r of a chain's centerline (exact, on
 * the polylines; the road mask is a 4 m grid). With junctions false, only
 * chains other than those q is on the centerline of.
 */
function carriageway(L: CityLayout, geom: RoadGeom) {
  const G = 32;
  const grid = new Map<number, number[]>();
  const key = (x: number, z: number) =>
    (Math.floor(z / G) + 4096) * 8192 + Math.floor(x / G) + 4096;
  const add = (x0: number, x1: number, z0: number, z1: number, v: number) => {
    for (let z = Math.floor(z0 / G); z <= Math.floor(z1 / G); z++)
      for (let x = Math.floor(x0 / G); x <= Math.floor(x1 / G); x++) {
        const k = (z + 4096) * 8192 + x + 4096;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(v);
      }
  };
  // Reach of the queries (half the widest road plus r <= 4 m).
  const R = ROAD_WIDTH[3] / 2 + 4;
  L.chains.forEach((c, ci) => {
    if (L.hidden?.chains[ci]) return;
    for (let i = 0; i + 1 < c.pts.length; i++) {
      const a = c.pts[i];
      const b = c.pts[i + 1];
      add(
        Math.min(a[0], b[0]) - R,
        Math.max(a[0], b[0]) + R,
        Math.min(a[1], b[1]) - R,
        Math.max(a[1], b[1]) + R,
        ci * 65536 + i,
      );
    }
  });
  geom.junctions.forEach((j, ji) => {
    if (j.outline.length < 3 || L.hidden?.junctions[ji]) return;
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const q of j.outline) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      z0 = Math.min(z0, q[1]);
      z1 = Math.max(z1, q[1]);
    }
    add(x0 - R, x1 + R, z0 - R, z1 + R, -1 - ji);
  });
  return (q: Vec2, r: number, junctions = true) => {
    const near = grid.get(key(q[0], q[1])) ?? [];
    // Not junctions: only other roads than those whose centerline q is on.
    const on = new Set<number>();
    if (!junctions)
      for (const v of near) {
        if (v < 0) continue;
        const c = L.chains[v >> 16];
        const i = v & 0xffff;
        if (pointSegment(q, c.pts[i], c.pts[i + 1])[0] < 0.5) on.add(v >> 16);
      }
    for (const v of near) {
      if (v < 0) {
        if (!junctions) continue;
        const o = geom.junctions[-1 - v].outline;
        if (pointInPolygon(q, o)) return true;
        for (let i = 0; i < o.length; i++)
          if (pointSegment(q, o[i], o[(i + 1) % o.length])[0] < r) return true;
        continue;
      }
      if (on.has(v >> 16)) continue;
      const c = L.chains[v >> 16];
      const i = v & 0xffff;
      if (
        pointSegment(q, c.pts[i], c.pts[i + 1])[0] <
        ROAD_WIDTH[c.kind] / 2 + r
      )
        return true;
    }
    return false;
  };
}

/**
 * Where an expressway pier may stand on the boulevard's pier median
 * (chainMedians): 2 clear of the junctions and the crossings at their
 * mouths (the plate outline plus the 5 m crosswalk band and the pier's
 * radius); 1 on the median across a crossing (people walk round it, as at
 * a median refuge); 0 in a junction box or at its edge, where crossing and
 * turning traffic would run into it.
 */
function pierClear(L: CityLayout, geom: RoadGeom) {
  const reach = 5 + PIER_RADIUS + 1;
  const boxes = geom.junctions.map(j => {
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const q of j.outline) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      z0 = Math.min(z0, q[1]);
      z1 = Math.max(z1, q[1]);
    }
    return [x0 - reach, x1 + reach, z0 - reach, z1 + reach];
  });
  return (q: Vec2) => {
    let ok = 2;
    for (let ji = 0; ji < boxes.length; ji++) {
      const b = boxes[ji];
      if (q[0] < b[0] || q[0] > b[1] || q[1] < b[2] || q[1] > b[3]) continue;
      const o = geom.junctions[ji].outline;
      if (o.length < 3 || L.hidden?.junctions[ji]) continue;
      if (pointInPolygon(q, o)) return 0;
      for (let i = 0; i < o.length; i++) {
        const d = pointSegment(q, o[i], o[(i + 1) % o.length])[0];
        if (d < PIER_RADIUS + 0.5) return 0;
        if (d < reach) ok = 1;
      }
    }
    return ok;
  };
}

/**
 * Open rail line ends: an end wall across the deck and a buffer stop (steel
 * frame, yellow buffer beam, red lamp) on each track, at the terminus
 * platforms, instead of the tracks running off the end of the viaduct.
 */
function railBufferStops(e: Elevated, m: CMesh) {
  if (e.loop) return;
  const n = e.pts.length;
  const fr = frames(e.pts);
  const galv = packMat(CM.metal, GALV);
  for (const k of [0, n - 1]) {
    const inward = k === 0 ? 1 : -1;
    const {d, l} = fr[k];
    const yaw = Math.atan2(d[0], d[1]);
    const q = e.pts[k];
    const at = (along: number, lat: number, y: number): Vec3 => [
      q[0] + d[0] * inward * along + l[0] * lat,
      e.heights[k] + y,
      q[1] + d[1] * inward * along + l[1] * lat,
    ];
    m.box(at(0.3, 0, 0.9), [5.2, 0.9, 0.3], packMat(CM.concrete), yaw);
    for (const c of [-2.1, 2.1]) {
      for (const s of [-0.75, 0.75]) {
        m.box(at(2.3, c + s, RAIL_TOP + 0.5), [0.09, 0.5, 0.09], galv, yaw);
        m.box(at(1.0, c + s, RAIL_TOP + 0.25), [0.09, 0.25, 0.09], galv, yaw);
        m.box(at(1.65, c + s, RAIL_TOP + 0.62), [0.07, 0.07, 0.7], galv, yaw);
      }
      m.box(
        at(2.45, c, RAIL_TOP + 1.05),
        [1.0, 0.2, 0.12],
        packMat(CM.paint, 0x92),
        yaw,
      );
      m.box(
        at(2.4, c, RAIL_TOP + 1.5),
        [0.12, 0.12, 0.06],
        packMat(CM.lamp, 3),
        yaw,
      );
    }
  }
}

/**
 * Rail lines run through hills in tunnels (layout elevateProfile): leave out
 * everything built (from triangle i0 and light l0 on) nearest a point of the
 * line whose deck is under the ground, and close each tunnel mouth with a
 * portal: a concrete headwall round a dark opening.
 */
function railTunnels(
  e: Elevated,
  hf: Heightfield,
  m: CMesh,
  i0: number,
  lights: LightList,
  l0: number,
) {
  const n = e.pts.length;
  const under = e.pts.map((_, i) => inTunnel(e, i, hf));
  if (!under.some(u => u)) return;
  const G = 16;
  const grid = new Map<number, number[]>();
  const key = (gx: number, gz: number) => (gz + 4096) * 8192 + gx + 4096;
  e.pts.forEach((q, i) => {
    const k = key(Math.floor(q[0] / G), Math.floor(q[1] / G));
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  });
  const buried = (x: number, z: number) => {
    const gx = Math.floor(x / G);
    const gz = Math.floor(z / G);
    let bi = -1;
    let bd = Infinity;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++)
        for (const i of grid.get(key(gx + dx, gz + dz)) ?? []) {
          const q = e.pts[i];
          const dd = (q[0] - x) ** 2 + (q[1] - z) ** 2;
          if (dd < bd) {
            bd = dd;
            bi = i;
          }
        }
    return bi >= 0 && under[bi];
  };
  let w = i0;
  for (let t = i0; t < m.icount; t += 3) {
    const a = m.pos(m.idx[t]);
    const b = m.pos(m.idx[t + 1]);
    const c = m.pos(m.idx[t + 2]);
    if (buried((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3)) continue;
    m.idx[w++] = m.idx[t];
    m.idx[w++] = m.idx[t + 1];
    m.idx[w++] = m.idx[t + 2];
  }
  m.icount = w;
  const L = lights.data;
  let lw = l0;
  for (let k = l0; k < L.length; k += LIGHT_FLOATS) {
    if (buried(L[k], L[k + 2])) continue;
    for (let j = 0; j < LIGHT_FLOATS; j++) L[lw + j] = L[k + j];
    lw += LIGHT_FLOATS;
  }
  L.length = lw;
  // Portals where the line goes under: the opening spans both tracks
  // (9.2 m) and 7.4 m over the deck, in a 14 m wide, 0.9 m thick headwall.
  const conc = packMat(CM.concrete);
  const fr = frames(e.pts);
  for (let i = 0; i + 1 < n; i++) {
    if (under[i] === under[i + 1]) continue;
    const a = e.pts[i];
    const b = e.pts[i + 1];
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const h = (e.heights[i] + e.heights[i + 1]) / 2;
    const {d, l} = fr[i];
    // Unit vector into the hill.
    const s = under[i + 1] ? 1 : -1;
    const yaw = Math.atan2(d[0], d[1]);
    const at = (along: number, lat: number, y: number): Vec3 => [
      mid[0] + d[0] * s * along + l[0] * lat,
      h + y,
      mid[1] + d[1] * s * along + l[1] * lat,
    ];
    for (const side of [-1, 1])
      m.box(at(0, side * 5.8, 3.2), [1.2, 5.6, 0.45], conc, yaw, 0, false);
    m.box(at(0, 0, 8.1), [7.0, 0.7, 0.45], conc, yaw, 0, false);
    // Coping along the top.
    m.box(at(-0.1, 0, 8.9), [7.2, 0.1, 0.6], conc, yaw, 0, false);
    // The dark bore a few metres in.
    m.box(at(3, 0, 3.6), [4.6, 3.8, 0.1], packMat(CM.paint, 0x91), yaw);
  }
}

/** Records a camera-solid box (centre, half extents, yaw). */
type Solid = (c: Vec3, h: Vec3, yaw: number) => void;

type Pier = (
  self: Elevated,
  q: Vec2,
  top: number,
  width: number,
  fallback: () => void,
) => boolean;

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
/**
 * RC_FASCIA flag: the recessed shadow band under the coping lip (y 1.06 ..
 * 0.70, set back 8 cm; uv.y 0 .. 0.36 like the fascia below it). It is in
 * the lip's shadow most of the day; the shader may darken it further
 * (grime, ~0.6x) so it carries as a dark line at range in flat light too.
 */
export const RC_RECESS = 0x40;
/**
 * RC_SOUNDWALL panel mix, 2 bits at RC_PANELS_SHIFT ((param >> 7) & 3), per
 * 120 m stretch: 0 = all ribbed grey precast; 1 = ribbed with about one
 * panel in four clear polycarbonate; 2 = ribbed with about one in six a
 * replaced panel in a fresher / other tone; 3 = all three. The shader picks
 * each ~2 m panel's type by hash of its index (floor(uv.x / 2)) and the
 * aux seed, plus a +-8 % tint and grime at the foot.
 */
export const RC_PANELS_SHIFT = 7;
/**
 * Accent span, 2 bits at RC_ACCENT_SHIFT ((param >> 9) & 3) on a span's
 * RC_FASCIA faces (the recess band, fillet and face) and the RC_PARAPET
 * coping lip over them: one span (12 m, bent to bent) in about five, so
 * the deck edge at 300 m has a beat of lighter / darker spans instead of
 * one grey ribbon. 1 = repaired span (fresh, paler patch-repair mortar,
 * crisp ends at the bents); 2 = protective coating (warm grey-beige,
 * flatter, cleaner); 3 = old span (darker, heavier soot and run-off).
 * 0 = normal. Wants roughly +-10-15 % value, readable at the far view.
 */
export const RC_ACCENT_SHIFT = 9;
/** CM.metal params: railhead tube, rail web/foot, galvanised OLE steel. */
export const RAIL_STEEL = 0x4000;
export const RAIL_WEB = 0x4001;
export const GALV = 0x8000;
/** CM.paint param on the OHLE masts: PAINT_STEEL | 7 (dark green paint, chipped). */
export const MAST_PAINT = 0x307;
/** CM.paint params: plate girder over roads (| seed8, 0x80 = board face). */
export const RAIL_GIRDER = 0x500;
export const INSULATOR = 0xf9;
/**
 * CM.screen param on station departure boards (| station index & 0xff);
 * uv 0..1 over the board face. Bit 16: ad screens carry at most a 16-bit
 * seed, so no ad can select the board (city-materials.wgsl screenMat
 * tests `param >> 16 == 1`).
 */
export const DEPARTURE = 0x10000;
/**
 * RC_STATION | RC_GLAZED flag on the concourse clerestory ribbon: the
 * shader adds a warm lit band at night (city-materials.wgsl, "clerestory
 * band" block).
 */
export const RC_CLERESTORY = 0x80;
/** CM.vending flag (| body 0..2) on the display front quad; 0x300 % 3 == 0. */
export const VENDING_FRONT = 0x300;
/**
 * CM.paint param on the station canopy's roof skylight strips (box, metre
 * UVs). In the 0xd0..0xef pale-grey fixture range, so until the shader
 * gives it a look (milky polycarbonate: pale, glossy, faint ribs, a soft
 * glow from the lit platform below at night) it renders as pale grey.
 */
export const SKYLIGHT = 0xd2;
/**
 * CM.paint param on the station canopy fascias (track side, both faces, and
 * the 0.3 m back fascia; uv.x metres along the segment, uv.y metres down
 * from the roof edge). Its own code so the shader can panel it without
 * touching 0xd0 (AC units, bins, plant boxes); in the 0xd0..0xef range, so
 * it falls back to the plain pale-grey paint.
 */
export const CANOPY_FASCIA = 0xd7;
/**
 * CM.sign flag on the concourse's main station-name board (| 64 + k): one
 * JR board unit (2.4 x 0.6 m in the atlas) stretched over a NB_SCALE x
 * larger box face (box UVs, metres from the face's corner), so the name is
 * one big glyph run, not the 2.4 m unit tiled. city-materials.wgsl
 * railNameBoard reads the same NB_SCALE.
 */
export const NAME_BIG = 0x400;
export const NB_SCALE = 4.5;
/**
 * CM.vending flags (| body 0..2) on the platform machines' proud lower-door
 * box (0x100: uv.y from its own bottom) and header box (0x200: uv.y from
 * its own bottom + 1.5); 0x300 is VENDING_FRONT.
 */
export const VENDING_DOOR = 0x100;
export const VENDING_HEADER = 0x200;
/** Railhead top above the deck top (trains.ts sits cars on it). */
export const RAIL_TOP = 0.37;
/** CM.paint param of New York's third-rail cover boards (fibreglass). */
const THIRD_RAIL_BOARD = 0x98;
/** CM.paint param of New York's bike-share blue (city-materials.wgsl). */
export const CITI_BLUE = 0x99;

/** common.wgsl hashu / hashuf, so geometry can sit where a shader hash puts a stain. */
function wgslHashu(x: number) {
  let v = x >>> 0;
  v = (v ^ 61 ^ (v >>> 16)) >>> 0;
  v = Math.imul(v, 9) >>> 0;
  v = (v ^ (v >>> 4)) >>> 0;
  v = Math.imul(v, 0x27d4eb2d) >>> 0;
  return (v ^ (v >>> 15)) >>> 0;
}
const wgslHashuf = (x: number) => (wgslHashu(x) & 0xffffff) / 16777216;
/**
 * Bent-unit u (12 * segment + 0..12) of the scupper streak that
 * city-materials.wgsl deckStains() draws on the RC_FASCIA face of segment i
 * with seed `sd` (aux >> 16): x0 = 12b + 6 + (hashuf(h ^ 0x22) - 0.5) * 1.8.
 */
export function scupperU(sd: number, i: number) {
  const h = wgslHashu((Math.imul(sd, 0x9e3779b1) ^ (i + 65536)) >>> 0);
  return 12 * i + 6 + (wgslHashuf((h ^ 0x22) >>> 0) - 0.5) * 1.8;
}

/** Integer hash of (line, k) to [0, 1): rail variety, not the layout RNG. */
const railHash = (a: number, b: number) => hash2(a * 7919 + 13, b) / 4294967296;

function railViaduct(
  e: Elevated,
  ei: number,
  hf: Heightfield,
  onRoad: (q: Vec2) => boolean,
  inRoad: (q: Vec2, r: number) => boolean,
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
  // Points over a road: the line itself, or a bent column (3.9 m out, 0.6 m
  // half wide) that would stand in a carriageway.
  const road = pts.map(
    (q, i) =>
      onRoad(q) ||
      [-3.9, 3.9].some(o =>
        inRoad([q[0] + fr[i].l[0] * o, q[1] + fr[i].l[1] * o], 0.9),
      ),
  );
  // Under-deck fitting light. At stations, where the deck is too high for
  // its radius to reach the ground (the columns were lit and the ground
  // black), a second, low pool light 5.2 m over the ground under it
  // (LightKind.station: lighting.wgsl lights nothing much above it and
  // throws a cone onto the ground), so the ground gets its pools.
  const underLight = (p: Vec3, r: number, col: Vec3, pool: boolean) => {
    lights.add(p, r, col, LightKind.station);
    const gy = hf.sample(p[0], p[2]);
    if (pool && p[1] - gy > r - 2 && p[1] - gy > 7.5)
      lights.add(
        [p[0], gy + 5.2, p[2]],
        8,
        [col[0] * 0.4, col[1] * 0.4, col[2] * 0.4],
        LightKind.station,
      );
  };
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
  // Accent spans (RC_ACCENT_SHIFT): whole joint-bounded blocks of four
  // spans (bents 4b + 2 .. 4b + 6, between the expansion-joint cover
  // plates at i % 4 == 2, where the shader keeps its hard span breaks),
  // about three blocks in ten, with a hashed kind 1..3; never a block
  // touching a station.
  const accentOf = (i: number) => {
    const b = Math.floor((i - 2) / 4);
    if (railHash(ei + 1201, b) >= 0.3) return 0;
    for (let k = 4 * b + 2; k < 4 * b + 6; k++)
      if (station[W(k) % segs]) return 0;
    return 1 + Math.floor(railHash(ei + 1202, b) * 3);
  };
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
    // Panel mix of the stretch (RC_PANELS field, see its doc).
    const mix = Math.min(3, Math.floor(railHash(ei + 202, b) * 4));
    return (
      RC_SOUNDWALL |
      (railHash(ei + 101, b) < 0.5 ? RC_GLAZED : 0) |
      (mix << RC_PANELS_SHIFT)
    );
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
    /** 'v' faces: the y their uv.y counts down from (default: their top). */
    top?: number;
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
      top?: number,
    ) => out.push({a, b, nl, ny, mat, uv, top});
    const st = station[i] === 1;
    const g = girder[i];
    const bed = packMat(CM.rail);
    // Centre cable trough between the tracks: precast lids (RC_TROUGH 'h':
    // uv.x along, so the shader's 1 m lid joints run across it) 22 cm up,
    // sat 2 cm down between 5 cm rims (RC_PARAPET 'h', paler precast) so
    // it reads as a channel with lids, not a paved strip.
    E([-0.32, 0.22], [0.32, 0.22], 0, 1, conc(RC_TROUGH), 'h');
    E([-0.32, 0.24], [-0.27, 0.24], 0, 1, conc(RC_PARAPET), 'h');
    E([0.27, 0.24], [0.32, 0.24], 0, 1, conc(RC_PARAPET), 'h');
    E([-3.4, -0.4], [3.4, -0.4], 0, -1, conc(RC_BEAM), 'h');
    for (const s of [-1, 1]) {
      const L = (o: number, y: number): Vec2 => [s * o, y];
      E(L(0.32, 0.24), L(0.32, 0), s, 0, conc(RC_TROUGH), 'v');
      E(L(0.32, 0), L(0.6, 0), 0, 1, bed, 'bed');
      // Ballast: crown, shoulders. Off the platforms the outer shoulder
      // starts 20 cm past the sleeper ends and drops 32 cm at about 1:2.3
      // into a concrete cess along the trough: 0.75 m of sloped stone,
      // wide enough to read from the along view.
      E(L(0.6, 0), L(0.9, 0.15), -s * 0.447, 0.894, bed, 'bed');
      if (st) {
        E(L(0.9, 0.15), L(3.6, 0.15), 0, 1, bed, 'bed');
        E(L(3.6, 0.15), L(4.0, 0), s * 0.351, 0.936, bed, 'bed');
      } else {
        E(L(0.9, 0.15), L(3.3, 0.15), 0, 1, bed, 'bed');
        E(L(3.3, 0.15), L(4.05, -0.17), s * 0.392, 0.92, bed, 'bed');
        E(L(4.05, -0.17), L(4.3, -0.17), 0, 1, conc(RC_PARAPET), 'h');
      }
      // New York: a third rail inboard of each track (its head a tube, see
      // the railheads below) under a cover board on brackets: the board's
      // top and its two edges.
      if (platformNyc) {
        const cb = packMat(CM.paint, THIRD_RAIL_BOARD);
        E(L(0.72, 0.52), L(0.98, 0.52), 0, 1, cb, 'h');
        E(L(0.72, 0.52), L(0.72, 0.48), -s, 0, cb, 'v');
        E(L(0.98, 0.52), L(0.98, 0.48), s, 0, cb, 'v');
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
        // Line-colour band along the platform's outer fascia (2 cm proud,
        // 0.45 m), the station's colour read from the street and at range.
        const lc = packMat(CM.paint, 0x0c);
        E(L(9.72, 0.95), L(9.72, 0.5), s, 0, lc, 'v');
        E(L(9.7, 0.95), L(9.72, 0.95), 0, 1, lc, 'h');
        E(L(9.7, 0.5), L(9.72, 0.5), 0, -1, lc, 'h');
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
        // Two precast cable troughs side by side (signal 4.3..4.6, power
        // 4.6..4.9, 6 cm higher), the track-side one with a 5 cm rim
        // (RC_PARAPET 'h') standing 2.5 cm proud of its lids (RC_TROUGH
        // 'h', running under the rim), the step between them, and a 5 cm
        // dark gap to the parapet: a raised channel with lids rather than
        // one flat walkway slab.
        const tr = conc(RC_TROUGH);
        const pa = conc(RC_PARAPET);
        E(L(4.3, 0.32), L(4.3, -0.17), -s, 0, tr, 'v');
        E(L(4.3, 0.32), L(4.35, 0.32), 0, 1, pa, 'h');
        E(L(4.3, 0.295), L(4.6, 0.295), 0, 1, tr, 'h');
        E(L(4.6, 0.355), L(4.6, 0.295), -s, 0, tr, 'v');
        E(L(4.6, 0.355), L(4.9, 0.355), 0, 1, tr, 'h');
        E(L(4.9, 0.355), L(4.9, 0.2), s, 0, tr, 'v');
        E(L(4.9, 0.2), L(4.95, 0.2), 0, 1, pa, 'h');
        E(L(4.95, 1.25), L(4.95, 0.2), -s, 0, pa, 'v');
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
        // Coping drip lip 19 cm deep (was 12): its soffit and the shadow
        // it throws on the fascia are the hard dark line under the pale
        // coping that carries the deck edge at range.
        const acc = accentOf(i) << RC_ACCENT_SHIFT;
        E(L(5.43, 1.25), L(5.43, 1.06), s, 0, conc(RC_PARAPET | acc), 'v');
        E(L(5.43, 1.06), L(5.12, 1.06), 0, -1, pa, 'h');
        // Shadow band: the top 0.36 m of the fascia is set back 8 cm
        // (RC_FASCIA | RC_RECESS) under the lip, then a 45-degree
        // weathering fillet steps it out to the face: with the lip soffit
        // a ~0.55 m dark band under the coping that survives to the far
        // view (3-4 px), over a lit fillet line. All three keep the
        // fascia's uv.y (metres down from 1.06) so formwork, scupper
        // streaks and stains run straight across them.
        const fa = conc(RC_FASCIA | acc);
        E(
          L(5.12, 1.06),
          L(5.12, 0.7),
          s,
          0,
          conc(RC_FASCIA | RC_RECESS | acc),
          'v',
          1.06,
        );
        E(L(5.12, 0.7), L(5.2, 0.62), s * 0.707, 0.707, fa, 'v', 1.06);
        E(L(5.2, 0.62), L(5.2, -0.9), s, 0, fa, 'v', 1.06);
        // LED strip under the coping lip (lamp faces down: lit at night).
        if (glowOf(i, s))
          E(L(5.23, 1.03), L(5.4, 1.03), 0, -1, packMat(CM.lamp, 1), 'h');
        // (The coping light line is a lamp tube, see copingLine below.)
        {
          // Galvanised cable tray on both outer fascias (0.45 m deep, 0.45
          // out, a 4 cm return lip on top, the dark cable bundle showing
          // over it): its soffit throws a shadow line on the fascia under
          // it, read from the street (the under-deck tray is hidden there).
          // (Round 8: the -1 side had a concrete trough the fascia's own
          // tone, and the side views look at the -1 side: no tray read.
          // Its outer face is dark green painted steel, MAST_PAINT, so it
          // reads as a dark line against the pale fascia from the street.)
          const trayM = packMat(CM.paint, MAST_PAINT);
          E(L(5.25, -0.1), L(5.65, -0.1), 0, -1, galv, 'h');
          E(L(5.65, 0.35), L(5.65, -0.1), s, 0, trayM, 'v');
          E(L(5.65, 0.35), L(5.61, 0.35), 0, 1, trayM, 'h');
          E(L(5.61, 0.35), L(5.61, 0.31), -s, 0, galv, 'v');
          E(L(5.25, 0.22), L(5.61, 0.22), 0, 1, packMat(CM.paint, 0x301), 'h');
        }
      }
      if (s > 0 && g < 0 && !st) {
        // Cable tray along the +1 side just inside the column line, hung
        // under the transverse beams' haunches (y -2.95, 2.55 m under the
        // centre soffit: at -1.25 it was hidden between the beams from the
        // ground): a 0.6 m galvanised bottom, 20 cm lips both sides and the
        // cable bundle showing over them, on drop rods every bay.
        E(L(2.7, -2.95), L(3.3, -2.95), 0, -1, galv, 'h');
        E(L(2.7, -2.75), L(2.7, -2.95), -s, 0, galv, 'v');
        E(L(3.3, -2.75), L(3.3, -2.95), s, 0, galv, 'v');
        E(L(2.72, -2.8), L(3.28, -2.8), 0, 1, packMat(CM.paint, 0x301), 'h');
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
        // Every span's outer web has 0x80 set: the shader paints the
        // clearance board there (and on the proud plate added below).
        const gm = packMat(CM.paint, RAIL_GIRDER | (g & 0x7f));
        const board = packMat(CM.paint, RAIL_GIRDER | 0x80 | (g & 0x7f));
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
    const keys = per.map(es => es.map(edgeKey));
    const done = per.map(es => es.map(() => false));
    for (let s = 0; s < per.length; s++) {
      for (let k = 0; k < per[s].length; k++) {
        if (done[s][k]) continue;
        const x = per[s][k];
        const key = keys[s][k];
        // Extend the run over following segments with the same edge.
        let s1 = s + 1;
        for (; s1 < per.length; s1++) {
          const ks = keys[s1];
          const j = per[s1].findIndex((_, q) => !done[s1][q] && ks[q] === key);
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
          return [u, (x.top ?? top) - p[1]];
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

  // Soundwall stretch ends: the panels stop on a steel H end post standing
  // proud of the coping, with a closed end face, then a 6 m raking taper
  // (both faces, its own sloped coping cap) down to the parapet: the wall
  // steps down instead of stopping dead. Next to a
  // platform (no room) only the end post and face.
  for (let i = e.loop ? 0 : 1; i < segs; i++) {
    const prev = W(i - 1) % segs;
    const w0 = wallOf(prev);
    const w1 = wallOf(i);
    if ((w0 !== 0) === (w1 !== 0)) continue;
    const d = fr[i].d;
    const f = w1 ? -1 : 1;
    const wall = w1 || w0;
    const taper = !station[w1 ? prev : i];
    const TL = 6;
    const nf: Vec3 = [d[0] * f, 0, d[1] * f];
    const yaw = Math.atan2(d[0], d[1]);
    const u0 = 12 * i;
    for (const s of [-1, 1]) {
      const lt = (o: number, y: number, a = 0): Vec3 => {
        const p = P(i, s * o, y);
        return [p[0] + d[0] * f * a, p[1], p[2] + d[1] * f * a];
      };
      const nl = (k: number): Vec3 => [
        fr[i].l[0] * s * k,
        0,
        fr[i].l[1] * s * k,
      ];
      if (taper) {
        // Panels: top from 2.75 down to 1.35 over TL (uv.y from the top
        // of the full-height panel, as on the run).
        for (const o of [5.04, 5.16])
          m.quad(
            [lt(o, 2.75), lt(o, 1.25), lt(o, 1.25, TL), lt(o, 1.35, TL)],
            nl(o > 5.1 ? 1 : -1),
            [
              [u0, 0],
              [u0, 1.5],
              [u0 + f * TL, 1.5],
              [u0 + f * TL, 1.4],
            ],
            conc(wall),
            seed(i),
          );
        // Raking coping cap: top and both sides.
        m.quad(
          [
            lt(4.99, 2.87),
            lt(5.21, 2.87),
            lt(5.21, 1.47, TL),
            lt(4.99, 1.47, TL),
          ],
          UP,
          [
            [u0, 4.99],
            [u0, 5.21],
            [u0 + f * TL, 5.21],
            [u0 + f * TL, 4.99],
          ],
          conc(RC_PARAPET),
          seed(i),
        );
        for (const o of [4.99, 5.21])
          m.quad(
            [lt(o, 2.87), lt(o, 2.74), lt(o, 1.34, TL), lt(o, 1.47, TL)],
            nl(o > 5.1 ? 1 : -1),
            [
              [u0, 0],
              [u0, 0.13],
              [u0 + f * TL, 0.13],
              [u0 + f * TL, 0],
            ],
            conc(RC_PARAPET),
            seed(i),
          );
      } else {
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
      }
      // H end post: 0.2 m flanges, 0.25 m deep, 25 cm above the cap.
      m.box(lt(5.1, 2.18, -0.06), [0.13, 0.94, 0.1], galv, yaw);
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
    cap = false,
  ) => {
    solid([c[0], (y0 + y1) / 2, c[1]], [hw, (y1 - y0) / 2, hw], yaw);
    if (hw > 0.55) mat = packMat(CM.concrete, (mat >>> 8) | RC_WIDE);
    if (cap) {
      // Bearing plinth at the column head: a 0.3 m block 8 cm proud all
      // round under the beam, its soffit a crisp shadow line where every
      // column meets the deck. (One box: a dark bearing bed above it as
      // well cost +56k vertices in river.)
      y1 -= 0.3;
      m.box(
        [c[0], y1 + 0.15, c[1]],
        [hw + 0.08, 0.15, hw + 0.08],
        packMat(CM.concrete, RC_BEAM),
        yaw,
        aux,
        false,
      );
    }
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
          // (Not in a carriageway: the cap beam carries the slab there.)
          if (hs[i] - 2.3 - go > 0.5 && !inRoad(o, 0.6))
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
            h > 3,
          );
        // Electrical conduit down about one column in three (not the
        // girder-flank bents, whose cap hides the head): a grey steel pipe
        // on the inner face up past the column head; on the +1 side a
        // junction box at 1.6 m and a bend into the cable tray.
        if (!flank && h > 3 && (no + (s > 0 ? 0 : 1)) % 3 === 0) {
          const cx = 3.9 - hw - 0.07;
          const at = (y: number, x = cx): Vec3 => {
            const p = P(i, s * x, 0);
            return [p[0] + d[0] * 0.28, y, p[2] + d[1] * 0.28];
          };
          const conduit = packMat(CM.paint, 0x90);
          const tray = s > 0 && !inStation;
          const ys = tray ? hs[i] - 2.85 : cTop - 0.05;
          const run = [at(g + 0.15), at(ys)];
          if (tray) {
            run.push(at(ys, 3.0));
            m.box(at(g + 1.6, cx - 0.04), [0.08, 0.2, 0.15], conduit, yaw);
          }
          m.tube(run, 0.04, conduit);
        }
        // Maintenance ladder up the street face of one bent in six
        // (alternating sides, so 12 columns apart on a side; piers under 26 m, a 90 m caged ladder in a
        // valley is not a thing): a caged steel ladder from 2.3 m (anti-climb
        // gap) on stand-offs to the column, edge beam and fascia, through a
        // hatch in a grated rest platform with a handrail at the bearing
        // level (a solid bump on the pier at mid / far range). Off the
        // soundwalls its stiles carry 1.05 m over the coping and over into
        // the walkway; on a soundwall stretch it tops out at a railed
        // landing outside the wall at coping level with an access door in
        // the wall behind it.
        const lwall =
          i < segs ? wallOf(i) !== 0 || wallOf(W(i - 1) % segs) !== 0 : true;
        if (
          !inStation &&
          !flank &&
          h > 4 &&
          h < 26 &&
          no % 6 === 3 &&
          s === (Math.floor(no / 6) & 1 ? 1 : -1) &&
          i < segs
        ) {
          const X = 5.75;
          const A = (x: number, y: number, a: number): Vec3 => {
            const p = P(i, s * x, 0);
            return [p[0] + d[0] * a, y, p[2] + d[1] * a];
          };
          const yb = g + 2.3;
          const yc = hs[i] + 1.25;
          const yt = yc + 1.05;
          for (const a of [-0.22, 0.22]) {
            m.tube(
              lwall
                ? [A(X, yb, a), A(X, yt, a)]
                : [A(X, yb, a), A(X, yt, a), A(5.15, yt, a), A(5.15, yc, a)],
              0.03,
              galv,
            );
            // Stand-offs: column face, edge beam, fascia.
            for (const [y, x] of [
              [g + 3.0, 4.4],
              [hs[i] - 1.6, 4.4],
              [hs[i] - 0.2, 5.2],
            ])
              m.tube([A(X, y, a), A(x, y, a)], 0.022, galv, FINE_TUBE);
          }
          for (let y = yb + 0.3; y < yc; y += 0.9)
            m.tube([A(X, y, -0.22), A(X, y, 0.22)], 0.016, galv, FINE_TUBE);
          // Railed grated platforms: x0..x1 out from the deck, 1.6 m along.
          const platform = (y: number, x0: number, x1: number) => {
            const pc = P(i, s * ((x0 + x1) / 2), y - 0.03);
            m.box(
              [pc[0], y - 0.03, pc[2]],
              [(x1 - x0) / 2, 0.03, 0.8],
              galv,
              Math.atan2(d[0], d[1]),
              0,
              false,
            );
            const rail = [
              A(x0, y + 1.1, -0.8),
              A(x1, y + 1.1, -0.8),
              A(x1, y + 1.1, 0.8),
              A(x0, y + 1.1, 0.8),
            ];
            m.tube(rail, 0.024, galv);
            for (const [x, a] of [
              [x1, -0.8],
              [x1, 0.8],
            ])
              m.tube([A(x, y, a), A(x, y + 1.1, a)], 0.024, galv);
            // Toe board along the outer edge.
            m.box(
              A(x1, y + 0.07, 0),
              [0.01, 0.07, 0.8],
              galv,
              Math.atan2(d[0], d[1]),
            );
          };
          const yp = hs[i] - 2.45;
          if (yp - yb > 2.5) platform(yp, 4.42, 6.55);
          if (lwall) {
            platform(yc - 0.02, 5.45, 6.55);
            // Access door in the soundwall behind the landing.
            const dq = (x: number, y: number, a: number) => A(x, y, a);
            m.quad(
              [
                dq(5.167, yc + 1.45, -0.42),
                dq(5.167, yc + 1.45, 0.42),
                dq(5.167, yc + 0.05, 0.42),
                dq(5.167, yc + 0.05, -0.42),
              ],
              [l[0] * s, 0, l[1] * s],
              [
                [0, 0],
                [0.84, 0],
                [0.84, 1.4],
                [0, 1.4],
              ],
              packMat(CM.paint, MAST_PAINT),
            );
          }
          // Cage: hoops every 1.8 m from 2.2 m up the ladder (not through
          // the rest platform's railing), three bars.
          const cage: [number, number][] = [
            [X, -0.36],
            [X + 0.55, -0.36],
            [X + 0.72, 0],
            [X + 0.55, 0.36],
            [X, 0.36],
          ];
          const h0 = yb + 2.2;
          let h1 = h0;
          for (let y = h0; y < hs[i] + 0.9; y += 1.8) {
            if (y > yp - 0.3 && y < yp + 1.3) continue;
            m.tube(
              cage.map(([x, a]) => A(x, y, a)),
              0.02,
              galv,
            );
            h1 = y;
          }
          if (h1 > h0)
            for (const [x, a] of cage.slice(1, 4))
              m.tube([A(x, h0, a), A(x, h1, a)], 0.018, galv);
        }
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
          // Bird-spike strips along the shelf's outer edge (pigeons perch
          // on every ledge under a viaduct): a steel base strip with a
          // bristle band over it (CM.metal), between the pads.
          for (const o of [-1.6, 1.6]) {
            m.box(
              at(o, -2.755, 0.95),
              [1.4, 0.006, 0.035],
              packMat(CM.metal),
              yaw,
            );
            m.box(
              at(o, -2.715, 0.95),
              [1.4, 0.035, 0.012],
              packMat(CM.metal, 0),
              yaw,
              0,
              true,
            );
          }
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
      // (A fitting, not a road luminaire: the street kind's junction
      // pool at radius 18 washed the whole underside into one white floor.)
      if (flank || (no % 4 === 2 && hs[i] - ground > 6)) {
        const u = P(i, 0, flank ? -3.06 : -2.36);
        m.box(u, [0.5, 0.06, 0.2], packMat(CM.lamp, 1), yaw, 0, false);
        underLight(
          [u[0], u[1] - 0.4, u[2]],
          11,
          [LED[0] * 0.8, LED[1] * 0.8, LED[2] * 0.8],
          inStation,
        );
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
    // Clearance board on every span, both outer webs: a 2.4 x 0.5 m plate
    // 3 cm proud (in front of the hazard band) with dark edges, mapped to
    // the shader's board (0x80: u 12i + 6 +- 1.2, uv.y 0.9..1.4 from the
    // web top), so the yellow / black board stands off the web.
    {
      const bm = packMat(CM.paint, RAIL_GIRDER | 0x80 | (girder[i] & 0x7f));
      const ta = 4.8 / 12;
      const tb = 7.2 / 12;
      for (const s of [-1, 1]) {
        const nl: Vec3 = [fr[i].l[0] * s, 0, fr[i].l[1] * s];
        const B = (t: number, o: number, y: number): Vec3 => {
          const p = P(i, s * o, y);
          const q = P(i + 1, s * o, y);
          return [
            lerp(p[0], q[0], t),
            y + lerp(hs[i], hs[W(i + 1)], t),
            lerp(p[2], q[2], t),
          ];
        };
        m.quad(
          [
            B(ta, 4.43, -1.8),
            B(tb, 4.43, -1.8),
            B(tb, 4.43, -2.3),
            B(ta, 4.43, -2.3),
          ],
          nl,
          [
            [12 * i + 4.8, 0.9],
            [12 * i + 7.2, 0.9],
            [12 * i + 7.2, 1.4],
            [12 * i + 4.8, 1.4],
          ],
          bm,
        );
        const fm = packMat(CM.frame);
        const d: Vec3 = [fr[i].d[0], 0, fr[i].d[1]];
        for (const [p0, p1, p2, p3, nn] of [
          [
            B(ta, 4.43, -1.8),
            B(tb, 4.43, -1.8),
            B(tb, 4.4, -1.8),
            B(ta, 4.4, -1.8),
            UP,
          ],
          [
            B(ta, 4.43, -2.3),
            B(tb, 4.43, -2.3),
            B(tb, 4.4, -2.3),
            B(ta, 4.4, -2.3),
            [0, -1, 0],
          ],
          [
            B(ta, 4.43, -1.8),
            B(ta, 4.43, -2.3),
            B(ta, 4.4, -2.3),
            B(ta, 4.4, -1.8),
            [-d[0], 0, -d[2]],
          ],
          [
            B(tb, 4.43, -1.8),
            B(tb, 4.43, -2.3),
            B(tb, 4.4, -2.3),
            B(tb, 4.4, -1.8),
            d,
          ],
        ] as [Vec3, Vec3, Vec3, Vec3, Vec3][])
          m.quad(
            [p0, p1, p2, p3],
            nn,
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
            fm,
          );
      }
    }
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

  // Continuous lines through every point: railheads, catenary wires (third
  // rails in New York), the cable conduit.
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
  if (platformNyc)
    for (const c of [-0.85, 0.85])
      line(k => P(k, c, RAIL_TOP + 0.03), 0.04, packMat(CM.metal, RAIL_STEEL));
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
  for (const c of platformNyc ? [] : [-2.1, 2.1]) {
    line(k => P(k, c + stag(k), CW), 0.007, packMat(CM.wire, 1));
    line(k => P(k, c + stag(k), MW - 0.5 * sag(k)), 0.008, packMat(CM.wire, 2));
    // Droppers every 6 m (two a bay, none at the gantries), on the
    // straight lines between the wires' points. FINE_TUBE: city.wgsl fades
    // them out past ~45-100 m, where each one was a 1 px dot and the pair
    // of wires read as a dashed line; the wires themselves stay solid.
    const lp = (a: Vec3, b: Vec3, t: number): Vec3 => [
      lerp(a[0], b[0], t),
      lerp(a[1], b[1], t),
      lerp(a[2], b[2], t),
    ];
    for (let k = 0; k < segs; k++)
      for (const t of [0, 0.5]) {
        if (t === 0 && isGantry(k)) continue;
        const c0 = P(k, c + stag(k), CW);
        const c1 = P(k + 1, c + stag(k + 1), CW);
        const m0 = P(k, c + stag(k), MW - 0.5 * sag(k));
        const m1 = P(k + 1, c + stag(k + 1), MW - 0.5 * sag(k + 1));
        m.tube(
          [lp(c0, c1, t), lp(m0, m1, t)],
          0.007,
          packMat(CM.wire, 2),
          FINE_TUBE,
        );
      }
  }
  // Coping lights: discrete LED fittings on the coping lip's outer face,
  // not one continuous tube (that read as a km-long neon stripe, "Tron, not
  // Tokyo"). One 1.2 m fitting (CM.lamp 7, a solid min-width lamp tube, so
  // each is a dot at range) in every span per side (~12 m; at 24 m the
  // far-night deck line vanished) at a hashed spot in the span, about one
  // in ten dead (an unlit dark housing, CM.paint 0x90): a dotted, slightly
  // irregular line of lights at night. Warm / cool and dimming are the
  // shader's (see asset-direction-rail.md §7, round 7).
  for (let k = 0; k < segs; k++) {
    if (station[k]) continue;
    const len = dist2(pts[k], pts[W(k + 1)]) || 12;
    for (const s of [-1, 1]) {
      const h = railHash(ei + 1301, k * 2 + (s > 0 ? 1 : 0));
      const t = 0.2 + 0.6 * railHash(ei + 1302, k * 2 + (s > 0 ? 1 : 0));
      const dt = 0.6 / len;
      const a = P(k, s * 5.455, 1.155);
      const b = P(k + 1, s * 5.455, 1.155);
      const at = (u: number): Vec3 => [
        lerp(a[0], b[0], u),
        lerp(a[1], b[1], u),
        lerp(a[2], b[2], u),
      ];
      m.tube(
        [at(t - dt), at(t + dt)],
        0.045,
        h < 0.1 ? packMat(CM.paint, 0x90) : packMat(CM.lamp, 7),
      );
    }
  }
  // One feeder, on the -1 masts (a point every 2nd bent is enough for its
  // sag): with one each side the line carried six parallel wires, which
  // at mid / far range merged into a grey hatch over the deck.
  if (!platformNyc)
    line(k => P(k, -4.8, 9.0 - 0.6 * sag(k)), 0.012, packMat(CM.wire, 2), 2);

  // OHLE structures every 4th point. Most are the light Warren-truss
  // portal; per gantry (a hash of the line and point, not the layout RNG)
  // about one in four is a pair of cantilever masts (no beam over the
  // centre: a gap in the row of portals), one in six a heavy box-girder
  // portal on taller H masts, and every signal location (24 points) a
  // signal bridge: a box girder with a grated walkway and handrails over
  // it and an access ladder up one mast. About one gantry in three carries
  // a disconnector (an isolator box high on a mast with an operating rod
  // down to a handle box at walkway level and a jumper to the feeder).
  const ins = packMat(CM.paint, INSULATOR);
  const cab = packMat(CM.paint, 0x90);
  // OHLE masts: dark green painted steel (PAINT_STEEL seed 7: green 0.14,
  // chipped), darker than the concrete they stand on; the beams stay galv.
  const mastM = packMat(CM.paint, MAST_PAINT);
  const iGirder = (i: number, yaw: number, d: Vec2) => {
    const L = 5.05;
    // Flanges (top, bottom) and the web (no top / bottom faces needed).
    m.box(P(i, 0, 8.68), [L, 0.02, 0.2], galv, yaw, 0, false);
    m.box(P(i, 0, 7.92), [L, 0.02, 0.2], galv, yaw, 0, false);
    m.box(P(i, 0, 8.3), [L, 0.36, 0.01], galv, yaw);
    // Stiffeners: a plate either side of the web (its two faces; the 16 mm
    // edge is not worth its vertices).
    const ns = 8;
    for (let k = 0; k <= ns; k++) {
      const x = -L + 0.1 + ((2 * L - 0.2) * k) / ns;
      for (const f of [-1, 1]) {
        const A = (dx: number, y: number, a: number): Vec3 => {
          const p = P(i, x + dx, y);
          return [p[0] + d[0] * f * a, p[1], p[2] + d[1] * f * a];
        };
        const ll = fr[i].l;
        const ln: Vec3 = [ll[0], 0, ll[1]];
        // uv.y metres up from the stiffener's foot (box faces' convention:
        // the shader gates its drips on the face height).
        const uv: Vec2[] = [
          [0, 0.72],
          [0.18, 0.72],
          [0.18, 0],
          [0, 0],
        ];
        for (const g of [-1, 1]) {
          const nn: Vec3 = [ln[0] * g, 0, ln[2] * g];
          m.quad(
            [
              A(g * 0.008, 8.66, 0.01),
              A(g * 0.008, 8.66, 0.19),
              A(g * 0.008, 7.94, 0.19),
              A(g * 0.008, 7.94, 0.01),
            ],
            nn,
            uv,
            galv,
          );
        }
      }
    }
  };
  // Through stations an extra light portal mid-bay (i % 4 == 2, masts on
  // the platforms 0.8 m in from the edge), so the wires in the station
  // are never 24 m from a support: from the along view a dropper and the
  // converging wires near the eye read as registration arms hanging off
  // the canopy with no mast.
  const midSt = (k: number) =>
    k % 4 === 2 && k < segs && station[k] === 1 && station[W(k - 1) % segs];
  // New York: no overhead line, so no masts; the signals stand on a short
  // post between the tracks (clear of both trains), a head with an aspect
  // for each direction.
  for (let i = 0; platformNyc && i < n; i += 24) {
    const d = fr[i].d;
    const yaw = Math.atan2(d[0], d[1]);
    const pp = P(i, 0, 0.24);
    m.tube([pp, [pp[0], pp[1] + 2.0, pp[2]]], 0.05, packMat(CM.paint, 0x91));
    const hp = P(i, 0, 2.6);
    m.box(hp, [0.16, 0.42, 0.08], packMat(CM.frame), yaw);
    for (const f of [-1, 1]) {
      const a = railHash(ei * 3 + (f < 0 ? 1 : 2), i);
      const [up, lo] = a < 0.7 ? [4, 5] : a < 0.9 ? [5, 5] : [3, 3];
      for (const [dy, asp] of [
        [0.18, up],
        [-0.18, lo],
      ] as [number, number][])
        m.box(
          [hp[0] + d[0] * f * 0.1, hp[1] + dy, hp[2] + d[1] * f * 0.1],
          [0.1, 0.1, 0.04],
          packMat(CM.lamp, asp),
          yaw,
        );
    }
  }
  for (let i = 0; !platformNyc && i < n; i++) {
    const ms = midSt(i);
    if (!isGantry(i) && !ms) continue;
    const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
    const d = fr[i].d;
    const gh = railHash(ei + 707, i);
    const kind = ms ? 0 : i % 24 === 0 ? 3 : gh < 0.17 ? 2 : gh < 0.42 ? 1 : 0;
    const heavy = kind >= 2;
    // Mast tops: 9.0 (feeder support); heavy portals 9.6.
    const mTop = heavy ? 9.6 : 9.0;
    for (const s of [-1, 1]) {
      const b = P(i, s * 4.8, (1.2 + mTop) / 2);
      if (heavy) {
        // H mast: two flanges and a web, wider than the light masts.
        for (const f of [-1, 1])
          m.box(
            [b[0] + d[0] * f * 0.13, b[1], b[2] + d[1] * f * 0.13],
            [0.15, (mTop - 1.2) / 2, 0.025],
            mastM,
            yaw,
          );
        m.box(b, [0.025, (mTop - 1.2) / 2, 0.11], mastM, yaw);
        // Cap plate.
        m.box(P(i, s * 4.8, mTop + 0.03), [0.19, 0.03, 0.19], mastM, yaw);
      } else m.box(b, [0.09, (mTop - 1.2) / 2, 0.15], mastM, yaw);
    }
    if (kind === 0) {
      // Warren truss: two chords and one zig-zag of diagonals.
      m.tube([P(i, -4.8, 8.6), P(i, 4.8, 8.6)], 0.06, galv);
      m.tube([P(i, -4.8, 7.9), P(i, 4.8, 7.9)], 0.06, galv);
      const zz: Vec3[] = [];
      for (let k = 0; k <= 12; k++)
        zz.push(P(i, -4.8 + k * 0.8, k % 2 ? 8.6 : 7.9));
      m.tube(zz, 0.035, galv);
    } else if (kind === 1) {
      // Cantilevers: a horizontal arm over each track at 7.9 m with a
      // raking tie from the mast head; the centre stays open.
      for (const s of [-1, 1]) {
        m.tube([P(i, s * 4.8, 7.9), P(i, s * 1.3, 7.9)], 0.055, galv);
        m.tube([P(i, s * 4.8, 8.95), P(i, s * 2.0, 7.95)], 0.035, galv);
      }
    } else {
      // Rolled-steel I girder 0.8 m deep across both tracks: 0.4 m top and
      // bottom flanges (4 cm), a recessed 2 cm web in their shadow, and
      // web stiffeners both sides every ~1.25 m, so it reads as galvanised
      // structural steel (flange highlight, dark web, a bolt-plate beat),
      // not one flat 10 m plank (the round-6 box).
      iGirder(i, yaw, d);
      if (kind === 3) {
        // Signal bridge: a grated walkway on the girder, handrails both
        // sides, and a ladder up the -1 mast.
        m.box(P(i, 0, 8.74), [5.2, 0.04, 0.55], galv, yaw, 0, false);
        for (const f of [-1, 1]) {
          const R = (o: number, y: number): Vec3 => {
            const p = P(i, o, y);
            return [p[0] + d[0] * f * 0.5, p[1], p[2] + d[1] * f * 0.5];
          };
          m.tube([R(-5.15, 9.85), R(5.15, 9.85)], 0.03, galv);
          m.tube([R(-5.15, 9.3), R(5.15, 9.3)], 0.02, galv);
          for (const o of [-5.15, 0, 5.15])
            m.tube([R(o, 8.78), R(o, 9.85)], 0.025, galv);
        }
        for (const f of [-1, 1]) {
          const L = (y: number): Vec3 => {
            const p = P(i, -5.12, y);
            return [p[0] + d[0] * f * 0.2, p[1], p[2] + d[1] * f * 0.2];
          };
          m.tube([L(1.25), L(9.85)], 0.025, galv);
        }
        for (let y = 1.7; y < 8.7; y += 0.9) {
          const p = P(i, -5.12, y);
          m.tube(
            [
              [p[0] - d[0] * 0.2, y, p[2] - d[1] * 0.2],
              [p[0] + d[0] * 0.2, y, p[2] + d[1] * 0.2],
            ],
            0.015,
            galv,
            FINE_TUBE,
          );
        }
      }
    }
    // Disconnector on one mast of about one gantry in three.
    if (railHash(ei + 708, i) < 0.33) {
      const s = railHash(ei + 709, i) < 0.5 ? -1 : 1;
      const x = 4.8 + (heavy ? 0.35 : 0.3);
      m.box(P(i, s * x, 7.05), [0.22, 0.34, 0.28], cab, yaw, 0, false);
      m.box(P(i, s * x, 1.85), [0.14, 0.2, 0.14], cab, yaw);
      m.tube(
        [P(i, s * (x - 0.05), 2.05), P(i, s * (x - 0.05), 6.68)],
        0.02,
        galv,
        FINE_TUBE,
      );
      // Jumper from the isolator up to the feeder (on its side) or the
      // mast head, on a post insulator.
      m.tube([P(i, s * x, 7.39), P(i, s * x, 7.8)], 0.05, ins, FINE_TUBE);
      m.tube(
        [P(i, s * x, 7.8), P(i, s * 4.8, s < 0 ? 9.0 : mTop - 0.2)],
        0.012,
        packMat(CM.wire, 2),
        FINE_TUBE,
      );
    }
    for (const c of [-2.1, 2.1]) {
      // Drop pole outboard of the track, hung from the bottom chord on an
      // insulator; a messenger support arm, and a registration arm on a
      // hinge insulator whose tip is the contact wire's support point (the
      // same staggered point the wire polyline passes through). All fine
      // hardware (FINE_TUBE): gone past ~100 m, where it beaded the wires.
      const st = stag(i);
      const sg = Math.sign(c);
      const xd = c + sg * 0.9;
      const F = FINE_TUBE;
      const mw = MW - 0.5 * sag(i);
      m.tube([P(i, xd, 7.9), P(i, xd, 7.45)], 0.065, ins, F);
      m.tube([P(i, xd, 7.45), P(i, xd, CW + 0.55)], 0.04, galv, F);
      m.tube([P(i, xd, mw), P(i, c + st, mw)], 0.03, galv, F);
      m.tube([P(i, xd, CW + 0.55), P(i, xd, CW + 0.22)], 0.055, ins, F);
      m.tube([P(i, xd, CW + 0.22), P(i, c + st, CW)], 0.025, galv, F);
      // Signal heads every 24 points (288 bent units), one face toward
      // each direction on this track (c < 0 is the left of the line's
      // direction; f is the face for left-hand running, the back carries
      // right-hand running's: trains.ts runs New York's on the right, and
      // both faces draw from the same aspect odds). Both lamps lit (hash
      // aspect: green over yellow, yellow over yellow, red over red).
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
    m.tube(
      [mid(i, t0, 0, -0.55), mid(i, t1, 0, -0.55)],
      0.07,
      packMat(CM.lamp, 6),
    );
    // A dim, tight light (radius 9, x0.5): the ground under the deck
    // shows a sequence of separate pools, not one white floor.
    const c = mid(i, 0.5, 0, -0.6);
    if (i % 2 === 1 && c[1] - hf.sample(c[0], c[2]) > 5)
      underLight(
        c,
        9,
        [cool[0] * 0.5, cool[1] * 0.5, cool[2] * 0.5],
        station[i] === 1,
      );
    const st = station[i] === 1;
    // Drop rods for the cable tray (non-station, non-girder spans), every
    // 4th bay (the tray reads from its lips; rods are fine hardware).
    if (!st && girder[i] < 0 && i % 4 === 1)
      for (const x of [2.72, 3.28])
        m.tube(
          [mid(i, 0.5, x, -0.4), mid(i, 0.5, x, -2.76)],
          0.012,
          galv,
          FINE_TUBE,
        );
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
    // Brackets under the outer cable trays (both sides), every 4th bay.
    if (!st && i % 4 === 2) {
      const d = fr[i].d;
      for (const sg of [-1, 1])
        m.quad(
          [
            mid(i, 0.5, sg * 5.2, -0.1),
            mid(i, 0.5, sg * 5.65, -0.1),
            mid(i, 0.5, sg * 5.25, -0.5),
            mid(i, 0.5, sg * 5.2, -0.5),
          ],
          [d[0], 0, d[1]],
          [
            [0, 0],
            [0.45, 0],
            [0.05, 0.4],
            [0, 0.4],
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

  // Scuppers: a short dark drain spout through the fascia, just under the
  // coping lip, at exactly the u where the shader's scupper streak
  // (deckStains) starts on that span, both sides, so every black-green
  // streak hangs from a pipe.
  for (let i = 0; i < segs; i++) {
    if (station[i]) continue;
    // Expansion-joint cover plates over the fascia at every 4th bent,
    // halfway between gantries (both sides): dark rust-brown painted
    // steel, 0.4 m wide, the full fascia height under the coping lip. A
    // dark tick every 48 m (24 m out of step with the masts), so the deck
    // edge at mid / far range has a beat instead of one grey ribbon.
    if (i % 4 === 2 && !station[W(i - 1) % segs]) {
      // (Front and two end faces only: the back is inside the fascia.)
      const d = fr[i].d;
      const jm = packMat(CM.paint, 0x304);
      for (const s of [-1, 1]) {
        const J = (x: number, a: number, y: number): Vec3 => {
          const p = P(i, s * x, y);
          return [p[0] + d[0] * a, p[1], p[2] + d[1] * a];
        };
        const uv: Vec2[] = [
          [0, 0],
          [0.4, 0],
          [0.4, 1.96],
          [0, 1.96],
        ];
        m.quad(
          [
            J(5.25, -0.2, 1.04),
            J(5.25, 0.2, 1.04),
            J(5.25, 0.2, -0.92),
            J(5.25, -0.2, -0.92),
          ],
          [fr[i].l[0] * s, 0, fr[i].l[1] * s],
          uv,
          jm,
        );
        for (const f of [-1, 1])
          m.quad(
            [
              J(5.1, f * 0.2, 1.04),
              J(5.25, f * 0.2, 1.04),
              J(5.25, f * 0.2, -0.92),
              J(5.1, f * 0.2, -0.92),
            ],
            [d[0] * f, 0, d[1] * f],
            uv,
            jm,
          );
      }
    }
    // At the same expansion joints: a coping step (a 0.6 m precast joint
    // block standing 25 cm proud of the coping and 6 cm outboard of the
    // lip: a notch in the deck's top line every 48 m in every side and 3/4
    // view) and a galvanised finger plate across the walkway troughs.
    if (i % 4 === 2 && !station[W(i - 1) % segs]) {
      const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
      const wall = wallOf(i) || wallOf(W(i - 1) % segs);
      for (const s of [-1, 1]) {
        const x0 = wall ? 5.18 : 4.95;
        m.box(
          P(i, s * ((x0 + 5.49) / 2), 1.27),
          [(5.49 - x0) / 2, 0.23, 0.3],
          conc(RC_PARAPET),
          yaw,
          seed(i),
        );
        const d = fr[i].d;
        const F = (x: number, a: number): Vec3 => {
          const p = P(i, s * x, 0.365);
          return [p[0] + d[0] * a, p[1], p[2] + d[1] * a];
        };
        m.quad(
          [F(4.31, -0.2), F(4.93, -0.2), F(4.93, 0.2), F(4.31, 0.2)],
          UP,
          [
            [0, 0],
            [0.62, 0],
            [0.62, 0.4],
            [0, 0.4],
          ],
          galv,
        );
      }
    }
    // Lineside equipment cabinet clusters (location cases), one span in
    // four at a hashed position in each run of four, a hashed side: two
    // grey 1.2 x 0.6 x 1.4 m cases (and a shorter third on about half)
    // with rain hoods. Off the soundwalls they stand on a 0.2 m plinth on
    // the walkway troughs, 0.7 m over the coping: a block in the parapet's
    // profile. On a soundwall stretch (most of the line), where the wall
    // would hide them, they sit outside it on a bracketed grated platform
    // at coping level with a handrail: a box on the deck edge seen from
    // the street.
    {
      const b4 = Math.floor(i / 4);
      const at = Math.floor(railHash(ei + 808, b4) * 4);
      if (i - b4 * 4 === at && !station[W(i - 1) % segs]) {
        const s = railHash(ei + 809, b4) < 0.5 ? -1 : 1;
        const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
        const len = dist2(pts[i], pts[W(i + 1)]) || 12;
        const tc = 0.3 + railHash(ei + 810, b4) * 0.25;
        const cm = packMat(CM.paint, 0xd0);
        const out = wallOf(i) !== 0;
        // Lateral centre and base of the cases.
        const xc = out ? 5.83 : 4.64;
        const yb = out ? 1.25 : 0.56;
        if (out) {
          const pc = mid(i, tc + 0.5 / len, s * 5.86, 1.22);
          m.box(pc, [0.42, 0.03, 1.75], galv, yaw, 0, false);
          for (const dt of [-0.8, 2.0]) {
            const t = tc + dt / len;
            m.tube(
              [mid(i, t, s * 5.2, -0.6), mid(i, t, s * 6.2, 1.18)],
              0.04,
              galv,
            );
          }
          m.tube(
            [
              mid(i, tc - 1.2 / len, s * 6.25, 2.3),
              mid(i, tc + 2.2 / len, s * 6.25, 2.3),
            ],
            0.025,
            galv,
          );
          for (const dt of [-1.2, 2.2])
            m.tube(
              [
                mid(i, tc + dt / len, s * 6.25, 1.25),
                mid(i, tc + dt / len, s * 6.25, 2.3),
              ],
              0.025,
              galv,
            );
        } else {
          m.box(
            mid(i, tc + 0.5 / len, s * 4.64, 0.46),
            [0.32, 0.1, 1.75],
            conc(RC_PARAPET),
            yaw,
            seed(i),
          );
        }
        const cases: [number, number][] = [
          [0, 1.4],
          [1.3, 1.4],
        ];
        if (railHash(ei + 811, b4) < 0.35) cases.push([-0.95, 1.0]);
        for (const [da, ht] of cases) {
          const t = tc + da / len;
          const w = da < 0 ? 0.3 : 0.6;
          m.box(mid(i, t, s * xc, yb + ht / 2), [0.3, ht / 2, w], cm, yaw);
          m.box(
            mid(i, t, s * xc, yb + ht + 0.03),
            [0.36, 0.03, w + 0.06],
            cm,
            yaw,
          );
        }
      }
    }
    // Span number plates: a white enamel plate (the JR board look, CM.sign
    // 56..63) on the fascia in about one span in five, both
    // sides, below the outer cable trough, out of step with the accent
    // spans: a bright tick on the grey edge that survives to ~300 m.
    if (i % 5 === (ei * 3 + 1) % 5) {
      for (const s of [-1, 1]) {
        const l = fr[i].l;
        const d = fr[i].d;
        // 1.8 x 0.7 m (was 1.2 x 0.5: ~2 px at the far view), alternately
        // the white enamel board and a JR-blue plate (CM.roadSign 24+,
        // white text line), so the accents read as white / blue ticks.
        const c = mid(i, 0.28, s * 5.215, -0.5);
        const A = (x: number, y: number): Vec3 => [
          c[0] + d[0] * x * s,
          c[1] + y,
          c[2] + d[1] * x * s,
        ];
        m.quad(
          [A(-0.9, 0.35), A(0.9, 0.35), A(0.9, -0.35), A(-0.9, -0.35)],
          [l[0] * s, 0, l[1] * s],
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
          Math.floor(i / 5) % 2
            ? packMat(CM.roadSign, 24 + ((ei + i) % 8))
            : packMat(CM.sign, 56 + ((ei + i) % 8)),
        );
      }
    }
    const t = (scupperU(seed(i) >>> 16, i) - 12 * i) / 12;
    for (const s of [-1, 1])
      m.tube(
        [mid(i, t, s * 5.12, 0.97), mid(i, t, s * 5.68, 0.84)],
        0.075,
        pipe,
      );
  }

  // Stations: a low canopy on T-frames over each raised side platform
  // (fascia with a light-box strip and name boards), stairs down through
  // the platform, platform furniture, and a glazed concourse under the
  // deck (or a stair tower beside it where the ground below is road).
  const PL = 1.45;
  const CY = PL + 3.2;
  const metal = packMat(CM.metal);
  const fasciaM = packMat(CM.paint, CANOPY_FASCIA);
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
  function railBike(p: Vec3, dir: Vec3, k: number, share = false) {
    const sd: Vec3 = [dir[2], 0, -dir[0]];
    const B = (x: number, y: number, s = 0): Vec3 => [
      p[0] + dir[0] * x + sd[0] * s,
      p[1] + y,
      p[2] + dir[2] * x + sd[2] * s,
    ];
    const col = packMat(CM.paint, share ? CITI_BLUE : BIKE[k % BIKE.length]);
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

  // Hanging platform clock at c (face centre), faces along the line: a
  // 0.56 m round (24-gon) back-lit face each way (CM.lamp 1), a dark rim,
  // black hour / minute hands 2 cm proud showing 10:08, a hanger rod to
  // the canopy roof.
  const CLOCK_SEGS = 24;
  function clock(c: Vec3, k: number) {
    const d = fr[W(k)].d;
    const l = fr[W(k)].l;
    const R = 0.28;
    const rim: Vec3[] = [];
    for (let q = 0; q <= CLOCK_SEGS; q++) {
      const a = (q / CLOCK_SEGS) * Math.PI * 2;
      rim.push([
        c[0] + l[0] * Math.cos(a) * R,
        c[1] + Math.sin(a) * R,
        c[2] + l[1] * Math.cos(a) * R,
      ]);
    }
    m.tube(rim, 0.05, packMat(CM.paint, 0x91));
    m.tube(
      [
        [c[0], c[1] + R, c[2]],
        [c[0], hs[W(k)] + CY + 0.32, c[2]],
      ],
      0.015,
      metal,
    );
    // (Local x is the viewer's right on each face.)
    for (const f of [-1, 1]) {
      const A = (x: number, y: number, z: number): Vec3 => [
        c[0] - l[0] * x * f + d[0] * f * z,
        c[1] + y,
        c[2] - l[1] * x * f + d[1] * f * z,
      ];
      const nf: Vec3 = [d[0] * f, 0, d[1] * f];
      const ring: number[] = [];
      const ctr = m.vertex(A(0, 0, 0.045), nf, 0.5, 0.5, packMat(CM.lamp, 1));
      for (let q = 0; q < CLOCK_SEGS; q++) {
        const a = (q / CLOCK_SEGS) * Math.PI * 2;
        ring.push(
          m.vertex(
            A(Math.cos(a) * R * 0.92, Math.sin(a) * R * 0.92, 0.045),
            nf,
            0.5 + Math.cos(a) * 0.5,
            0.5 + Math.sin(a) * 0.5,
            packMat(CM.lamp, 1),
          ),
        );
      }
      for (let q = 0; q < CLOCK_SEGS; q++)
        m.triFacing(ctr, ring[q], ring[(q + 1) % CLOCK_SEGS], nf);
      // Hands (angles from 12 o'clock, clockwise as seen from this face).
      for (const [ang, len, w] of [
        [((10 + 8 / 60) / 12) * Math.PI * 2, 0.15, 0.022],
        [(8 / 60) * Math.PI * 2, 0.22, 0.014],
      ]) {
        const ux = Math.sin(ang);
        const uy = Math.cos(ang);
        flat(
          A(-uy * w - ux * 0.03, ux * w - uy * 0.03, 0.05),
          A(uy * w - ux * 0.03, -ux * w - uy * 0.03, 0.05),
          A(uy * w + ux * len, -ux * w + uy * len, 0.05),
          A(-uy * w + ux * len, ux * w + uy * len, 0.05),
          nf,
          1,
          1,
          packMat(CM.paint, 0x91),
        );
      }
    }
  }

  for (const si of e.stations) {
    const i0 = Math.max(0, si - 7);
    const i1 = Math.min(n - 1, si + 7);
    const name = packMat(CM.sign, 64 + (si % 8));
    const nameBig = packMat(CM.sign, NAME_BIG | (64 + (si % 8)));
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
        const dn = (p: Vec3, y: number): Vec3 => [p[0], p[1] - y, p[2]];
        flat(r0, r1, r2, r3, [0, -1, 0], len, 5.8, metal);
        {
          // Roof top, for the view from the train (the eye is only ~0.4 m
          // over the roof plane there, so anything flush is invisible):
          // standing seams every ~0.9 m down the slope (5 cm tents, the
          // shader's 0.9 m sheet laps sit between them), a raised ridge
          // rooflight down the middle of every bay (CM.paint SKYLIGHT, a
          // 0.84 m wide, 0.24 m tall prism stopping 0.3 m short of the
          // T-frames), a capped ventilator in every bay near the high edge
          // and an upstand lip on the low (gutter) edge.
          const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
          const d = fr[i].d;
          const ry = (x: number) => CY + 0.15 + (0.3 * (x - 4.0)) / 5.8;
          const R = (t: number, x: number, dy: number) =>
            mid(i, t, o(x), ry(x) + dy);
          // (Round 7 tried steep 7 cm ribs every 0.6 m: from the grazing
          // along view their eye-facing flanks merged into one uniformly
          // lit plane, flatter than these 45-degree seams; the roof's
          // tone is the shader's.)
          const roofM = packMat(CM.paint, 0xf8);
          const ns = Math.round(len / 0.9);
          for (let q = 1; q < ns; q++) {
            const u = (q * len) / ns;
            const t = u / len;
            const dt = 0.05 / len;
            for (const f of [-1, 1]) {
              const nr: Vec3 = [d[0] * f * 0.7071, 0.7071, d[1] * f * 0.7071];
              m.quad(
                [
                  R(t + f * dt, 4.0, 0),
                  R(t + f * dt, 9.8, 0),
                  R(t, 9.8, 0.05),
                  R(t, 4.0, 0.05),
                ],
                nr,
                [
                  [u + f * 0.05, 0],
                  [u + f * 0.05, 5.8],
                  [u, 5.8],
                  [u, 0],
                ],
                roofM,
              );
            }
          }
          // Ridge rooflight.
          {
            const sk = packMat(CM.paint, SKYLIGHT);
            const ta = 0.3 / len;
            const tb = 1 - ta;
            const ll = fr[i].l;
            for (const f of [-1, 1]) {
              const x0 = 7.0 + f * 0.42;
              const nr: Vec3 = [
                ll[0] * side * f * 0.5,
                0.866,
                ll[1] * side * f * 0.5,
              ];
              m.quad(
                [
                  R(ta, x0, 0),
                  R(tb, x0, 0),
                  R(tb, 7.0, 0.24),
                  R(ta, 7.0, 0.24),
                ],
                nr,
                [
                  [0, 0],
                  [len - 0.6, 0],
                  [len - 0.6, 0.48],
                  [0, 0.48],
                ],
                sk,
              );
            }
            for (const [t, f] of [
              [ta, -1],
              [tb, 1],
            ] as [number, number][]) {
              const nf: Vec3 = [d[0] * f, 0, d[1] * f];
              const a0 = m.vertex(R(t, 6.58, 0), nf, 0, 0, sk);
              const a1 = m.vertex(R(t, 7.42, 0), nf, 0.84, 0, sk);
              const a2 = m.vertex(R(t, 7.0, 0.24), nf, 0.42, 0.24, sk);
              m.triFacing(a0, a1, a2, nf);
            }
          }
          const vm = packMat(CM.paint, 0x90);
          m.box(R(0.5, 8.9, 0.25), [0.3, 0.25, 0.45], vm, yaw);
          m.box(R(0.5, 8.9, 0.54), [0.4, 0.04, 0.55], vm, yaw, 0, false);
          // Gutter lip on the low edge (both faces), only 6 cm: the train
          // eye is ~0.2 m over this edge, a taller upstand hid the roof.
          const up = (p: Vec3, y: number): Vec3 => [p[0], p[1] + y, p[2]];
          flat(up(r1, 0.06), up(r0, 0.06), r0, r1, inn, len, 0.06, vm);
          flat(up(r0, 0.06), up(r1, 0.06), r1, r0, out, len, 0.06, vm);
          // Box gutter on the eaves, in front of the fascia top: a 0.25 m
          // mid-grey (0x90, darker than the 0.62 fascia) steel face toward the track (the darker lip over
          // the pale fascia), its soffit, and a near-black wet channel
          // seen from above (the train eye is just over it).
          const gm = packMat(CM.paint, 0x90);
          const g0 = P(i, o(3.8), CY + 0.21);
          const g1 = P(i + 1, o(3.8), CY + 0.21);
          flat(g1, g0, dn(g0, 0.25), dn(g1, 0.25), inn, len, 0.25, gm);
          const h0 = P(i, o(4.0), CY - 0.04);
          const h1 = P(i + 1, o(4.0), CY - 0.04);
          flat(dn(g0, 0.25), dn(g1, 0.25), h1, h0, [0, -1, 0], len, 0.2, gm);
          flat(
            dn(g0, 0.08),
            dn(g1, 0.08),
            P(i + 1, o(4.0), CY + 0.13),
            P(i, o(4.0), CY + 0.13),
            UP,
            len,
            0.2,
            packMat(CM.paint, 0x301),
          );
        }
        // Track-side fascia 0.6 m deep, a light-box strip along its lower
        // edge (lit face down and toward the track), back fascia 0.3 m.
        flat(r1, r0, dn(r0, 0.45), dn(r1, 0.45), inn, len, 0.45, fasciaM);
        flat(r0, r1, dn(r1, 0.45), dn(r0, 0.45), out, len, 0.45, fasciaM);
        // The light-box strip along the fascia foot is a dark steel channel
        // (0x90) with discrete 1.6 m diffuser fittings in it, one under each
        // purlin (round 8: the continuous lit strip read as one white
        // "Tron" stripe along the outer canopy edge at night).
        const b0 = dn(r0, 0.45);
        const b1 = dn(r1, 0.45);
        const chM = packMat(CM.paint, 0x90);
        const c0 = P(i, o(4.15), CY - 0.5);
        const c1 = P(i + 1, o(4.15), CY - 0.5);
        flat(b1, b0, dn(b0, 0.2), dn(b1, 0.2), inn, len, 0.2, chM);
        flat(dn(b0, 0.2), dn(b1, 0.2), c1, c0, [0, -1, 0], len, 0.15, chM);
        const np = Math.max(2, Math.round(len / 2.5));
        {
          const lm = packMat(CM.lamp, 8);
          const tin: Vec3 = [inn[0] * 0.012, 0, inn[2] * 0.012];
          const sh = (p: Vec3, d: Vec3, y = 0): Vec3 => [
            p[0] + d[0],
            p[1] + y,
            p[2] + d[2],
          ];
          for (let q = 1; q < np; q++) {
            const ta = q / np - 0.8 / len;
            const tb = q / np + 0.8 / len;
            const A = (t: number, x: number, y: number) => mid(i, t, o(x), y);
            flat(
              sh(A(tb, 4.0, CY - 0.33), tin),
              sh(A(ta, 4.0, CY - 0.33), tin),
              sh(A(ta, 4.0, CY - 0.47), tin),
              sh(A(tb, 4.0, CY - 0.47), tin),
              inn,
              1.6,
              0.14,
              lm,
            );
            flat(
              A(ta, 4.03, CY - 0.512),
              A(tb, 4.03, CY - 0.512),
              A(tb, 4.13, CY - 0.512),
              A(ta, 4.13, CY - 0.512),
              [0, -1, 0],
              1.6,
              0.1,
              lm,
            );
          }
        }
        flat(r2, r3, dn(r3, 0.3), dn(r2, 0.3), out, len, 0.3, fasciaM);
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
        // Purlins across the soffit every ~2.5 m (between the T-frames),
        // each carrying a 1.2 m fluorescent fitting over the walking band:
        // a steel batten box hung under the purlin with its tube (CM.lamp 8)
        // parallel to the track (round 8: the tube used to lie along the
        // purlin, a lit diagonal across the bay in the platform view; the
        // continuous lamp strip beside them is gone too).
        for (let q = 1; q < np; q++) {
          const t = q / np;
          m.tube(
            [mid(i, t, o(4.1), CY + 0.08), mid(i, t, o(9.7), CY + 0.38)],
            0.06,
            metal,
          );
          const dt = 0.6 / len;
          m.box(
            mid(i, t, o(6.0), CY + 0.1),
            [0.07, 0.025, 0.63],
            packMat(CM.paint, 0x90),
            yaw,
            0,
            false,
          );
          m.tube(
            [
              mid(i, t - dt, o(6.0), CY + 0.045),
              mid(i, t + dt, o(6.0), CY + 0.045),
            ],
            0.03,
            packMat(CM.lamp, 8),
          );
        }
        // Car position markers every 24 m, hung just under the canopy
        // fascia and facing along the platform: small yellow plates
        // (door-position numbers on the real thing).
        if ((i - si) % 2 === 0)
          m.box(
            mid(i, 0.25, o(4.2), CY - 0.64),
            [0.14, 0.12, 0.02],
            packMat(CM.paint, 0x92),
            yaw,
            0,
            false,
          );
      }
      // (The eaves gutter is the box gutter along each roof segment.)
      // Hanging name boards facing the track, and a big one on the back
      // fascia facing the street.
      for (const k of [si - 4, si + 3]) {
        if (k < i0 || k >= i1) continue;
        const yaw = Math.atan2(fr[k].d[0], fr[k].d[1]);
        const b = mid(k, 0.5, o(4.6), CY - 0.62);
        const top = mid(k, 0.5, o(4.6), CY + 0.12)[1];
        m.box(b, [0.05, 0.32, 2.4], name, yaw);
        for (const f of [-1.6, 1.6])
          m.tube(
            [
              [b[0] + fr[k].d[0] * f, b[1] + 0.32, b[2] + fr[k].d[1] * f],
              [b[0] + fr[k].d[0] * f, top, b[2] + fr[k].d[1] * f],
            ],
            0.015,
            metal,
          );
      }
      {
        const yaw = Math.atan2(fr[si].d[0], fr[si].d[1]);
        const b = P(si, o(9.86), CY + 0.1);
        m.box(b, [0.05, 0.32, 2.4], name, yaw);
        // Perpendicular hanging sign mid-platform, 2.6 m clear of the
        // platform (it was 2.47, and filled the top of the platform view),
        // on two rods to the roof.
        const h = mid(si, 0.5, o(6.8), CY - 0.28);
        m.box(h, [1.2, 0.32, 0.05], name, yaw);
        const hl = fr[si].l;
        for (const x of [-0.9, 0.9]) {
          const rp: Vec3 = [h[0] + hl[0] * x, h[1] + 0.32, h[2] + hl[1] * x];
          m.tube([rp, [rp[0], hs[si] + CY + 0.3, rp[2]]], 0.015, metal);
        }
        // Double-faced platform clocks hung over the bench line (round,
        // back-lit face, black hands at 10:08): one just short of the
        // mid-platform sign, where the platform view sees it clear of the
        // boards, and one 1.5 bays on.
        clock(mid(si, 0.25, o(8.3), PL + 2.45), si);
        clock(mid(si + 1, 0.75, o(8.3), PL + 2.45), si + 1);
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
          // Slatted bench: four seat slats and three back slats with
          // gaps between them, on two steel end frames (two on the 0 slot).
          for (const a of r === 0 ? [0.3, 0.62] : [0.5]) {
            for (let q = 0; q < 4; q++)
              m.box(
                mid(k, a, o(8.77 + q * 0.11), PL + 0.43),
                [0.042, 0.02, 0.9],
                bench,
                yaw,
              );
            for (let q = 0; q < 3; q++)
              m.box(
                mid(k, a, o(9.2 + q * 0.015), PL + 0.56 + q * 0.13),
                [0.015, 0.045, 0.9],
                bench,
                yaw,
              );
            const len = dist2(pts[k], pts[W(k + 1)]) || 1;
            for (const f of [-0.75, 0.75]) {
              m.box(
                mid(k, a + f / len, o(8.95), PL + 0.2),
                [0.2, 0.2, 0.025],
                metal,
                yaw,
              );
              m.box(
                mid(k, a + f / len, o(9.23), PL + 0.6),
                [0.025, 0.2, 0.025],
                metal,
                yaw,
              );
            }
          }
        } else if (r === 1) {
          // Vending pair standing across the platform against the fence,
          // lit fronts facing along it toward the station centre (round 8:
          // facing the track they showed a blank side slab down the
          // platform), and a recycling-bin trio beside them.
          const fs = k >= si ? -1 : 1;
          const fd: Vec3 = [fr[k].d[0] * fs, 0, fr[k].d[1] * fs];
          for (const v of platformNyc ? [] : [0, 1]) {
            const c = mid(k, 0.45, o(9.05 - v * 0.92), PL + 0.9);
            const vm = packMat(CM.vending, (k + v + (side > 0 ? 1 : 0)) % 3);
            const vy = Math.atan2(-fd[2], fd[0]);
            // Front (the box's +x face) toward the platform.
            m.box(c, [0.38, 0.9, 0.45], vm, vy);
            // The display front as its own quad 3 mm proud with the
            // VENDING_FRONT flag (same box UV as the +x face), so the
            // shader can keep the drink window off the other faces.
            {
              const R: Vec3 = [Math.cos(vy), 0, -Math.sin(vy)];
              const Fw: Vec3 = [Math.sin(vy), 0, Math.cos(vy)];
              const V = (z: number, y: number): Vec3 => [
                c[0] + R[0] * 0.383 + Fw[0] * z,
                c[1] + y,
                c[2] + R[2] * 0.383 + Fw[2] * z,
              ];
              m.quad(
                [V(0.45, -0.9), V(-0.45, -0.9), V(-0.45, 0.9), V(0.45, 0.9)],
                R,
                [
                  [0, 0],
                  [0.9, 0],
                  [0.9, 1.8],
                  [0, 1.8],
                ],
                packMat(
                  CM.vending,
                  VENDING_FRONT | ((k + v + (side > 0 ? 1 : 0)) % 3),
                ),
              );
            }
            // The lit display window (uv.y 0.7 .. 1.5 on the front, where
            // the shader draws the drink rows) recessed 6 cm: the lower
            // body (coin slot, buttons, flap) and the header panel stand
            // proud of it, so the window reads as a lit box set into the
            // machine with a shadowed lip, not a decal.
            const fx = (x: number, y: number): Vec3 => [
              c[0] + fd[0] * x,
              PL + y,
              c[2] + fd[2] * x,
            ];
            const body = (k + v + (side > 0 ? 1 : 0)) % 3;
            m.box(
              fx(0.41, 0.35),
              [0.03, 0.35, 0.45],
              packMat(CM.vending, VENDING_DOOR | body),
              vy,
              0,
              true,
              true,
            );
            m.box(
              fx(0.41, 1.65),
              [0.03, 0.15, 0.45],
              packMat(CM.vending, VENDING_HEADER | body),
              vy,
              0,
              true,
              true,
            );
          }
          // Bins: three 0.4 m grey cabinets (cans / bottles / paper) with
          // coloured lid bands, against the fence 3 m in front of the machines.
          const lenB = dist2(pts[k], pts[W(k + 1)]) || 1;
          [0x92, 0x0c, 0x90].forEach((lid, q) => {
            if (platformNyc && q !== 2) return;
            const t = 0.45 + (fs * (3.0 + q * 0.44)) / lenB;
            m.box(
              mid(k, t, o(9.28), PL + 0.45),
              [0.2, 0.45, 0.2],
              packMat(CM.paint, 0xd0),
              yaw,
            );
            m.box(
              mid(k, t, o(9.28), PL + 0.86),
              [0.205, 0.05, 0.205],
              packMat(CM.paint, lid),
              yaw,
            );
          });
        }
        // Car-position floor markers behind the tactile strip, every 6 m:
        // 0.45 m line-colour squares painted on the paving (4 mm proud),
        // where the doors stop; not over the stair well. (None in New
        // York.)
        if (!platformNyc && !(stairOf[W(k) % segs] & (side < 0 ? 1 : 2))) {
          const len = dist2(pts[k], pts[W(k + 1)]) || 1;
          for (const t of [0.25, 0.75]) {
            const F = (x: number, a: number) =>
              mid(k, t + a / len, o(x), PL + 0.004);
            m.quad(
              [F(5.0, -0.22), F(5.0, 0.22), F(5.45, 0.22), F(5.45, -0.22)],
              UP,
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
              packMat(CM.paint, 0x0c),
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
        underLight([c[0], c[1] - 0.6, c[2]], 9, cool, true);
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
        // Main name board half-width (big board when the band allows it).
        const nbBig = ub - 0.5 >= 0.6 * NB_SCALE;
        const nbHalf = nbBig ? 1.2 * NB_SCALE : 3.6;
        m.box(
          [cx, gnd + hg + ub / 2, cz],
          [9.85, ub / 2, half + 0.1],
          conc(RC_STATION),
          yaw,
          seed(ck),
          false,
        );
        // Clerestory: a 1 m glazing ribbon along both long faces of the
        // upper band (behind the fins and the name board), the curtain-wall
        // material with uv.y 1.2 .. 2.2 (glass between the kick plate and
        // the transom), so the upper storey shows a lit band at night.
        if (ub > 1.6) {
          const l2 = fr[ck + 1].l;
          const dv: Vec2 = [Math.sin(yaw), Math.cos(yaw)];
          for (const s of [-1, 1]) {
            const Q = (a: number, y: number): Vec3 => [
              cx + l2[0] * s * 9.87 + dv[0] * a,
              gnd + hg + ub / 2 + y,
              cz + l2[1] * s * 9.87 + dv[1] * a,
            ];
            const a0 = -half + 0.4;
            const a1 = half - 0.4;
            m.quad(
              [Q(a0, -0.5), Q(a1, -0.5), Q(a1, 0.5), Q(a0, 0.5)],
              [l2[0] * s, 0, l2[1] * s],
              [
                [0, 1.2],
                [a1 - a0, 1.2],
                [a1 - a0, 2.2],
                [0, 2.2],
              ],
              conc(RC_STATION | RC_GLAZED | RC_CLERESTORY),
              seed(ck),
            );
            // A lit LED cornice line over the ribbon (CM.ledLine 0: every
            // face glows at night), and a row of back-lit 4:1 ad boxes
            // (CM.sign 32..43, standing proud of the fins) above it, clear
            // of the name board: the upper storey is a lit band at night.
            m.box(
              Q(0, 0.56),
              [0.04, 0.04, (a1 - a0) / 2],
              packMat(CM.ledLine, 0),
              yaw,
              0,
              false,
            );
            if (ub > 3.0) {
              let q = 0;
              for (let a = a0 + 1.6; a + 1.6 <= a1; a += 3.6) {
                if (Math.abs(a) < nbHalf + 1.75) continue;
                const p = Q(a, 1.25);
                const fo = (x: number) =>
                  [p[0] + l2[0] * s * x, p[1], p[2] + l2[1] * s * x] as Vec3;
                m.box(
                  fo(0.27),
                  [0.05, 0.4, 1.55],
                  packMat(CM.frame),
                  yaw,
                  0,
                  false,
                );
                // Face: uv 0..1, u to the viewer's right, v down.
                const F = (x: number, y: number): Vec3 => {
                  const c = fo(0.325);
                  return [c[0] + dv[0] * s * x, c[1] + y, c[2] + dv[1] * s * x];
                };
                m.quad(
                  [F(-1.5, 0.38), F(1.5, 0.38), F(1.5, -0.38), F(-1.5, -0.38)],
                  [l2[0] * s, 0, l2[1] * s],
                  [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 1],
                  ],
                  packMat(
                    CM.sign,
                    32 + ((si * 5 + q++ * 3 + (s > 0 ? 1 : 0)) % 12),
                  ),
                );
              }
            }
          }
        }
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
          // Canopy: steel slab with a 0.5 m fascia (line-colour band on
          // it) and a dark soffit with two rows of square downlights over
          // the doors (CM.lamp 1, the lit underside was one glowing slab).
          m.box(f(11.0, 3.05), [1.75, 0.09, 2.9], metal, yaw, 0, false);
          m.box(f(12.7, 2.97), [0.05, 0.25, 2.9], packMat(CM.paint, 0x90), yaw);
          m.box(f(12.77, 3.0), [0.02, 0.12, 2.9], packMat(CM.paint, 0x0c), yaw);
          for (const x of [10.75, 11.95])
            for (const a of [-1.9, -0.95, 0, 0.95, 1.9])
              flat(
                f(x + 0.13, 2.955, a - 0.13),
                f(x + 0.13, 2.955, a + 0.13),
                f(x - 0.13, 2.955, a + 0.13),
                f(x - 0.13, 2.955, a - 0.13),
                [0, -1, 0],
                0.26,
                0.26,
                packMat(CM.lamp, 1),
              );
          lights.add(f(11.0, 2.7), 7, LED, LightKind.station);
          if (ub > 1.4) {
            // Main station-name board: one back-lit JR board drawn once at
            // NB_SCALE x the 2.4 x 0.6 m platform board (CM.sign 64.. |
            // NAME_BIG: the shader stretches the atlas unit over the whole
            // face), ~1 m kanji, as big as the upper band allows, with LED
            // edge lines (CM.ledLine 0) top and bottom.
            const bw = nbHalf;
            const bh = nbBig ? 0.3 * NB_SCALE : 0.36;
            m.box(
              f(9.9, hg + ub / 2),
              [0.06, bh, bw],
              nbBig ? nameBig : name,
              yaw,
            );
            for (const y of [-bh - 0.03, bh + 0.03])
              m.box(
                f(9.93, hg + ub / 2 + y),
                [0.03, 0.025, bw + 0.03],
                packMat(CM.ledLine, 0),
                yaw,
                0,
                false,
                true,
              );
          }
          // Back-lit ad panels (portrait 1.2 x 1.8 m digital posters,
          // CM.screen, emissive day and night) on frames standing proud
          // of the glazing, two each side of the entrance; and an IC gate
          // line under the entrance canopy: five grey gate cabinets
          // across the doors with blue glowing IC reader tops (CM.ledLine
          // 1), white street-end indicators (0) and a small pool light, so the
          // entrance has the warm-white gate glow of a Tokyo station.
          for (const a of [-3.6, -5.1, 5.1, 6.6]) {
            if (Math.abs(a) > half - 0.9) continue;
            if (s > 0 && a > 0) continue;
            m.box(f(9.85, 1.35, a), [0.07, 1.05, 0.68], packMat(CM.frame), yaw);
            const F = (x: number, y: number): Vec3 => f(9.925, 1.35 + y, a + x);
            m.quad(
              [
                F(-0.6 * s, 0.9),
                F(0.6 * s, 0.9),
                F(0.6 * s, -0.9),
                F(-0.6 * s, -0.9),
              ],
              out,
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
              packMat(CM.screen, (si * 13 + Math.round(a * 3) + s * 7) & 0xff),
            );
          }
          for (const a of [-1.6, -0.8, 0, 0.8, 1.6]) {
            m.box(
              f(12.05, 0.5, a),
              [0.55, 0.5, 0.09],
              packMat(CM.paint, 0xd0),
              yaw,
            );
            m.box(
              f(12.25, 1.02, a),
              [0.15, 0.02, 0.07],
              packMat(CM.ledLine, 1),
              yaw,
            );
            m.box(
              f(12.61, 0.75, a),
              [0.015, 0.08, 0.06],
              packMat(CM.ledLine, 0),
              yaw,
            );
          }
          lights.add(f(12.3, 2.4), 6, LED, LightKind.station);
          // Fins on the upper band every 1.6 m, clear of the name board.
          if (ub > 0.8)
            for (let a = -half + 0.8; a <= half - 0.8; a += 1.6) {
              if (Math.abs(a) < nbHalf + 0.4) continue;
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
          // New York: a bike-share dock instead, a blue bike in each dock
          // post, about one in four empty, and a pay kiosk at the end.
          if (s > 0) {
            const a0 = 3.2;
            const a1 = Math.min(half - 2.0, a0 + 6.0);
            if (!platformNyc)
              m.tube([f(10.15, 0.42, a0), f(10.15, 0.42, a1)], 0.025, metal);
            let b = 0;
            for (let a = a0 + 0.3; a < a1; a += 0.62, b++) {
              const p = f(10.8, 0, a);
              if (!platformNyc) railBike(p, out, b + si);
              else {
                m.box(f(10.2, 0.45, a), [0.06, 0.45, 0.09], metal, yaw);
                if (railHash(ei + 811, si * 16 + b) >= 0.25)
                  railBike(p, [-out[0], 0, -out[2]], 0, true);
              }
            }
            if (platformNyc) {
              const kiosk = packMat(CM.paint, CITI_BLUE);
              m.box(f(10.25, 0.95, a1 + 0.5), [0.16, 0.95, 0.3], kiosk, yaw);
              m.box(
                f(10.42, 1.3, a1 + 0.5),
                [0.015, 0.45, 0.24],
                packMat(CM.frame),
                yaw,
              );
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
          [2.4, 0.36, 0.06],
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
  pierOk: (q: Vec2) => number,
  legOk: (g: Vec2) => boolean,
  solid: Solid,
) {
  const pts = e.pts;
  const n = pts.length;
  const fr = frames(pts);
  // Pier columns for the camera (and the traffic checks): the square
  // inscribed in the column, so it never shows the camera stopping short.
  const pierSolid = (q: Vec2, ground: number, top: number) => {
    const r = PIER_RADIUS * Math.SQRT1_2;
    solid(
      [q[0], (ground - 1 + top) / 2, q[1]],
      [r, (top - ground + 1) / 2, r],
      0,
    );
  };
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
    // (A column on the pier median like the others, under a full-width
    // cap: a wall across the middle lanes would block them.)
    pierSolid(q, ground, hs[k] - 2);
    m.cylinder(
      [q[0], ground - 1, q[1]],
      PIER_RADIUS,
      hs[k] - 2 - ground + 1,
      12,
      packMat(CM.concrete),
      false,
    );
    m.box(
      [c[0], hs[k] - 2.8, c[2]],
      [halfW * 0.8, 0.8, 1.4],
      packMat(CM.concrete),
      yaw,
    );
  }
  let lastPier = -100;
  let pierCount = 0;
  let lastLight = -100;
  // Where a pier may stand (see elevatedStructures).
  const okAt = pts.map((q, i) =>
    hs[i] - 2 - hf.sample(q[0], q[1]) > 3 ? pierOk(q) : 0,
  );
  // Distance along to the next median pier spot.
  const nextOk = new Float64Array(n + 1).fill(Infinity);
  for (let i = n - 1; i >= 0; i--)
    nextOk[i] = okAt[i] === 2 ? along[i] : nextOk[i + 1];
  // Straddle bent legs: on the sidewalks, 1.3 m past the boulevard's kerbs.
  const reach = ROAD_WIDTH[3] / 2 + 1.3;
  const legsAt = (i: number) =>
    [-1, 1].map(
      s =>
        [
          pts[i][0] + fr[i].l[0] * reach * s,
          pts[i][1] + fr[i].l[1] * reach * s,
        ] as Vec2,
    );
  for (let i = 0; i < n; i++) {
    const q = pts[i];
    const ground = hf.sample(q[0], q[1]);
    const top = hs[i] - 2;
    // Every 32 m or more; also the last place before a stretch without
    // (a junction), so the span over it is no longer than it must be; and
    // on a crossing or beside another road only where the deck has gone
    // 48 m without.
    const gap = along[i] - lastPier;
    const last = i + 1 < n && okAt[i + 1] < 2;
    // Through a run of junctions (no median spot for 40 m and none within
    // 12 m ahead): a straddle bent, its legs on the sidewalks either side
    // and a cross-beam over the whole boulevard under the deck.
    if (
      okAt[i] === 0 &&
      gap > 40 &&
      nextOk[i] - along[i] > 12 &&
      top - ground > 3 &&
      legsAt(i).every(legOk)
    ) {
      const legs = legsAt(i);
      const stood = pier(e, q, top, 1.5, () => {
        const yaw = Math.atan2(fr[i].l[0], fr[i].l[1]);
        for (const g of legs) {
          const gy = hf.sample(g[0], g[1]);
          m.box(
            [g[0], (gy - 1 + top) / 2, g[1]],
            [0.8, (top - gy + 1) / 2, 0.8],
            packMat(CM.concrete),
            yaw,
          );
        }
        m.box(
          [q[0], top - 0.8, q[1]],
          [1.2, 0.8, reach + 0.9],
          packMat(CM.concrete),
          yaw,
        );
      });
      if (stood) {
        lastPier = along[i];
        pierCount++;
      }
    } else if (
      (okAt[i] === 2 && (gap > 32 || (gap > 12 && last))) ||
      (okAt[i] === 1 && gap > 48)
    ) {
      const yaw = Math.atan2(fr[i].d[0], fr[i].d[1]);
      const pierNo = pierCount;
      // (No pier where it can't stand clear of the lanes: the next point.)
      const stood = pier(e, q, top, 1.5, () => {
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
        pierSolid(q, ground, top);
        m.cylinder(
          [q[0], ground - 1, q[1]],
          PIER_RADIUS,
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
      if (stood) {
        lastPier = along[i];
        pierCount++;
        // Expansion joint across the deck over each pier.
        m.beam(
          P(i, -(halfW - 0.45), 0.012),
          P(i, halfW - 0.45, 0.012),
          0.12,
          0.012,
          packMat(CM.metal),
        );
      }
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

/** terrain.wgsl hash21 (in doubles: close enough to place boxes on). */
function shaderHash21(x: number, y: number) {
  const fr = (v: number) => v - Math.floor(v);
  let a = fr(x * 0.1031);
  let b = fr(y * 0.1031);
  let c = a;
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d;
  b += d;
  c += d;
  return fr((a + b) * c);
}

/** terrain.wgsl valueNoise. */
function shaderValueNoise(x: number, z: number) {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const fx = x - i;
  const fz = z - j;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = shaderHash21(i, j);
  const b = shaderHash21(i + 1, j);
  const c = shaderHash21(i, j + 1);
  const d = shaderHash21(i + 1, j + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

/** Outskirts block cell (m); terrain.wgsl OUT_CELL draws its streets. */
const OUT_CELL = 75;

/**
 * Whether outskirts block (i, j) (cells counted from the world's -x / -z
 * edge) is a park: terrain.wgsl outskirtsPark, in exact u32 arithmetic so
 * both sides agree.
 */
function outskirtsPark(i: number, j: number) {
  let v = (Math.imul(i + 4096, 73856093) ^ Math.imul(j + 4096, 19349663)) >>> 0;
  // The shaders' hashu.
  v = (v ^ 61 ^ (v >>> 16)) >>> 0;
  v = Math.imul(v, 9);
  v ^= v >>> 4;
  v = Math.imul(v, 0x27d4eb2d);
  v ^= v >>> 15;
  return ((v >>> 0) & 0xffff) < 3932; // 6 %
}
/**
 * Building line of an outskirts block: metres in from the cell's grid
 * lines (5 m of roadway and 2 m of pavement, terrain.wgsl outskirtsGround,
 * then a 0.5 m margin).
 */
const OUT_SETBACK = 7.5;

/**
 * Outskirts: the city continues past the generated world as low-detail
 * buildings (an HLOD skyline) so the horizon reads as an endless metropolis.
 * The band is a grid of 75 m blocks whose streets the terrain shader draws
 * (outskirtsGround); each block is built up to its building line as one
 * slab or as 2-6 lots with 3 m between them. Dense next to the world's
 * edge, thinning out (more empty blocks, more single slabs) toward the
 * horizon. `settled`: the terrain heights as rendered.
 */
function outskirts(L: CityLayout, m: CMesh, settled: Float32Array) {
  const hf0 = L.terrain.heights;
  const hf = new Heightfield(hf0.size, hf0.cell, settled);
  const S = L.params.size / 2;
  const band = 3600;
  const cell = OUT_CELL;
  const rng = new Rng(L.seed ^ 0x51ced);
  // Ground as terrain.wgsl heightAt draws it beyond the edge; NaN on water.
  const groundAt = (x: number, z: number) => {
    const raw = hf.sample(x, z);
    if (raw < 1.2) return NaN;
    const edge = Math.max(Math.abs(x), Math.abs(z)) - S;
    const alongZ = Math.abs(x) >= Math.abs(z);
    let acc = 0;
    for (let k = -2; k <= 2; k++)
      acc += alongZ ? hf.sample(x, z + k * 40) : hf.sample(x + k * 40, z);
    const h = Math.max(
      lerp(raw, acc * 0.2, Math.min(1, edge / 300)),
      Math.min(raw, 1.5),
    );
    return (
      h +
      (shaderValueNoise(x * 0.002, z * 0.002) - 0.5) *
        20 *
        Math.min(1, Math.max(0, edge / 1500))
    );
  };
  const box = (x0: number, z0: number, x1: number, z1: number, h: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, z] of [
      [x0, z0],
      [x1, z0],
      [x0, z1],
      [x1, z1],
      [(x0 + x1) / 2, (z0 + z1) / 2],
    ]) {
      const g = groundAt(x, z);
      if (!(g === g)) return;
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    const y0 = lo - 4;
    const y1 = hi + h;
    const style = rng.int(0, 1 << 16);
    m.box(
      [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
      [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2],
      // Zone 7: city-materials.wgsl shades the top as a roof.
      packMat(CM.facade, (style & 0x1fff) | (7 << 13) | (2 << 16)),
      0,
      rng.nextU32(),
    );
  };
  const height = (lo: number, hi: number) =>
    Math.min(160, rng.range(lo, hi) * (rng.chance(0.08) ? 3 : 1));
  // Split [a, b] into n parts at jittered points, gap metres between them.
  const split = (a: number, b: number, n: number, gap: number) => {
    const cuts = [a];
    for (let i = 1; i < n; i++)
      cuts.push(a + ((b - a) * (i + rng.range(-0.2, 0.2))) / n);
    cuts.push(b);
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++)
      out.push([
        cuts[i] + (i > 0 ? gap / 2 : 0),
        cuts[i + 1] - (i < n - 1 ? gap / 2 : 0),
      ]);
    return out;
  };
  for (let z = -S - band; z < S + band; z += cell) {
    for (let x = -S - band; x < S + band; x += cell) {
      // How far the block lies outside the world (< 0: inside).
      const dOut = Math.max(x - S, -S - x - cell, z - S, -S - z - cell);
      if (dOut < 0) continue;
      if (outskirtsPark(Math.round((x + S) / cell), Math.round((z + S) / cell)))
        continue;
      const t = smoothstep(0, 1000, dOut);
      if (rng.chance(0.04 + 0.56 * t)) continue;
      const bx0 = x + OUT_SETBACK;
      const bx1 = x + cell - OUT_SETBACK;
      const bz0 = z + OUT_SETBACK;
      const bz1 = z + cell - OUT_SETBACK;
      if (rng.chance(lerp(0.9, 0.05, t))) {
        // Lots: 2-3 by 1-2, every lot on the building line.
        const nx = rng.int(1, 4);
        const nz = nx === 1 ? rng.int(2, 4) : rng.int(1, 3);
        const occ = lerp(0.95, 0.6, t);
        for (const [x0, x1] of split(bx0, bx1, nx, 3))
          for (const [z0, z1] of split(bz0, bz1, nz, 3))
            if (rng.chance(occ)) box(x0, z0, x1, z1, height(9, 40));
      } else {
        // One slab over the block, a little in from the building line.
        const i = rng.range(0, 6);
        box(bx0 + i, bz0 + i, bx1 - i, bz1 - i, height(9, 30));
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

/**
 * The independent parts of the base build, in mesh order: the roads (with
 * the bridge piers, the settled terrain and the land use raster), the
 * blocks (sidewalks, ground fill; they record the curb band) and the
 * elevated rail and expressways (with the street lights).
 * Each can be built in its own worker (buildBasePart) and the parts put
 * together in this order (assembleBase) give the same base as one build.
 */
export const BASE_PARTS = ['roads', 'blocks', 'elevated'] as const;
export type BasePartName = (typeof BASE_PARTS)[number];

/** A built part: mesh, lights and camera solids, as transferable arrays. */
export interface BasePart {
  name: BasePartName;
  /** Vertex words (VERTEX_WORDS per vertex) and triangle indices. */
  words: Uint32Array;
  idx: Uint32Array;
  lights: Float64Array;
  solids: Float64Array;
  /** roads: the pier mesh, the terrain heights as rendered, land use. */
  pierWords?: Uint32Array;
  pierIdx?: Uint32Array;
  settled?: Float32Array;
  landUse?: Uint8Array;
  /** The road mask, if the maker sends it along (assembleBase's default). */
  mask?: Uint8Array;
  /** elevated: the street lights (after the part's own lights). */
  streetLights?: Float64Array;
  /** blocks: the curb band triangles (bandTrisData). */
  band?: Float64Array;
}

export function basePartTransfer(p: BasePart): Transferable[] {
  const out: Transferable[] = [
    p.words.buffer,
    p.idx.buffer,
    p.lights.buffer,
    p.solids.buffer,
  ];
  for (const a of [
    p.pierWords,
    p.pierIdx,
    p.settled,
    p.landUse,
    p.mask,
    p.streetLights,
    p.band,
  ])
    if (a) out.push(a.buffer);
  return out;
}

/**
 * Record the large boxes the bridge and viaduct builders emit into `mesh`,
 * so the camera can treat them as solid (they are otherwise only render
 * meshes). Returns the undo.
 */
function recordSolids(mesh: CMesh, solids: number[]) {
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
}

const meshWords = (m: CMesh) => m.u32.slice(0, m.vcount * VERTEX_WORDS);
const meshIdx = (m: CMesh) => m.idx.slice(0, m.icount);

/**
 * One part of the base: geom = computeRoadGeom(L), mask = roadMask(L) (the
 * blocks do without it).
 */
export function buildBasePart(
  L: CityLayout,
  name: BasePartName,
  geom: RoadGeom,
  mask: Uint8Array = new Uint8Array(0),
): BasePart {
  const m = new CMesh(1 << 16, 1 << 17);
  const lights = new LightList();
  const solids: number[] = [];
  const unM = recordSolids(m, solids);
  const part: Partial<BasePart> = {name};
  if (name === 'roads') {
    const piers = new CMesh(1 << 12, 1 << 13);
    const unP = recordSolids(piers, solids);
    const settled = settleRoadbed(L);
    roads(L, geom, m, lights, piers, settled);
    unP();
    part.pierWords = meshWords(piers);
    part.pierIdx = meshIdx(piers);
    release(piers.u32, piers.idx);
    part.settled = settled;
    part.landUse = landUse(
      L,
      mask,
      L.hidden ? roadMask(L, true, geom) : undefined,
    );
  } else if (name === 'blocks') {
    blocks(L, m, geom);
    part.band = bandTrisData(geom);
  } else {
    elevatedStructures(L, geom, mask, m, lights, (c, h, yaw) =>
      solids.push(c[0], c[1], c[2], h[0], h[1], h[2], yaw),
    );
    const street = new LightList();
    streetLights(L, geom, street);
    part.streetLights = new Float64Array(street.data);
  }
  unM();
  part.words = meshWords(m);
  part.idx = meshIdx(m);
  release(m.u32, m.idx);
  part.lights = new Float64Array(lights.data);
  part.solids = new Float64Array(solids);
  return part as BasePart;
}

/**
 * The base from its parts (one of each, any order) and the rest; `mask`
 * defaults to the one a part carries.
 */
export function assembleBase(
  L: CityLayout,
  geom: RoadGeom,
  mask: Uint8Array | undefined,
  parts: BasePart[],
): BaseGeometry {
  // Sized for the parts plus the outskirts (up to ~330k vertices), so the
  // largest buffer of the load is not grown by doubling (and copying).
  let nv = 1 << 19;
  let ni = 1 << 20;
  for (const p of parts) {
    nv += p.words.length / VERTEX_WORDS;
    ni += p.idx.length;
  }
  const m = new CMesh(nv, ni);
  const piers = new CMesh(1 << 12, 1 << 13);
  const lights = new LightList();
  const solids: number[] = [];
  const of = (name: BasePartName) => parts.find(p => p.name === name)!;
  for (const name of BASE_PARTS) {
    const p = of(name);
    m.append(p.words, p.idx);
    for (const v of p.lights) lights.data.push(v);
    for (const v of p.solids) solids.push(v);
  }
  for (const v of of('elevated').streetLights!) lights.data.push(v);
  const r = of('roads');
  piers.append(r.pierWords!, r.pierIdx!);
  if (!bandTrisOf.has(geom)) attachBand(geom, of('blocks').band!);
  // The asset lab shows its subject alone, without the distant skyline.
  if (!L.hidden) outskirts(L, m, r.settled!);
  return {
    mesh: m,
    piers,
    lights: lights.data,
    landUse: r.landUse!,
    roadMask: mask ?? parts.find(p => p.mask)!.mask!,
    geom,
    terrainHeights: r.settled!,
    solids,
  };
}

export function buildBase(L: CityLayout): BaseGeometry {
  const geom = computeRoadGeom(L);
  const mask = roadMask(L);
  return assembleBase(
    L,
    geom,
    mask,
    BASE_PARTS.map(name => buildBasePart(L, name, geom, mask)),
  );
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
  // Boxes are clipped to the map (plus a margin): nothing queries beyond
  // it, and a stray far vertex would otherwise fill millions of cells.
  const lim = L.params.size / 2 + 256;
  const add = (
    g: Map<number, number[]>,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    v: number,
  ) => {
    x0 = Math.max(x0, -lim);
    z0 = Math.max(z0, -lim);
    x1 = Math.min(x1, lim);
    z1 = Math.min(z1, lim);
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
 * over the lanes; New York's mast arms), shared by the tile props (pole,
 * heads, luminaire) and the base light list (the junction luminaire's
 * light). `arm` indexes geom.junctions[ji].arms.
 *
 * Each arm's pole carries the heads for the traffic crossing the box toward
 * that arm (travelling along arm.dir; `face` = -arm.dir, toward it), and
 * stands on that traffic's nearside (config.ts nearside()) just past the
 * box: the far left-hand corner in Tokyo, the far right-hand one in New
 * York. The arm (`armDir`, from the pole across the road) hangs the heads
 * over that traffic's own lanes, as Japanese overhang signals and US mast
 * arms do.
 */
export function signalSpots(
  L: CityLayout,
  geom: RoadGeom,
  hf: Heightfield,
  ji: number,
  cb: (p: Vec3, armDir: Vec2, reach: number, arm: number, face: Vec2) => void,
) {
  const j = L.junctions[ji];
  if (!j.signal || L.hidden?.junctions[ji]) return;
  // Lab site edge: no plate (see roads()), no signals.
  if (L.hidden && j.arms.filter(a => !L.hidden!.chains[a.chain]).length <= 1)
    return;
  const jg = geom.junctions[ji];
  const land = landing(L, geom);
  jg.arms.forEach((a, k) => {
    const l = nearside(L.params, a.dir);
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
        cb(p, [-l[0], -l[1]], Math.min(a.width * 0.45, 6) + extra, k, [
          -a.dir[0],
          -a.dir[1],
        ]);
        return;
      }
    }
  });
}

/**
 * Junction luminaire on a signal pole: arm height, the head's reach and
 * (on the mast poles, see signalLums) the far head's maximum reach.
 */
export const SIGNAL_LUM = {h: 9.5, reach: 2.5, far: 6.5} as const;

/**
 * The junction luminaire heads on signal pole `k` of junction ji (pole at
 * p, from signalSpots): the luminaire arm points from the pole toward the
 * junction centre (round 4 aimed it across the approach and threw the
 * light down the approach, leaving the box the darkest place on the road
 * at night). Every pole has a head at SIGNAL_LUM.reach (`pool` false: a
 * directed throw toward the centre); on two diagonal poles of each box
 * with an avenue or arterial arm the arm reaches on over the box to a second head (`pool` true: a round
 * pool, kind 0) up to SIGNAL_LUM.far out, stopping 3 m short of the
 * centre. Shared by the tile props, the base light list and the tree
 * clearance.
 */
export function signalLums(
  L: CityLayout,
  ji: number,
  p: Vec3,
  armDir: Vec2,
  k: number,
  cb: (head: Vec3, dir: Vec2, reach: number, pool: boolean) => void,
) {
  const c = L.junctions[ji].p;
  const dx = c[0] - p[0];
  const dz = c[1] - p[2];
  const dl = Math.hypot(dx, dz);
  const dir: Vec2 = dl > 1 ? [dx / dl, dz / dl] : armDir;
  const head = (r: number): Vec3 => [
    p[0] + dir[0] * r,
    p[1] + SIGNAL_LUM.h,
    p[2] + dir[1] * r,
  ];
  cb(head(SIGNAL_LUM.reach), dir, SIGNAL_LUM.reach, false);
  const far = Math.min(SIGNAL_LUM.far, dl - 3);
  const big = L.junctions[ji].arms.some(a => L.chains[a.chain].kind >= 2);
  if (big && ((k + hash2(ji, 0x1a4)) & 1) === 0 && far > SIGNAL_LUM.reach + 1.5)
    cb(head(far), dir, far, true);
}

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
      signalSpots(L, geom, hf, ji, (p, armDir, _r, k) =>
        signalLums(L, ji, p, armDir, k, h => add(h[0], h[2])),
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
  // Junction luminaires on the signal poles (signalLums): each corner
  // head throws toward the box centre (directed, brighter than the road
  // luminaires), and the far heads over the box are round pools (kind
  // exactly 0, which the shader doubles), so the box is the best-lit place
  // on the road.
  // Tuned in the lab (top-night): box mean luma ~1.1-1.2x the sidewalk's.
  const s = 1.0;
  const lum: Vec3 = [LED[0] * s, LED[1] * s, LED[2] * s];
  const p = 0.4;
  const poolCol: Vec3 = [LED[0] * p, LED[1] * p, LED[2] * p];
  L.junctions.forEach((_, ji) =>
    signalSpots(L, geom, hf, ji, (p, armDir, _reach, k) =>
      signalLums(L, ji, p, armDir, k, (h, dir, _r, pool) =>
        lights.add(
          [h[0], h[1] - 0.35, h[2]],
          pool ? 26 : 24,
          pool ? poolCol : lum,
          pool ? LightKind.street : directedKind(dir),
        ),
      ),
    ),
  );
}

export {Rng};
