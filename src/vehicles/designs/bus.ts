// Japanese low-floor city bus (Erga / Blue Ribbon class): 10.5 m, flat front
// with a huge windshield and an LED destination screen, doors on the left
// (kerb) side, driver on the right, roof air-conditioning pod.

import {Rng} from '../../math/random.ts';
import type {Vec3} from '../../math/vec.ts';
import {Mat, type VehicleDesign} from '../types.ts';
import {buildCar, GLASS_LAYER} from './car.ts';
import {
  blob,
  clamp,
  lerp,
  panel,
  projected,
  rect,
  smooth,
  tube,
} from './kit.ts';

/** palette[0] body, palette[1] livery band. Tokyo operators: white/green, white/blue, cream/red. */
const BUS_PALETTE: Vec3[] = [
  [0.82, 0.82, 0.8],
  [0.03, 0.25, 0.08],
  [0.8, 0.78, 0.7],
  [0.3, 0.02, 0.02],
  [0.85, 0.85, 0.85],
  [0.02, 0.08, 0.3],
];

export function bus(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const L = rng.range(10.4, 10.7);
  const width = 2.49;
  const H = 3.02;
  const wheelbase = rng.range(5.2, 5.35);
  const fo = 2.25;
  const zf = wheelbase / 2 + fo;
  const zr = zf - L;
  const W = width / 2;
  const belt = 1.22;
  const winTop = 2.42;
  const floorY = 0.38;
  const frontDoor = [zf - 1.62, zf - 0.62];
  const midDoor = [0.15, 1.2];
  const driverX = W - 0.55;
  const cowl = zf - 0.1;
  const edgeYFn = (z: number) =>
    lerp(belt, 0.95, smooth((z - (zf - 0.75)) / 0.5));
  // Window pillars every ~1.2 m between the doors and the rear.
  const pillars: number[] = [frontDoor[0] - 0.05];
  for (let z = frontDoor[0] - 1.15; z > zr + 0.9; z -= rng.range(1.1, 1.25))
    pillars.push(z);
  return buildCar({
    name: 'bus',
    kind: 'bus',
    L,
    width,
    H,
    wheelbase,
    frontOverhang: fo,
    wheelR: 0.5,
    tyreW: 0.3,
    rimRatio: 0.5,
    spokes: 8,
    sill: 0.3,
    frontDepth: 0.2,
    frontExp: 4.5,
    rearDepth: 0.2,
    rearExp: 5,
    hoodFrontY: 0.95,
    beltF: 0.95,
    beltR: belt,
    deckRearY: belt,
    edgeYFn,
    bumperF: 0.3,
    bumperR: 0.34,
    ymax: 0.9,
    tuck: 0.03,
    tumble: 0.015,
    roll: 0.03,
    leanF: 0.03,
    leanR: 0.03,
    cowlZ: cowl,
    wsTopZ: zf - 0.3,
    roofRearZ: zr + 0.12,
    rearBaseZ: null,
    roofTumble: 0.07,
    roofCrown: 0.07,
    hoodCrown: 0.01,
    ghCornerBase: 0.16,
    ghCornerTop: 0.14,
    glassBulge: 0.02,
    roofMat: Mat.paint,
    cPillar: 'paint',
    cPillarTop: 0.1,
    rearPillarWidth: 0.3,
    pillars,
    bPillar: 'black',
    aPillar: 'black',
    grille: 'slim',
    headlight: {x: W - 0.28, y: 0.6, hx: 0.17, hy: 0.055, n: 6, slant: 0},
    taillight: {x: W - 0.12, y: 1.0, hx: 0.08, hy: 0.3, n: 6},
    doors: [],
    noMirrors: true,
    rearSeat: false,
    interior: 'none',
    wallBack: Mat.interior,
    wallSegU: 7,
    floorY,
    dualRear: true,
    driver: {
      eye: [driverX, 1.9, zf - 1.25],
      wheel: [driverX, 1.32, zf - 0.68],
      tilt: -1.05,
      wheelR: 0.24,
    },
    palette: BUS_PALETTE,
    extras: (kit, ctx) => {
      const g = ctx.gh.glass;
      const gh = ctx.gh;
      const side = (shape: (s: number, t: number) => [number, number]) =>
        projected(g, [2, 1], shape, p => p[0]);
      const wall = ctx.wall.sheet;
      const wside = (shape: (s: number, t: number) => [number, number]) =>
        projected(wall, [2, 1], shape, p => p[0]);
      const zS0 =
          Math.max(gh.base[gh.iRearCorner][2], gh.top[gh.iRearCorner][2]) +
          0.02,
        zS1 = Math.min(gh.base[gh.iSide][2], gh.top[gh.iSide][2]) - 0.02;
      // Body panel above the windows (with the livery band) over the glass band.
      const band = (
        y0: number,
        y1: number | null,
        mat: number,
        off = 0.006,
      ) => {
        const shape = (s: number, t: number): [number, number] => {
          const z = lerp(zS0, zS1, s);
          return [z, lerp(y0, y1 ?? ctx.roofEdgeY(z) - 0.012, t)];
        };
        kit.decal(g, side(shape), mat, {
          ns: 10,
          nt: 3,
          offset: off,
          mirror: true,
          segS: 12,
          segT: 2,
        });
        kit.decal(
          g,
          side((u, t) => shape(lerp(0.02, 0.98, u), lerp(0.1, 0.9, t))),
          Mat.interior,
          {
            ns: 10,
            nt: 3,
            offset: GLASS_LAYER.innerSkin,
            inner: true,
            mirror: true,
            segS: 12,
            segT: 2,
          },
        );
      };
      // Over the drip rail (the panel hides it), the livery over the panel.
      band(winTop, null, Mat.paint, GLASS_LAYER.trim + 0.003);
      band(winTop, winTop + 0.08, Mat.paint2, GLASS_LAYER.trim + 0.006);
      // Livery band along the skirt.
      const archEdge = 0.48 + 0.55;
      for (const [z0, z1] of [
        [zr + 0.4, -wheelbase / 2 - archEdge],
        [-wheelbase / 2 + archEdge, wheelbase / 2 - archEdge],
        [wheelbase / 2 + archEdge, zf - 0.4],
      ]) {
        kit.decal(wall, wside(rect(z0, z1, 0.75, 0.86)), Mat.paint2, {
          ns: 8,
          nt: 2,
          offset: 0.004,
          mirror: true,
          segS: 10,
          segT: 1,
        });
      }
      // Rear: engine cover below a small rear window, route number screen.
      const nRows = gh.base.length;
      const rearMap =
        (a0: number, a1: number) =>
        (s: number, t: number): [number, number] => [
          g.u(1 + lerp(a0, a1, t) * 3),
          g.v(lerp(0, gh.iRearCorner + 0.5, s)),
        ];
      kit.decal(g, rearMap(0, 0.6), Mat.paint, {
        ns: 14,
        nt: 3,
        offset: GLASS_LAYER.panel,
        mirror: true,
        segS: 16,
      });
      kit.decal(g, rearMap(0, 0.6), Mat.interior, {
        ns: 14,
        nt: 3,
        offset: GLASS_LAYER.innerSkin,
        inner: true,
        mirror: true,
        segS: 16,
      });
      kit.decal(
        g,
        (s, t) => [g.u(1 + lerp(0.84, 0.94, t) * 3), g.v(lerp(0, 1.5, s))],
        Mat.screen,
        {ns: 3, nt: 2, offset: 0.009, mirror: true},
      );
      // Front destination screen with a black surround, and a side screen by the front door.
      const frontMap =
        (a0: number, a1: number, k0: number) =>
        (s: number, t: number): [number, number] => [
          g.u(1 + lerp(a0, a1, t) * 3),
          g.v(lerp(k0, nRows - 1, s)),
        ];
      kit.decal(g, frontMap(0.82, 1, gh.iSide + 1), Mat.plastic, {
        ns: 5,
        nt: 3,
        offset: 0.006,
        mirror: true,
      });
      kit.decal(g, frontMap(0.86, 0.97, gh.iFrontCorner), Mat.screen, {
        ns: 5,
        nt: 3,
        offset: 0.009,
        mirror: true,
      });
      kit.decal(
        g,
        side(rect(frontDoor[0] - 1.0, frontDoor[0] - 0.2, 2.12, 2.34)),
        Mat.screen,
        {ns: 4, nt: 2, offset: 0.008, leftOnly: true},
      );
      // Doors (kerb side = left): glazed lower panels and black frames.
      for (const [z0, z1] of [frontDoor, midDoor]) {
        kit.decal(
          wall,
          wside(
            rect(
              z0 + 0.04,
              z1 - 0.04,
              ctx.cfg.sill + 0.12,
              ctx.edgeY((z0 + z1) / 2) - 0.03,
            ),
          ),
          // Over the skirt livery and the shoulder crease's rib.
          Mat.glass,
          {ns: 3, nt: 3, offset: 0.011, leftOnly: true},
        );
        for (const z of [z0, (z0 + z1) / 2, z1]) {
          kit.decal(
            wall,
            wside(
              rect(
                z - 0.02,
                z + 0.02,
                ctx.cfg.sill + 0.05,
                ctx.edgeY(z) - 0.03,
              ),
            ),
            Mat.rubber,
            {ns: 2, nt: 4, offset: 0.014, leftOnly: true},
          );
          kit.decal(
            g,
            side(rect(z - 0.025, z + 0.025, ctx.edgeY(z) + 0.004, winTop)),
            Mat.plastic,
            {ns: 2, nt: 3, offset: 0.007, leftOnly: true},
          );
        }
      }
      // Roof air-conditioning pod and rear engine grille.
      const zAc = -0.4;
      blob(
        kit,
        [0, ctx.roofY(0, zAc) + 0.1, zAc],
        [W * 0.62, 0.13, 1.5],
        Mat.paint,
        {n: 6, m: 8, segU: 14, segV: 6},
      );
      kit.decal(
        wall,
        projected(wall, [0, 1], rect(0.02, W * 0.6, 0.55, 0.95), p => -p[2]),
        Mat.plastic,
        {ns: 4, nt: 3, offset: 0.004, mirror: true},
      );
      // Rabbit-ear mirrors hanging in front of the windshield.
      for (const sx of [1, -1]) {
        const top: Vec3 = [sx * (W - 0.08), 2.75, zf - 0.32];
        tube(
          kit,
          [
            top,
            [sx * (W + 0.05), 2.7, zf + 0.15],
            [sx * (W + 0.1), 2.35, zf + 0.35],
          ],
          0.018,
          Mat.plastic,
          {along: 4, seg: 5},
        );
        blob(
          kit,
          [sx * (W + 0.1), 2.15, zf + 0.36],
          [0.12, 0.2, 0.04],
          Mat.plastic,
          {n: 4, segU: 10, segV: 3},
        );
      }
      // --- Interior: floor, driver platform and dash, seats, poles and handrails.
      const xi = W - 0.12;
      panel(
        kit,
        [-xi, floorY, zf - 0.3],
        [xi, floorY, zf - 0.3],
        [-xi, floorY, zr + 0.3],
        [xi, floorY, zr + 0.3],
        Mat.interior,
        {segU: 1, segV: 1, flip: true},
      );
      blob(kit, [driverX, 0.6, zf - 1.1], [0.45, 0.22, 0.6], Mat.interior, {
        n: 10,
        m: 10,
        segU: 10,
        segV: 4,
      });
      blob(
        kit,
        [driverX - 0.05, 1.2, zf - 0.5],
        [0.55, 0.12, 0.2],
        Mat.plastic,
        {n: 6, m: 6, segU: 12, segV: 4},
      );
      blob(kit, [driverX, 1.3, zf - 0.6], [0.2, 0.05, 0.1], Mat.dash, {
        n: 6,
        segU: 10,
        segV: 3,
      });
      tube(
        kit,
        [
          [driverX, 1.0, zf - 0.45],
          [driverX, 1.28, zf - 0.66],
        ],
        0.04,
        Mat.plastic,
        {along: 1, seg: 6},
      );
      // Ceiling panel (light liner) below the roof structure.
      panel(
        kit,
        [xi, 2.38, zf - 0.35],
        [-xi, 2.38, zf - 0.35],
        [xi, 2.38, zr + 0.25],
        [-xi, 2.38, zr + 0.25],
        Mat.seat,
      );
      // Full-width dashboard under the windshield with a frame across its base.
      blob(kit, [0, 1.0, zf - 0.32], [W - 0.12, 0.16, 0.2], Mat.plastic, {
        n: 8,
        m: 6,
        segU: 14,
        segV: 4,
      });
      blob(kit, [0, 1.17, zf - 0.3], [W - 0.14, 0.02, 0.18], Mat.interior, {
        n: 8,
        m: 8,
        segU: 14,
        segV: 2,
      });
      // Rear: roof end cap and a route number box above the rear window.
      blob(
        kit,
        [0, ctx.roofY(0, zr + 0.3) - 0.02, zr + 0.25],
        [W - 0.1, 0.06, 0.3],
        Mat.paint,
        {n: 8, m: 6, segU: 14, segV: 4},
      );
      // Driver seat.
      blob(kit, [driverX, 1.22, zf - 1.15], [0.25, 0.07, 0.25], Mat.seat, {
        n: 5,
        m: 4,
        segU: 8,
        segV: 4,
      });
      blob(kit, [driverX, 1.56, zf - 1.42], [0.24, 0.32, 0.07], Mat.seat, {
        n: 5,
        m: 4,
        segU: 8,
        segV: 4,
      });
      // Passenger seats: pairs on the right, singles on the left, facing forward.
      const seatRow = (x: number, z: number, w: number, y0: number) => {
        blob(kit, [x, y0 + 0.42, z], [w, 0.06, 0.22], Mat.seat, {
          n: 6,
          m: 4,
          segU: 8,
          segV: 3,
        });
        blob(kit, [x, y0 + 0.75, z - 0.24], [w, 0.3, 0.05], Mat.seat, {
          n: 6,
          m: 4,
          segU: 8,
          segV: 3,
        });
        tube(
          kit,
          [
            [x - w * 0.6, y0 + 1.07, z - 0.27],
            [x + w * 0.6, y0 + 1.07, z - 0.27],
          ],
          0.015,
          Mat.chrome,
          {along: 1, seg: 4},
        );
      };
      for (let z = midDoor[0] - 0.6; z > zr + 0.9; z -= 0.78) {
        const y0 = z < -wheelbase / 2 + 0.8 ? 0.3 : floorY;
        seatRow(W - 0.45, z, 0.4, y0);
        if (z < -0.5) seatRow(-(W - 0.32), z, 0.22, y0);
      }
      for (let z = frontDoor[0] - 0.9; z > midDoor[1] + 0.4; z -= 0.78)
        seatRow(W - 0.45, z, 0.4, floorY);
      // Handrails along the ceiling and vertical poles.
      for (const sx of [1, -1])
        tube(
          kit,
          [
            [sx * 0.55, 2.2, zr + 0.6],
            [sx * 0.55, 2.2, zf - 1.4],
          ],
          0.016,
          Mat.chrome,
          {along: 1, seg: 5},
        );
      for (const z of [
        frontDoor[0] - 0.1,
        midDoor[0] - 0.1,
        midDoor[1] + 0.1,
        -2.0,
        -3.6,
      ]) {
        tube(
          kit,
          [
            [-(W - 0.45), floorY, z],
            [-(W - 0.45), 2.2, z],
          ],
          0.018,
          Mat.chrome,
          {along: 1, seg: 5},
        );
      }
      void clamp;
    },
  });
}
