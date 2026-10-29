// Generic road-vehicle body built from NURBS sheets:
//
//   wall  — one loft per side running around the plan outline from the rear
//           tip, along the side, to the front tip. Each station is a vertical
//           profile (sill -> side -> shoulder roll) placed along the outline
//           normal, so bumpers, front face, flanks and rear face are one smooth
//           surface. The bottom edge rises over the wheels to form the arches.
//   hood / deck / belly — z-lofts from the wall's top (or bottom) edge to the
//           center line, sharing the wall's station points so the seams match.
//   greenhouse — glass wrapped from the belt line to the roof edge plus a roof
//           z-loft; pillars, frit and trims are decals on the glass.

import type {Vec3} from '../../math/vec.ts';
import {Mat} from '../types.ts';
import {
  Kit,
  Sheet,
  clamp,
  lerp,
  smooth,
  sp,
  add,
  mul,
  sub,
  norm,
  cross,
  panel,
  tube,
} from './kit.ts';

export interface Profile {
  /** Nominal bottom of the panel (sill, bumper bottom). */
  yb: number;
  /** Top edge height (hood edge, belt line, deck edge). */
  ytop: number;
  /** Height of the widest point. */
  ymax: number;
  /** Inset of the panel at yb relative to the widest point. */
  tuck: number;
  /** Inset at the start of the shoulder roll relative to the widest point. */
  tumble: number;
  /** Shoulder roll radii (vertical, horizontal). */
  rollY: number;
  rollN: number;
  /** Inward run of the underside lip. */
  under: number;
}

export interface Axle {
  z: number;
  wheelR: number;
  archR: number;
}

export interface WallSpec {
  W: number;
  zf: number;
  zr: number;
  front: {depth: number; exp: number};
  rear: {depth: number; exp: number};
  axles: Axle[];
  /** Height above which profile points stay fixed (above the arch tops). */
  splitY: number;
  /** Station spacing along the outline (m). */
  spacing?: number;
  /** Profile at a station: z, facing (0 side .. 1 tip), end (+1 front, -1 rear). */
  profile: (z: number, f: number, end: number) => Profile;
  /**
   * Plan inset of the top edge (side, front tip, rear tip). The top edge then
   * follows its own superellipse outline, which keeps hood/deck edges smooth;
   * the profile's tumble is adjusted to reach it.
   */
  topInset?: {side: number; front: number; rear: number};
}

export interface Station {
  tau: number;
  x: number;
  z: number;
  nx: number;
  nz: number;
  f: number;
  end: number;
}

/** Plan outline of the right half: rear tip -> side -> front tip, arclength parameterized. */
export class Outline {
  pts: {x: number; z: number; nx: number; nz: number; s: number; g: number}[] =
    [];
  length = 0;

  spec: Pick<WallSpec, 'W' | 'zf' | 'zr' | 'front' | 'rear'>;

  constructor(spec: Pick<WallSpec, 'W' | 'zf' | 'zr' | 'front' | 'rear'>) {
    this.spec = spec;
    const raw: [number, number][] = [];
    const gs: number[] = [];
    const Q = 240;
    for (let i = 0; i <= Q; i++) {
      raw.push(this.atG(i / Q));
      gs.push(i / Q);
    }
    for (let i = 1; i < 60; i++) {
      raw.push(this.atG(1 + i / 60));
      gs.push(1 + i / 60);
    }
    for (let i = 0; i <= Q; i++) {
      raw.push(this.atG(2 + i / Q));
      gs.push(2 + i / Q);
    }
    let s = 0;
    for (let i = 0; i < raw.length; i++) {
      if (i > 0)
        s += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
      const a = raw[Math.max(0, i - 1)];
      const b = raw[Math.min(raw.length - 1, i + 1)];
      const tx = b[0] - a[0],
        tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1;
      this.pts.push({
        x: raw[i][0],
        z: raw[i][1],
        nx: tz / l,
        nz: -tx / l,
        s,
        g: gs[i],
      });
    }
    this.length = s;
    // Exact normals at the tips.
    this.pts[0].nx = 0;
    this.pts[0].nz = -1;
    this.pts[this.pts.length - 1].nx = 0;
    this.pts[this.pts.length - 1].nz = 1;
  }

