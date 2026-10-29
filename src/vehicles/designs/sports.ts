// Front-engine sports coupe (GR86 / Fairlady Z / RX-7 class).

import {Rng} from '../../math/random.ts';
import type {Vec3} from '../../math/vec.ts';
import type {VehicleDesign} from '../types.ts';
import {buildCar} from './car.ts';

const SPORTS_PALETTE: Vec3[] = [
  [0.4, 0.01, 0.01], // red
  [0.82, 0.82, 0.8],
  [0.02, 0.02, 0.025],
  [0.02, 0.06, 0.25], // blue
  [0.5, 0.51, 0.53],
  [0.7, 0.35, 0.01], // orange
  [0.6, 0.55, 0.05], // yellow
];

export function sports(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const L = rng.range(4.25, 4.4);
  const width = rng.range(1.78, 1.85);
  const H = rng.range(1.26, 1.31);
  const wheelbase = rng.range(2.5, 2.57);
  const fo = rng.range(0.8, 0.9);
  const zf = wheelbase / 2 + fo;
  const zr = zf - L;
  const cowl = wheelbase / 2 - rng.range(0.5, 0.6);
  return buildCar({
    name: 'sports',
    kind: 'car',
    L,
    width,
    H,
    wheelbase,
    frontOverhang: fo,
    wheelR: 0.33,
    tyreW: 0.235,
    rimRatio: 0.7,
    spokes: rng.pick([5, 6, 10]),
    sill: 0.14,
    frontDepth: 0.38,
    frontExp: 4.6,
    rearDepth: 0.3,
    rearExp: 5,
    hoodFrontY: 0.64,
    beltF: 0.86,
    beltR: 0.9,
    deckRearY: 0.9,
    bumperF: 0.13,
    bumperR: 0.17,
    ymax: 0.56,
    tuck: 0.05,
    tumble: 0.08,
    roll: 0.04,
    leanF: 0.12,
    leanR: 0.08,
    cowlZ: cowl,
    wsTopZ: cowl - 1.0,
    roofRearZ: cowl - 1.0 - rng.range(0.55, 0.7),
    rearBaseZ: zr + rng.range(0.5, 0.6),
    roofTumble: 0.24,
    roofCrown: 0.05,
    hoodCrown: 0.035,
    ghCornerBase: 0.18,
    ghCornerTop: 0.15,
    glassBulge: 0.035,
    cPillar: 'paint',
    cPillarTop: 0.08,
    bPillar: 'black',
    aPillar: 'paint',
    rearPillarWidth: 0.22,
    pillars: [-wheelbase / 2 + 0.6],
    grille: 'slim',
    headlight: {
      x: width / 2 - 0.27,
      y: 0.545,
      hx: 0.22,
      hy: 0.048,
      n: 5,
      slant: 0.55,
    },
    taillight: {
      x: width / 2 - 0.22,
      y: 0.8,
      hx: 0.2,
      hy: 0.04,
      n: 6,
      wrap: true,
      bar: rng.chance(0.5),
    },
    doors: [cowl - 0.15, -wheelbase / 2 + 0.6],
    rearSeat: false,
    spoiler: rng.chance(0.6),
    palette: SPORTS_PALETTE,
  });
}
