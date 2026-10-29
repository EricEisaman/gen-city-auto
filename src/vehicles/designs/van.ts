// One-box delivery van (HiAce / Caravan class): semi-cab-over, short sloping
// nose, sliding side door, vertical tailgate. Panel van or window van by seed.

import {Rng} from '../../math/random.ts';
import type {Vec3} from '../../math/vec.ts';
import type {VehicleDesign} from '../types.ts';
import {buildCar} from './car.ts';

const VAN_PALETTE: Vec3[] = [
  [0.82, 0.82, 0.8],
  [0.85, 0.85, 0.85],
  [0.5, 0.51, 0.53],
  [0.78, 0.77, 0.72],
  [0.015, 0.015, 0.018],
  [0.05, 0.12, 0.3],
];

export function van(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const L = 4.695;
  const width = 1.695;
  const H = rng.range(1.96, 2.0);
  const wheelbase = 2.57;
  const fo = 0.98;
  const zf = wheelbase / 2 + fo;
  const zr = zf - L;
  const cowl = zf - rng.range(0.52, 0.58);
  const belt = 1.06;
  const panelVan = rng.chance(0.6);
  return buildCar({
    name: 'van',
    kind: 'van',
    L,
    width,
    H,
    wheelbase,
    frontOverhang: fo,
    wheelR: 0.33,
    tyreW: 0.195,
    rimRatio: 0.52,
    spokes: 6,
    sill: 0.24,
    frontDepth: 0.36,
    frontExp: 5,
    rearDepth: 0.09,
    rearExp: 8,
    hoodFrontY: 0.93,
    beltF: belt - 0.03,
    beltR: belt,
    deckRearY: belt,
    bumperF: 0.3,
    bumperR: 0.33,
    ymax: 0.7,
    tuck: 0.03,
    tumble: 0.025,
    roll: 0.03,
    leanF: 0.14,
    leanR: 0.02,
    cowlZ: cowl,
    wsTopZ: cowl - 0.66,
    roofRearZ: zr + 0.06,
    rearBaseZ: null,
    roofTumble: 0.05,
    roofCrown: 0.03,
    hoodCrown: 0.03,
    ghCornerBase: 0.12,
    ghCornerTop: 0.1,
    glassBulge: 0.015,
    cPillar: 'black',
    cPillarTop: 0.05,
    rearPillarWidth: 0.2,
    hatchLower: 0.38,
    pillars: [wheelbase / 2 - 0.62, -0.55],
    upperBand: 0.1,
    bPillar: 'black',
    aPillar: 'black',
    grille: 'wide',
    headlight: {
      x: width / 2 - 0.22,
      y: 0.8,
      hx: 0.17,
      hy: 0.06,
      n: 5,
      slant: 0.3,
    },
    taillight: {
      x: width / 2 - 0.06,
      y: 0.75,
      hx: 0.05,
      hy: 0.16,
      n: 5,
      wrap: true,
    },
    doors: [cowl - 0.08, wheelbase / 2 - 0.62, -0.55],
    cargoFromZ: panelVan ? wheelbase / 2 - 0.58 : undefined,
    rearSeat: !panelVan,
    floorY: 0.64,
    dashDepth: 0.45,
    eyeBack: 0.6,
    zFire: cowl - 0.12,
    zBulk: panelVan ? wheelbase / 2 - 0.85 : -0.9,
    palette: VAN_PALETTE,
  });
}