  at(tau: number) {
    const s = clamp(tau, 0, 1) * this.length;
    let lo = 0,
      hi = this.pts.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.pts[m].s <= s) lo = m;
      else hi = m;
    }
    const a = this.pts[lo],
      b = this.pts[hi];
    const t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    let nx = lerp(a.nx, b.nx, t),
      nz = lerp(a.nz, b.nz, t);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    return {
      x: lerp(a.x, b.x, t),
      z: lerp(a.z, b.z, t),
      nx,
      nz,
      g: lerp(a.g, b.g, t),
    };
  }

  /**
   * Point by segment parameter g: [0, 1] rear quarter (tip -> side, by angle),
   * [1, 2] straight side (by z), [2, 3] front quarter (side -> tip). Outlines
   * whose quarters start at the same z correspond point by point at equal g.
   */
  atG(g: number): [number, number] {
    const {W, zf, zr, front, rear} = this.spec;
    if (g <= 1) {
      const phi = (Math.PI / 2) * (1 - clamp(g, 0, 1));
      return [
        W * sp(Math.cos(phi), rear.exp),
        zr + rear.depth - rear.depth * sp(Math.sin(phi), rear.exp),
      ];
    }
    if (g <= 2) return [W, lerp(zr + rear.depth, zf - front.depth, g - 1)];
    const phi = (Math.PI / 2) * clamp(g - 2, 0, 1);
    return [
      W * sp(Math.cos(phi), front.exp),
      zf - front.depth + front.depth * sp(Math.sin(phi), front.exp),
    ];
  }

  /** tau where the outline reaches z (z is monotonic along the outline). */
  tauAtZ(z: number) {
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 50; i++) {
      const m = (lo + hi) / 2;
      if (this.at(m).z < z) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  }
}

/** Arch height at z (−Infinity when not over a wheel). */
export function archY(axles: Axle[], sill: number, z: number) {
  let y = -Infinity;
  for (const a of axles) {
    const dz = Math.abs(z - a.z);
    const R = a.archR;
    if (dz <= R) y = Math.max(y, a.wheelR + Math.sqrt(R * R - dz * dz));
    else {
      const e = Math.max(0.03, (a.wheelR - sill) * 0.45);
      if (dz < R + e)
        y = Math.max(
          y,
          a.wheelR - (a.wheelR - sill) * smooth((dz - R) / e) * 1.0,
        );
    }
  }
  return y;
}

/** The side/front/rear skin of one half. */
export class Wall {
  outline: Outline;
  stations: Station[] = [];
  rows: Vec3[][] = [];
  sheet: Sheet;
  spec: WallSpec;
  topOutline: Outline | null = null;

  /**
   * Station frame: outline point, the horizontal direction sections are laid
   * out along (outward), and the inset of the top edge along it. With a top
   * outline the direction points from the matching top-outline point to the
   * outline point, so neighbouring sections never cross at tight corners.
   */
  frame(tau: number) {
    const o = this.outline.at(tau);
    if (!this.topOutline)
      return {...o, dx: o.nx, dz: o.nz, inset: null as number | null};
    const e = this.topOutline.atG(o.g);
    let dx = o.x - e[0],
      dz = o.z - e[1];
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return {...o, dx: o.nx, dz: o.nz, inset: 0};
    dx /= l;
    dz /= l;
    return {...o, dx, dz, inset: l};
  }

