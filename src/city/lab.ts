// Asset lab: shows one building, road junction or rail viaduct of a generated
// city on its own, with the full game renderer, so it can be judged and
// iterated on in isolation. The city layout is generated as usual and then
// filtered (the layout RNG stream is untouched). Buildings and elevated
// structures are dropped from their arrays; chains, junctions and blocks keep
// their indices (tile props hash them) and are masked via CityLayout.hidden.
// Also computes the fixed camera presets around the chosen asset.

import {
  clamp,
  dist2,
  pointInPolygon,
  pointSegment,
  type Vec2,
} from '../math/vec.ts';
import type {Vec3} from '../math/vec.ts';
import {sidewalkY} from './gen-base.ts';
import {
  closestOnPolyline,
  elevatedHalfWidth,
  Road,
  ROAD_WIDTH,
  SIDEWALK,
  type Block,
  type BuildingKind,
  type CityLayout,
  type Elevated,
  type RoadChain,
} from './layout.ts';
import {chainAt, computeRoadGeom, type RoadGeom} from './roadgeom.ts';
import {SEA_LEVEL} from './terrain.ts';

export type LabAsset = 'building' | 'road' | 'rail';

export interface LabSpec {
  asset: LabAsset;
  /** Which candidate (0 = the most typical / first). */
  pick: number;
  /** Building kind filter. */
  kind?: BuildingKind;
  /** Rail: centre the section on a station. */
  station?: boolean;
  /** Keep the buildings around a road or rail asset as context. */
  ctx?: boolean;
}

export interface LabView {
  eye: Vec3;
  target: Vec3;
  /** Vertical field of view in radians. */
  fov: number;
  /** Show every tile at LOD1 (the distant shell). */
  lod1?: boolean;
}

export interface LabInfo {
  asset: LabAsset;
  /** What was picked, for the HUD and logs. */
  label: string;
  /** Streaming focus. */
  focus: Vec3;
  /** Camera presets in display order. */
  views: Record<string, LabView>;
  /** The `orbit` preset circles `center` at `radius`, eye at `height`. */
  orbit: {center: Vec3; radius: number; height: number; fov: number};
}

/** What isolate() chose; labInfo() turns it into camera presets. */
type Site =
  | {asset: 'building'; building: number; chain: number; s: number}
  | {asset: 'road'; junction: number}
  | {asset: 'rail'; line: number; s: number; station: number};

export interface Isolated {
  layout: CityLayout;
  site: Site;
  label: string;
}

const KINDS: BuildingKind[] = [
  'tower',
  'glass',
  'midrise',
  'pencil',
  'house',
  'apartment',
  'station',
];

export function isLabAsset(s: string | null): s is LabAsset {
  return s === 'building' || s === 'road' || s === 'rail';
}

export function isBuildingKind(s: string | null): s is BuildingKind {
  return KINDS.includes(s as BuildingKind);
}

function bbox(pts: Vec2[], pad = 0): [number, number, number, number] {
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const q of pts) {
    x0 = Math.min(x0, q[0]);
    x1 = Math.max(x1, q[0]);
    z0 = Math.min(z0, q[1]);
    z1 = Math.max(z1, q[1]);
  }
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}

const overlap = (
  a: [number, number, number, number],
  b: [number, number, number, number],
) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

function polyDist(q: Vec2, poly: Vec2[]) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++)
    d = Math.min(d, pointSegment(q, poly[i], poly[(i + 1) % poly.length])[0]);
  return d;
}

/** Points every ~2 m along a chain. */
function samples(c: RoadChain): Vec2[] {
  const out: Vec2[] = [c.pts[0]];
  for (let i = 1; i < c.pts.length; i++) {
    const a = c.pts[i - 1];
    const b = c.pts[i];
    const k = Math.max(1, Math.ceil(dist2(a, b) / 2));
    for (let s = 1; s <= k; s++)
      out.push([
        a[0] + ((b[0] - a[0]) * s) / k,
        a[1] + ((b[1] - a[1]) * s) / k,
      ]);
  }
  return out;
}

/** The chain runs along the block's curb (for at least ~6 m). */
function alongBlock(c: RoadChain, pts: Vec2[], b: Block) {
  const r = ROAD_WIDTH[c.kind] / 2 + 1.5;
  let n = 0;
  for (const q of pts) if (polyDist(q, b.curb) < r && ++n >= 3) return true;
  return false;
}

