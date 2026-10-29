// Pedestrian figure built from NURBS (revolved parts). Rendered by the vehicle
// renderer: material 16 = top clothes (instance color), 17 = trousers
// (instance color 2), 15 = skin. Legs and arms are separate "rotor" parts that
// swing about their hip/shoulder pivots (see VehicleRenderer.add).

import {Rng} from '../math/random.ts';
import type {Vec3} from '../math/vec.ts';
import {emptyMesh, tessellate, type Mesh} from '../nurbs/mesh.ts';
import {makeCurve, revolve, transformSurface} from '../nurbs/nurbs.ts';
import {Mat, type Rotor, type VehicleDesign} from './types.ts';

const SKIN = 15;
const CLOTH = 16;
const CLOTH2 = 17;

function rev(
  m: Mesh,
  pts: [number, number][],
  mat: number,
  center: Vec3,
  squash = 1,
  seg = 10,
) {
  const prof = makeCurve(
    pts.map(([r, y]) => [r, y, 0] as Vec3),
    2,
  );
  const surf = transformSurface(revolve(prof, [0, 0, 0], [0, 1, 0]), p => [
    center[0] + p[0],
    center[1] + p[1],
    center[2] + p[2] * squash,
  ]);
  tessellate(m, surf, mat, {segU: 6, segV: seg});
}

export function person(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const h = rng.range(1.55, 1.85);
  const s = h / 1.75;
  const body = emptyMesh();
  const hip = 0.9 * s;
  const shoulder = 1.42 * s;
  // Torso, flattened front-to-back.
  rev(
    body,
    [
      [0.0, 0.0],
      [0.13, 0.02],
      [0.14, 0.25],
      [0.17, 0.5],
      [0.08, 0.6],
      [0.0, 0.62],
    ],
    CLOTH,
    [0, 0.85 * s, 0],
    0.6,
  );
  // Neck, head and hair.
  rev(
    body,
    [
      [0.0, 0.0],
      [0.045, 0.0],
      [0.045, 0.08],
      [0.0, 0.1],
    ],
    SKIN,
    [0, 1.44 * s, 0],
    1,
    8,
  );
  rev(
    body,
    [
      [0.0, 0.0],
      [0.055, 0.02],
      [0.1, 0.12],
      [0.085, 0.22],
      [0.0, 0.25],
    ],
    SKIN,
    [0, 1.5 * s, 0],
    1,
    10,
  );
  rev(
    body,
    [
      [0.0, 0.12],
      [0.105, 0.14],
      [0.09, 0.24],
      [0.0, 0.27],
    ],
    Mat.rubber,
    [0, 1.5 * s, -0.01],
    1.05,
    10,
  );
  const rotors: Rotor[] = [];
  // Legs (pivot at the hip), modeled hanging down from the origin.
  for (const side of [-1, 1]) {
    const leg = emptyMesh();
    rev(
      leg,
      [
        [0.0, -hip],
        [0.065, -hip + 0.02],
        [0.075, -hip + 0.45 * s],
        [0.09, -0.04],
        [0.0, 0.0],
      ],
      CLOTH2,
      [0, 0, 0],
      1,
      8,
    );
    rev(
      leg,
      [
        [0.0, 0.0],
        [0.06, 0.0],
        [0.06, 0.06],
        [0.0, 0.08],
      ],
      Mat.rubber,
      [0, -hip, 0.03],
      1.6,
      6,
    );
    rotors.push({
      position: [side * 0.09 * s, hip, 0],
      axis: [1, 0, 0],
      mesh: leg,
    });
  }
  // Arms (pivot at the shoulder).
  for (const side of [-1, 1]) {
    const arm = emptyMesh();
    rev(
      arm,
      [
        [0.0, -0.6 * s],
        [0.045, -0.57 * s],
        [0.05, -0.05],
        [0.0, 0.0],
      ],
      CLOTH,
      [0, 0, 0],
      1,
      6,
    );
    rev(
      arm,
      [
        [0.0, -0.1],
        [0.035, -0.08],
        [0.03, 0.0],
        [0.0, 0.01],
      ],
      SKIN,
      [0, -0.6 * s, 0],
      1,
      6,
    );
    rotors.push({
      position: [side * 0.21 * s, shoulder, 0],
      axis: [1, 0, 0],
      mesh: arm,
    });
  }
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
    kind: 'person',
    size: [0.5, h, 0.3],
    body,
    wheels: [],
    rotors,
    driverEye: [0, h - 0.1, 0.1],
    headlights: [],
    taillights: [],
    palette: tops,
  };
}