  constructor(spec: WallSpec) {
    this.spec = spec;
    this.outline = new Outline(spec);
    if (spec.topInset) {
      const t = spec.topInset;
      this.topOutline = new Outline({
        W: spec.W - t.side,
        zf: spec.zf - t.front,
        zr: spec.zr + t.rear,
        front: {
          depth: Math.max(0.03, spec.front.depth - t.front),
          exp: spec.front.exp,
        },
        rear: {
          depth: Math.max(0.03, spec.rear.depth - t.rear),
          exp: spec.rear.exp,
        },
      });
    }
    const ol = this.outline;
    const spacing = spec.spacing ?? 0.14;
    const taus: number[] = [];
    const n = Math.ceil(ol.length / spacing);
    for (let i = 0; i <= n; i++) {
      // Slightly denser toward the tips where the outline turns.
      const t = i / n;
      taus.push(t);
    }
    for (const a of spec.axles) {
      const N = 14;
      for (let i = 0; i <= N; i++) {
        const z = a.z + a.archR * Math.cos(Math.PI * (i / N));
        taus.push(ol.tauAtZ(z));
      }
      const e = Math.max(0.03, (a.wheelR - this.sill()) * 0.45);
      for (const d of [0.35, 0.7, 1.05]) {
        taus.push(ol.tauAtZ(a.z + a.archR + e * d));
        taus.push(ol.tauAtZ(a.z - a.archR - e * d));
      }
    }
    taus.sort((a, b) => a - b);
    const minGap = 0.022 / ol.length;
    const uniq: number[] = [];
    for (const t of taus) {
      if (!uniq.length || t - uniq[uniq.length - 1] > minGap) uniq.push(t);
      else if (t === 1) uniq[uniq.length - 1] = 1;
    }
    for (const tau of uniq) {
      const o = ol.at(tau);
      this.stations.push({
        tau,
        x: o.x,
        z: o.z,
        nx: o.nx,
        nz: o.nz,
        f: Math.abs(o.nz),
        end: Math.sign(o.z) || 1,
      });
      this.rows.push(this.section(tau));
    }
    this.sheet = new Sheet(this.rows, 1);
  }

  sill() {
    return this.spec.profile(0, 0, 0).yb;
  }

  /** Profile points (n = outward offset, y) at a station. */
  profile2D(tau: number): [number, number][] {
    const o = this.outline.at(tau);
    const f = Math.abs(o.nz);
    const p = this.spec.profile(o.z, f, Math.sign(o.z) || 1);
    const yS = p.ytop - p.rollY;
    const fr = this.frame(tau);
    if (fr.inset !== null) p.tumble = fr.inset - p.rollN;
    const ymax = clamp(p.ymax, p.yb + 0.02, yS - 0.02);
    const nf = (y: number) => {
      if (y < ymax)
        return -p.tuck * Math.pow(clamp((ymax - y) / (ymax - p.yb), 0, 1.5), 2);
      return -p.tumble * Math.pow(clamp((y - ymax) / (yS - ymax), 0, 1), 1.4);
    };
    const ay = archY(this.spec.axles, p.yb, o.z);
    const y0 = Number.isFinite(ay)
      ? Math.max(p.yb, lerp(ay, p.yb, smooth(f * 3)))
      : p.yb;
    const rb = Math.min(0.03, (yS - y0) * 0.1);
    const ysplit = clamp(
      Math.max(this.spec.splitY, y0 + rb + 0.08),
      y0 + rb + 0.03,
      yS - 0.06,
    );
    const pts: [number, number][] = [];
    pts.push([nf(y0) - p.under, y0]);
    pts.push([nf(y0) - rb * 0.9, y0 + rb * 0.08]);
    pts.push([nf(y0 + rb), y0 + rb]);
    for (const t of [1 / 3, 2 / 3, 1]) {
      const y = lerp(y0 + rb, ysplit, t);
      pts.push([nf(y), y]);
    }
    for (const t of [1 / 3, 2 / 3, 1]) {
      const y = lerp(ysplit, yS, t);
      pts.push([nf(y), y]);
    }
    const nS = nf(yS);
    for (const deg of [40, 70, 90]) {
      const th = (deg * Math.PI) / 180;
      pts.push([
        nS - p.rollN * (1 - Math.cos(th)),
        yS + p.rollY * Math.sin(th),
      ]);
    }
    return pts;
  }

  section(tau: number): Vec3[] {
    const o = this.frame(tau);
    return this.profile2D(tau).map(
      ([n, y]) => [Math.max(0, o.x + o.dx * n), y, o.z + o.dz * n] as Vec3,
    );
  }

  /** Top edge point at tau (where hood, deck or glass meet the wall). */
  edge(tau: number): Vec3 {
    const s = this.section(tau);
    return s[s.length - 1];
  }

