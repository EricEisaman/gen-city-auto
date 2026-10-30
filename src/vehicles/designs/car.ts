// Parametric passenger car (sedan, hatchback, kei, sports, SUV, taxi) built on
// the carbody kit. Each design supplies a CarConfig; this file turns it into
// body panels, greenhouse, lights, trims and a first-person interior.

import type {Vec3} from '../../math/vec.ts';
import {Mat, type VehicleDesign, type VehicleKind} from '../types.ts';
import {dial, steeringWheelMesh, wheelMesh} from '../parts.ts';
import {
  archY,
  buildBody,
  buildGreenhouse,
  type Greenhouse,
  type Profile,
  type Wall,
} from './carbody.ts';
import {
  Kit,
  Sheet,
  band,
  blob,
  clamp,
  dot,
  cross,
  detailScale,
  lerp,
  norm,
  panel,
  place,
  projected,
  rect,
  smooth,
  superellipse,
  tube,
} from './kit.ts';

export interface CarConfig {
  name: string;
  kind: VehicleKind;
  /** Overall length, full width, roof height. */
  L: number;
  width: number;
  H: number;
  wheelbase: number;
  /** Front overhang (front axle to front tip). */
  frontOverhang: number;
  wheelR: number;
  tyreW: number;
  rimRatio?: number;
  spokes?: number;
  sill: number;
  /** Plan rounding at the ends. */
  frontDepth: number;
  frontExp: number;
  rearDepth: number;
  rearExp: number;
  /** Heights of the wall top edge: hood front, cowl/belt front, belt rear, deck rear. */
  hoodFrontY: number;
  beltF: number;
  beltR: number;
  deckRearY: number;
  /** Bumper bottoms. */
  bumperF: number;
  bumperR: number;
  /** Side shape. */
  ymax: number;
  tuck: number;
  tumble: number;
  roll: number;
  /** Front/rear face lean (top edge setback). */
  leanF: number;
  leanR: number;
  /** Greenhouse: windshield base z (center), roof front/rear edge z, rear glass base z. */
  cowlZ: number;
  wsTopZ: number;
  roofRearZ: number;
  /** Rear glass base z; null = hatch (rear glass starts on the tail's top edge). */
  rearBaseZ: number | null;
  roofTumble: number;
  roofCrown: number;
  hoodCrown: number;
  ghCornerBase: number;
  ghCornerTop: number;
  glassBulge: number;
  /** Paint material for the roof (paint2 for two-tone). */
  roofMat?: number;
  /** Style switches. */
  cPillar: 'paint' | 'black';
  /** How far forward of the roof's rear corner the C pillar reaches at the top. */
  cPillarTop: number;
  /** Tailgate: fraction of the rear glass height painted as the lower hatch panel. */
  hatchLower?: number;
  /** Gap between tyre and arch (default 4 cm). */
  archGap?: number;
  /** Height of a body-coloured band above the side windows (tall vehicles). */
  upperBand?: number;
  /** Narrow vertical rear pillar of this width instead of a sloping C pillar. */
  rearPillarWidth?: number;
  /** z of vertical side pillars (default: the B pillar at doors[1]). */
  pillars?: number[];
  bPillar: 'paint' | 'black';
  aPillar: 'paint' | 'black';
  grille: 'wide' | 'slim' | 'tall' | 'chrome';
  headlight: {
    x: number;
    y: number;
    hx: number;
    hy: number;
    n?: number;
    slant?: number;
  };
  taillight: {
    x: number;
    y: number;
    hx: number;
    hy: number;
    n?: number;
    wrap?: boolean;
    bar?: boolean;
  };
  fenderMirrors?: boolean;
  noMirrors?: boolean;
  /** false skips road-car details (lights, grille, plates, handles, mirrors, wipers). */
  carDetails?: boolean;
  /** Wall station spacing and the fixed-profile height (see WallSpec). */
  spacing?: number;
  splitY?: number;
  wallBack?: number;
  wallSegU?: number;
  /** Override of the wall top edge height along z. */
  edgeYFn?: (z: number) => number;
  /** Door split points along z (front door front edge, B pillar, rear door rear edge); 2 doors if bPillar only. */
  doors: number[];
  archFlare?: boolean;
  roofRails?: boolean;
  spoiler?: boolean;
  /** Seats rows: z of front seat cushion center and rear bench (null = 2 seats). */
  rearSeat: boolean;
  palette: Vec3[];
  /** Cabin floor height (default sill + 0.1). */
  floorY?: number;
  /** Interior layout overrides: dash depth behind the cowl, eye behind the dash, firewall/bulkhead z. */
  dashDepth?: number;
  eyeBack?: number;
  zFire?: number;
  zBulk?: number;
  /** Paint over the side glass behind this z (panel van / cargo). */
  cargoFromZ?: number;
  /** Twin rear wheels (trucks). */
  dualRear?: boolean;
  /** 'none' skips the generic car interior (the extras hook builds its own). */
  interior?: 'car' | 'none';
  /** Overrides for the driver position when interior is 'none'. */
  driver?: {eye: Vec3; wheel: Vec3; tilt: number; wheelR?: number};
  /** Extra details hook (taxi sign etc.). */
  extras?: (kit: Kit, ctx: CarContext) => void;
}

export interface CarContext {
  cfg: CarConfig;
  wall: Wall;
  gh: Greenhouse;
  track: number;
  floorY: number;
  xEdge: (z: number) => number;
  roofEdgeY: (z: number) => number;
  W: number;
  zf: number;
  zr: number;
  roofY: (x: number, z: number) => number;
  edgeY: (z: number) => number;
}

