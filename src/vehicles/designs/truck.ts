// Cab-over light box truck (Elf / Canter / Dutro 2-ton class): flat-fronted
// tilt cab, ladder frame, dual rear wheels and an aluminium van body.

import {Rng} from '../../math/random.ts';
import type {Vec3} from '../../math/vec.ts';
import {Mat, type VehicleDesign} from '../types.ts';
import {buildCar} from './car.ts';
import {blob, panel, tube, type Kit} from './kit.ts';
import {makeCurve, revolve} from '../../nurbs/nurbs.ts';

/** palette[0] cab colour, palette[1] box colour. */
const TRUCK_PALETTE: Vec3[] = [
  [0.82, 0.82, 0.8],
  [0.72, 0.73, 0.74],
  [0.05, 0.12, 0.35],
  [0.5, 0.51, 0.53],
  [0.25, 0.4, 0.15],
  [0.85, 0.85, 0.85],
  [0.4, 0.03, 0.03],
];

/** Box with slightly rounded vertical and roof edges; every face outward. */
function cargoBox(
  kit: Kit,
  x: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  mat: number,
) {
  const r = 0.03;
  panel(
    kit,
    [x, y0, z0 + r],
    [x, y0, z1 - r],
    [x, y1 - r, z0 + r],
    [x, y1 - r, z1 - r],
    mat,
    {mirror: true, flip: true},
  );
  panel(
    kit,
    [x - r, y1, z0],
    [-x + r, y1, z0],
    [x - r, y1, z1],
    [-x + r, y1, z1],
    mat,
  );
  panel(
    kit,
    [x - r, y0, z1],
    [-x + r, y0, z1],
    [x - r, y1, z1],
    [-x + r, y1, z1],
    mat,
    {flip: true},
  );
  panel(
    kit,
    [x - r, y0, z0],
    [-x + r, y0, z0],
    [x - r, y1, z0],
    [-x + r, y1, z0],
    mat,
  );
  panel(
    kit,
    [x - r, y0, z0 + r],
    [-x + r, y0, z0 + r],
    [x - r, y0, z1 - r],
    [-x + r, y0, z1 - r],
    Mat.metal,
    {flip: true},
  );
  // Rounded vertical corners (front: start at +z, rear: start at +x) and roof edges.
  const front = revolve(
    makeCurve(
      [
        [x - r, y0, z1],
        [x - r, y1, z1],
      ],
      1,
    ),
    [x - r, 0, z1 - r],
    [0, 1, 0],
    Math.PI / 2,
  );
  const rear = revolve(
    makeCurve(
      [
        [x, y0, z0 + r],
        [x, y1, z0 + r],
      ],
      1,
    ),
    [x - r, 0, z0 + r],
    [0, 1, 0],
    Math.PI / 2,
  );
  const edge = revolve(
    makeCurve(
      [
        [x, y1 - r, z0 + r],
        [x, y1 - r, z1 - r],
      ],
      1,
    ),
    [x - r, y1 - r, 0],
    [0, 0, 1],
    Math.PI / 2,
  );
  for (const S of [front, rear, edge])
    kit.surf(S, mat, {segU: 1, segV: 4, mirror: true, flip: true});
  // Rear door frame, hinges and lock bars.
  const zr = z0 - 0.004;
  for (const xx of [x - 0.03, 0.006])
    panel(
      kit,
      [xx, y0 + 0.03, zr],
      [xx - 0.012, y0 + 0.03, zr],
      [xx, y1 - 0.03, zr],
      [xx - 0.012, y1 - 0.03, zr],
      Mat.rubber,
      {mirror: true},
    );
  for (const yy of [y0 + 0.3, (y0 + y1) / 2, y1 - 0.3])
    blob(kit, [x - 0.06, yy, zr], [0.035, 0.02, 0.012], Mat.chrome, {
      mirror: true,
      segU: 8,
      segV: 2,
    });
  for (const xx of [0.25, 0.6])
    tube(
      kit,
      [
        [xx * x, y0 + 0.1, zr - 0.02],
        [xx * x, y1 - 0.1, zr - 0.02],
      ],
      0.012,
      Mat.chrome,
      {mirror: true, along: 1, seg: 5},
    );
}