  bottom(tau: number): Vec3 {
    return this.section(tau)[0];
  }

  /** Fractional station index nearest to tau (for v lookups). */
  index(tau: number) {
    const st = this.stations;
    for (let k = 0; k < st.length - 1; k++) {
      if (tau <= st[k + 1].tau)
        return k + (tau - st[k].tau) / (st[k + 1].tau - st[k].tau);
    }
    return st.length - 1;
  }
}

/**
 * Crowned top surface (hood / deck) from wall edge points to the center line.
 * Rows from the side run straight across; rows from the front/rear quarter
 * fan to center points that slide along the center line toward the tip, so
 * the nose is covered by well-shaped rows instead of collapsing ones.
 */
export function fanSheet(
  edges: {p: Vec3; tau: number}[],
  tauQ: number,
  tauTip: number,
  centerY: (z: number, f: number) => number,
  sign: number,
  rowPts: number[] = [0, 0.2, 0.45, 0.7, 1],
) {
  const q = edges.reduce(
    (best, e) =>
      Math.abs(e.tau - tauQ) < Math.abs(best.tau - tauQ) ? e : best,
    edges[0],
  );
  const tip = edges.reduce(
    (best, e) =>
      Math.abs(e.tau - tauTip) < Math.abs(best.tau - tauTip) ? e : best,
    edges[0],
  );
  const rows: Vec3[][] = edges.map(e => {
    const f = clamp((e.tau - tauQ) / (tauTip - tauQ), 0, 1);
    const zc = f > 0 ? lerp(q.p[2], tip.p[2], f) : e.p[2];
    const yc = lerp(centerY(zc, f), tip.p[1], f * f);
    const C: Vec3 = [0, yc, zc];
    return rowPts.map(
      a =>
        [
          lerp(e.p[0], 0, a),
          e.p[1] + (yc - e.p[1]) * Math.sin((a * Math.PI) / 2),
          lerp(e.p[2], C[2], a),
        ] as Vec3,
    );
  });
  return new Sheet(rows, sign);
}

export interface BodyParts {
  wall: Wall;
  hood: Sheet | null;
  deck: Sheet | null;
  belly: Sheet;
}

/**
 * Build wall + hood + deck + belly + wheel wells into kit. Hood covers stations
 * whose top edge lies at z >= hoodZ, deck those at z <= deckZ.
 */
