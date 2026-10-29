// Pedestrian figure built from NURBS (revolved parts). Rendered by the vehicle
// renderer: material 16 = top clothes (instance color), 17 = trousers
// (instance color 2), 15 = skin. Legs and arms are separate "rotor" parts that
// swing about their hip/shoulder pivots (see VehicleRenderer.add).

import {Rng} from '../math/random.ts';
import type {Vec3} from '../math/vec.ts';
import {emptyMesh, tessellate, type Mesh} from '../nurbs/mesh.ts';
import {loftPoints} from '../nurbs/nurbs.ts';
import {Mat, type Rotor, type VehicleDesign} from './types.ts';

const SKIN = 15;
const CLOTH = 16;
const CLOTH2 = 17;

/** Lofted body part from elliptical sections: [y, rx, rz, zOffset]. */
function ellLoft(
  m: Mesh,
  secs: [number, number, number, number][],
  mat: number,
  cx = 0,
) {
  const rows: Vec3[][] = secs.map(([y, rx, rz, oz]) => {
    const pts: Vec3[] = [];
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * rx, y, oz + Math.sin(a) * rz]);
    }
    return pts;
  });
  tessellate(m, loftPoints(rows, {degreeU: 3, degreeV: 2}), mat, {
    segU: 12,
    segV: Math.max(4, secs.length * 2),
    flip: true,
  });
}

export function person(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const female = rng.chance(0.5);
  const h = female ? rng.range(1.52, 1.68) : rng.range(1.63, 1.82);
  const s = h / 1.75;
  const body = emptyMesh();
  const hip = 0.9 * s;
  const shoulder = 1.42 * s;
  const sw = (female ? 0.17 : 0.2) * s;
  const coat = rng.chance(0.35);
  // Torso: hips, waist, chest, shoulders, lofted from ellipses.
  ellLoft(
    body,
    [
      [hip - 0.05, 0.15 * s, 0.1 * s, 0],
      [hip + 0.12 * s, (female ? 0.13 : 0.14) * s, 0.09 * s, 0],
      [hip + 0.32 * s, sw * 0.85, 0.11 * s, 0.01],
      [shoulder - 0.06, sw, 0.1 * s, 0],
      [shoulder + 0.02, sw * 0.55, 0.07 * s, 0],
      [shoulder + 0.05, 0.03, 0.03, 0],
    ],
    CLOTH,
  );
  if (coat) {
    // Long coat skirt below the hips.
    ellLoft(
      body,
      [
        [hip - 0.32 * s, 0.17 * s, 0.13 * s, 0],
        [hip - 0.05, 0.16 * s, 0.11 * s, 0],
      ],
      CLOTH,
    );
  } else if (female && rng.chance(0.5)) {
    ellLoft(
      body,
      [
        [hip - 0.38 * s, 0.2 * s, 0.15 * s, 0],
        [hip - 0.02, 0.15 * s, 0.1 * s, 0],
      ],
      CLOTH2,
    );
  }
  // Neck and head.
  ellLoft(
    body,
    [
      [shoulder, 0.045, 0.045, 0],
      [shoulder + 0.09, 0.042, 0.045, 0],
    ],
    SKIN,
  );
  const hy = shoulder + 0.07;
  ellLoft(
    body,
    [
      [hy, 0.01, 0.01, 0.01],
      [hy + 0.04, 0.065, 0.075, 0.015],
      [hy + 0.12, 0.08, 0.095, 0.01],
      [hy + 0.2, 0.075, 0.09, 0],
      [hy + 0.25, 0.02, 0.02, 0],
    ],
    SKIN,
  );
  // Hair: a cap, longer at the back for some.
  const long = female ? rng.chance(0.7) : rng.chance(0.1);
  ellLoft(
    body,
    [
      [
        hy + (long ? 0.02 : 0.11),
        0.085,
        long ? 0.07 : 0.1,
        long ? -0.035 : -0.012,
      ],
      [hy + 0.16, 0.088, 0.1, -0.005],
      [hy + 0.255, 0.03, 0.03, 0],
    ],
    Mat.rubber,
  );
  // Shoulder bag for some.
  if (rng.chance(0.35)) {
    ellLoft(
      body,
      [
        [hip, 0.03, 0.12, 0],
        [hip + 0.22, 0.03, 0.12, 0],
      ],
      Mat.plastic,
      -sw - 0.03,
    );
  }
  const rotors: Rotor[] = [];
  // Legs (pivot at the hip), modeled hanging down from the origin.
  for (const side of [-1, 1]) {
    const leg = emptyMesh();
    ellLoft(
      leg,
      [
        [-hip + 0.08, 0.045, 0.05, 0],
        [-hip * 0.5, 0.055, 0.06, 0],
        [-0.05, 0.075, 0.08, 0],
        [0.02, 0.06, 0.06, 0],
      ],
      CLOTH2,
    );
    ellLoft(
      leg,
      [
        [-hip, 0.04, 0.05, 0.04],
        [-hip + 0.04, 0.045, 0.11, 0.05],
        [-hip + 0.09, 0.035, 0.05, 0.0],
      ],
      Mat.rubber,
    );
    rotors.push({
      position: [side * 0.085 * s, hip, 0],
      axis: [1, 0, 0],
      mesh: leg,
    });
  }
  // Arms with hands (pivot at the shoulder).
  for (const side of [-1, 1]) {
    const arm = emptyMesh();
    ellLoft(
      arm,
      [
        [-0.58 * s, 0.035, 0.035, 0],
        [-0.3 * s, 0.042, 0.042, 0],
        [-0.02, 0.052, 0.05, 0],
        [0.03, 0.03, 0.03, 0],
      ],
      CLOTH,
    );
    ellLoft(
      arm,
      [
        [-0.72 * s, 0.015, 0.02, 0],
        [-0.66 * s, 0.03, 0.045, 0],
        [-0.58 * s, 0.028, 0.035, 0],
      ],
      SKIN,
    );
    rotors.push({
      position: [side * (sw + 0.03), shoulder - 0.03, 0],
      axis: [1, 0, 0],
      mesh: arm,
    });
  }
  const tops: Vec3[] = [
    [0.02, 0.02, 0.025],
    [0.05, 0.06, 0.09],
    [0.18, 0.18, 0.17],
    [0.5, 0.48, 0.44],
    [0.35, 0.28, 0.2],
    [0.62, 0.62, 0.6],
    [0.08, 0.12, 0.2],
    [0.3, 0.06, 0.05],
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
