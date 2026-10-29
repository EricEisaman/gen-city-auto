// Tall-wagon kei car (N-Box / Tanto / Spacia class): 3.4 m x 1.48 m, boxy and tall.

import {Rng} from '../../math/random.ts';
import type {Vec3} from '../../math/vec.ts';
import type {VehicleDesign} from '../types.ts';
import {buildCar} from './car.ts';

const KEI_PALETTE: Vec3[] = [
  [0.82, 0.82, 0.8],
  [0.6, 0.55, 0.42], // beige
  [0.02, 0.02, 0.025],
  [0.5, 0.51, 0.53],
  [0.35, 0.45, 0.5], // pastel blue
  [0.55, 0.3, 0.3], // rose
  [0.78, 0.77, 0.72],
  [0.12, 0.2, 0.12], // dark green
];

export function kei(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const L = 3.395;
  const width = 1.475;
  const H = rng.range(1.72, 1.79);
  const wheelbase = rng.range(2.49, 2.52);
  const fo = rng.range(0.5, 0.56);
  const zf = wheelbase / 2 + fo;
  const zr = zf - L;
  const cowl = wheelbase / 2 - rng.range(0.0, 0.08);
  const belt = rng.range(0.98, 1.04);
  return buildCar({
    name: 'kei',
    kind: 'car',
    L,
    width,
    H,
    wheelbase,
    frontOverhang: fo,
    wheelR: 0.285,
    tyreW: 0.155,
    rimRatio: 0.6,
    sill: 0.19,
    frontDepth: 0.26,
    frontExp: 4.5,
    rearDepth: 0.12,
    rearExp: 6,
    hoodFrontY: 0.84,
    beltF: belt - 0.04,
    beltR: belt,
    deckRearY: belt,
    bumperF: 0.2,
    bumperR: 0.26,
    ymax: 0.62,
    tuck: 0.04,
    tumble: 0.025,
    roll: 0.035,
    leanF: 0.12,
    leanR: 0.03,
    cowlZ: cowl,
    wsTopZ: cowl - 0.82,
    roofRearZ: zr + 0.1,
    rearBaseZ: null,
    roofTumble: 0.07,
    roofCrown: 0.025,
    hoodCrown: 0.03,
    ghCornerBase: 0.1,
    ghCornerTop: 0.1,
    glassBulge: 0.02,
    cPillar: 'black',
    cPillarTop: 0.05,
    rearPillarWidth: 0.1,
    pillars: [-0.15, -wheelbase / 2 + 0.4],
    upperBand: 0.13,
    bPillar: 'black',
    aPillar: 'black',
    grille: rng.pick(['slim', 'chrome'] as const),
    headlight: {
      x: width / 2 - 0.21,
      y: 0.72,
      hx: 0.16,
      hy: 0.075,
      n: 4,
      slant: 0.2,
    },
    taillight: {
      x: width / 2 - 0.08,
      y: belt - 0.16,
      hx: 0.06,
      hy: 0.12,
      n: 5,
      wrap: true,
    },
    doors: [cowl - 0.08, -0.15, -wheelbase / 2 + 0.4],
    rearSeat: true,
    palette: KEI_PALETTE,
  });
}