export function buildBody(
  kit: Kit,
  spec: WallSpec,
  o: {
    hoodZ: number | null;
    hoodCrown: number;
    deckZ: number | null;
    deckCrown: number;
    paint?: number;
    track: number;
    tyreW: number;
    bellyY: number;
    wellDepth?: number;
    /** Give the wall an inside face of this material (vehicles without door cards). */
    wallBack?: number;
    wallSegU?: number;
  },
): BodyParts {
  const wall = new Wall(spec);
  const ol = wall.outline;
  const paint = o.paint ?? Mat.paint;
  kit.sheet(wall.sheet, paint, {
    mirror: true,
    segU: o.wallSegU ?? 9,
    segV: Math.min(64, wall.stations.length * 2),
    doubleSided: o.wallBack !== undefined,
    backMat: o.wallBack,
    backOffset: 0.004,
  });
  const edgesOf = (pred: (e: Vec3, tau: number) => boolean, bottom = false) => {
    const out: {p: Vec3; tau: number}[] = [];
    wall.rows.forEach((r, k) => {
      const p = bottom ? r[0] : r[r.length - 1];
      if (pred(p, wall.stations[k].tau))
        out.push({p, tau: wall.stations[k].tau});
    });
    return out;
  };
  const tauF = ol.tauAtZ(spec.zf - spec.front.depth);
  const tauR = ol.tauAtZ(spec.zr + spec.rear.depth);
  const ytopAt = (z: number) => spec.profile(z, 0, Math.sign(z) || 1).ytop;
  let hood: Sheet | null = null;
  let deck: Sheet | null = null;
  if (o.hoodZ !== null) {
    const hz = o.hoodZ;
    const edges = edgesOf((e, tau) => e[2] >= hz || tau > tauF);
    if (edges.length > 2) {
      hood = fanSheet(edges, tauF, 1, z => ytopAt(z) + o.hoodCrown, 1);
      kit.sheet(hood, paint, {
        mirror: true,
        segU: 6,
        segV: Math.min(32, edges.length * 2),
      });
    }
  }
  if (o.deckZ !== null) {
    const dz = o.deckZ;
    const edges = edgesOf((e, tau) => e[2] <= dz || tau < tauR);
    if (edges.length > 2) {
      deck = fanSheet(edges, tauR, 0, z => ytopAt(z) + o.deckCrown, 1);
      kit.sheet(deck, paint, {
        mirror: true,
        segU: 6,
        segV: Math.min(28, edges.length * 2),
      });
    }
  }
  // Belly: from the wall's bottom lip to the center. Over the wheels it runs
  // flat (the wheel-well roof) and then drops: the drop is the well's inner wall.
  const inner = o.track - o.tyreW / 2 - 0.06;
  const bEdges = edgesOf(() => true, true);
  const bq0 = bEdges.reduce(
    (b, e) => (Math.abs(e.tau - tauR) < Math.abs(b.tau - tauR) ? e : b),
    bEdges[0],
  );
  const bq1 = bEdges.reduce(
    (b, e) => (Math.abs(e.tau - tauF) < Math.abs(b.tau - tauF) ? e : b),
    bEdges[0],
  );
  const bRows: Vec3[][] = bEdges.map(({p: b, tau}) => {
    const yc = Math.min(b[1], o.bellyY);
    const fF = clamp((tau - tauF) / (1 - tauF), 0, 1);
    const fR = clamp((tauR - tau) / tauR, 0, 1);
    let zc = b[2];
    if (fF > 0) zc = lerp(bq1.p[2], bEdges[bEdges.length - 1].p[2], fF);
    if (fR > 0) zc = lerp(bq0.p[2], bEdges[0].p[2], fR);
    const xi = Math.max(b[0] * 0.5, Math.min(b[0] - 0.015, inner));
    const t1 = b[0] > 1e-6 ? 1 - xi / b[0] : 0;
    const P1: Vec3 = [xi, b[1], lerp(b[2], zc, t1)];
    const P2: Vec3 = [
      Math.max(0, xi - 0.04),
      yc,
      lerp(b[2], zc, Math.min(1, t1 + 0.05)),
    ];
    return [b, P1, P2, [0, yc, zc]];
  });
  const belly = new Sheet(bRows, -1, {u: 1});
  kit.sheet(belly, Mat.metal, {
    mirror: true,
    segU: 2,
    segV: Math.min(64, bRows.length),
  });
  // Arch lips: a rolled edge (closed tube) along each wheel opening hides the
  // panel edge and the gap to the wheel-well liner.
  for (const a of spec.axles) {
    const pts: Vec3[] = [];
    wall.rows.forEach((r, k) => {
      const z = wall.stations[k].z;
      if (Math.abs(z - a.z) < a.archR + 0.02 && wall.stations[k].f < 0.3)
        pts.push(r[2]);
    });
    if (pts.length > 3)
      tube(kit, pts, 0.014, paint, {
        mirror: true,
        along: Math.min(18, pts.length),
        seg: 4,
      });
  }
  return {wall, hood, deck, belly};
}

// ---------------------------------------------------------------------------
// Greenhouse

export interface GhSpec {
  /** Base: rear and front center z, corner radius, side half-width function, base height function. */
  zb0: number;
  zb1: number;
  rb: number;
  xb: (z: number) => number;
  yb: (x: number, z: number) => number;
  /** Roof edge: rear and front z, half width, corner radius, edge height along z, crown. */
  zt0: number;
  zt1: number;
  xt: number;
  rt: number;
  yt: (z: number) => number;
  crown: number;
  bulge: number;
  /** Optional replacement for the rear base segment + corner (e.g. on the wall top edge). */
  rearBase?: Vec3[];
  counts?: [number, number, number, number, number];
}