export function buildCar(cfg: CarConfig): VehicleDesign {
  const kit = new Kit();
  const W = cfg.width / 2;
  const wb = cfg.wheelbase;
  const zf = wb / 2 + cfg.frontOverhang;
  const zr = zf - cfg.L;
  const track = W - cfg.tyreW / 2 - 0.035;
  const archR = cfg.wheelR + (cfg.archGap ?? 0.04);
  const axles = [
    {z: wb / 2, wheelR: cfg.wheelR, archR},
    {z: -wb / 2, wheelR: cfg.wheelR, archR},
  ].filter(a => a.z > zr + 0.2 && a.z < zf - 0.2);
  const cowl = cfg.cowlZ;
  const rearBase = cfg.rearBaseZ;
  // Top edge height along z (side): hood slopes to the nose, belt rises to the rear, deck drops to the tail.
  const edgeY = (z: number) => {
    if (cfg.edgeYFn) return cfg.edgeYFn(z);
    if (z > cowl) {
      const t = clamp((z - cowl) / (zf - cowl), 0, 1);
      return lerp(cfg.beltF, cfg.hoodFrontY, Math.pow(t, 1.6));
    }
    const zb = rearBase ?? zr;
    if (z < zb) {
      const t = clamp((zb - z) / (zb - zr), 0, 1);
      return lerp(cfg.beltR, cfg.deckRearY, Math.pow(t, 2));
    }
    return lerp(cfg.beltR, cfg.beltF, (z - zb) / (cowl - zb));
  };
  const profile = (z: number, f: number, end: number): Profile => {
    const e = smooth(f);
    const front = end > 0;
    const bump = front ? cfg.bumperF : cfg.bumperR;
    // Bottom rises from the sill toward the bumpers ahead of/behind the wheels.
    const zArchEnd = front ? wb / 2 + archR : -wb / 2 - archR;
    const tEnd = clamp(
      (Math.abs(z) - Math.abs(zArchEnd)) /
        Math.max(0.05, Math.abs(front ? zf : zr) - Math.abs(zArchEnd)),
      0,
      1,
    );
    const yb = lerp(cfg.sill, bump, Math.max(smooth(tEnd), e));
    const lean = front ? cfg.leanF : cfg.leanR;
    return {
      yb,
      ytop: edgeY(z),
      ymax: lerp(cfg.ymax, bump + 0.16, e),
      tuck: lerp(cfg.tuck, 0.07, e),
      tumble: lerp(cfg.tumble, lean, e),
      rollY: lerp(cfg.roll, cfg.roll * 1.6, e),
      rollN: lerp(cfg.roll * 1.4, cfg.roll * 2.2, e),
      under: 0.05,
    };
  };
  const body = buildBody(
    kit,
    {
      W,
      zf,
      zr,
      front: {depth: cfg.frontDepth, exp: cfg.frontExp},
      rear: {depth: cfg.rearDepth, exp: cfg.rearExp},
      axles,
      splitY: cfg.splitY ?? cfg.wheelR + archR + 0.03,
      spacing: cfg.spacing,
      profile,
      topInset: {
        side: cfg.tumble + cfg.roll * 1.4,
        front: cfg.leanF + cfg.roll * 2.2,
        rear: cfg.leanR + cfg.roll * 2.2,
      },
    },
    {
      hoodZ: cowl - cfg.ghCornerBase - 0.08,
      hoodCrown: cfg.hoodCrown,
      deckZ: rearBase === null ? null : rearBase + cfg.ghCornerBase + 0.08,
      deckCrown: cfg.hoodCrown * 0.8,
      track,
      tyreW: cfg.tyreW,
      bellyY: cfg.sill + 0.02,
      wallBack: cfg.wallBack,
      wallSegU: cfg.wallSegU,
    },
  );
  const wall = body.wall;
  const ol = wall.outline;
  const edgeAtZ = (z: number) => wall.edge(ol.tauAtZ(z));
  const xEdge = (z: number) => edgeAtZ(z)[0];
  const crownAt = (xe: number) => cfg.hoodCrown * clamp(xe / 0.35, 0, 1);
  const baseY = (x: number, z: number) => {
    const e = edgeAtZ(z);
    const onTop =
      rearBase === null
        ? z > cowl - cfg.ghCornerBase - 0.08
        : z > cowl - cfg.ghCornerBase - 0.08 ||
          z < rearBase + cfg.ghCornerBase + 0.08;
    if (!onTop) return e[1];
    const c = z > 0 ? crownAt(e[0]) : crownAt(e[0]) * 0.8;
    return e[1] + c * Math.sin((Math.PI / 2) * clamp(1 - x / e[0], 0, 1));
  };
  // Hatch: rear glass base follows the wall's top edge around the tail.
  let rearBasePts: Vec3[] | undefined;
  let zb0 = rearBase ?? zr;
  if (rearBase === null) {
    rearBasePts = [];
    const tq = ol.tauAtZ(zr + cfg.rearDepth);
    for (let i = 0; i <= 12; i++) rearBasePts.push(wall.edge((tq * i) / 12));
    zb0 = rearBasePts[0][2];
  }
  const roofEdgeY = (z: number) => {
    const mid = (cfg.wsTopZ + cfg.roofRearZ) / 2;
    const half = (cfg.wsTopZ - cfg.roofRearZ) / 2;
    return cfg.H - cfg.roofCrown - 0.025 * Math.pow((z - mid) / half, 2);
  };
  const zMid = (cowl + zb0) / 2;
  const xt = xEdge(zMid) - cfg.roofTumble;
  const gh = buildGreenhouse(
    kit,
    {
      zb0,
      zb1: cowl,
      rb: cfg.ghCornerBase,
      xb: xEdge,
      yb: baseY,
      zt0: cfg.roofRearZ,
      zt1: cfg.wsTopZ,
      xt,
      rt: cfg.ghCornerTop,
      yt: roofEdgeY,
      crown: cfg.roofCrown,
      bulge: cfg.glassBulge,
      rearBase: rearBasePts,
    },
    {roofMat: cfg.roofMat},
  );
  const roofY = (x: number, z: number) =>
    roofEdgeY(z) +
    cfg.roofCrown * Math.sin((Math.PI / 2) * clamp(1 - x / xt, 0, 1));
  const ctx: CarContext = {
    cfg,
    wall,
    gh,
    track,
    floorY: cfg.floorY ?? cfg.sill + 0.1,
    xEdge,
    roofEdgeY,
    W,
    zf,
    zr,
    roofY,
    edgeY,
  };

  // --- Pillars, frit and trims on the glass (index space: u column 0..3, v row).
  const g = gh.glass;
  const nRows = gh.base.length;
  const glassDecal = (
    k0: (a: number) => number,
    k1: (a: number) => number,
    a0: number,
    a1: number,
    mat: number,
    inner = true,
    off = 0.006,
    trim = false,
  ) => {
    const map = (s: number, t: number): [number, number] => {
      const a = lerp(a0, a1, t);
      return [g.u(1 + a * 3), g.v(clamp(lerp(k0(a), k1(a), s), 0, nRows - 1))];
    };
    // Enough samples across the rows to follow corners (chords would cut into the glass).
    const span = Math.max(Math.abs(k1(0) - k0(0)), Math.abs(k1(1) - k0(1)));
    const ns = Math.min(8, Math.max(3, Math.ceil(span * 1.5) + 1));
    kit.decal(g, map, mat, {
      ns,
      nt: 5,
      offset: off,
      mirror: true,
      segS: ns - 1,
      segT: 6,
    });
    // The inside trim is a little narrower so its edges never poke through
    // the glass; pillar trims are rounded covers in headliner fabric, a little
    // wider than the paint so its inner side never shows past their edges.
    const mapIn = (s: number, t: number) =>
      map(trim ? lerp(-0.12, 1.12, s) : lerp(0.28, 0.72, s), t);
    if (inner)
      kit.decal(g, mapIn, trim ? Mat.headliner : Mat.interior, {
        ns: trim ? Math.max(ns, 6) : ns,
        nt: 5,
        offset: 0.012,
        inner: true,
        mirror: true,
        segS: trim ? Math.max(ns, 6) * 2 : ns - 1,
        segT: 6,
        bump: trim ? s => 0.012 * Math.sin(Math.PI * s) : undefined,
        // Its edges show through the glass from outside: give them a back.
        doubleSided: trim,
      });
  };
  const pillarMat = (p: 'paint' | 'black') =>
    p === 'paint' ? (cfg.roofMat ?? Mat.paint) : Mat.plastic;
  // A pillar: a ~9 cm band centred in the front corner rows (real pillar
  // trim is 8-10 cm; the whole corner would be a wall at the driver's eye).
  const aRows = (() => {
    const u = g.u(2.5);
    const p0 = g.point(u, g.v(gh.iSide)),
      p1 = g.point(u, g.v(gh.iFrontCorner));
    const len = Math.hypot(p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]);
    const perRow = len / Math.max(1, gh.iFrontCorner - gh.iSide);
    const c = (gh.iSide + gh.iFrontCorner) / 2 - 0.4;
    const h = Math.min(1.0, 0.045 / perRow);
    return [
      Math.max(gh.iSide + 0.6, c - h),
      Math.min(gh.iFrontCorner - 1.4, c + h),
    ];
  })();
  glassDecal(
    () => aRows[0],
    () => aRows[1],
    0,
    1,
    pillarMat(cfg.aPillar),
    true,
    0.006,
    true,
  );
  // Windshield frit along base and top + header.
  glassDecal(
    () => gh.iFrontCorner - 0.6,
    () => nRows - 1,
    0,
    0.07,
    Mat.plastic,
    true,
  );
  glassDecal(
    () => gh.iFrontCorner - 0.6,
    () => nRows - 1,
    0.965,
    1,
    Mat.plastic,
    true,
  );
  // Rear window frit.
  glassDecal(
    () => 0,
    () => gh.iRearSeg + 0.5,
    0,
    0.06,
    Mat.plastic,
    false,
  );
  glassDecal(
    () => 0,
    () => gh.iRearSeg + 0.5,
    0.94,
    1,
    Mat.plastic,
    true,
  );
  // Side pillars as straight-edged quads projected onto the side glass.
  const sidePillar = (
    z0b: number,
    z1b: number,
    z0t: number,
    z1t: number,
    mat: number,
  ) => {
    const yb = (z: number) => edgeAtZ(z)[1] + 0.003;
    const yt = (z: number) => roofEdgeY(z) - 0.003;
    const shape = (s: number, t: number): [number, number] => {
      const z = lerp(lerp(z0b, z1b, s), lerp(z0t, z1t, s), t);
      return [z, lerp(yb(z), yt(z), t)];
    };
    kit.decal(
      g,
      projected(g, [2, 1], shape, p => p[0]),
      mat,
      {ns: 3, nt: 4, offset: 0.006, mirror: true, segS: 2, segT: 4},
    );
    const shapeIn = (s2: number, t: number) => shape(lerp(0.06, 0.94, s2), t);
    kit.decal(
      g,
      projected(g, [2, 1], shapeIn, p => p[0]),
      Mat.headliner,
      {
        ns: 5,
        nt: 4,
        offset: 0.012,
        inner: true,
        mirror: true,
        segS: 6,
        segT: 4,
        bump: s2 => 0.016 * Math.sin(Math.PI * s2),
      },
    );
  };
  // C pillar: rear corner rows plus a side quad forward to the rear door glass.
  const zDoorRear = cfg.doors.length
    ? cfg.doors[cfg.doors.length - 1]
    : gh.base[gh.iRearCorner][2] + 0.3;
  glassDecal(
    () => gh.iRearSeg + 0.4,
    () => gh.iRearCorner + 0.3,
    0,
    1,
    pillarMat(cfg.cPillar),
  );
  {
    const zb = gh.base[gh.iRearCorner][2],
      zt = gh.top[gh.iRearCorner][2];
    if (cfg.rearPillarWidth !== undefined)
      sidePillar(
        zb - 0.02,
        zb + cfg.rearPillarWidth,
        zt - 0.02,
        zt + cfg.rearPillarWidth,
        pillarMat(cfg.cPillar),
      );
    else
      sidePillar(
        zb - 0.02,
        zDoorRear,
        zt - 0.02,
        Math.max(zt + 0.05, cfg.roofRearZ + cfg.ghCornerTop + cfg.cPillarTop),
        pillarMat(cfg.cPillar),
      );
  }
  // B pillar.
  for (const bz of cfg.pillars ?? (cfg.doors.length > 2 ? [cfg.doors[1]] : []))
    sidePillar(
      bz - 0.045,
      bz + 0.045,
      bz - 0.1,
      bz - 0.03,
      pillarMat(cfg.bPillar),
    );
  if (cfg.hatchLower) {
    // Tailgate: body-coloured lower panel below the rear window, and a frame.
    const pm = cfg.roofMat ?? Mat.paint;
    glassDecal(
      () => 0,
      () => gh.iRearCorner - 0.4,
      0,
      cfg.hatchLower,
      pm,
    );
    glassDecal(
      () => gh.iRearCorner - 1.3,
      () => gh.iRearCorner - 0.4,
      cfg.hatchLower,
      1,
      pm,
    );
  }
  if (cfg.upperBand) {
    // Body-coloured band between the side windows and the roof edge.
    const z0 =
      Math.max(gh.base[gh.iRearCorner][2], gh.top[gh.iRearCorner][2]) + 0.01;
    const z1 = Math.min(gh.base[gh.iSide][2], gh.top[gh.iSide][2]) - 0.01;
    const shape = (s2: number, t: number): [number, number] => {
      const z = lerp(z0, z1, s2);
      const yt = roofEdgeY(z) - 0.004;
      return [z, lerp(yt - cfg.upperBand!, yt, t)];
    };
    const mat = cfg.roofMat ?? Mat.paint;
    const ns = Math.max(4, Math.ceil((z1 - z0) / 0.2));
    kit.decal(
      g,
      projected(g, [2, 1], shape, p => p[0]),
      mat,
      {ns, nt: 3, offset: 0.009, mirror: true, segS: ns, segT: 2},
    );
    kit.decal(
      g,
      projected(g, [2, 1], shape, p => p[0]),
      Mat.interior,
      {ns, nt: 3, offset: 0.012, inner: true, mirror: true, segS: ns, segT: 2},
    );
  }
  if (cfg.cargoFromZ !== undefined) {
    const zc = cfg.cargoFromZ;
    const zEnd = gh.base[gh.iRearCorner][2];
    const yb = (z: number) => edgeAtZ(z)[1] + 0.002;
    const yt = (z: number) => roofEdgeY(z) - 0.002;
    const shape = (s2: number, t: number): [number, number] => {
      const z = lerp(zc, zEnd, s2);
      return [z, lerp(yb(z), yt(z), t)];
    };
    const paintMat = cfg.roofMat ?? Mat.paint;
    kit.decal(
      g,
      projected(g, [2, 1], shape, p => p[0]),
      paintMat,
      {ns: 6, nt: 4, offset: 0.01, mirror: true, segS: 6, segT: 4},
    );
    kit.decal(
      g,
      projected(g, [2, 1], shape, p => p[0]),
      Mat.interior,
      {ns: 6, nt: 4, offset: 0.01, inner: true, mirror: true, segS: 6, segT: 4},
    );
    glassDecal(
      () => gh.iRearSeg - 0.5,
      () => gh.iRearCorner + 0.3,
      0,
      1,
      paintMat,
    );
  }
  // Roof drip rail / glass top trim and belt trim along the side.
  glassDecal(
    () => gh.iRearCorner - 1,
    () => gh.iSide + 0.6,
    0.955,
    1,
    Mat.plastic,
    false,
    0.007,
  );
  glassDecal(
    () => gh.iRearCorner - 0.5,
    () => gh.iSide + 0.5,
    0,
    0.035,
    Mat.chrome,
    false,
    0.007,
  );

  // --- Front: headlights, grille, intake, plate.
  const sh = wall.sheet;
  const front = (shape: (s: number, t: number) => [number, number]) =>
    projected(sh, [0, 1], shape, p => p[2]);
  const rear = (shape: (s: number, t: number) => [number, number]) =>
    projected(sh, [0, 1], shape, p => -p[2]);
  const side = (shape: (s: number, t: number) => [number, number]) =>
    projected(sh, [2, 1], shape, p => p[0]);
  const hl = cfg.headlight;
  const tl = cfg.taillight;
  if (cfg.carDetails !== false) {
    // Lights are projected along a direction swung toward the corner so they wrap.
    const corner = (end: number, theta: number) => {
      const d: Vec3 = [Math.sin(theta), 0, end * Math.cos(theta)];
      const ax: Vec3 = [Math.cos(theta), 0, -end * Math.sin(theta)];
      return {
        proj: (shape: (s: number, t: number) => [number, number]) =>
          projected(sh, [ax, 1], shape, p => dot(p, d)),
        aAt: (x: number, y: number) =>
          dot(sh.point(...sh.solve([0, 1], [x, y], p => end * p[2])), ax),
      };
    };
    {
      const c = corner(1, 0.55);
      const ac = c.aAt(hl.x, hl.y);
      const n = hl.n ?? 5,
        sl = hl.slant ?? 0;
      kit.decal(
        sh,
        c.proj(superellipse(ac, hl.y, hl.hx + 0.012, hl.hy + 0.012, n, sl)),
        Mat.plastic,
        {ns: 8, nt: 6, offset: 0.004, mirror: true},
      );
      kit.decal(
        sh,
        c.proj(
          superellipse(
            ac - hl.hx * 0.22,
            hl.y + hl.hy * 0.05,
            hl.hx * 0.72,
            hl.hy * 0.75,
            n,
            sl * 0.9,
          ),
        ),
        Mat.headlight,
        // Domed lens standing out of the dark housing.
        {
          ns: 7,
          nt: 5,
          offset: 0.006,
          mirror: true,
          segS: 10,
          segT: 6,
          bump: (u, t) => 0.014 * Math.sin(Math.PI * u) * Math.sin(Math.PI * t),
        },
      );
      // Projector lens and indicator at the outer end.
      blob(
        kit,
        [
          hl.x - hl.hx * 0.15,
          hl.y,
          sh.point(
            ...sh.solve([0, 1], [hl.x - hl.hx * 0.15, hl.y], p => p[2]),
          )[2] - 0.01,
        ],
        [0.032, 0.032, 0.02],
        Mat.chrome,
        {mirror: true, segU: 10, segV: 4},
      );
      kit.decal(
        sh,
        c.proj(
          superellipse(
            ac + hl.hx * 0.72,
            hl.y + hl.hy * 0.1 + sl * hl.hy * 0.7,
            hl.hx * 0.22,
            hl.hy * 0.45,
            4,
          ),
        ),
        Mat.indicator,
        {ns: 5, nt: 5, offset: 0.02, mirror: true},
      );
    }
    const gy = hl.y - hl.hy * 0.5;
    const gx = hl.x - hl.hx - 0.03;
    if (cfg.grille === 'wide') {
      kit.decal(sh, front(rect(0, gx, gy - 0.08, gy + 0.03)), Mat.plastic, {
        ns: 4,
        nt: 3,
        offset: 0.004,
        mirror: true,
      });
      for (const yy of [gy - 0.05, gy - 0.02, gy + 0.01])
        kit.decal(
          sh,
          front(rect(0, gx + 0.01, yy - 0.004, yy + 0.004)),
          Mat.chrome,
          {ns: 4, nt: 2, offset: 0.007, mirror: true},
        );
    } else if (cfg.grille === 'chrome') {
      kit.decal(sh, front(rect(0, gx, gy - 0.1, gy + 0.04)), Mat.chrome, {
        ns: 4,
        nt: 3,
        offset: 0.004,
        mirror: true,
      });
      for (let i = 0; i < 5; i++) {
        const yy = gy - 0.08 + i * 0.025;
        kit.decal(
          sh,
          front(rect(0, gx - 0.015, yy - 0.006, yy + 0.006)),
          Mat.plastic,
          {ns: 4, nt: 2, offset: 0.007, mirror: true},
        );
      }
    } else if (cfg.grille === 'tall') {
      kit.decal(
        sh,
        front(superellipse(0, gy - 0.08, gx * 0.85, 0.11, 6, 0, true)),
        Mat.plastic,
        {ns: 6, nt: 6, offset: 0.004, mirror: true},
      );
      for (let i = 0; i < 4; i++)
        kit.decal(
          sh,
          front(
            rect(
              0,
              gx * 0.8 - Math.abs(i - 1.5) * 0.02,
              gy - 0.15 + i * 0.045,
              gy - 0.142 + i * 0.045,
            ),
          ),
          Mat.chrome,
          {ns: 3, nt: 2, offset: 0.007, mirror: true},
        );
      kit.decal(
        sh,
        front(rect(0, gx + 0.01, gy + 0.025, gy + 0.04)),
        Mat.chrome,
        {ns: 4, nt: 2, offset: 0.008, mirror: true},
      );
    } else {
      kit.decal(sh, front(rect(0, gx, gy - 0.02, gy + 0.025)), Mat.plastic, {
        ns: 4,
        nt: 2,
        offset: 0.004,
        mirror: true,
      });
    }
    // Lower intake, bumper lip, fog lamps.
    const by = cfg.bumperF;
    kit.decal(
      sh,
      front(superellipse(0, by + 0.1, W * 0.5, 0.055, 6, 0, true)),
      Mat.plastic,
      {ns: 6, nt: 5, offset: 0.004, mirror: true},
    );
    kit.decal(sh, front(rect(0, W * 0.78, by + 0.03, by + 0.05)), Mat.plastic, {
      ns: 5,
      nt: 2,
      offset: 0.003,
      mirror: true,
    });
    {
      const c = corner(1, 0.5);
      const ac = c.aAt(W * 0.7, by + 0.12);
      kit.decal(
        sh,
        c.proj(superellipse(ac, by + 0.12, 0.06, 0.03, 5)),
        Mat.plastic,
        {ns: 5, nt: 5, offset: 0.004, mirror: true},
      );
      kit.decal(
        sh,
        c.proj(superellipse(ac, by + 0.12, 0.04, 0.016, 4)),
        Mat.headlight,
        {ns: 5, nt: 5, offset: 0.007, mirror: true},
      );
    }

    // --- Rear: taillights, bumper crease, reflectors.
    {
      const c = corner(-1, tl.wrap ? 0.7 : 0.35);
      const ac = c.aAt(tl.x, tl.y);
      const n = tl.n ?? 6;
      kit.decal(
        sh,
        c.proj(superellipse(ac, tl.y, tl.hx + 0.012, tl.hy + 0.012, n)),
        Mat.plastic,
        {ns: 8, nt: 5, offset: 0.003, mirror: true},
      );
      kit.decal(
        sh,
        c.proj(superellipse(ac, tl.y, tl.hx, tl.hy, n)),
        Mat.taillight,
        {
          ns: 8,
          nt: 5,
          offset: 0.006,
          mirror: true,
          segS: 10,
          segT: 5,
          bump: (u, t) => 0.01 * Math.sin(Math.PI * u) * Math.sin(Math.PI * t),
        },
      );
      kit.decal(
        sh,
        c.proj(
          superellipse(
            ac - tl.hx * 0.35,
            tl.y - tl.hy * 0.3,
            tl.hx * 0.2,
            tl.hy * 0.35,
            4,
          ),
        ),
        Mat.indicator,
        {ns: 5, nt: 5, offset: 0.017, mirror: true},
      );
      kit.decal(
        sh,
        c.proj(
          superellipse(
            ac - tl.hx * 0.75,
            tl.y - tl.hy * 0.3,
            tl.hx * 0.15,
            tl.hy * 0.35,
            4,
          ),
        ),
        Mat.headlight,
        {ns: 5, nt: 5, offset: 0.017, mirror: true},
      );
      kit.decal(
        sh,
        c.proj(
          superellipse(
            ac + tl.hx * 0.25,
            tl.y + tl.hy * 0.2,
            tl.hx * 0.45,
            tl.hy * 0.25,
            4,
          ),
        ),
        Mat.taillight,
        {ns: 5, nt: 5, offset: 0.017, mirror: true},
      );
      if (tl.bar)
        kit.decal(
          sh,
          rear(
            rect(
              0,
              tl.x - tl.hx * 0.8,
              tl.y - tl.hy * 0.2,
              tl.y + tl.hy * 0.25,
            ),
          ),
          Mat.taillight,
          {ns: 4, nt: 2, offset: 0.005, mirror: true},
        );
      const crease = cfg.bumperR + 0.3;
      const c2 = corner(-1, 0.6);
      kit.decal(
        sh,
        c2.proj(
          rect(
            c2.aAt(0, crease),
            c2.aAt(W - 0.03, crease),
            crease - 0.004,
            crease + 0.004,
          ),
        ),
        Mat.rubber,
        {ns: 8, nt: 2, offset: 0.002, mirror: true, segS: 10, segT: 1},
      );
      kit.decal(
        sh,
        c2.proj(
          rect(
            c2.aAt(0.01, cfg.bumperR + 0.08),
            c2.aAt(W * 0.75, cfg.bumperR + 0.08),
            cfg.bumperR + 0.05,
            cfg.bumperR + 0.1,
          ),
        ),
        Mat.plastic,
        {ns: 6, nt: 2, offset: 0.003, mirror: true},
      );
      const ar = c2.aAt(W * 0.78, cfg.bumperR + 0.14);
      kit.decal(
        sh,
        c2.proj(superellipse(ar, cfg.bumperR + 0.14, 0.05, 0.012, 4)),
        Mat.taillight,
        {ns: 5, nt: 5, offset: 0.005, mirror: true},
      );
    }
    // Plates (Japanese plate 330 x 165): white plate with a dark frame.
    const plate = (y: number, dir: number) => {
      const z =
        sh.point(...sh.solve([0, 1], [0.0, y], p => dir * p[2]))[2] +
        dir * 0.012;
      const hx = 0.165,
        hy = 0.0825;
      const q = (
        x0: number,
        x1: number,
        y0: number,
        y1: number,
        dz: number,
        mat: number,
      ) => {
        const zz = z + dir * dz;
        if (dir > 0)
          panel(
            kit,
            [x0, y0, zz],
            [x1, y0, zz],
            [x0, y1, zz],
            [x1, y1, zz],
            mat,
          );
        else
          panel(
            kit,
            [x1, y0, zz],
            [x0, y0, zz],
            [x1, y1, zz],
            [x0, y1, zz],
            mat,
          );
      };
      const zz = z;
      const f = [-hx - 0.012, hx + 0.012, y - hy - 0.012, y + hy + 0.012];
      if (dir > 0)
        panel(
          kit,
          [f[0], f[2], zz],
          [f[1], f[2], zz],
          [f[0], f[3], zz],
          [f[1], f[3], zz],
          Mat.plastic,
          {doubleSided: true},
        );
      else
        panel(
          kit,
          [f[1], f[2], zz],
          [f[0], f[2], zz],
          [f[1], f[3], zz],
          [f[0], f[3], zz],
          Mat.plastic,
          {doubleSided: true},
        );
      q(-hx, hx, y - hy, y + hy, 0.003, Mat.rim);
      // Green-on-white plate: region + class line on top, large number below.
      q(-0.1, -0.01, y + 0.035, y + 0.055, 0.005, Mat.plastic);
      q(0.02, 0.07, y + 0.035, y + 0.055, 0.005, Mat.plastic);
      for (const x0 of [-0.12, -0.04, 0.04])
        q(x0, x0 + 0.06, y - 0.06, y + 0.01, 0.005, Mat.plastic);
    };
    plate(by + 0.14, 1);
    plate(cfg.rearBaseZ === null ? cfg.bumperR + 0.38 : cfg.bumperR + 0.3, -1);

    // --- Side: shut lines, handles, mirrors, side repeaters.
    const sideY0 = cfg.sill + 0.06;
    const line = (z0: number, z1: number, y0: number, y1: number) =>
      kit.decal(sh, side(rect(z0, z1, y0, y1)), Mat.rubber, {
        ns: 2,
        nt: 6,
        offset: 0.0025,
        mirror: true,
        segS: 1,
        segT: 8,
      });
    for (const z of cfg.doors) {
      const top = edgeY(z) - 0.005;
      line(
        z - 0.003,
        z + 0.003,
        Math.max(sideY0, archY(axles, cfg.sill, z) + 0.03),
        top,
      );
    }
    if (cfg.doors.length >= 2) {
      // Door bottom line, broken where it would cross a wheel arch.
      let z0 = cfg.doors[cfg.doors.length - 1] + 0.003;
      const z1 = cfg.doors[0] - 0.003;
      for (const a of [...axles].sort((p, q) => p.z - q.z)) {
        const lo = a.z - archR - 0.12,
          hi = a.z + archR + 0.12;
        if (hi < z0 || lo > z1) continue;
        if (lo > z0 + 0.05) line(z0, lo, sideY0 - 0.003, sideY0 + 0.003);
        z0 = Math.max(z0, hi);
      }
      if (z1 > z0 + 0.05) line(z0, z1, sideY0 - 0.003, sideY0 + 0.003);
    }
    for (let i = 0; i < cfg.doors.length - 1; i++) {
      const zh = cfg.doors[i + 1] + (cfg.doors[i] - cfg.doors[i + 1]) * 0.2;
      const yh = edgeY(zh) - 0.1;
      kit.decal(sh, side(superellipse(zh, yh, 0.075, 0.016, 4)), Mat.chrome, {
        ns: 5,
        nt: 3,
        offset: 0.012,
        mirror: true,
        bump: (s, t) => 0.006 * Math.sin(Math.PI * t) * Math.sin(Math.PI * s),
      });
    }
    // Side mirrors (door or fender).
    if (cfg.noMirrors) {
      // Built by the design.
    } else if (cfg.fenderMirrors) {
      const zm = zf - 0.55;
      const ym = edgeY(zm);
      const xm = xEdge(zm) - 0.03;
      tube(
        kit,
        [
          [xm - 0.02, ym - 0.02, zm],
          [xm + 0.01, ym + 0.06, zm - 0.03],
          [xm + 0.04, ym + 0.1, zm - 0.06],
        ],
        0.009,
        Mat.plastic,
        {mirror: true, along: 3, seg: 4},
      );
      blob(
        kit,
        [xm + 0.05, ym + 0.12, zm - 0.07],
        [0.05, 0.04, 0.025],
        Mat.plastic,
        {mirror: true, segU: 10, segV: 4, n: 4},
      );
      blob(
        kit,
        [xm + 0.05, ym + 0.12, zm - 0.095],
        [0.042, 0.032, 0.004],
        Mat.chrome,
        {mirror: true, segU: 10, segV: 2, n: 4},
      );
    } else {
      const zm = cowl - cfg.ghCornerBase - 0.08;
      const ym = edgeY(zm) + 0.08;
      const xm = xEdge(zm) + 0.12;
      blob(
        kit,
        [xm, ym, zm],
        [0.1, 0.06, 0.045],
        cfg.roofMat === Mat.paint2 ? Mat.paint2 : Mat.paint,
        {
          mirror: true,
          n: 3.5,
          m: 2.5,
          xf: p => [p[0], p[1], p[2] + 0.03 * (p[0] / 0.1) ** 2],
          segU: 12,
          segV: 5,
        },
      );
      blob(kit, [xm, ym, zm - 0.04], [0.085, 0.048, 0.008], Mat.chrome, {
        mirror: true,
        n: 4,
        segU: 10,
        segV: 2,
      });
      // Mirror base on the door top and an arm out to the housing.
      const xd = xEdge(zm);
      const yd = edgeY(zm);
      blob(
        kit,
        [xd + 0.005, yd - 0.02, zm + 0.01],
        [0.03, 0.035, 0.06],
        Mat.plastic,
        {mirror: true, n: 4, segU: 10, segV: 4},
      );
      tube(
        kit,
        [
          [xd + 0.01, yd - 0.01, zm + 0.01],
          [xd + 0.05, ym - 0.025, zm + 0.005],
          [xm - 0.07, ym - 0.02, zm],
        ],
        0.016,
        Mat.plastic,
        {mirror: true, along: 4, seg: 6},
      );
      blob(
        kit,
        [xm + 0.04, ym - 0.04, zm + 0.02],
        [0.05, 0.008, 0.02],
        Mat.indicator,
        {mirror: true, segU: 8, segV: 3},
      );
    }
    // Wipers.
    {
      // Lying on the windshield just above its base, parked toward the right.
      const onGlass = (x: number, h: number): Vec3 => {
        const y = baseY(x, cowl) + h;
        const uv = g.solve([0, 1], [x, y], p => p[2]);
        const p = g.point(uv[0], uv[1]);
        const n = g.normal(uv[0], uv[1]);
        return [p[0] + n[0] * 0.012, p[1] + n[1] * 0.012, p[2] + n[2] * 0.012];
      };
      const wl = Math.min(0.55, xEdge(cowl) * 0.6);
      for (const xw of [0.04, xEdge(cowl) * 0.62]) {
        const x0 = xw - wl * 0.85;
        tube(
          kit,
          [
            onGlass(Math.max(0.02, xw), 0.03),
            onGlass(Math.max(0.02, (xw + Math.max(x0, -xw)) / 2), 0.045),
            onGlass(Math.abs(Math.max(x0, -xw + 0.05)), 0.06),
          ],
          0.006,
          Mat.plastic,
          {along: 3, seg: 4},
        );
      }
    }
  }
  if (cfg.roofRails) {
    const xr = xt - 0.1;
    const pts: Vec3[] = [];
    for (let i = 0; i <= 6; i++) {
      const z = lerp(cfg.roofRearZ + 0.1, cfg.wsTopZ - 0.15, i / 6);
      const lift = i === 0 || i === 6 ? 0.01 : 0.045;
      pts.push([xr, roofY(xr, z) + lift, z]);
    }
    tube(kit, pts, 0.014, Mat.chrome, {mirror: true, along: 12, seg: 5});
  }
  if (cfg.spoiler) {
    const zs = zr + 0.12;
    const ys = edgeY(zs) + 0.05;
    blob(kit, [0, ys, zs], [W * 0.8, 0.012, 0.09], cfg.roofMat ?? Mat.paint, {
      n: 8,
      m: 3,
      segU: 14,
      segV: 4,
    });
    for (const sx of [1, -1])
      blob(
        kit,
        [sx * W * 0.6, ys - 0.03, zs + 0.02],
        [0.012, 0.035, 0.04],
        Mat.plastic,
        {segU: 6, segV: 3},
      );
  }
  if (cfg.carDetails !== false) {
    const bodyMat = cfg.roofMat === Mat.paint2 ? Mat.paint : Mat.paint;
    // Shoulder crease: a raised rib following the belt line along the flank.
    const z0 = zr + cfg.rearDepth + 0.05,
      z1 = zf - cfg.frontDepth - 0.05;
    const crease = (t: number): [number, number] => {
      const z = lerp(z0, z1, t);
      return [z, edgeY(z) - 0.11];
    };
    kit.decal(sh, side(band(crease, 0.05)), bodyMat, {
      ns: 3,
      nt: 20,
      offset: 0.002,
      mirror: true,
      segS: 3,
      segT: 20,
      bump: u => 0.006 * Math.sin(Math.PI * u),
    });
    // Wheel-arch flares: a swelling lip around each opening that blends out.
    if (!cfg.archFlare) {
      for (const a of axles) {
        const c = (t: number): [number, number] => {
          const th = lerp(-Math.PI * 0.4, Math.PI * 0.4, t);
          return [
            a.z + Math.sin(th) * (archR + 0.04),
            a.wheelR + Math.cos(th) * (archR + 0.04),
          ];
        };
        kit.decal(sh, side(band(c, 0.08)), bodyMat, {
          ns: 4,
          nt: 14,
          offset: 0.001,
          mirror: true,
          segS: 3,
          segT: 12,
          bump: u =>
            0.012 *
            Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.6)), 2) *
            (1 - u * 0.5),
        });
      }
    }
  }
  if (cfg.archFlare) {
    for (const a of axles) {
      const c = (t: number): [number, number] => {
        const th = lerp(-Math.PI * 0.47, Math.PI * 0.47, t);
        return [
          a.z + Math.sin(th) * (archR + 0.035),
          a.wheelR + Math.cos(th) * (archR + 0.035),
        ];
      };
      kit.decal(sh, side(band(c, 0.06)), Mat.plastic, {
        ns: 2,
        nt: 12,
        offset: 0.006,
        mirror: true,
        segS: 1,
        segT: 16,
      });
    }
    // Lower cladding.
    kit.decal(
      sh,
      side(
        rect(
          -wb / 2 + archR + 0.07,
          wb / 2 - archR - 0.07,
          cfg.sill + 0.03,
          cfg.sill + 0.13,
        ),
      ),
      Mat.plastic,
      {ns: 4, nt: 3, offset: 0.005, mirror: true},
    );
  }

  cfg.extras?.(kit, ctx);

  // --- Interior.
  const floorY = ctx.floorY;
  const driverX = W * 0.42;
  const zDashRear =
    cowl -
    (cfg.dashDepth ??
      lerp(0.55, 0.75, clamp((cfg.cowlZ - cfg.wsTopZ - 0.5) / 0.4, 0, 1)));
  const eyeZ = zDashRear - (cfg.eyeBack ?? 0.82);
  // Seat cushion height: normally 25 cm above the floor, lower in low cars so
  // the headrests stay under the roof.
  const seatY0 = (x: number, z: number) =>
    Math.max(
      floorY + 0.12,
      Math.min(floorY + 0.25, roofY(Math.abs(x), z - 0.35) - 1.03),
    );
  // The first-person camera sits CAMERA_LIFT above driverEye. Seat the
  // driver low enough that the windscreen header stays >= 14 degrees above
  // that camera (a thin strip of headliner, not a wall), as low-roof cars
  // really do; never closer than 6 cm to the floor.
  const CAMERA_LIFT = 0.15;
  const eye0 = seatY0(driverX, eyeZ + 0.12) + 0.62;
  const headerY = roofY(driverX, cfg.wsTopZ) - 0.02;
  const camMax =
    headerY - Math.max(0.1, cfg.wsTopZ - eyeZ) * Math.tan((14 * Math.PI) / 180);
  const seatDrop = clamp(
    eye0 + CAMERA_LIFT - camMax,
    0,
    seatY0(driverX, eyeZ + 0.12) - (floorY + 0.06),
  );
  const seatY = (x: number, z: number) => seatY0(x, z) - seatDrop;
  const eyeY = eye0 - seatDrop;
  if (cfg.interior !== 'none') {
    // Small trim details only at full detail: LOD meshes see the cabin
    // through glass from afar, and tiny blobs keep a minimum ring count.
    const fine = detailScale() > 0.9;
    const zFire = cfg.zFire ?? Math.min(cowl - 0.1, wb / 2 - archR - 0.02);
    const zBulk =
      cfg.zBulk ??
      (rearBase === null
        ? zr + 0.45
        : Math.max(rearBase - 0.05, -wb / 2 + 0.05));
    const xIn = (z: number) => xEdge(z) - 0.04;
    const beltIn = (z: number) => edgeY(z) - 0.01;
    // Door cards: top at the glass base, bottom at the floor (or over the rear wheel).
    {
      const rows: Vec3[][] = [];
      const N = 10;
      const zc0 = zBulk - 0.02,
        zc1 = cowl - cfg.ghCornerBase;
      for (let i = 0; i <= N; i++) {
        const z = lerp(zc0, zc1, i / N);
        const xe = xEdge(z);
        const ye = edgeY(z);
        const yBot = Math.max(
          floorY - 0.03,
          archYAt(axles, cfg.sill, z) + 0.03,
        );
        rows.push([
          [xe - 0.002, ye - 0.002, z],
          [xe - 0.045, ye - 0.02, z],
          [xe - 0.07, ye - 0.12, z],
          [xe - 0.06, lerp(ye - 0.12, yBot, 0.5), z],
          [xe - 0.07, yBot, z],
        ]);
      }
      const card = new Sheet(rows, 1);
      kit.sheet(card, Mat.interior, {mirror: true, segU: 6, segV: 12});
      // Soft-touch upper (window sill and shoulder), a satin strip along it.
      const vA = card.v(0.02),
        vB = card.v(N - 0.02);
      if (fine) {
        kit.decal(
          card,
          (s, t) => [lerp(card.u(0), card.u(2.15), s), lerp(vA, vB, t)],
          Mat.softTouch,
          {ns: 5, nt: 9, offset: 0.0015, mirror: true, segS: 4, segT: 10},
        );
        kit.decal(
          card,
          (s, t) => [lerp(card.u(1.55), card.u(1.68), s), lerp(vA, vB, t)],
          Mat.satin,
          {ns: 2, nt: 9, offset: 0.003, mirror: true, segS: 1, segT: 10},
        );
      }
      // (u, v) on the card of the world point (z, y): rows are uniform in z,
      // y falls monotonically along each row.
      const cardUV = (z: number, y: number): [number, number] => {
        const v = card.v(clamp(((z - zc0) / (zc1 - zc0)) * N, 0, N));
        let lo = 0,
          hi = 1;
        for (let it = 0; it < 30; it++) {
          const m = (lo + hi) / 2;
          if (card.point(m, v)[1] > y) lo = m;
          else hi = m;
        }
        return [(lo + hi) / 2, v];
      };
      const onCard =
        (shape: (s: number, t: number) => [number, number]) =>
        (s: number, t: number) =>
          cardUV(...shape(s, t));
      // Per-door inserts (trimmed like the seats), armrests, pulls, speakers.
      const d = cfg.doors;
      const doorSpans: [number, number][] =
        d.length > 2
          ? [
              [d[1] + 0.06, Math.min(d[0], zc1) - 0.12],
              [Math.max(d[2], zc0) + 0.1, d[1] - 0.06],
            ]
          : [[Math.max(zc0, zDashRear - 1.1) + 0.1, zc1 - 0.12]];
      for (const [z0, z1] of doorSpans) {
        if (z1 - z0 < 0.25) continue;
        const zm = (z0 + z1) / 2;
        const ye = beltIn(zm);
        // (Plain rectangle: superellipse end rows collapse and fold.)
        const xa = xIn(zm) - 0.075;
        blob(
          kit,
          [xa, ye - 0.28, zm - 0.02],
          [0.045, 0.028, (z1 - z0) * 0.38],
          Mat.leather,
          {mirror: true, n: 3, m: 5, segU: 10, segV: 4},
        );
        if (!fine) continue;
        const insert = onCard(rect(z0, z1, ye - 0.25, ye - 0.15));
        kit.decal(card, insert, Mat.seat, {
          ns: 7,
          nt: 4,
          offset: 0.004,
          mirror: true,
          segS: 6,
          segT: 4,
          bump: (s, t) => 0.006 * Math.sin(Math.PI * s) * Math.sin(Math.PI * t),
        });
        blob(
          kit,
          [xa + 0.01, ye - 0.235, z1 - 0.05],
          [0.012, 0.012, 0.055],
          Mat.satin,
          {mirror: true, n: 3, m: 3, segU: 8, segV: 3},
        );
        const yBot = Math.max(floorY, archYAt(axles, cfg.sill, zm + 0.1));
        if (ye - 0.36 - yBot > 0.16) {
          const zs = z1 - 0.13,
            ys = yBot + 0.1;
          const [su, sv] = cardUV(zs, ys);
          const ps = card.point(su, sv);
          // Disc facing the cabin (local z -> world x, a proper rotation).
          blob(
            kit,
            [ps[0] - 0.002, ps[1], ps[2]],
            [0.075, 0.075, 0.006],
            Mat.rubber,
            {
              n: 2,
              m: 3,
              segU: 12,
              segV: 3,
              mirror: true,
              xf: p => [p[2], p[1], -p[0]],
            },
          );
        }
      }
    }
    // Floor (carpet).
    const xf = xEdge(zMid) - 0.062;
    panel(
      kit,
      [-xf, floorY, zFire],
      [xf, floorY, zFire],
      [-xf, floorY, zBulk],
      [xf, floorY, zBulk],
      Mat.interior,
      {segU: 1, segV: 1},
    );
    // Dash: rows across x, stations along the dash's side profile.
    {
      const yb1 = baseY(0, cowl - 0.02);
      const yTop = cfg.beltF + 0.02;
      const prof: [number, number][] = [
        [yb1 - 0.005, cowl - 0.02],
        [yTop - 0.01, lerp(cowl, zDashRear, 0.45)],
        [yTop, zDashRear + 0.07],
        [yTop - 0.012, zDashRear + 0.002],
        [yTop - 0.045, zDashRear - 0.008],
        [yTop - 0.2, zDashRear + 0.03],
        [
          Math.min(yTop - 0.3, floorY + 0.3),
          Math.min(zDashRear + 0.22, zFire - 0.05),
        ],
        [floorY - 0.01, Math.max(zFire, zDashRear + 0.1)],
      ];
      const rows: Vec3[][] = prof.map(([y, z]) => {
        // Ends meet the door card (or the glass base at belt height).
        const xe = xEdge(z),
          ye = edgeY(z);
        const yEnd = Math.min(y, ye - 0.003);
        const xEnd =
          yEnd >= ye - 0.02
            ? lerp(
                xe - 0.045,
                xe - 0.003,
                clamp((yEnd - (ye - 0.02)) / 0.017, 0, 1),
              )
            : xe - 0.065;
        const xi = Math.min(xe - 0.1, xEdge(zDashRear) - 0.1);
        return [
          [-xEnd, yEnd, z],
          [-xi * 0.7, y + 0.006, z],
          [0, y + 0.01, z],
          [xi * 0.7, y + 0.006, z],
          [xEnd, yEnd, z],
        ] as Vec3[];
      });
      const dash = new Sheet(rows, 1, {v: 2});
      kit.sheet(dash, Mat.softTouch, {segU: 12, segV: 18});
      // Frame on a face with outward normal n: local x right, y up the face,
      // z into the surface.
      type Frame = {p: Vec3; n: Vec3; xf: (q: Vec3) => Vec3};
      const frameAt = (p: Vec3, n: Vec3): Frame => {
        const X = norm(cross(n, [0, 1, 0]));
        const Y = cross(X, n);
        const xf = (q: Vec3): Vec3 => [
          X[0] * q[0] + Y[0] * q[1] - n[0] * q[2],
          X[1] * q[0] + Y[1] * q[1] - n[1] * q[2],
          X[2] * q[0] + Y[2] * q[1] - n[2] * q[2],
        ];
        return {p, n, xf};
      };
      const onDash = (x: number, y: number): Frame => {
        const [u, v] = dash.solve([0, 1], [x, y], p => -p[2]);
        return frameAt(dash.point(u, v), dash.normal(u, v));
      };
      // Point at local (x, y) on frame f, lifted along its normal.
      const at = (f: Frame, lift: number, x = 0, y = 0): Vec3 => {
        const q = f.xf([x, y, 0]);
        return [
          f.p[0] + q[0] + f.n[0] * lift,
          f.p[1] + q[1] + f.n[1] * lift,
          f.p[2] + q[2] + f.n[2] * lift,
        ];
      };
      // Air vent: satin surround, dark throat and horizontal slats.
      const vent = (f: Frame, hw: number, hh: number, mirror = false) => {
        blob(kit, at(f, 0), [hw + 0.008, hh + 0.008, 0.007], Mat.satin, {
          n: 6,
          m: 3,
          segU: 12,
          segV: 3,
          xf: f.xf,
          mirror,
        });
        blob(kit, at(f, 0.0035), [hw, hh, 0.006], Mat.rubber, {
          n: 7,
          m: 3,
          segU: 12,
          segV: 3,
          xf: f.xf,
          mirror,
        });
        for (const k of [-0.35, 0.35])
          blob(
            kit,
            at(f, 0.009, 0, k * hh * 1.2),
            [hw * 0.97, 0.0025, 0.004],
            Mat.plastic,
            {
              n: 4,
              m: 3,
              segU: 8,
              segV: 3,
              xf: f.xf,
              mirror,
            },
          );
      };
      const xOut = xEdge(zDashRear) - 0.17;
      if (fine) {
        // Demister slot along the windscreen base and corner tweeter grilles.
        kit.decal(
          dash,
          (s, t) => [
            lerp(dash.u(0.55), dash.u(3.45), s),
            lerp(dash.v(0.32), dash.v(0.4), t),
          ],
          Mat.rubber,
          {ns: 9, nt: 2, offset: 0.0015, segS: 16, segT: 1},
        );
        for (const uc of [0.32, 3.68]) {
          const p = dash.point(dash.u(uc), dash.v(0.5));
          kit.decal(
            dash,
            projected(
              dash,
              [0, 2],
              superellipse(p[0], p[2], 0.035, 0.035, 2),
              p => p[1],
            ),
            Mat.rubber,
            {ns: 7, nt: 7, offset: 0.0015, segS: 6, segT: 6},
          );
        }
        vent(onDash(xOut, yTop - 0.085), 0.05, 0.026, true);
        // Satin strip across the passenger side of the face, glovebox below.
        kit.decal(
          dash,
          projected(
            dash,
            [0, 1],
            rect(-xOut + 0.07, -0.17, yTop - 0.125, yTop - 0.107),
            p => -p[2],
          ),
          Mat.satin,
          {ns: 9, nt: 2, offset: 0.0025, segS: 10, segT: 1},
        );
        // Driver side: the strip continues under the cluster to the door,
        // with the knee-pad seam below it.
        kit.decal(
          dash,
          projected(
            dash,
            [0, 1],
            rect(0.17, xOut - 0.07, yTop - 0.125, yTop - 0.107),
            p => -p[2],
          ),
          Mat.satin,
          {ns: 9, nt: 2, offset: 0.0025, segS: 10, segT: 1},
        );
        kit.decal(
          dash,
          projected(
            dash,
            [0, 1],
            rect(0.16, xOut + 0.06, yTop - 0.215, yTop - 0.209),
            p => -p[2],
          ),
          Mat.rubber,
          {ns: 9, nt: 2, offset: 0.0015, segS: 10, segT: 1},
        );
        const gx = -driverX - 0.03,
          gy = yTop - 0.205;
        kit.decal(
          dash,
          projected(
            dash,
            [0, 1],
            rect(gx - 0.175, gx + 0.175, gy - 0.062, gy + 0.062),
            p => -p[2],
          ),
          Mat.rubber,
          {ns: 9, nt: 5, offset: 0.0012, segS: 10, segT: 4},
        );
        kit.decal(
          dash,
          projected(
            dash,
            [0, 1],
            rect(gx - 0.171, gx + 0.171, gy - 0.058, gy + 0.058),
            p => -p[2],
          ),
          Mat.softTouch,
          {ns: 9, nt: 5, offset: 0.0026, segS: 10, segT: 4},
        );
        {
          const f = onDash(gx, gy + 0.035);
          blob(kit, at(f, 0.004), [0.04, 0.007, 0.005], Mat.satin, {
            n: 4,
            m: 3,
            segU: 8,
            segV: 3,
            xf: f.xf,
          });
        }
      }
      // Instrument hood over the cluster (Japan is RHD: driver on +x).
      {
        const hw = 0.25;
        const hRows: Vec3[][] = [];
        const NH = 10;
        for (let i = 0; i <= NH; i++) {
          const a = lerp(-1, 1, i / NH);
          const e = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(a), 3)), 1 / 3);
          const h = 0.088 * e;
          const x = driverX + a * hw;
          const zl = zDashRear + 0.035 - 0.065 * e;
          hRows.push([
            [x, yTop - 0.012, zDashRear + 0.22],
            [x, yTop + h * 0.72, zDashRear + 0.13],
            [x, yTop + h, zDashRear + 0.04 - 0.03 * e],
            [x, yTop + h - 0.012 * e, zl],
            [x, yTop + h - 0.03 * e - 0.01, zl + 0.012],
          ]);
        }
        kit.sheet(new Sheet(hRows, -1), Mat.softTouch, {
          segU: 6,
          segV: 14,
          doubleSided: true,
          backOffset: 0.002,
        });
        // Cluster: dark back panel in the recess, two dials, a small TFT.
        const cy = yTop + 0.03,
          cz = zDashRear + 0.05;
        blob(kit, [driverX, cy, cz + 0.02], [0.21, 0.055, 0.02], Mat.rubber, {
          n: 6,
          m: 4,
          segU: 16,
          segV: 3,
          xf: p => place(p, [0, 0, 0], -0.2),
        });
        for (const dx of [-0.095, 0.095])
          dial(kit, [driverX + dx, cy, cz - 0.002], 0.046, -0.2);
        if (fine)
          blob(
            kit,
            [driverX, cy, cz - 0.001],
            [0.035, 0.032, 0.002],
            Mat.display,
            {
              n: 8,
              m: 2,
              segU: 8,
              segV: 2,
              xf: p => place(p, [0, 0, 0], -0.2),
            },
          );
      }
      // Centre stack: a panel standing proud of the face from under the lip
      // to the console, holding the screen, vents and climate controls.
      {
        const A: Vec3 = [0, yTop - 0.05, zDashRear - 0.045];
        const B: Vec3 = [
          0,
          floorY + 0.2,
          Math.min(zDashRear + 0.1, zFire - 0.12),
        ];
        const dy = A[1] - B[1],
          dz = A[2] - B[2];
        const L = Math.hypot(dy, dz);
        // Face frame: local y up the stack, local z into it.
        const n: Vec3 = [0, -dz / L, dy / L];
        const face: Vec3 = [0, -n[1], -n[2]];
        const fAt = (t: number): Frame =>
          frameAt([0, lerp(B[1], A[1], t), lerp(B[2], A[2], t)], face);
        // Body: sheared box (local y along the face, depth horizontal) so
        // its top never rises out of the dash.
        const depth = 0.08;
        const ay = dy / L,
          az = dz / L;
        blob(
          kit,
          [0, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2 + depth],
          [0.14, L / 2 + 0.01, depth],
          Mat.softTouch,
          {
            n: 7,
            m: 6,
            segU: 16,
            segV: 4,
            xf: q => [q[0], q[1] * ay, q[1] * az + q[2]],
          },
        );
        // Screen (gloss black bezel + display).
        const fS = fAt(1 - 0.075 / L);
        blob(kit, at(fS, 0.002), [0.118, 0.07, 0.006], Mat.plastic, {
          n: 8,
          m: 3,
          segU: 12,
          segV: 3,
          xf: fS.xf,
        });
        blob(kit, at(fS, 0.006), [0.108, 0.06, 0.003], Mat.display, {
          n: 10,
          m: 2,
          segU: 8,
          segV: 2,
          xf: fS.xf,
        });
        // Centre vents below the screen.
        const fV = fAt(1 - 0.185 / L);
        if (fine)
          for (const vx of [-0.065, 0.065])
            vent(frameAt(at(fV, 0, vx), face), 0.05, 0.022);
        // Climate panel: satin band with two knobs and a row of buttons.
        const tC = 1 - 0.27 / L;
        if (fine && tC > 0.2) {
          const fC = fAt(tC);
          blob(kit, at(fC, 0.002), [0.12, 0.035, 0.005], Mat.satin, {
            n: 8,
            m: 3,
            segU: 16,
            segV: 3,
            xf: fC.xf,
          });
          for (const kx of [-0.085, 0.085]) {
            blob(kit, at(fC, 0.012, kx), [0.021, 0.021, 0.012], Mat.plastic, {
              n: 2,
              m: 6,
              segU: 12,
              segV: 3,
              xf: fC.xf,
            });
            blob(kit, at(fC, 0.024, kx), [0.016, 0.016, 0.002], Mat.satin, {
              n: 2,
              m: 2,
              segU: 8,
              segV: 2,
              xf: fC.xf,
            });
          }
          for (const bx of [-0.03, -0.01, 0.01, 0.03])
            blob(kit, at(fC, 0.007, bx), [0.008, 0.013, 0.004], Mat.rubber, {
              n: 5,
              m: 3,
              segU: 8,
              segV: 2,
              xf: fC.xf,
            });
        }
        // Console between the seats: shifter surround, gear lever, armrest.
        const zc1 = B[2] + 0.02;
        const zc0 = Math.max(eyeZ - 0.25, zBulk + 0.3);
        const yc = floorY + 0.2;
        const flat = (p: Vec3): Vec3 => [p[0], p[2], -p[1]];
        blob(
          kit,
          [0, (floorY + yc) / 2, (zc0 + zc1) / 2],
          [0.115, (yc - floorY) / 2 + 0.01, (zc1 - zc0) / 2],
          Mat.softTouch,
          {n: 6, m: 6, segU: 12, segV: 5},
        );
        const zg = Math.min(zc1 - 0.12, eyeZ + 0.45);
        if (fine) {
          blob(kit, [0, yc + 0.006, zg], [0.06, 0.09, 0.006], Mat.satin, {
            n: 6,
            m: 3,
            segU: 10,
            segV: 3,
            xf: flat,
          });
          blob(kit, [0, yc + 0.012, zg], [0.05, 0.08, 0.006], Mat.rubber, {
            n: 6,
            m: 3,
            segU: 10,
            segV: 3,
            xf: flat,
          });
          tube(
            kit,
            [
              [0, yc + 0.01, zg],
              [0, yc + 0.08, zg - 0.02],
            ],
            0.009,
            Mat.satin,
            {along: 1, seg: 6},
          );
          blob(
            kit,
            [0, yc + 0.1, zg - 0.025],
            [0.024, 0.026, 0.032],
            Mat.leather,
            {
              n: 2.2,
              m: 2.2,
              segU: 10,
              segV: 4,
              xf: flat,
            },
          );
        }
        // Armrest lid over a storage box between the front seats.
        const za = eyeZ + 0.05;
        const ya = Math.max(seatY(0, eyeZ) + 0.14, yc + 0.05);
        blob(
          kit,
          [0, (floorY + ya) / 2, za],
          [0.1, (ya - floorY) / 2, 0.16],
          Mat.softTouch,
          {n: 6, m: 6, segU: 10, segV: 4},
        );
        blob(kit, [0, ya + 0.02, za], [0.095, 0.028, 0.17], Mat.leather, {
          n: 4,
          m: 4,
          segU: 10,
          segV: 4,
        });
      }
      // Steering column shroud.
      const sy = cfg.beltF - 0.1,
        sz = zDashRear - 0.26,
        ct = Math.sin(0.42),
        cc = Math.cos(0.42);
      blob(
        kit,
        [driverX, sy - ct * 0.2, sz + cc * 0.2],
        [0.05, 0.045, 0.14],
        Mat.plastic,
        {n: 3, m: 4, segU: 10, segV: 4, xf: p => place(p, [0, 0, 0], 0.42)},
      );
    }
    // Seats.
    const seat = (
      x: number,
      z: number,
      w: number,
      back = true,
      head = true,
    ) => {
      const cy = seatY(x, z);
      blob(kit, [x, cy, z + 0.05], [w, 0.07, 0.26], Mat.seat, {
        n: 5,
        m: 4,
        segU: 8,
        segV: 4,
      });
      if (back) {
        blob(kit, [x, cy + 0.33, z - 0.24], [w * 0.95, 0.32, 0.07], Mat.seat, {
          n: 5,
          m: 4,
          segU: 8,
          segV: 4,
          xf: p => [p[0], p[1], p[2] - 0.2 * (p[1] / 0.32)],
        });
        if (head) {
          // Headrest on two chrome stems, clear of the backrest top.
          blob(
            kit,
            [
              x,
              Math.min(cy + 0.8, roofY(Math.abs(x), z - 0.35) - 0.15),
              z - 0.35,
            ],
            [w * 0.55, 0.1, 0.06],
            Mat.seat,
            {
              n: 4,
              m: 4,
              segU: 10,
              segV: 3,
            },
          );
          for (const dx of [-0.06, 0.06])
            tube(
              kit,
              [
                [x + dx, cy + 0.62, z - 0.33],
                [
                  x + dx,
                  Math.min(cy + 0.72, roofY(Math.abs(x), z - 0.35) - 0.2),
                  z - 0.35,
                ],
              ],
              0.006,
              Mat.chrome,
              {along: 1, seg: 5},
            );
        }
      }
    };
    seat(driverX, eyeZ + 0.12, 0.25);
    seat(-driverX, eyeZ + 0.12, 0.25);
    if (cfg.rearSeat) {
      const zRear = Math.max(eyeZ - 0.85, zBulk + 0.4);
      const cy = seatY(0.3, zRear) - 0.03;
      blob(kit, [0, cy, zRear + 0.05], [xf * 0.95, 0.08, 0.26], Mat.seat, {
        n: 6,
        m: 4,
        segU: 12,
        segV: 5,
      });
      blob(
        kit,
        [0, cy + 0.32, zRear - 0.24],
        [xf * 0.95, 0.32, 0.08],
        Mat.seat,
        {
          n: 6,
          m: 4,
          segU: 12,
          segV: 5,
          xf: p => [p[0], p[1], p[2] - 0.18 * (p[1] / 0.32)],
        },
      );
    }
    // Rear bulkhead / parcel shelf closes the cabin.
    {
      const yTop = edgeY(zBulk);
      panel(
        kit,
        [xIn(zBulk), floorY, zBulk],
        [-xIn(zBulk), floorY, zBulk],
        [xIn(zBulk), yTop, zBulk],
        [-xIn(zBulk), yTop, zBulk],
        Mat.interior,
        {flip: true},
      );
      if (rearBase !== null) {
        const z1 = rearBase + 0.02;
        const yb = baseY(0, z1);
        panel(
          kit,
          [xIn(zBulk), yTop, zBulk],
          [-xIn(zBulk), yTop, zBulk],
          [xIn(z1), yb, z1],
          [-xIn(z1), yb, z1],
          Mat.interior,
          {flip: true},
        );
      }
    }
    // Rear-view mirror and sun visors.
    {
      const zm = cfg.wsTopZ - 0.08;
      const ym = roofY(0, zm) - 0.09;
      // Rounded housing with a domed back, the glass set into its face.
      blob(kit, [0, ym, zm + 0.004], [0.122, 0.036, 0.02], Mat.plastic, {
        n: 2.8,
        m: 2.4,
        segU: 24,
        segV: 6,
        taper: t => {
          const k = Math.max(0, t * 2 - 1);
          return [lerp(1, 0.9, k), lerp(1, 0.82, k)];
        },
      });
      if (fine)
        blob(kit, [0, ym, zm - 0.0155], [0.11, 0.027, 0.002], Mat.chrome, {
          n: 3,
          m: 2,
          segU: 24,
          segV: 2,
        });
      tube(
        kit,
        [
          [0, ym, zm + 0.01],
          [0, roofY(0, zm) - 0.02, zm + 0.03],
        ],
        0.008,
        Mat.plastic,
        {along: 1, seg: 4},
      );
      for (const sx of [driverX, -driverX]) {
        // Padded visor folded up against the headliner, on a hinge rod.
        const yv = roofY(sx, zm - 0.07) - 0.008;
        const slope = (roofY(sx, zm) - roofY(sx, zm - 0.14)) / 0.14;
        blob(kit, [sx, yv, zm - 0.07], [0.15, 0.0035, 0.068], Mat.headliner, {
          n: 6,
          m: 2.5,
          segU: 10,
          segV: 3,
          xf: p => [p[0], p[1] + p[2] * slope, p[2]],
        });
        if (fine)
          tube(
            kit,
            [
              [sx + 0.17 * Math.sign(sx), yv + 0.002, zm - 0.008],
              [sx - 0.16 * Math.sign(sx), yv + 0.002, zm - 0.008],
            ],
            0.005,
            Mat.plastic,
            {along: 1, seg: 5},
          );
      }
    }
  }

  // Steering wheel and wheels.
  const dr = cfg.driver ?? {
    eye: [driverX, eyeY, eyeZ] as Vec3,
    wheel: [driverX, cfg.beltF - 0.1, zDashRear - 0.26] as Vec3,
    tilt: -0.42,
  };
  const wheels: VehicleDesign['wheels'] = [];
  for (const sx of [1, -1]) {
    wheels.push({
      position: [sx * track, cfg.wheelR, wb / 2],
      radius: cfg.wheelR,
      width: cfg.tyreW,
      steer: true,
    });
    wheels.push({
      position: [sx * track, cfg.wheelR, -wb / 2],
      radius: cfg.wheelR,
      width: cfg.tyreW,
      steer: false,
    });
    if (cfg.dualRear)
      wheels.push({
        position: [sx * (track - cfg.tyreW - 0.02), cfg.wheelR, -wb / 2],
        radius: cfg.wheelR,
        width: cfg.tyreW,
        steer: false,
      });
  }
  return {
    name: cfg.name,
    kind: cfg.kind,
    size: [cfg.width, cfg.H, cfg.L],
    body: kit.mesh,
    wheelMesh: wheelMesh(cfg.wheelR, cfg.tyreW, {
      rimRatio: cfg.rimRatio,
      spokes: cfg.spokes,
    }),
    wheels,
    rotors: [],
    steeringWheel: {
      position: dr.wheel,
      tilt: dr.tilt,
      mesh: steeringWheelMesh(dr.wheelR ?? 0.185),
    },
    driverEye: dr.eye,
    headlights: [
      [hl.x, hl.y, zf - 0.05],
      [-hl.x, hl.y, zf - 0.05],
    ],
    taillights: [
      [tl.x, tl.y, zr + 0.05],
      [-tl.x, tl.y, zr + 0.05],
    ],
    palette: cfg.palette,
  };
}

function archYAt(
  axles: {z: number; wheelR: number; archR: number}[],
  sill: number,
  z: number,
) {
  let y = -Infinity;
  for (const a of axles) {
    const dz = Math.abs(z - a.z);
    if (dz < a.archR + 0.05)
      y = Math.max(
        y,
        a.wheelR + Math.sqrt(Math.max(0, a.archR * a.archR - dz * dz)),
      );
  }
  return Number.isFinite(y) ? y : sill;
}

export {smooth};
