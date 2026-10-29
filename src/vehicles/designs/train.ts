// Tokyo commuter EMU cab car (E233 class): 20 m stainless body, wide-body
// sides, four double doors per side, colour band (paint2), cab front with a
// black windshield mask and destination display, single-arm pantograph,
// bogies and underfloor equipment. Ground (y = 0) is the rail head.

import type {Vec3} from '../../math/vec.ts';
import {Mat, type VehicleDesign} from '../types.ts';
import {buildCar} from './car.ts';
import {
  blob,
  lerp,
  panel,
  place,
  projected,
  rect,
  tube,
  type Kit,
} from './kit.ts';

/** palette[0] stainless body, palette[1] line colour band. */
const TRAIN_PALETTE: Vec3[] = [
  [0.55, 0.56, 0.58],
  [0.8, 0.25, 0.01], // Chuo line orange
  [0.6, 0.61, 0.63],
  [0.05, 0.45, 0.1], // Yamanote green
  [0.52, 0.53, 0.55],
  [0.0, 0.3, 0.6], // Keihin-Tohoku blue
  [0.58, 0.58, 0.6],
  [0.75, 0.6, 0.0], // Sobu yellow
];

/** Solid wheelset: two flanged discs (closed superellipsoids) on an axle. */
function wheelset(kit: Kit, z: number, r: number) {
  for (const sx of [1, -1]) {
    // Disc axis along x: build along z, then yaw 90 degrees (a proper rotation).
    const disc = (rad: number, half: number, dx: number, mat: number) =>
      blob(kit, [sx * (0.56 + dx), r, z], [rad, rad, half], mat, {
        n: 2,
        m: 10,
        segU: 12,
        segV: 3,
        xf: p => place(p, [0, 0, 0], 0, Math.PI / 2),
      });
    disc(r, 0.065, 0, Mat.metal);
    disc(r + 0.025, 0.012, -0.06, Mat.metal);
  }
  tube(
    kit,
    [
      [-0.66, r, z],
      [0.66, r, z],
    ],
    0.07,
    Mat.metal,
    {along: 1, seg: 6},
  );
}