function centroid(poly: Vec2[]): Vec2 {
  let x = 0,
    z = 0;
  for (const q of poly) {
    x += q[0];
    z += q[1];
  }
  return [x / poly.length, z / poly.length];
}

function areaAbs(poly: Vec2[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

/** Outward unit normal of the building's front edge, and the edge midpoint. */
function frontEdge(fp: Vec2[], front: number) {
  const a = fp[front];
  const b = fp[(front + 1) % fp.length];
  const l = dist2(a, b) || 1;
  const u: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  let n: Vec2 = [u[1], -u[0]];
  const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // Outward: away from the footprint centroid (independent of winding).
  const c = centroid(fp);
  if ((m[0] - c[0]) * n[0] + (m[1] - c[1]) * n[1] < 0) n = [-n[0], -n[1]];
  return {m, u, n};
}

/** Arc length on a chain nearest to q. */
function chainS(c: RoadChain, arc: number[], q: Vec2) {
  const h = closestOnPolyline(c.pts, q);
  return {s: arc[h.i] + (arc[h.i + 1] - arc[h.i]) * h.t, d: h.d};
}

function emptyMask(L: CityLayout) {
  return {
    chains: new Uint8Array(L.chains.length).fill(1),
    junctions: new Uint8Array(L.junctions.length).fill(1),
    blocks: new Uint8Array(L.blocks.length).fill(1),
  };
}

/** Show the junctions at both ends of the visible chains. */
function showEnds(L: CityLayout, mask: ReturnType<typeof emptyMask>) {
  L.junctions.forEach((j, ji) => {
    if (j.arms.some(a => !mask.chains[a.chain])) mask.junctions[ji] = 0;
  });
}

/** Show the blocks the visible chains run along (`near` limits them). */
function showBlocks(
  L: CityLayout,
  mask: ReturnType<typeof emptyMask>,
  near: (b: Block) => boolean,
) {
  const vis = L.chains
    .map((c, ci) => ({c, ci}))
    .filter(x => !mask.chains[x.ci])
    .map(x => ({c: x.c, pts: samples(x.c), box: bbox(x.c.pts, 16)}));
  L.blocks.forEach((b, bi) => {
    if (!mask.blocks[bi] || !near(b)) return;
    const box = bbox(b.curb);
    if (vis.some(v => overlap(v.box, box) && alongBlock(v.c, v.pts, b)))
      mask.blocks[bi] = 0;
  });
}

/** The block a building stands on. */
function blockOf(L: CityLayout, p: Vec2) {
  return L.blocks.findIndex(b => !b.park && pointInPolygon(p, b.curb));
}

/**
 * Filter the layout down to one asset. Throws if nothing matches.
 */
export function isolate(L: CityLayout, spec: LabSpec): Isolated {
  const geom = computeRoadGeom(L);
  const mask = emptyMask(L);
  const hf = L.terrain.heights;
  const keepBuildings = (blocks: Uint8Array) =>
    L.buildings.filter(b => {
      const bi = blockOf(L, centroid(b.footprint));
      return bi >= 0 && !blocks[bi];
    });
  if (spec.asset === 'building') {
    // Candidates with a street frontage, ordered by how typical they are for
    // their kind (height and footprint near the kind's median, on flat
    // ground), so pick=0 is a representative example.
    const cands = L.buildings
      .map((b, i) => ({b, i}))
      .filter(x => x.b.front >= 0 && (!spec.kind || x.b.kind === spec.kind));
    if (!cands.length)
      throw new Error(`lab: no ${spec.kind ?? ''} building with a frontage`);
    const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
    const med = new Map<BuildingKind, [number, number]>();
    for (const k of KINDS) {
      const of = cands.filter(x => x.b.kind === k);
      if (of.length)
        med.set(k, [
          median(of.map(x => x.b.height)),
          median(of.map(x => areaAbs(x.b.footprint))),
        ]);
    }
    const score = (x: (typeof cands)[0]) => {
      const [mh, ma] = med.get(x.b.kind)!;
      return (
        Math.abs(Math.log(x.b.height / mh)) +
        Math.abs(Math.log(areaAbs(x.b.footprint) / ma))
      );
    };
    const order = cands
      .map(x => ({...x, k: score(x)}))
      .sort((a, b) => a.k - b.k || a.b.id - b.b.id);
    let n = spec.pick;
    for (const {b, i} of order) {
      // Skip sites on slopes (exposed foundations) or beside a viaduct.
      if (b.base - b.low > 1.5) continue;
      if (L.elevated.some(e => closestOnPolyline(e.pts, b.footprint[0]).d < 40))
        continue;
      const bi = blockOf(L, centroid(b.footprint));
      if (bi < 0) continue;
      // The street in front: nearest chain ahead of the front edge.
      const {m, n: nrm} = frontEdge(b.footprint, b.front);
      let chain = -1;
      let best = 40;
      let s = 0;
      L.chains.forEach((c, ci) => {
        if (c.bridge.some(x => x)) return;
        const h = chainS(c, geom.arc[ci], m);
        if (h.d >= best) return;
        const q = chainAt(c, geom.arc[ci], h.s).p;
        const ahead = (q[0] - m[0]) * nrm[0] + (q[1] - m[1]) * nrm[1];
        if (ahead < h.d * 0.6) return;
        chain = ci;
        best = h.d;
        s = h.s;
      });
      if (chain < 0 || n-- > 0) continue;
      // Its block, the chains along the block, the junctions at their ends,
      // and the blocks across those streets (for the opposite sidewalk).
      const blk = L.blocks[bi];
      const box = bbox(blk.curb, 30);
      L.chains.forEach((c, ci) => {
        if (overlap(bbox(c.pts), box) && alongBlock(c, samples(c), blk))
          mask.chains[ci] = 0;
      });
      mask.chains[chain] = 0;
      showEnds(L, mask);
      showBlocks(
        L,
        mask,
        bb => dist2(centroid(bb.curb), centroid(blk.curb)) < 400,
      );
      mask.blocks[bi] = 0;
      return {
        layout: {...L, buildings: [b], elevated: [], hidden: mask},
        site: {asset: 'building', building: 0, chain, s},
        label: `building #${i} ${b.kind} ${b.height.toFixed(0)} m`,
      };
    }
    throw new Error(`lab: only ${spec.pick - n} ${spec.kind ?? ''} buildings`);
  }
  if (spec.asset === 'road') {
    // Junctions of streets and avenues with three or more arms, on land, away
    // from viaducts and bridges: signalized crossroads first, then nearest
    // the city centre.
    const center = L.hubs[0].p;
    const cands = L.junctions
      .map((j, i) => ({j, i}))
      .filter(({j}) => {
        if (j.arms.length < 3) return false;
        const kinds = j.arms.map(a => L.chains[a.chain].kind);
        if (
          Math.min(...kinds) < Road.street ||
          Math.max(...kinds) < Road.avenue
        )
          return false;
        if (j.arms.some(a => L.chains[a.chain].bridge.some(x => x)))
          return false;
        if (hf.sample(j.p[0], j.p[1]) < SEA_LEVEL + 1) return false;
        return !L.elevated.some(e => closestOnPolyline(e.pts, j.p).d < 80);
      })
      .map(x => ({
        ...x,
        k:
          dist2(x.j.p, center) +
          (x.j.signal ? 0 : 4000) +
          (x.j.arms.length >= 4 ? 0 : 2000),
      }))
      .sort((a, b) => a.k - b.k);
    const pick = cands[spec.pick];
    if (!pick) throw new Error(`lab: only ${cands.length} junctions`);
    const R = 120;
    L.chains.forEach((c, ci) => {
      if (closestOnPolyline(c.pts, pick.j.p).d < R) mask.chains[ci] = 0;
    });
    showEnds(L, mask);
    showBlocks(L, mask, b => dist2(centroid(b.curb), pick.j.p) < R + 60);
    return {
      layout: {
        ...L,
        buildings: spec.ctx ? keepBuildings(mask.blocks) : [],
        elevated: [],
        hidden: mask,
      },
      site: {asset: 'road', junction: pick.i},
      label: `junction #${pick.i} (${pick.j.arms.length} arms)`,
    };
  }
  // Rail: sections every 300 m along each line (on land, fairly straight,
  // clear of stations), or the stations themselves.
  const sites: {line: number; s: number; station: number}[] = [];
  L.elevated.forEach((e, li) => {
    if (e.kind !== 'rail') return;
    const arc = arcOf(e.pts);
    const total = arc[arc.length - 1];
    const stationS = e.stations.map(si => arc[si]);
    if (spec.station) {
      e.stations.forEach((si, k) =>
        sites.push({line: li, s: stationS[k], station: si}),
      );
      return;
    }
    for (let s = 300; s < total - 300; s += 300) {
      const p = along(e, arc, s);
      const a = along(e, arc, s - 120).d;
      const b = along(e, arc, s + 120).d;
      if (a[0] * b[0] + a[1] * b[1] < Math.cos(0.2)) continue;
      if (hf.sample(p.p[0], p.p[1]) < SEA_LEVEL + 1) continue;
      if (stationS.some(t => Math.abs(t - s) < 150)) continue;
      sites.push({line: li, s, station: -1});
    }
  });
  const site = sites[spec.pick];
  if (!site) throw new Error(`lab: only ${sites.length} rail sections`);
  const e = L.elevated[site.line];
  const F = along(e, arcOf(e.pts), site.s).p;
  // Ground roads under and beside the viaduct near the section.
  const R = 450;
  const reach = elevatedHalfWidth(e) + 25;
  L.chains.forEach((c, ci) => {
    if (closestOnPolyline(c.pts, F).d > R) return;
    if (
      samples(c).some(
        q => dist2(q, F) < R && closestOnPolyline(e.pts, q).d < reach,
      )
    )
      mask.chains[ci] = 0;
  });
  showEnds(L, mask);
  showBlocks(
    L,
    mask,
    b =>
      dist2(centroid(b.curb), F) < R &&
      b.curb.some(q => closestOnPolyline(e.pts, q).d < 60),
  );
  return {
    layout: {
      ...L,
      buildings: spec.ctx ? keepBuildings(mask.blocks) : [],
      elevated: [e],
      hidden: mask,
    },
    site: {asset: 'rail', line: 0, s: site.s, station: site.station},
    label: `rail line ${site.line} at ${site.s.toFixed(0)} m${site.station >= 0 ? ' (station)' : ''}`,
  };
}

function arcOf(pts: Vec2[]) {
  const a = [0];
  for (let i = 1; i < pts.length; i++)
    a.push(a[i - 1] + dist2(pts[i - 1], pts[i]));
  return a;
}

/** Point, unit tangent and deck height at arc length s along a viaduct. */
function along(e: Elevated, arc: number[], s: number) {
  const n = e.pts.length;
  s = clamp(s, 0, arc[n - 1]);
  let i = 0;
  while (i < n - 2 && arc[i + 1] < s) i++;
  const t = (s - arc[i]) / (arc[i + 1] - arc[i] || 1);
  const a = e.pts[i];
  const b = e.pts[i + 1];
  const l = dist2(a, b) || 1;
  return {
    p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as Vec2,
    d: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] as Vec2,
    h: e.heights[i] + (e.heights[i + 1] - e.heights[i]) * t,
  };
}

const rot = (d: Vec2, a: number): Vec2 => [
  d[0] * Math.cos(a) - d[1] * Math.sin(a),
  d[0] * Math.sin(a) + d[1] * Math.cos(a),
];

/**
 * Camera presets for the isolated asset. `solids` are the viaduct boxes from
 * buildBase (the camera must not stand inside a pier).
 */
export function labInfo(
  iso: Isolated,
  geom: RoadGeom,
  solids: number[],
): LabInfo {
  const L = iso.layout;
  const hf = L.terrain.heights;
  const g = (q: Vec2) => hf.sample(q[0], q[1]);
  const v3 = (q: Vec2, y: number): Vec3 => [q[0], y, q[1]];
  const site = iso.site;
  const views: Record<string, LabView> = {};
  const look = (eye: Vec3, target: Vec3, fov = 1.0, lod1 = false) => ({
    eye: [
      eye[0],
      Math.max(eye[1], hf.sample(eye[0], eye[2]) + 0.5),
      eye[2],
    ] as Vec3,
    target,
    fov,
    ...(lod1 ? {lod1} : {}),
  });
  /** Eye at horizontal distance `d` from `c` along `dir`, `y` absolute. */
  const from = (c: Vec3, dir: Vec2, d: number, y: number): Vec3 => [
    c[0] + dir[0] * d,
    y,
    c[2] + dir[1] * d,
  ];
  let orbit: LabInfo['orbit'];
  let focus: Vec3;
  if (site.asset === 'building') {
    const b = L.buildings[site.building];
    const fp = b.footprint;
    const {m, u, n} = frontEdge(fp, b.front);
    // Extents in the front frame (u along the facade, n out of it).
    let u0 = Infinity,
      u1 = -Infinity,
      n0 = Infinity,
      n1 = -Infinity;
    for (const q of fp) {
      const dx = q[0] - m[0];
      const dz = q[1] - m[1];
      u0 = Math.min(u0, dx * u[0] + dz * u[1]);
      u1 = Math.max(u1, dx * u[0] + dz * u[1]);
      n0 = Math.min(n0, dx * n[0] + dz * n[1]);
      n1 = Math.max(n1, dx * n[0] + dz * n[1]);
    }
    const at = (du: number, dn: number): Vec2 => [
      m[0] + u[0] * du + n[0] * dn,
      m[1] + u[1] * du + n[1] * dn,
    ];
    const span = Math.max(u1 - u0, n1 - n0);
    const y0 = b.base;
    const top = b.base + b.height;
    const C = v3(at((u0 + u1) / 2, (n0 + n1) / 2), y0 + b.height * 0.45);
    focus = C;
    const size = Math.max(b.height, span);
    // Distance at which the whole building fits a 1 rad vertical view.
    const fit = (0.6 * size) / Math.tan(0.5);
    // Street: on the opposite sidewalk, moved along the street past the
    // near front corner, looking back at the corner (3/4 view).
    const c = L.chains[site.chain];
    const arc = geom.arc[site.chain];
    const q0 = chainAt(c, arc, site.s);
    const left: Vec2 = [-q0.d[1], q0.d[0]];
    const side =
      (m[0] - q0.p[0]) * left[0] + (m[1] - q0.p[1]) * left[1] > 0 ? 1 : -1;
    const across = ROAD_WIDTH[c.kind] / 2 + SIDEWALK[c.kind] * 0.55;
    const toFacade = dist2(q0.p, m) + across;
    // Walk along the street toward the end with more room; dirU is the
    // matching direction along the facade.
    const total = arc[arc.length - 1];
    const sgn = total - site.s >= site.s ? 1 : -1;
    const dirU = (u[0] * q0.d[0] + u[1] * q0.d[1]) * sgn > 0 ? 1 : -1;
    const corner = dirU > 0 ? u1 : u0;
    const ds = Math.abs(corner - (u0 + u1) / 2) + toFacade * 0.55;
    const sS = clamp(site.s + sgn * ds, 2, total - 2);
    const q1 = chainAt(c, arc, sS);
    const l1: Vec2 = [-q1.d[1], q1.d[0]];
    const sp: Vec2 = [
      q1.p[0] - l1[0] * across * side,
      q1.p[1] - l1[1] * across * side,
    ];
    const eyeS = v3(sp, sidewalkY(hf, sp[0], sp[1], q1.h) + 1.7);
    const T = at((u0 + u1) / 2 + (corner - (u0 + u1) / 2) * 0.35, 0);
    const Dh = dist2(sp, T);
    const fovS = 1.05;
    const aB = Math.atan2(y0 - eyeS[1], Dh);
    const aT = Math.atan2(top - eyeS[1], Dh);
    const pitch = aT - aB < fovS * 0.85 ? (aT + aB) / 2 : aB + fovS / 2 - 0.08;
    views.street = look(eyeS, v3(T, eyeS[1] + Math.tan(pitch) * Dh), fovS);
    // Facade: 8 m out from the middle of the front, looking up 25 degrees.
    const fq = at((u0 + u1) / 2, 8);
    const fy = sidewalkY(hf, fq[0], fq[1], y0) + 1.7;
    const fa = 25 * (Math.PI / 180);
    views.facade = look(
      v3(fq, fy),
      [
        fq[0] - n[0] * Math.cos(fa),
        fy + Math.sin(fa),
        fq[1] - n[1] * Math.cos(fa),
      ],
      1.05,
    );
    // 3/4 directions on the street side and behind.
    const d34 = rot(n, 0.7 * dirU);
    const back = rot([-n[0], -n[1]], -0.6 * dirU);
    views.mid = look(
      from(C, d34, Math.max(100, fit * 1.3), y0 + 20 + b.height * 0.2),
      C,
    );
    views.far = look(from(C, d34, Math.max(350, fit * 2.5), y0 + 60), C);
    views.shell = {...views.far, lod1: true};
    // Aerial: 45 degrees down onto the roof, close enough that the roof
    // fills about 40 % of the frame (the top of the front facade shows).
    const R = v3([C[0], C[2]], top - Math.min(3, b.height * 0.15));
    const ad = Math.max(24, span * 1.6) * Math.SQRT1_2;
    views.aerial = look(from(R, rot(n, 0.5 * dirU), ad, R[1] + ad), R);
    views.rear = look(
      // Above the utility wires (8-9 m) that line small streets.
      from(
        C,
        back,
        Math.max(45, fit * 1.1),
        y0 + Math.max(14, b.height * 0.35),
      ),
      C,
    );
    // Service: the rear at eye level, 3/4 from the other side.
    const svc = rot([-n[0], -n[1]], 0.75 * dirU);
    const sq: Vec2 = [
      C[0] + svc[0] * Math.max(20, span * 1.2),
      C[2] + svc[1] * Math.max(20, span * 1.2),
    ];
    views.service = look(
      v3(sq, g(sq) + 1.7),
      v3([C[0], C[2]], y0 + Math.min(b.height, 20) * 0.4),
      1.1,
    );
    orbit = {
      center: C,
      radius: Math.max(42, fit * 1.3),
      height: y0 + b.height * 0.6 + 12,
      fov: 1.0,
    };
  } else if (site.asset === 'road') {
    const j = L.junctions[site.junction];
    const jg = geom.junctions[site.junction];
    // The widest arm is the road we look along.
    const arm = jg.arms.reduce((a, b) => (b.width > a.width ? b : a));
    const c = L.chains[arm.chain];
    const arc = geom.arc[arm.chain];
    const total = arc[arc.length - 1];
    /** Point `d` m out along the arm, `lat` m to its left. */
    const P = (d: number, lat: number) => {
      const q = chainAt(c, arc, arm.end === 0 ? d : total - d);
      const dir: Vec2 = arm.end === 0 ? q.d : [-q.d[0], -q.d[1]];
      const l: Vec2 = [-dir[1], dir[0]];
      return {
        p: [q.p[0] + l[0] * lat, q.p[1] + l[1] * lat] as Vec2,
        h: q.h,
        dir,
      };
    };
    const W = ROAD_WIDTH[c.kind];
    const sw = SIDEWALK[c.kind];
    const sb = arm.setback;
    const J = v3(j.p, j.h);
    focus = J;
    // Stand on the sidewalk of the larger visible block (one side of a
    // divided road may be a narrow median strip).
    const blockArea = (q: Vec2) => {
      const bi = L.blocks.findIndex(
        (b, i) => !L.hidden?.blocks[i] && pointInPolygon(q, b.curb),
      );
      return bi < 0 ? 0 : areaAbs(L.blocks[bi].curb);
    };
    const lat = W / 2 + sw * 0.5;
    const ws = blockArea(P(sb + 28, -lat).p) > blockArea(P(sb + 28, lat).p);
    const walk = P(sb + 28, ws ? -lat : lat);
    views.eye = look(
      v3(walk.p, sidewalkY(hf, walk.p[0], walk.p[1], walk.h) + 1.7),
      v3(P(sb, (W / 2) * (ws ? -0.2 : 0.2)).p, j.h + 1.2),
      1.05,
    );
    // Tokyo drives on the left: the lane heading to the junction is on the
    // arm's right (as seen from the junction).
    const lane = P(sb + 32, -W / 4);
    views.low = look(
      v3(lane.p, lane.h + 1.2),
      v3(P(0, -W / 4).p, j.h + 1.0),
      1.05,
    );
    views.top = look([j.p[0], j.h + 40, j.p[1] + 0.3], J);
    views.mid = look(from(J, rot(arm.dir, 0.8), 45, j.h + 30), J);
    views.far = look(from(J, rot(arm.dir, 0.35), 250, j.h + 50), J);
    views.shell = {...views.far, lod1: true};
    // Looking along the gutter toward the junction, 2 m from the curb.
    const k = P(sb + 9, W / 2 - 0.3);
    const ce = P(sb + 12, W / 2 - 1.5);
    views.curb = look(v3(ce.p, ce.h + 1.3), v3(k.p, k.h + 0.05), 1.05);
    orbit = {center: J, radius: 70, height: j.h + 25, fov: 1.0};
  } else {
    const e = L.elevated[site.line];
    const arc = arcOf(e.pts);
    const A = along(e, arc, site.s);
    const t = A.d;
    const l: Vec2 = [-t[1], t[0]];
    const H = A.h;
    const gF = g(A.p);
    const F = v3(A.p, H - 2);
    focus = F;
    const sideP: Vec2 = [A.p[0] + l[0] * 40, A.p[1] + l[1] * 40];
    views.side = look(v3(sideP, g(sideP) + 1.7), F, 1.05);
    // Under the deck, off its centre line and clear of piers.
    const inSolid = (q: Vec2, y: number) => {
      for (let i = 0; i < solids.length; i += 7) {
        const [cx, cy, cz, hx, hy, hz, yaw] = solids.slice(i, i + 7);
        const dx = q[0] - cx;
        const dz = q[1] - cz;
        // CMesh.box: local x = (cos yaw, -sin yaw), z = (sin yaw, cos yaw).
        const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
        const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
        if (
          Math.abs(lx) < hx + 1.2 &&
          Math.abs(lz) < hz + 1.2 &&
          Math.abs(y - cy) < hy + 1
        )
          return true;
      }
      return false;
    };
    let under = A;
    let off = 2.5;
    search: for (const o of [2.5, -2.5, 4, -4]) {
      for (let k = 0; k <= 24; k++) {
        const s = site.s + (k % 2 ? 1 : -1) * Math.ceil(k / 2);
        const q = along(e, arc, s);
        const p: Vec2 = [q.p[0] - q.d[1] * o, q.p[1] + q.d[0] * o];
        if (!inSolid(p, g(p) + 1.7)) {
          under = q;
          off = o;
          break search;
        }
      }
    }
    const uP: Vec2 = [
      under.p[0] - under.d[1] * off,
      under.p[1] + under.d[0] * off,
    ];
    const uy = g(uP) + 1.7;
    views.under = look(
      v3(uP, uy),
      [uP[0] + under.d[0] * 40, uy + 5, uP[1] + under.d[1] * 40],
      1.05,
    );
    const ahead = along(e, arc, site.s + 60);
    views.along = look(v3(A.p, H + 5), v3(ahead.p, ahead.h + 1), 1.05);
    views.mid = look(from(F, rot(l, 0.7), 120, gF + 30), F);
    views.far = look(from(F, rot(l, 0.5), 300, gF + 60), F);
    views.shell = {...views.far, lod1: true};
    // Station: from the street, 3/4 onto the platforms.
    const si =
      site.station >= 0
        ? site.station
        : e.stations.reduce(
            (best, s) =>
              best < 0 ||
              Math.abs(arc[s] - site.s) < Math.abs(arc[best] - site.s)
                ? s
                : best,
            -1,
          );
    if (si >= 0 && Math.abs(arc[si] - site.s) < 300) {
      const S = along(e, arc, arc[si]);
      const sl: Vec2 = [-S.d[1], S.d[0]];
      const sp: Vec2 = [
        S.p[0] + sl[0] * 32 + S.d[0] * 30,
        S.p[1] + sl[1] * 32 + S.d[1] * 30,
      ];
      views.station = look(v3(sp, g(sp) + 1.7), v3(S.p, S.h - 1), 1.05);
    }
    orbit = {center: F, radius: 110, height: gF + 35, fov: 1.0};
  }
  const a0 = 0.3;
  views.orbit = look(
    [
      orbit.center[0] + Math.sin(a0) * orbit.radius,
      orbit.height,
      orbit.center[2] + Math.cos(a0) * orbit.radius,
    ],
    orbit.center,
    orbit.fov,
  );
  return {asset: site.asset, label: iso.label, focus, views, orbit};
}
