// Tokyo taxi in the style of the Crown Comfort: upright three-box sedan with
// fender mirrors, chrome bumpers, a two-tone livery (paint + paint2) and an
// illuminated roof sign (andon).

import type {Vec3} from '../../math/vec.ts';
import {Mat, type VehicleDesign} from '../types.ts';
import {buildCar} from './car.ts';
import {blob, projected, rect} from './kit.ts';

/** Body colour / livery pairs: palette[2k] body, palette[2k+1] second colour. */
const TAXI_PALETTE: Vec3[] = [
  [0.7, 0.5, 0.01], // yellow
  [0.02, 0.18, 0.06], // green
  [0.015, 0.015, 0.018], // black (Nihon Kotsu style)
  [0.6, 0.6, 0.6],
  [0.03, 0.2, 0.08], // green body
  [0.7, 0.55, 0.02], // yellow
  [0.65, 0.25, 0.01], // orange
  [0.8, 0.8, 0.78],
  [0.02, 0.05, 0.2], // navy
  [0.75, 0.75, 0.72],
];

export function taxi(seed: number): VehicleDesign {
  void seed;
  const L = 4.69;
  const width = 1.695;
  const H = 1.52;
  const wheelbase = 2.68;
  const fo = 0.92;
  const zf = wheelbase / 2 + fo;
  const zr = zf - L;
  const cowl = wheelbase / 2 - 0.4;
  const roofRear = cowl - 0.78 - 1.2;
  return buildCar({
    name: 'taxi',
    kind: 'taxi',
    L,
    width,
    H,
    wheelbase,
    frontOverhang: fo,
    wheelR: 0.31,
    tyreW: 0.185,
    rimRatio: 0.58,
    spokes: 8,
    sill: 0.2,
    frontDepth: 0.22,
    frontExp: 6,
    rearDepth: 0.2,
    rearExp: 6,
    hoodFrontY: 0.8,
    beltF: 0.92,
    beltR: 0.94,
    deckRearY: 0.92,
    bumperF: 0.24,
    bumperR: 0.27,
    ymax: 0.62,
    tuck: 0.04,
    tumble: 0.03,
    roll: 0.025,
    leanF: 0.05,
    leanR: 0.04,
    cowlZ: cowl,
    wsTopZ: cowl - 0.78,
    roofRearZ: roofRear,
    rearBaseZ: zr + 0.95,
    roofTumble: 0.12,
    roofCrown: 0.03,
    hoodCrown: 0.02,
    ghCornerBase: 0.1,
    ghCornerTop: 0.08,
    glassBulge: 0.015,
    roofMat: Mat.paint2,
    cPillar: 'paint',
    cPillarTop: 0.1,
    bPillar: 'black',
    aPillar: 'paint',
    rearPillarWidth: 0.2,
    pillars: [-0.12, -wheelbase / 2 + 0.5],
    grille: 'chrome',
    headlight: {
      x: width / 2 - 0.22,
      y: 0.66,
      hx: 0.15,
      hy: 0.06,
      n: 8,
      slant: 0,
    },
    taillight: {x: width / 2 - 0.14, y: 0.78, hx: 0.12, hy: 0.09, n: 8},
    fenderMirrors: true,
    doors: [cowl - 0.1, -0.12, -wheelbase / 2 + 0.5],
    rearSeat: true,
    palette: TAXI_PALETTE,
    extras: (kit, ctx) => {
      // Roof sign (andon): a lit wedge on a paint2 base near the front of the roof.
      const z = cowl - 0.78 - 0.32;
      const y = ctx.roofY(0, z);
      blob(kit, [0, y + 0.03, z], [0.3, 0.03, 0.13], Mat.paint2, {
        n: 6,
        m: 6,
        segU: 12,
        segV: 4,
      });
      blob(kit, [0, y + 0.15, z], [0.27, 0.11, 0.08], Mat.headlight, {
        n: 8,
        m: 4,
        segU: 14,
        segV: 4,
        taper: t => [0.85 + 0.15 * Math.sin(Math.PI * t), 1],
      });
      blob(kit, [0, y + 0.265, z], [0.24, 0.015, 0.05], Mat.paint2, {
        n: 6,
        segU: 10,
        segV: 3,
      });
      // Continuous livery stripe in the second colour along the belt, nose to tail.
      const sh = ctx.wall.sheet;
      const yS = 0.76;
      kit.decal(
        sh,
        projected(
          sh,
          [2, 1],
          rect(ctx.zr + 0.25, ctx.zf - 0.25, yS - 0.03, yS + 0.03),
          p => p[0],
        ),
        Mat.paint2,
        {ns: 16, nt: 2, offset: 0.004, mirror: true, segS: 24, segT: 1},
      );
      // Vacancy display (空車) on the passenger side of the dash, behind the windshield.
      blob(
        kit,
        [-width * 0.25, ctx.edgeY(cowl) + 0.06, cowl - 0.3],
        [0.09, 0.035, 0.02],
        Mat.screen,
        {n: 8, m: 8, segU: 8, segV: 3},
      );
    },
  });
}