export function truck(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const width = 1.695;
  const wheelbase = rng.range(3.3, 3.45);
  const fo = 1.05;
  const zf = wheelbase / 2 + fo;
  const cabL = 1.9;
  const zrCab = zf - cabL;
  const boxL = rng.range(4.1, 4.4);
  const boxFront = zrCab - 0.1;
  const boxRear = boxFront - boxL;
  const boxTop = rng.range(2.6, 2.75);
  const boxW = 0.92;
  const boxFloor = 0.95;
  const cowl = zf - 0.1;
  const H = 2.05;
  const L = zf - boxRear;
  const design = buildCar({
    name: 'truck',
    kind: 'truck',
    L: cabL,
    width,
    H,
    wheelbase,
    frontOverhang: fo,
    wheelR: 0.36,
    tyreW: 0.2,
    rimRatio: 0.5,
    spokes: 6,
    sill: 0.62,
    frontDepth: 0.14,
    frontExp: 6,
    rearDepth: 0.05,
    rearExp: 10,
    hoodFrontY: 1.36,
    beltF: 1.42,
    beltR: 1.45,
    deckRearY: 1.45,
    bumperF: 0.56,
    bumperR: 0.6,
    ymax: 1.0,
    tuck: 0.03,
    tumble: 0.02,
    roll: 0.03,
    leanF: 0.05,
    leanR: 0.01,
    cowlZ: cowl,
    wsTopZ: cowl - 0.22,
    roofRearZ: zrCab + 0.05,
    rearBaseZ: null,
    roofTumble: 0.05,
    roofCrown: 0.03,
    hoodCrown: 0.01,
    ghCornerBase: 0.09,
    ghCornerTop: 0.08,
    glassBulge: 0.01,
    cPillar: 'paint',
    cPillarTop: 0.05,
    rearPillarWidth: 0.1,
    pillars: [],
    bPillar: 'paint',
    aPillar: 'black',
    grille: 'wide',
    headlight: {x: width / 2 - 0.2, y: 0.8, hx: 0.15, hy: 0.07, n: 6, slant: 0},
    taillight: {x: width / 2 - 0.1, y: 0.9, hx: 0.05, hy: 0.05, n: 4},
    doors: [cowl - 0.1, zrCab + 0.32],
    cargoFromZ: zrCab + 0.3,
    rearSeat: false,
    floorY: 1.02,
    dashDepth: 0.32,
    eyeBack: 0.66,
    zFire: cowl - 0.1,
    zBulk: zrCab + 0.12,
    dualRear: true,
    wallSegU: 7,
    palette: TRUCK_PALETTE,
    extras: (kit, ctx) => {
      // Ladder frame, cross members, fuel tank, battery box.
      const fx = 0.42;
      blob(
        kit,
        [fx, 0.72, (zf - 0.3 + boxRear) / 2],
        [0.04, 0.09, (zf - 0.3 - boxRear) / 2],
        Mat.metal,
        {n: 12, m: 16, mirror: true, segU: 6, segV: 4},
      );
      for (let z = zrCab; z > boxRear; z -= 0.9)
        blob(kit, [0, 0.72, z], [fx, 0.05, 0.04], Mat.metal, {
          n: 10,
          m: 10,
          segU: 6,
          segV: 2,
        });
      blob(kit, [0.65, 0.62, -0.1], [0.18, 0.18, 0.35], Mat.metal, {
        n: 8,
        m: 10,
        segU: 10,
        segV: 4,
      });
      blob(kit, [-0.65, 0.62, 0.3], [0.15, 0.14, 0.2], Mat.plastic, {
        n: 10,
        m: 10,
        segU: 8,
        segV: 3,
      });
      // Box sub-frame and body.
      blob(
        kit,
        [fx, boxFloor - 0.07, (boxFront + boxRear) / 2],
        [0.05, 0.06, boxL / 2],
        Mat.metal,
        {n: 12, m: 16, mirror: true, segU: 6, segV: 3},
      );
      cargoBox(kit, boxW, boxFloor, boxTop, boxRear, boxFront, Mat.paint2);
      // Side marker lamps along the box bottom and top.
      for (let i = 0; i < 3; i++) {
        const z = boxFront - 0.4 - i * ((boxL - 0.8) / 2);
        blob(
          kit,
          [boxW + 0.008, boxFloor + 0.08, z],
          [0.01, 0.025, 0.04],
          Mat.indicator,
          {mirror: true, segU: 6, segV: 3},
        );
      }
      for (const z of [boxFront - 0.05, boxRear + 0.05])
        blob(
          kit,
          [boxW - 0.1, boxTop + 0.02, z],
          [0.06, 0.02, 0.03],
          z > boxRear + 1 ? Mat.indicator : Mat.taillight,
          {mirror: true, segU: 6, segV: 3},
        );
      // Rear wheel mudguards (half rings over the dual wheels) and side guard rails.
      const rz = -wheelbase / 2;
      const R = 0.46;
      const prof = makeCurve(
        [
          [ctx.track + 0.12, 0.36, rz - R],
          [ctx.track - 0.36, 0.36, rz - R],
        ],
        1,
      );
      kit.surf(revolve(prof, [0, 0.36, rz], [1, 0, 0], Math.PI), Mat.plastic, {
        segU: 1,
        segV: 12,
        mirror: true,
        doubleSided: true,
      });
      for (const y of [0.55, 0.8])
        tube(
          kit,
          [
            [boxW - 0.02, y, zrCab - 0.2],
            [boxW - 0.02, y, rz + 0.55],
          ],
          0.018,
          Mat.metal,
          {mirror: true, along: 1, seg: 5},
        );
      // Rear bumper bar with lamps and plate.
      blob(
        kit,
        [0, 0.62, boxRear + 0.05],
        [boxW - 0.05, 0.05, 0.04],
        Mat.metal,
        {n: 12, m: 12, segU: 10, segV: 3},
      );
      for (const sx of [1, -1]) {
        blob(
          kit,
          [sx * (boxW - 0.18), 0.74, boxRear + 0.06],
          [0.14, 0.06, 0.03],
          Mat.plastic,
          {n: 10, m: 8, segU: 8, segV: 3},
        );
        blob(
          kit,
          [sx * (boxW - 0.24), 0.74, boxRear + 0.03],
          [0.06, 0.045, 0.01],
          Mat.taillight,
          {n: 8, m: 4, segU: 8, segV: 2},
        );
        blob(
          kit,
          [sx * (boxW - 0.12), 0.74, boxRear + 0.03],
          [0.04, 0.045, 0.01],
          Mat.indicator,
          {n: 8, m: 4, segU: 8, segV: 2},
        );
      }
      panel(
        kit,
        [0.165, 0.68, boxRear + 0.0],
        [-0.165, 0.68, boxRear + 0.0],
        [0.165, 0.845, boxRear + 0.0],
        [-0.165, 0.845, boxRear + 0.0],
        Mat.rim,
        {doubleSided: true, backMat: Mat.plastic},
      );
      // Front bumper bar below the cab face, and the rear underride guard.
      blob(
        kit,
        [0, 0.48, zf - 0.08],
        [width / 2 - 0.02, 0.09, 0.09],
        Mat.metal,
        {n: 10, m: 8, segU: 12, segV: 3},
      );
      blob(
        kit,
        [0, 0.42, boxRear + 0.12],
        [boxW - 0.12, 0.05, 0.05],
        Mat.metal,
        {n: 10, m: 10, segU: 10, segV: 3},
      );
      for (const sx of [0.55, -0.55])
        tube(
          kit,
          [
            [sx, 0.42, boxRear + 0.12],
            [sx, 0.7, boxRear + 0.2],
          ],
          0.03,
          Mat.metal,
          {along: 1, seg: 5},
        );
      // Big truck mirrors on stalks and the cab step.
      const zm = cowl - 0.15;
      tube(
        kit,
        [
          [width / 2 - 0.02, 1.35, zm],
          [width / 2 + 0.16, 1.45, zm - 0.02],
          [width / 2 + 0.22, 1.5, zm - 0.04],
        ],
        0.012,
        Mat.metal,
        {mirror: true, along: 3, seg: 4},
      );
      blob(
        kit,
        [width / 2 + 0.24, 1.55, zm - 0.06],
        [0.03, 0.17, 0.08],
        Mat.plastic,
        {n: 6, m: 4, mirror: true, segU: 10, segV: 4},
      );
      blob(
        kit,
        [width / 2 + 0.03, 0.5, zf - 0.55],
        [0.06, 0.02, 0.2],
        Mat.metal,
        {n: 10, m: 10, mirror: true, segU: 6, segV: 3},
      );
    },
  });
  design.size = [Math.max(width, boxW * 2), boxTop, L];
  return design;
}
