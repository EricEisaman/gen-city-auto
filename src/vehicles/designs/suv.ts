// Mid-size crossover SUV (RAV4 / Harrier / CX-5 class).

import {Rng} from '../../math/random.ts';
import type {VehicleDesign} from '../types.ts';
import {buildCar} from './car.ts';
import {CITY_PALETTE} from './palettes.ts';

export function suv(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const L = rng.range(4.55, 4.75);
  const width = rng.range(1.84, 1.88);
  const H = rng.range(1.66, 1.72);
  const wheelbase = rng.range(2.66, 2.72);
  const fo = rng.range(0.9, 0.98);
  const zf = wheelbase / 2 + fo;
  const zr = zf - L;
  const cowl = wheelbase / 2 - rng.range(0.32, 0.4);
  const belt = rng.range(1.1, 1.14);
  return buildCar({
    name: 'suv',
    kind: 'car',
    L,
    width,
    H,
    wheelbase,
    frontOverhang: fo,
    wheelR: 0.365,
    tyreW: 0.225,
    rimRatio: 0.63,
    spokes: rng.pick([5, 6]),
    sill: 0.24,
    frontDepth: 0.38,
    frontExp: 4,
    rearDepth: 0.24,
    rearExp: 4.5,
    hoodFrontY: 0.92,
    beltF: belt,
    beltR: belt + 0.05,
    deckRearY: belt + 0.05,
    bumperF: 0.32,
    bumperR: 0.38,
    ymax: 0.72,
    tuck: 0.06,
    tumble: 0.05,
    roll: 0.04,
    leanF: 0.13,
    leanR: 0.06,
    cowlZ: cowl,
    wsTopZ: cowl - 0.85,
    roofRearZ: zr + rng.range(0.3, 0.38),
    rearBaseZ: null,
    roofTumble: 0.15,
    roofCrown: 0.035,
    hoodCrown: 0.04,
    ghCornerBase: 0.16,
    ghCornerTop: 0.14,
    glassBulge: 0.03,
    cPillar: 'paint',
    cPillarTop: 0.2,
    rearPillarWidth: 0.18,
    pillars: [-0.12, -wheelbase / 2 + 0.48],
    upperBand: 0.04,
    bPillar: 'black',
    aPillar: 'black',
    grille: rng.pick(['tall', 'chrome'] as const),
    headlight: {
      x: width / 2 - 0.27,
      y: 0.82,
      hx: 0.21,
      hy: 0.055,
      n: 5,
      slant: 0.35,
    },
    taillight: {
      x: width / 2 - 0.14,
      y: belt - 0.04,
      hx: 0.13,
      hy: 0.06,
      n: 6,
      wrap: true,
      bar: rng.chance(0.3),
    },
    doors: [cowl - 0.1, -0.12, -wheelbase / 2 + 0.48],
    archFlare: true,
    roofRails: rng.chance(0.7),
    rearSeat: true,
    palette: CITY_PALETTE,
  });
}