export function train(seed: number): VehicleDesign {
  void seed;
  const L = 19.7;
  const width = 2.95;
  const W = width / 2;
  const H = 3.65;
  const zf = L / 2;
  const zr = -L / 2;
  const belt = 1.95;
  const winTop = 2.9;
  const roofEdge = 3.2;
  const floorY = 1.13;
  const wb = 60;
  const doors = [-7.0, -2.25, 2.5, 7.25].map(z => z - 0.35);
  const cabRear = zf - 2.0;
  const design = buildCar({
    name: 'train',
    kind: 'train',
    L,
    width,
    H,
    wheelbase: wb,
    frontOverhang: zf - wb / 2,
    wheelR: 0.43,
    tyreW: 0.12,
    sill: 0.88,
    frontDepth: 0.4,
    frontExp: 3,
    rearDepth: 0.15,
    rearExp: 10,
    hoodFrontY: belt,
    beltF: belt,
    beltR: belt,
    deckRearY: belt,
    edgeYFn: () => belt,
    bumperF: 0.55,
    bumperR: 0.85,
    ymax: 1.65,
    tuck: 0.09,
    tumble: 0.01,
    roll: 0.015,
    leanF: 0.03,
    leanR: 0.01,
    cowlZ: zf - 0.22,
    wsTopZ: zf - 0.42,
    roofRearZ: zr + 0.05,
    rearBaseZ: null,
    roofTumble: 0.07,
    roofCrown: H - roofEdge,
    hoodCrown: 0.01,
    ghCornerBase: 0.3,
    ghCornerTop: 0.28,
    glassBulge: 0.02,
    cPillar: 'paint',
    cPillarTop: 0.1,
    rearPillarWidth: 0.15,
    pillars: [],
    bPillar: 'paint',
    aPillar: 'black',
    grille: 'slim',
    headlight: {x: 1, y: 2, hx: 0.1, hy: 0.05},
    taillight: {x: 1, y: 2, hx: 0.1, hy: 0.05},
    doors: [],
    noMirrors: true,
    carDetails: false,
    rearSeat: false,
    interior: 'none',
    wallBack: Mat.interior,
    wallSegU: 5,
    spacing: 0.45,
    splitY: 1.3,
    floorY,
    driver: {
      eye: [-0.55, 2.35, zf - 1.2],
      wheel: [-0.55, 1.95, zf - 0.6],
      tilt: -1.2,
      wheelR: 0.001,
    },
    palette: TRAIN_PALETTE,
    extras: (kit, ctx) => {
      const gh = ctx.gh;
      const g = gh.glass;
      const wall = ctx.wall.sheet;
      const gside = (shape: (s: number, t: number) => [number, number]) =>
        projected(g, [2, 1], shape, p => p[0]);
      const wside = (shape: (s: number, t: number) => [number, number]) =>
        projected(wall, [2, 1], shape, p => p[0]);
      const zS0 =
        Math.max(gh.base[gh.iRearCorner][2], gh.top[gh.iRearCorner][2]) + 0.01;
      const zS1 = Math.min(gh.base[gh.iSide][2], gh.top[gh.iSide][2]) - 0.01;
      const opaque = (
        z0: number,
        z1: number,
        y0: number,
        y1: number | null,
        mat: number = Mat.paint,
        inner = true,
      ) => {
        const a = Math.max(z0, zS0),
          b = Math.min(z1, zS1);
        if (b <= a + 0.005) return;
        const shape = (s: number, t: number): [number, number] => {
          const z = lerp(a, b, s);
          return [z, lerp(y0, y1 ?? ctx.roofEdgeY(z) - 0.01, t)];
        };
        // Enough rows across the band to follow the glass bulge.
        const nt = (y1 ?? 3.2) - y0 > 0.3 ? 5 : 2;
        const ns = Math.max(2, Math.ceil((b - a) / 0.8) + 1);
        kit.decal(g, gside(shape), mat, {
          ns,
          nt,
          offset: 0.01,
          mirror: true,
          segS: ns - 1,
          segT: nt - 1,
        });
        if (inner)
          kit.decal(
            g,
            gside((u, t) => shape(lerp(0.06, 0.94, u), lerp(0.08, 0.92, t))),
            Mat.interior,
            {
              ns,
              nt,
              offset: 0.012,
              inner: true,
              mirror: true,
              segS: ns - 1,
              segT: nt - 1,
            },
          );
      };
      // Stainless strip above the windows, and the window/door layout on the glass band.
      opaque(zS0, zS1, winTop, null);
      const hw = 0.65;
      const edges: [number, number][] = [];
      let prev = zS0;
      for (const d of [...doors, cabRear + hw]) {
        const isCab = d === cabRear + hw;
        // Wall between the previous opening and this door: pillar, window pair, pillar.
        const w0 = prev + 0.18,
          w1 = d - hw - 0.18;
        if (w1 - w0 > 0.6) {
          opaque(prev, w0, belt, winTop);
          const mid = (w0 + w1) / 2;
          if (w1 - w0 > 1.6) opaque(mid - 0.04, mid + 0.04, belt, winTop);
          opaque(w1, d - hw, belt, winTop);
        } else opaque(prev, d - hw, belt, winTop);
        if (isCab) break;
        // Door: door windows in the upper half, stainless below; bi-parting line.
        opaque(d - hw, d - hw + 0.12, belt, winTop);
        opaque(d + hw - 0.12, d + hw, belt, winTop);
        opaque(d - 0.08, d + 0.08, belt, winTop);
        opaque(d - hw, d + hw, belt, belt + 0.25);
        edges.push([d - hw, d + hw]);
        prev = d + hw;
      }
      // Cab: side door with a drop window, then the cab corner pillar.
      opaque(cabRear + hw, cabRear + 0.9, belt, winTop);
      opaque(cabRear + 1.45, zS1, belt, winTop);
      // Door outlines and steps on the wall; colour band below the windows.
      const line = (z: number) => {
        kit.decal(
          wall,
          wside(rect(z - 0.008, z + 0.008, 1.08, belt - 0.02)),
          Mat.rubber,
          {ns: 2, nt: 3, offset: 0.009, mirror: true, segS: 1, segT: 2},
        );
        kit.decal(
          g,
          gside(rect(z - 0.008, z + 0.008, belt + 0.004, winTop + 0.05)),
          Mat.rubber,
          {ns: 2, nt: 5, offset: 0.009, mirror: true, segS: 1, segT: 4},
        );
      };
      for (const [a, b] of edges) {
        line(a);
        line(b);
        line((a + b) / 2);
        kit.decal(wall, wside(rect(a, b, 1.0, 1.1)), Mat.metal, {
          ns: 2,
          nt: 2,
          offset: 0.013,
          mirror: true,
          segS: 1,
          segT: 1,
        });
      }
      line(cabRear + 0.9);
      line(cabRear + 1.45);
      kit.decal(
        wall,
        wside(rect(zr + 0.2, zf - 0.6, belt - 0.24, belt - 0.05)),
        Mat.paint2,
        {ns: 20, nt: 3, offset: 0.008, mirror: true, segS: 24, segT: 2},
      );
      // Front: band across the nose, lights, black mask, destination display.
      const fw = (shape: (s: number, t: number) => [number, number]) =>
        projected(wall, [0, 1], shape, p => p[2]);
      kit.decal(
        wall,
        fw(rect(0.003, W - 0.12, belt - 0.24, belt - 0.05)),
        Mat.paint2,
        {ns: 6, nt: 2, offset: 0.008, mirror: true, segS: 8, segT: 1},
      );
      kit.decal(wall, fw(rect(0.003, W - 0.15, 1.15, 1.5)), Mat.plastic, {
        ns: 6,
        nt: 2,
        offset: 0.008,
        mirror: true,
        segS: 6,
        segT: 1,
      });
      for (const [x, mat] of [
        [W - 0.32, Mat.headlight],
        [W - 0.52, Mat.taillight],
      ] as const) {
        kit.decal(wall, fw(rect(x - 0.08, x + 0.08, 1.25, 1.4)), mat, {
          ns: 3,
          nt: 3,
          offset: 0.01,
          mirror: true,
        });
      }
      const nRows = gh.base.length;
      const fmap =
        (a0: number, a1: number, k0: number) =>
        (s: number, t: number): [number, number] => [
          g.u(1 + lerp(a0, a1, t) * 3),
          g.v(lerp(k0, nRows - 1, s)),
        ];
      kit.decal(g, fmap(0.72, 0.84, gh.iFrontCorner + 1.5), Mat.screen, {
        ns: 4,
        nt: 2,
        offset: 0.012,
        mirror: true,
      });
      kit.decal(g, fmap(0.0, 0.08, gh.iSide + 1), Mat.plastic, {
        ns: 5,
        nt: 2,
        offset: 0.01,
        mirror: true,
      });
      // Gangway end: stainless over the glass except a door window, bellows, coupler.
      const rmap =
        (a0: number, a1: number, k0: number, k1: number) =>
        (s: number, t: number): [number, number] => [
          g.u(1 + lerp(a0, a1, t) * 3),
          g.v(lerp(k0, k1, s)),
        ];
      kit.decal(g, rmap(0, 1, 0.9, gh.iRearCorner + 0.5), Mat.paint, {
        ns: 8,
        nt: 3,
        offset: 0.01,
        mirror: true,
      });
      for (const [a0, a1] of [
        [0, 0.28],
        [0.75, 1],
      ]) {
        kit.decal(g, rmap(a0, a1, 0, 0.9), Mat.paint, {
          ns: 4,
          nt: 5,
          offset: 0.01,
          mirror: true,
        });
      }
      // Gangway door frame, end tail lamps and the rear skirt.
      kit.decal(g, rmap(0.28, 0.75, 0.75, 0.9), Mat.rubber, {
        ns: 2,
        nt: 3,
        offset: 0.013,
        mirror: true,
      });
      const rw = (shape: (s: number, t: number) => [number, number]) =>
        projected(wall, [0, 1], shape, p => -p[2]);
      kit.decal(wall, rw(rect(0.003, 0.42, 1.0, 1.9)), Mat.paint, {
        ns: 3,
        nt: 3,
        offset: 0.01,
        mirror: true,
      });
      for (const xx of [0.42, 0.005])
        kit.decal(wall, rw(rect(xx, xx + 0.02, 1.0, 1.92)), Mat.rubber, {
          ns: 2,
          nt: 3,
          offset: 0.012,
          mirror: true,
        });
      kit.decal(wall, rw(rect(W - 0.42, W - 0.2, 1.25, 1.4)), Mat.taillight, {
        ns: 3,
        nt: 3,
        offset: 0.012,
        mirror: true,
      });
      kit.decal(wall, rw(rect(W - 0.42, W - 0.2, 1.08, 1.2)), Mat.headlight, {
        ns: 3,
        nt: 3,
        offset: 0.012,
        mirror: true,
      });
      blob(kit, [0, 0.82, zr + 0.12], [W * 0.85, 0.12, 0.08], Mat.metal, {
        n: 8,
        m: 8,
        segU: 12,
        segV: 3,
      });
      // End-cap rail along the rear belt line closes the seam between wall and end glass.
      blob(
        kit,
        [0, belt + 0.07, zr + 0.04],
        [W - 0.04, 0.09, 0.07],
        Mat.paint,
        {n: 10, m: 6, segU: 14, segV: 3},
      );
      blob(kit, [0, 2.0, zr - 0.12], [0.55, 0.95, 0.12], Mat.rubber, {
        n: 8,
        m: 6,
        segU: 12,
        segV: 3,
      });
      for (const [z, d] of [
        [zr, -1],
        [zf, 1],
      ]) {
        blob(kit, [0, 0.88, z + d * 0.25], [0.12, 0.1, 0.3], Mat.metal, {
          n: 6,
          m: 8,
          segU: 8,
          segV: 3,
        });
      }
      // Front skirt (snow plough) and side skirts.
      blob(kit, [0, 0.62, zf - 0.35], [W * 0.75, 0.22, 0.12], Mat.metal, {
        n: 6,
        m: 8,
        segU: 12,
        segV: 3,
      });
      // Bogies, wheelsets and underfloor equipment.
      for (const bz of [-6.9, 6.9]) {
        blob(kit, [0, 0.72, bz], [1.1, 0.18, 1.55], Mat.metal, {
          n: 10,
          m: 10,
          segU: 12,
          segV: 4,
        });
        for (const dz of [-1.05, 1.05]) wheelset(kit, bz + dz, 0.43);
        for (const sx of [1, -1])
          blob(kit, [sx * 0.98, 0.55, bz], [0.12, 0.17, 1.35], Mat.metal, {
            n: 8,
            m: 8,
            segU: 8,
            segV: 3,
          });
      }
      for (const [z0, z1] of [
        [-5.2, -1.6],
        [-1.0, 1.4],
        [2.0, 5.2],
      ]) {
        for (const sx of [1, -1])
          blob(
            kit,
            [sx * 0.75, 0.78, (z0 + z1) / 2],
            [0.45, 0.2, (z1 - z0) / 2],
            Mat.metal,
            {n: 10, m: 10, segU: 10, segV: 4},
          );
      }
      // Roof: AC units and a single-arm pantograph on insulators.
      for (const z of [-3.5, 4.5])
        blob(
          kit,
          [0, ctx.roofY(0, z) + 0.12, z],
          [0.95, 0.16, 1.4],
          Mat.paint,
          {n: 8, m: 8, segU: 12, segV: 5},
        );
      const pz = -7.6;
      const py = ctx.roofY(0, pz);
      for (const sx of [0.5, -0.5])
        for (const dz of [-0.5, 0.5])
          blob(kit, [sx, py + 0.06, pz + dz], [0.05, 0.07, 0.05], Mat.plastic, {
            segU: 8,
            segV: 3,
          });
      blob(kit, [0, py + 0.15, pz], [0.6, 0.04, 0.6], Mat.metal, {
        n: 10,
        m: 10,
        segU: 8,
        segV: 3,
      });
      const knee: Vec3 = [0, py + 0.42, pz - 0.95];
      for (const sx of [0.25, -0.25])
        tube(
          kit,
          [
            [sx, py + 0.18, pz + 0.3],
            [sx * 0.4, knee[1], knee[2]],
          ],
          0.03,
          Mat.metal,
          {along: 1, seg: 5},
        );
      tube(kit, [knee, [0, py + 0.62, pz + 0.2]], 0.022, Mat.metal, {
        along: 1,
        seg: 5,
      });
      tube(
        kit,
        [
          [-0.75, py + 0.62, pz + 0.2],
          [0.75, py + 0.62, pz + 0.2],
        ],
        0.025,
        Mat.metal,
        {along: 1, seg: 5},
      );
      for (const sx of [1, -1])
        tube(
          kit,
          [
            [sx * 0.75, py + 0.62, pz + 0.2],
            [sx * 0.92, py + 0.56, pz + 0.2],
          ],
          0.02,
          Mat.metal,
          {along: 1, seg: 4},
        );
      // --- Interior: floor, long bench seats, poles, straps, cab console and bulkhead.
      const xi = W - 0.12;
      panel(
        kit,
        [-xi, floorY, cabRear],
        [xi, floorY, cabRear],
        [-xi, floorY, zr + 0.2],
        [xi, floorY, zr + 0.2],
        Mat.interior,
        {flip: true},
      );
      panel(
        kit,
        [-xi, floorY, zf - 0.3],
        [xi, floorY, zf - 0.3],
        [-xi, floorY, cabRear],
        [xi, floorY, cabRear],
        Mat.interior,
        {flip: true},
      );
      for (let i = 0; i < doors.length - 1; i++) {
        const a = doors[i] + hw + 0.1,
          b = doors[i + 1] - hw - 0.1;
        for (const sx of [1, -1]) {
          blob(
            kit,
            [sx * (W - 0.38), floorY + 0.42, (a + b) / 2],
            [0.25, 0.06, (b - a) / 2],
            Mat.seat,
            {n: 6, m: 10, segU: 8, segV: 4},
          );
          blob(
            kit,
            [sx * (W - 0.2), floorY + 0.75, (a + b) / 2],
            [0.06, 0.28, (b - a) / 2],
            Mat.seat,
            {n: 6, m: 10, segU: 8, segV: 4},
          );
        }
      }
      for (const sx of [0.7, -0.7])
        tube(
          kit,
          [
            [sx, 2.45, zr + 0.5],
            [sx, 2.45, cabRear - 0.2],
          ],
          0.015,
          Mat.chrome,
          {along: 1, seg: 4},
        );
      for (const d of doors)
        for (const sx of [1, -1])
          tube(
            kit,
            [
              [sx * (W - 0.55), floorY, d - hw - 0.08],
              [sx * (W - 0.55), 2.45, d - hw - 0.08],
            ],
            0.018,
            Mat.chrome,
            {along: 1, seg: 4},
          );
      // Cab bulkhead with a door window, console, seat, master controller.
      panel(
        kit,
        [xi, floorY, cabRear],
        [-xi, floorY, cabRear],
        [xi, roofEdge, cabRear],
        [-xi, roofEdge, cabRear],
        Mat.interior,
        {doubleSided: true},
      );
      // Driver's desk: a sloped console across the left of the cab with two
      // display screens, a speedometer and the one-handle master controller.
      blob(kit, [-0.55, 1.42, zf - 0.5], [0.75, 0.4, 0.25], Mat.plastic, {
        n: 8,
        m: 8,
        segU: 12,
        segV: 4,
      });
      blob(kit, [-0.55, 1.84, zf - 0.55], [0.72, 0.03, 0.22], Mat.plastic, {
        n: 8,
        m: 8,
        segU: 12,
        segV: 3,
        xf: p => place(p, [0, 0, 0], 0.35),
      });
      for (const dx of [-0.25, 0.15])
        blob(kit, [-0.55 + dx, 1.92, zf - 0.5], [0.16, 0.1, 0.012], Mat.dash, {
          n: 8,
          m: 8,
          segU: 8,
          segV: 2,
          xf: p => place(p, [0, 0, 0], -0.5),
        });
      blob(kit, [0.3, 1.42, zf - 0.5], [0.45, 0.4, 0.22], Mat.plastic, {
        n: 8,
        m: 8,
        segU: 10,
        segV: 3,
      });
      tube(
        kit,
        [
          [-0.95, 1.85, zf - 0.75],
          [-0.95, 2.0, zf - 0.85],
        ],
        0.012,
        Mat.plastic,
        {along: 1, seg: 4},
      );
      blob(kit, [-0.95, 2.02, zf - 0.86], [0.06, 0.025, 0.025], Mat.rubber, {
        segU: 6,
        segV: 2,
      });
      blob(kit, [-0.55, 1.65, zf - 1.15], [0.25, 0.07, 0.25], Mat.seat, {
        n: 5,
        m: 4,
        segU: 8,
        segV: 4,
      });
      blob(kit, [-0.55, 2.0, zf - 1.42], [0.24, 0.3, 0.07], Mat.seat, {
        n: 5,
        m: 4,
        segU: 8,
        segV: 4,
      });
    },
  });
  design.wheels = [];
  design.wheelMesh = undefined;
  design.steeringWheel = undefined;
  design.size = [width, H + 0.45, L];
  design.headlights = [
    [W - 0.32, 1.32, zf],
    [-(W - 0.32), 1.32, zf],
  ];
  design.taillights = [
    [W - 0.52, 1.32, zf],
    [-(W - 0.52), 1.32, zf],
  ];
  return design;
}
