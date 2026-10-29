// Mid-size Japanese sedan (Camry / Accord / Mazda6 class).

import {Rng} from '../../math/random.ts';
import {Mat, type VehicleDesign} from '../types.ts';
import {buildCar} from './car.ts';
import {CITY_PALETTE} from './palettes.ts';

export function sedan(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const L = rng.range(4.6, 4.8);
  const width = rng.range(1.78, 1.85);
  const H = rng.range(1.42, 1.48);
  const wheelbase = rng.range(2.75, 2.85);
  const fo = rng.range(0.84, 0.9);
  const zf = wheelbase / 2 + fo;
  const zr = zf - L;
  const cowl = wheelbase / 2 - rng.range(0.38, 0.45);
  return buildCar({
    name: 'sedan',
    kind: 'car',
    L,
    width,
    H,
    wheelbase,
    frontOverhang: fo,
    wheelR: 0.33,
    tyreW: 0.215,
    sill: 0.19,
    frontDepth: 0.36,
    frontExp: 5,
    rearDepth: 0.3,
    rearExp: 5.5,
    hoodFrontY: 0.74,
    beltF: 0.95,
    beltR: 0.99,
    deckRearY: 0.96,
    bumperF: 0.2,
    bumperR: 0.21,
    ymax: 0.62,
    tuck: 0.04,
    tumble: 0.055,
    roll: 0.035,
    leanF: 0.14,
    leanR: 0.07,
    cowlZ: cowl,
    wsTopZ: cowl - 0.9,
    roofRearZ: cowl - 0.9 - rng.range(1.05, 1.15),
    rearBaseZ: zr + rng.range(0.78, 0.86),
    roofTumble: 0.2,
    roofCrown: 0.05,
    hoodCrown: 0.04,
    ghCornerBase: 0.16,
    ghCornerTop: 0.13,
    glassBulge: 0.03,
    cPillar: 'paint',
    cPillarTop: 0.12,
    bPillar: 'black',
    aPillar: 'paint',
    grille: rng.pick(['wide', 'chrome', 'slim'] as const),
    headlight: {
      x: width / 2 - 0.27,
      y: 0.645,
      hx: 0.22,
      hy: 0.055,
      n: 5,
      slant: 0.35,
    },
    taillight: {
      x: width / 2 - 0.22,
      y: 0.86,
      hx: 0.2,
      hy: 0.06,
      n: 6,
      wrap: true,
      bar: rng.chance(0.4),
    },
    doors: [cowl - 0.12, -0.1, -wheelbase / 2 + 0.52],
    rearSeat: true,
    palette: CITY_PALETTE,
  });
}

export {Mat};
