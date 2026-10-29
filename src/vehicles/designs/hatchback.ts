// Compact hatchback (Fit / Yaris / Note class).

import {Rng} from '../../math/random.ts';
import type {VehicleDesign} from '../types.ts';
import {buildCar} from './car.ts';
import {CITY_PALETTE} from './palettes.ts';

export function hatchback(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const L = rng.range(3.9, 4.0);
  const width = rng.range(1.69, 1.75);
  const H = rng.range(1.5, 1.55);
  const wheelbase = rng.range(2.5, 2.58);
  const fo = rng.range(0.82, 0.9);
  const zf = wheelbase / 2 + fo;
  const zr = zf - L;
  const cowl = wheelbase / 2 - rng.range(0.22, 0.3);
  const belt = rng.range(0.96, 1.0);
  return buildCar({
    name: 'hatchback',
    kind: 'car',
    L,
    width,
    H,
    wheelbase,
    frontOverhang: fo,
    wheelR: 0.31,
    tyreW: 0.185,
    sill: 0.2,
    frontDepth: 0.36,
    frontExp: 5,
    rearDepth: 0.22,
    rearExp: 5.5,
    hoodFrontY: 0.74,
    beltF: belt,
    beltR: belt + 0.06,
    deckRearY: belt + 0.06,
    bumperF: 0.21,
    bumperR: 0.24,
    ymax: 0.6,
    tuck: 0.035,
    tumble: 0.05,
    roll: 0.035,
    leanF: 0.14,
    leanR: 0.05,
    cowlZ: cowl,
    wsTopZ: cowl - 0.92,
    roofRearZ: zr + rng.range(0.55, 0.62),
    rearBaseZ: null,
    roofTumble: 0.17,
    roofCrown: 0.04,
    hoodCrown: 0.04,
    ghCornerBase: 0.15,
    ghCornerTop: 0.14,
    glassBulge: 0.03,
    cPillar: 'paint',
    cPillarTop: 0.18,
    rearPillarWidth: 0.12,
    hatchLower: 0.28,
    pillars: [-0.2],
    bPillar: 'black',
    aPillar: 'paint',
    grille: rng.pick(['slim', 'wide'] as const),
    headlight: {
      x: width / 2 - 0.26,
      y: 0.63,
      hx: 0.2,
      hy: 0.055,
      n: 5,
      slant: 0.45,
    },
    taillight: {
      x: width / 2 - 0.12,
      y: belt - 0.05,
      hx: 0.11,
      hy: 0.09,
      n: 5,
      wrap: true,
    },
    doors: [cowl - 0.1, -0.2, -wheelbase / 2 + 0.45],
    rearSeat: true,
    spoiler: rng.chance(0.5),
    palette: CITY_PALETTE,
  });
}
