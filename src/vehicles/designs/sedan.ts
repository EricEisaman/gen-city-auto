// Example design: a mid-size sedan lofted from cross sections. Serves as the
// reference for how designs use the NURBS API.

import {Rng} from '../../math/random.ts';
import type {Vec3} from '../../math/vec.ts';
import {addBox, emptyMesh, tessellate} from '../../nurbs/mesh.ts';
import {circle, loftPoints, mirrorX, revolve, type NurbsSurface} from '../../nurbs/nurbs.ts';
import {wheelMesh} from '../parts.ts';
import {Mat, type VehicleDesign} from '../types.ts';

export function sedan(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const L = rng.range(4.5, 4.9);
  const W = rng.range(1.78, 1.86) / 2;
  const H = rng.range(1.42, 1.5);
  const wheelR = 0.33;
  const wheelbase = L * 0.6;
  const belt = 0.95;
  const body = emptyMesh();

  // Profile height of the lower body along the length (t = 0 rear, 1 front).
  const deck = (t: number) => {
    if (t < 0.12) return 0.78 + t * 1.2; // rear bumper up to trunk lid
    if (t > 0.82) return belt - (t - 0.82) * 1.2; // hood slopes to nose
    return belt;
  };
  const stations = 11;
  const rows: Vec3[][] = [];
  for (let k = 0; k < stations; k++) {
    const t = k / (stations - 1);
    const z = (t - 0.5) * L;
    const end = Math.min(t, 1 - t);
    const taper = Math.min(1, 0.55 + end * 5);
    const w = W * taper;
    const top = deck(t);
    const bottom = 0.18 + (end < 0.08 ? (0.08 - end) * 2 : 0);
    rows.push([
      [0, bottom, z],
      [w * 0.85, bottom, z],
      [w, bottom + 0.15, z],
      [w * 1.0, (bottom + top) * 0.55, z],
      [w * 0.97, top - 0.04, z],
      [w * 0.75, top, z],
      [0, top + 0.02, z],
    ]);
  }
  const lower = loftPoints(rows);
  const addMirrored = (s: NurbsSurface, mat: number, opts = {}) => {
    tessellate(body, s, mat, opts);
    tessellate(body, mirrorX(s), mat, opts);
  };
  addMirrored(lower, Mat.paint);

  // Greenhouse: glass band from the belt line up to the roof edge, and the roof.
  const gStations = 7;
  const glassRows: Vec3[][] = [];
  const roofRows: Vec3[][] = [];
  const g0 = 0.2;
  const g1 = 0.78;
  for (let k = 0; k < gStations; k++) {
    const t = k / (gStations - 1);
    const zt = g0 + (g1 - g0) * t;
    const z = (zt - 0.5) * L;
    // Roof height rises quickly over the windshield and falls over the rear glass.
    const rise = Math.sin(Math.PI * Math.pow(t, 0.85));
    const roof = belt + (H - belt) * Math.min(1, rise * 1.35);
    const wBelt = W * 0.93;
    const wRoof = W * (0.72 + 0.06 * rise);
    glassRows.push([
      [wBelt, belt, z],
      [(wBelt + wRoof) / 2 + 0.02, (belt + roof) / 2, z],
      [wRoof, roof - 0.01, z],
    ]);
    roofRows.push([
      [wRoof, roof - 0.01, z],
      [wRoof * 0.6, roof + 0.015, z],
      [0, roof + 0.02, z],
    ]);
  }
  addMirrored(loftPoints(glassRows, {degreeU: 2}), Mat.glass);
  addMirrored(loftPoints(roofRows, {degreeU: 2}), Mat.paint);

  // Lights, grille, bumpers as small boxes.
  for (const s of [1, -1]) {
    addBox(body, [s * W * 0.68, 0.72, L / 2 - 0.12], [0.16, 0.05, 0.08], Mat.headlight);
    addBox(body, [s * W * 0.7, 0.86, -L / 2 + 0.16], [0.16, 0.05, 0.06], Mat.taillight);
    addBox(body, [s * (W + 0.02), 0.95, L * 0.18], [0.05, 0.05, 0.1], Mat.plastic); // mirror
  }
  addBox(body, [0, 0.5, L / 2 - 0.05], [W * 0.5, 0.08, 0.06], Mat.plastic);

  // Interior: seats, dash, floor.
  for (const s of [1, -1]) {
    addBox(body, [s * W * 0.45, 0.55, 0.0], [0.25, 0.08, 0.25], Mat.seat);
    addBox(body, [s * W * 0.45, 0.85, -0.25], [0.24, 0.3, 0.06], Mat.seat);
    addBox(body, [s * W * 0.45, 0.55, -0.9], [0.25, 0.08, 0.25], Mat.seat);
  }
  addBox(body, [0, 0.9, 0.85], [W * 0.92, 0.1, 0.18], Mat.dash);
  addBox(body, [0, 0.3, 0], [W * 0.95, 0.02, L * 0.3], Mat.interior);

  // Steering wheel: a revolved circle (torus).
  const steer = emptyMesh();
  const ring = circle([0.17, 0, 0], [1, 0, 0], [0, 0, 1], 0.018);
  tessellate(steer, revolve(ring, [0, 0, 0], [0, 0, 1]), Mat.plastic, {segU: 8, segV: 24});

  const ax = wheelbase / 2;
  const wx = W - 0.08;
  return {
    name: 'sedan',
    kind: 'car',
    size: [W * 2, H, L],
    body,
    wheelMesh: wheelMesh(wheelR, 0.22),
    wheels: [
      {position: [wx, wheelR, ax], radius: wheelR, width: 0.22, steer: true},
      {position: [-wx, wheelR, ax], radius: wheelR, width: 0.22, steer: true},
      {position: [wx, wheelR, -ax], radius: wheelR, width: 0.22, steer: false},
      {position: [-wx, wheelR, -ax], radius: wheelR, width: 0.22, steer: false},
    ],
    rotors: [],
    steeringWheel: {position: [-W * 0.45, 0.95, 0.55], tilt: 0.4, mesh: steer},
    driverEye: [-W * 0.45, 1.2, -0.05],
    headlights: [
      [W * 0.68, 0.72, L / 2],
      [-W * 0.68, 0.72, L / 2],
    ],
    taillights: [
      [W * 0.7, 0.86, -L / 2],
      [-W * 0.7, 0.86, -L / 2],
    ],
    palette: [
      [0.7, 0.7, 0.72],
      [0.02, 0.02, 0.025],
      [0.85, 0.85, 0.85],
      [0.25, 0.02, 0.02],
      [0.05, 0.1, 0.25],
      [0.35, 0.36, 0.38],
    ],
  };
}
