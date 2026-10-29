// Pedestrian figure built from NURBS (revolved and lofted parts). Rendered by
// the vehicle renderer: paint = top clothes, paint2 = trousers/skirt.

import {Rng} from '../math/random.ts';
import type {Vec3} from '../math/vec.ts';
import {emptyMesh, tessellate} from '../nurbs/mesh.ts';
import {makeCurve, revolve, transformSurface} from '../nurbs/nurbs.ts';
import {Mat, type VehicleDesign} from './types.ts';

/** Extra material id (vehicle shader case 15) for skin. */
const SKIN = 15;
const CLOTH = 16;
const CLOTH2 = 17;

export function person(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const h = rng.range(1.55, 1.85);
  const s = h / 1.75;
  const m = emptyMesh();
  const rev = (pts: [number, number][], mat: number, center: Vec3, squash = 1, seg = 10) => {
    const prof = makeCurve(pts.map(([r, y]) => [r, y, 0] as Vec3), 2);
    const surf = transformSurface(revolve(prof, [0, 0, 0], [0, 1, 0]), p => [center[0] + p[0], center[1] + p[1], center[2] + p[2] * squash]);
    tessellate(m, surf, mat, {segU: 6, segV: seg});
  };
  // Torso (top clothes) with shoulders, revolved and flattened front-to-back.
  rev([[0.0, 0.0], [0.13, 0.02], [0.14, 0.25], [0.17, 0.5], [0.08, 0.6], [0.0, 0.62]], CLOTH, [0, 0.85 * s, 0], 0.6);
  // Legs (trousers).
  for (const side of [-1, 1]) {
    rev([[0.0, 0.0], [0.065, 0.02], [0.075, 0.45], [0.09, 0.86], [0.0, 0.9]], CLOTH2, [side * 0.09 * s, 0, 0], 1, 8);
    // Shoes.
    rev([[0.0, 0.0], [0.06, 0.0], [0.06, 0.06], [0.0, 0.08]], Mat.rubber, [side * 0.09 * s, 0, 0.03], 1.6, 6);
    // Arms.
    rev([[0.0, 0.0], [0.045, 0.03], [0.05, 0.55], [0.0, 0.6]], CLOTH, [side * 0.24 * s, 0.82 * s, 0], 1, 6);
  }
  // Head and hair.
  rev([[0.0, 0.0], [0.055, 0.02], [0.1, 0.12], [0.085, 0.22], [0.0, 0.25]], SKIN, [0, 1.48 * s, 0], 1, 10);
  rev([[0.0, 0.12], [0.105, 0.14], [0.09, 0.24], [0.0, 0.27]], Mat.rubber, [0, 1.48 * s, -0.01], 1.05, 10);
  const tops: Vec3[] = [
    [0.05, 0.05, 0.06],
    [0.8, 0.8, 0.78],
    [0.25, 0.28, 0.35],
    [0.45, 0.12, 0.1],
    [0.55, 0.5, 0.42],
    [0.12, 0.2, 0.32],
  ];
  return {
    name: 'person',
    kind: 'person' as VehicleDesign['kind'],
    size: [0.5, h, 0.3],
    body: m,
    wheels: [],
    rotors: [],
    driverEye: [0, h - 0.1, 0.1],
    headlights: [],
    taillights: [],
    palette: tops,
  };
}