export interface Greenhouse {
  glass: Sheet;
  roof: Sheet;
  base: Vec3[];
  top: Vec3[];
  /** Row index ranges: rear segment end, rear corner end, side end, front corner end. */
  iRearSeg: number;
  iRearCorner: number;
  iSide: number;
  iFrontCorner: number;
}

export function buildGreenhouse(
  kit: Kit,
  g: GhSpec,
  o: {roofMat?: number; glassSeg?: number} = {},
): Greenhouse {
  // Side rows about every 30 cm so the v interpolation stays even with the corners.
  const sideLen =
    g.zb1 -
    g.rb -
    (g.rearBase ? g.rearBase[g.rearBase.length - 1][2] : g.zb0 + g.rb);
  const [nRS, nRC, nS, nFC, nFS] = g.counts ?? [
    3,
    4,
    Math.max(6, Math.round(sideLen / 0.3)),
    4,
    4,
  ];
  const base: Vec3[] = [];
  const top: Vec3[] = [];
  const roofY = (x: number, z: number, xe: number) =>
    g.yt(z) +
    g.crown * Math.sin((Math.PI / 2) * clamp(1 - x / Math.max(xe, 1e-3), 0, 1));
  const xbR = g.xb(g.zb0 + g.rb),
    xbF = g.xb(g.zb1 - g.rb);
  // Rear segment + corner.
  const rearTop = (t: number): Vec3 => {
    // t in [0, 1] over segment (0..a) then corner (a..1)
    const a = nRS / (nRS + nRC);
    if (t <= a) {
      const x = (g.xt - g.rt) * (t / a);
      return [x, roofY(x, g.zt0, g.xt - g.rt), g.zt0];
    }
    const th = -Math.PI / 2 + (Math.PI / 2) * ((t - a) / (1 - a));
    const x = g.xt - g.rt + g.rt * Math.cos(th);
    const z = g.zt0 + g.rt + g.rt * Math.sin(th);
    return [x, roofY(x, z, x), z];
  };
  const frontTop = (t: number): Vec3 => {
    const a = nFC / (nFC + nFS);
    if (t <= a) {
      const th = (Math.PI / 2) * (t / a);
      const x = g.xt - g.rt + g.rt * Math.cos(th);
      const z = g.zt1 - g.rt + g.rt * Math.sin(th);
      return [x, roofY(x, z, x), z];
    }
    const x = (g.xt - g.rt) * (1 - (t - a) / (1 - a));
    return [x, roofY(x, g.zt1, g.xt - g.rt), g.zt1];
  };
  const nR = nRS + nRC;
  if (g.rearBase) {
    const rb = g.rearBase;
    for (let i = 0; i < nR; i++) {
      const f = i / nR;
      const k = f * (rb.length - 1);
      const i0 = Math.floor(k);
      const i1 = Math.min(rb.length - 1, i0 + 1);
      const p = rb[i0],
        q = rb[i1];
      base.push([
        lerp(p[0], q[0], k - i0),
        lerp(p[1], q[1], k - i0),
        lerp(p[2], q[2], k - i0),
      ]);
      top.push(rearTop(f));
    }
  } else {
    for (let i = 0; i < nRS; i++) {
      const x = (xbR - g.rb) * (i / nRS);
      base.push([x, g.yb(x, g.zb0), g.zb0]);
      top.push(rearTop(i / nR));
    }
    for (let i = 0; i < nRC; i++) {
      const th = -Math.PI / 2 + (Math.PI / 2) * (i / nRC);
      const x = xbR - g.rb + g.rb * Math.cos(th);
      const z = g.zb0 + g.rb + g.rb * Math.sin(th);
      base.push([x, g.yb(x, z), z]);
      top.push(rearTop((nRS + i) / nR));
    }
  }
  const iRearSeg = nRS;
  const iRearCorner = nR;
  const zbs0 = g.rearBase ? g.rearBase[g.rearBase.length - 1][2] : g.zb0 + g.rb;
  for (let i = 0; i <= nS; i++) {
    const t = i / nS;
    const z = lerp(zbs0, g.zb1 - g.rb, t);
    const zt = lerp(g.zt0 + g.rt, g.zt1 - g.rt, t);
    const x = g.xb(z);
    base.push([x, g.yb(x, z), z]);
    top.push([g.xt, roofY(g.xt, zt, g.xt), zt]);
  }
  const iSide = base.length - 1;
  const nF = nFC + nFS;
  for (let i = 1; i <= nF; i++) {
    const t = i / nF;
    const a = nFC / nF;
    let x: number, z: number;
    if (t <= a) {
      const th = (Math.PI / 2) * (t / a);
      x = xbF - g.rb + g.rb * Math.cos(th);
      z = g.zb1 - g.rb + g.rb * Math.sin(th);
    } else {
      x = (xbF - g.rb) * (1 - (t - a) / (1 - a));
      z = g.zb1;
    }
    base.push([x, g.yb(x, z), z]);
    top.push(frontTop(t));
  }
  const iFrontCorner = iSide + nFC;
  // Glass rows: base -> top with an outward bulge.
  const rows: Vec3[][] = base.map((b, k) => {
    const t = top[k];
    const prev = base[Math.max(0, k - 1)],
      next = base[Math.min(base.length - 1, k + 1)];
    const tan = sub(next, prev);
    const outward = norm(cross(sub(t, b), tan));
    // Center rows lie on the mirror plane: keep them exactly there.
    if (k === 0 || k === base.length - 1) outward[0] = 0;
    // Column 0 continues 15 mm below the base so the glass tucks under the
    // body and no seam can open between them.
    const up = norm(sub(t, b));
    const row: Vec3[] = [sub(b, mul(up, 0.015))];
    for (const a of [0, 1 / 3, 2 / 3, 1]) {
      row.push(
        add(
          add(b, mul(sub(t, b), a)),
          mul(outward, g.bulge * Math.sin(Math.PI * a)),
        ),
      );
    }
    return row;
  });
  const glass = new Sheet(rows, 1);
  kit.sheet(glass, Mat.glass, {
    mirror: true,
    doubleSided: true,
    segU: 4,
    segV: o.glassSeg ?? 32,
  });
  // Roof: z-loft from the roof edge (rear segment end .. front corner end) to center.
  const edges = top.slice(iRearSeg, iFrontCorner + 1);
  const rRows: Vec3[][] = edges.map((e, k) => {
    // The roof edge drapes 1 cm over the glass top (drip rail) to close the seam.
    const kk = k + iRearSeg;
    const r = rows[kk];
    const up = norm(sub(r[4], r[3]));
    const out = norm(
      cross(
        up,
        sub(top[Math.min(top.length - 1, kk + 1)], top[Math.max(0, kk - 1)]),
      ),
    );
    const row: Vec3[] = [add(add(e, mul(out, 0.008)), mul(up, -0.012))];
    for (const a of [0, 0.15, 0.4, 0.7, 1]) {
      const x = e[0] * (1 - a);
      row.push([x, roofY(x, e[2], e[0]), e[2]]);
    }
    return row;
  });
  const roof = new Sheet(rRows, 1);
  kit.sheet(roof, o.roofMat ?? Mat.paint, {
    mirror: true,
    segU: 6,
    segV: 18,
    doubleSided: true,
    backMat: Mat.seat,
  });
  // Headliner trim: closes the seam between the glass top and the roof liner from inside.
  const trim: Vec3[][] = top.map((t, k) => {
    const r = rows[k];
    const up = norm(sub(r[4], r[3]));
    const out = norm(
      cross(
        up,
        sub(top[Math.min(top.length - 1, k + 1)], top[Math.max(0, k - 1)]),
      ),
    );
    const inward: Vec3 = norm([-out[0], 0, -out[2]]);
    return [
      add(add(t, mul(out, -0.01)), mul(up, -0.03)),
      add(add(t, mul(inward, 0.06)), [0, 0.004, 0]),
    ];
  });
  kit.sheet(new Sheet(trim, -1, {u: 1}), Mat.interior, {
    mirror: true,
    segU: 1,
    segV: 40,
  });
  return {glass, roof, base, top, iRearSeg, iRearCorner, iSide, iFrontCorner};
}

export {panel};
