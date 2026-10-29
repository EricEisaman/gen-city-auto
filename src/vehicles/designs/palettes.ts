// Body colour palettes (linear RGB) reflecting Tokyo traffic: mostly white,
// pearl, silver and black, some dark blue, grey and red.

import type {Vec3} from '../../math/vec.ts';

export const CITY_PALETTE: Vec3[] = [
  [0.82, 0.82, 0.8], // white
  [0.78, 0.77, 0.72], // pearl white
  [0.5, 0.51, 0.53], // silver
  [0.015, 0.015, 0.018], // black
  [0.2, 0.21, 0.22], // gunmetal grey
  [0.02, 0.04, 0.12], // dark blue
  [0.35, 0.02, 0.02], // red
  [0.85, 0.85, 0.85], // white
  [0.6, 0.6, 0.62], // silver
  [0.04, 0.05, 0.06], // dark grey
];
