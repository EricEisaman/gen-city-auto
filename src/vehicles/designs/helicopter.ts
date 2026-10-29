// Light single-engine helicopter (AS350 / Bell 407 class) for news, police and
// private use: pod-and-boom fuselage with a bubble canopy, skids, engine
// fairing, tail boom with fins, four-blade main rotor and two-blade tail rotor.
// Origin is on the ground under the main rotor mast.

import {Rng} from '../../math/random.ts';
import type {Vec3} from '../../math/vec.ts';
import {Mat, type VehicleDesign} from '../types.ts';
import {
  Kit,
  Sheet,
  blob,
  clamp,
  lerp,
  place,
  projected,
  rect,
  smooth,
  sp,
  tube,
} from './kit.ts';

/** palette[0] body, palette[1] stripe colour. */
const HELI_PALETTE: Vec3[] = [
  [0.82, 0.82, 0.8],
  [0.02, 0.06, 0.3], // police blue
  [0.015, 0.015, 0.018],
  [0.5, 0.02, 0.02],
  [0.85, 0.45, 0.02],
  [0.05, 0.12, 0.35],
  [0.6, 0.61, 0.63],
];

interface Section {
  z: number;
  w: number;
  yc: number;
  hTop: number;
  hBot: number;
  n: number;
}

export function helicopter(seed: number): VehicleDesign {
  const rng = new Rng(seed);
  const kit = new Kit();
  const skidY = 0.05;
  const floorY = 0.62;
  const zNose = rng.range(2.25, 2.4);
  const zCabRear = -1.05;
  const zBoomEnd = -6.9;
  const mastY = 2.95;
  // Fuselage half-sections along z (nose -> tail): half width, center height, top/bottom extents.
  const S = (z: number): Section => {
    if (z > zCabRear) {
      // Cabin pod: rounded nose, deep bubble.
      const t = clamp((zNose - z) / (zNose - zCabRear), 0, 1);
      const nose = Math.pow(
        Math.sin((Math.PI / 2) * clamp(t / 0.42, 0, 1)),
        0.75,
      );
      return {
        z,
        w: 0.86 * nose,
        yc: lerp(1.15, 1.35, t),
        hTop: lerp(0.55, 0.88, Math.min(1, t * 1.6)) * Math.max(nose, 0.2),
        hBot: 0.52 * nose + 0.02,
        n: 2.6,
      };
    }
    // Aft: engine deck tapering into the boom.
    const t = clamp((zCabRear - z) / (zCabRear - zBoomEnd), 0, 1);
    const k = smooth(t / 0.35);
    return {
      z,
      w: lerp(0.86, 0.2, k) - 0.06 * t,
      yc: lerp(1.35, 1.72, k),
      hTop: lerp(0.88, 0.19, k) - 0.04 * t,
      hBot: lerp(0.52, 0.19, k) - 0.04 * t,
      n: lerp(2.6, 2.1, k),
    };
  };
  const ring = (
    s: Section,
    th0: number,
    th1: number,
    count: number,
  ): Vec3[] => {
    const pts: Vec3[] = [];
    for (let i = 0; i <= count; i++) {
      const th = lerp(th0, th1, i / count);
      const c = Math.cos(th),
        si = Math.sin(th);
      pts.push([
        s.w * sp(c, s.n),
        s.yc + (si > 0 ? s.hTop : s.hBot) * sp(si, s.n),
        s.z,
      ]);
    }
    return pts;
  };
  // Canopy boundary angle (belt line) along the cabin; glass above it.
  const belt = (z: number) => lerp(-0.55, 0.05, smooth((zNose - z) / 1.6));
  const cabZ: number[] = [];
  for (let i = 0; i <= 14; i++)
    cabZ.push(lerp(zNose, zCabRear, Math.pow(i / 14, 1.25)));
  cabZ.reverse();
  // Lower cabin (paint) and canopy (glass): rows run bottom -> top so normals face out.
  const lowerRows = cabZ.map(z => ring(S(z), -Math.PI / 2, belt(z), 6));
  const glassRows = cabZ.map(z => ring(S(z), belt(z), Math.PI / 2, 6));
  const lower = new Sheet(lowerRows, 1);
  const canopy = new Sheet(glassRows, 1);
  kit.sheet(lower, Mat.paint, {
    mirror: true,
    segU: 8,
    segV: 18,
    doubleSided: true,
    backMat: Mat.interior,
  });
  kit.sheet(canopy, Mat.glass, {
    mirror: true,
    segU: 8,
    segV: 18,
    doubleSided: true,
  });
  // Aft fuselage + boom (full half sections).
  const aftZ: number[] = [];
  for (let i = 0; i <= 16; i++)
    aftZ.push(lerp(zCabRear, zBoomEnd, Math.pow(i / 16, 1.3)));
  aftZ.reverse();
  const aft = new Sheet(
    aftZ.map(z => {
      const s = S(z);
      return [
        ...ring(s, -Math.PI / 2, belt(zCabRear), 6),
        ...ring(s, belt(zCabRear), Math.PI / 2, 6).slice(1),
      ];
    }),
    1,
  );
  kit.sheet(aft, Mat.paint, {mirror: true, segU: 12, segV: 24});
  // Tail cap.
  blob(
    kit,
    [0, S(zBoomEnd).yc, zBoomEnd],
    [S(zBoomEnd).w, S(zBoomEnd).hTop, 0.18],
    Mat.paint,
    {segU: 10, segV: 4},
  );
  // Canopy frame: roof spine, door pillars and the windshield center post (paint over glass).
  const side = (shape: (s: number, t: number) => [number, number]) =>
    projected(canopy, [2, 1], shape, p => p[0]);
  const top = (shape: (s: number, t: number) => [number, number]) =>
    projected(canopy, [0, 2], shape, p => p[1]);
  for (const [z0, z1] of [
    [0.55, 0.65],
    [-0.7, -0.6],
  ]) {
    const sh = (s: number, t: number): [number, number] => {
      const z = lerp(z0, z1, s);
      const sec = S(z);
      const yb = sec.yc + sec.hBot * sp(Math.sin(belt(z)), sec.n) + 0.02;
      return [z, lerp(yb, sec.yc + sec.hTop * 0.97, t)];
    };
    kit.decal(canopy, side(sh), Mat.paint, {
      ns: 2,
      nt: 6,
      offset: 0.006,
      mirror: true,
      segS: 1,
      segT: 6,
    });
    kit.decal(canopy, side(sh), Mat.interior, {
      ns: 2,
      nt: 6,
      offset: 0.012,
      inner: true,
      mirror: true,
      segS: 1,
      segT: 6,
    });
  }
  kit.decal(canopy, top(rect(0.0, 0.18, -0.95, 1.2)), Mat.paint, {
    ns: 3,
    nt: 8,
    offset: 0.006,
    mirror: true,
  });
  kit.decal(canopy, top(rect(0.0, 0.18, -0.95, 1.2)), Mat.interior, {
    ns: 3,
    nt: 8,
    offset: 0.012,
    inner: true,
    mirror: true,
  });
  // Engine/transmission fairing, exhaust, intake.
  blob(kit, [0, 2.32, -0.35], [0.5, 0.3, 1.25], Mat.paint, {
    n: 3,
    m: 2.4,
    segU: 14,
    segV: 8,
    taper: t => [lerp(0.6, 1, Math.sin(Math.PI * Math.min(1, t * 1.4))), 1],
  });
  tube(
    kit,
    [
      [0.18, 2.3, -1.4],
      [0.22, 2.25, -1.75],
    ],
    0.09,
    Mat.metal,
    {mirror: true, along: 2, seg: 8},
  );
  blob(kit, [0, 2.6, 0.15], [0.22, 0.05, 0.25], Mat.plastic, {
    n: 4,
    segU: 10,
    segV: 3,
  });
  // Mast.
  tube(
    kit,
    [
      [0, 2.5, 0],
      [0, mastY, 0],
    ],
    0.07,
    Mat.metal,
    {along: 1, seg: 8},
  );
  // Stripe in the second colour along the lower cabin and boom.
  const lside = (shape: (s: number, t: number) => [number, number]) =>
    projected(lower, [2, 1], shape, p => p[0]);
  kit.decal(lower, lside(rect(-0.9, 1.2, 0.95, 1.06)), Mat.paint2, {
    ns: 8,
    nt: 3,
    offset: 0.006,
    mirror: true,
    segS: 10,
    segT: 2,
  });
  const aside = (shape: (s: number, t: number) => [number, number]) =>
    projected(aft, [2, 1], shape, p => p[0]);
  kit.decal(aft, aside(rect(-6.2, -1.6, 1.62, 1.72)), Mat.paint2, {
    ns: 10,
    nt: 3,
    offset: 0.006,
    mirror: true,
    segS: 12,
    segT: 2,
  });
  kit.decal(aft, aside(rect(-1.6, -1.1, 1.0, 1.1)), Mat.paint2, {
    ns: 3,
    nt: 2,
    offset: 0.004,
    mirror: true,
  });
  // Fins: vertical fin (up and down) and horizontal stabiliser with end plates.
  const fin = (
    pts: Vec3[],
    thick: number,
    chord: number,
    mat: number,
    horizontal = false,
  ) => {
    const rows: Vec3[][] = pts.map(p => {
      const r: Vec3[] = [];
      for (let i = 0; i <= 8; i++) {
        const th = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const a = Math.cos(th) * thick,
          b = Math.sin(th) * chord;
        r.push(
          horizontal ? [p[0], p[1] + a, p[2] + b] : [p[0] + a, p[1], p[2] + b],
        );
      }
      return r;
    });
    kit.surf(new Sheet(rows, 1).S, mat, {
      segU: 8,
      segV: pts.length * 2,
      doubleSided: true,
    });
  };
  fin(
    [
      [0, 1.8, zBoomEnd + 0.15],
      [0, 2.3, zBoomEnd - 0.05],
      [0, 2.75, zBoomEnd - 0.25],
    ],
    0.035,
    0.32,
    Mat.paint,
  );
  fin(
    [
      [0, 1.55, zBoomEnd + 0.15],
      [0, 1.25, zBoomEnd + 0.05],
    ],
    0.03,
    0.22,
    Mat.paint,
  );
  fin(
    [
      [-1.0, 1.75, zBoomEnd + 1.3],
      [0, 1.75, zBoomEnd + 1.3],
      [1.0, 1.75, zBoomEnd + 1.3],
    ],
    0.025,
    0.22,
    Mat.paint,
    true,
  );
  for (const sx of [1, -1])
    blob(
      kit,
      [sx * 1.0, 1.78, zBoomEnd + 1.3],
      [0.02, 0.16, 0.18],
      Mat.paint2,
      {segU: 8, segV: 3},
    );
  // Skids and cross tubes.
  for (const sx of [1, -1]) {
    tube(
      kit,
      [
        [sx * 1.08, skidY + 0.3, 2.05],
        [sx * 1.1, skidY + 0.06, 1.7],
        [sx * 1.1, skidY, 1.0],
        [sx * 1.1, skidY, -1.4],
        [sx * 1.1, skidY + 0.04, -1.75],
      ],
      0.04,
      Mat.metal,
      {along: 12, seg: 6, caps: true},
    );
    for (const z of [0.95, -0.55])
      tube(
        kit,
        [
          [sx * 1.1, skidY, z],
          [sx * 0.95, 0.4, z],
          [sx * 0.55, 0.62, z],
        ],
        0.045,
        Mat.metal,
        {along: 4, seg: 6},
      );
    blob(kit, [sx * 1.1, 0.25, -0.2], [0.06, 0.06, 0.12], Mat.plastic, {
      segU: 6,
      segV: 3,
    });
  }
  // Lights: landing light under the nose, beacon on the fin, nav lights, strobes.
  blob(kit, [0, 0.72, zNose - 0.5], [0.09, 0.03, 0.09], Mat.headlight, {
    segU: 8,
    segV: 3,
  });
  blob(kit, [0, 2.8, zBoomEnd - 0.26], [0.04, 0.04, 0.04], Mat.taillight, {
    segU: 6,
    segV: 3,
  });
  blob(kit, [0, 2.75, -0.95], [0.05, 0.04, 0.08], Mat.taillight, {
    segU: 6,
    segV: 3,
  });
  blob(kit, [1.02, 1.75, zBoomEnd + 1.3], [0.03, 0.03, 0.04], Mat.indicator, {
    segU: 6,
    segV: 3,
  });
  blob(kit, [-1.02, 1.75, zBoomEnd + 1.3], [0.03, 0.03, 0.04], Mat.taillight, {
    segU: 6,
    segV: 3,
  });
  // Searchlight / camera ball under the nose (news / police).
  blob(kit, [0.35, 0.7, zNose - 0.75], [0.14, 0.14, 0.14], Mat.plastic, {
    segU: 10,
    segV: 6,
  });
  blob(kit, [0.35, 0.7, zNose - 0.62], [0.08, 0.08, 0.02], Mat.glass, {
    segU: 10,
    segV: 2,
  });
  // Antennas.
  tube(
    kit,
    [
      [0, 0.62, -0.8],
      [0, 0.35, -1.0],
    ],
    0.006,
    Mat.plastic,
    {along: 1, seg: 4},
  );
  // --- Cockpit: floor, instrument panel and glare shield, two front seats,
  // rear bench, cyclic and collective. Pilot on the right.
  kit.surf(
    new Sheet(
      [
        [
          [0.75, floorY, zCabRear + 0.1],
          [-0.75, floorY, zCabRear + 0.1],
        ],
        [
          [0.6, floorY, zNose - 0.55],
          [-0.6, floorY, zNose - 0.55],
        ],
      ],
      1,
      {u: 1, v: 1},
    ).S,
    Mat.interior,
    {segU: 1, segV: 1},
  );
  blob(kit, [0, 1.12, 1.45], [0.62, 0.17, 0.12], Mat.plastic, {
    n: 6,
    m: 6,
    segU: 12,
    segV: 4,
  });
  blob(kit, [0, 1.15, 1.37], [0.5, 0.12, 0.012], Mat.dash, {
    n: 8,
    m: 6,
    segU: 12,
    segV: 3,
    xf: p => place(p, [0, 0, 0], -0.35),
  });
  blob(kit, [0, 0.85, 1.25], [0.12, 0.3, 0.1], Mat.plastic, {
    n: 6,
    m: 6,
    segU: 8,
    segV: 3,
  });
  const seat = (x: number, z: number, w: number) => {
    blob(kit, [x, floorY + 0.28, z], [w, 0.06, 0.24], Mat.seat, {
      n: 5,
      m: 4,
      segU: 8,
      segV: 4,
    });
    blob(kit, [x, floorY + 0.62, z - 0.24], [w, 0.3, 0.06], Mat.seat, {
      n: 5,
      m: 4,
      segU: 8,
      segV: 4,
      xf: p => [p[0], p[1], p[2] - 0.12 * (p[1] / 0.3)],
    });
  };
  seat(0.38, 0.62, 0.22);
  seat(-0.38, 0.62, 0.22);
  seat(0, -0.45, 0.65);
  tube(
    kit,
    [
      [0.38, floorY, 1.0],
      [0.38, floorY + 0.55, 0.92],
    ],
    0.018,
    Mat.plastic,
    {along: 1, seg: 5},
  );
  blob(kit, [0.38, floorY + 0.57, 0.91], [0.025, 0.05, 0.025], Mat.rubber, {
    segU: 6,
    segV: 3,
  });
  tube(
    kit,
    [
      [0.14, floorY + 0.15, 0.55],
      [0.16, floorY + 0.35, 0.9],
    ],
    0.018,
    Mat.plastic,
    {along: 1, seg: 5},
  );
  // Bulkhead behind the rear bench.
  kit.surf(
    new Sheet(
      [
        [
          [0.85, floorY, zCabRear],
          [-0.85, floorY, zCabRear],
        ],
        [
          [0.75, 1.95, zCabRear],
          [-0.75, 1.95, zCabRear],
        ],
      ],
      1,
      {u: 1, v: 1},
    ).S,
    Mat.interior,
    {segU: 1, segV: 1, doubleSided: true},
  );

  // --- Rotors.
  const blade = (
    len: number,
    chord: number,
    thick: number,
    root: number,
  ): Vec3[][] => {
    const rows: Vec3[][] = [];
    for (let k = 0; k <= 6; k++) {
      const r = root + (len - root) * (k / 6);
      const twist = 0.12 * (1 - k / 6);
      const row: Vec3[] = [];
      for (let i = 0; i <= 10; i++) {
        const th = (i / 10) * Math.PI * 2;
        // Airfoil-ish: thicker toward the leading edge (+z).
        const c = Math.cos(th),
          s = Math.sin(th);
        const zc = chord * 0.5 * c;
        const yc = thick * s * (0.6 + 0.4 * c);
        row.push([
          r,
          yc * Math.cos(twist) + zc * Math.sin(twist),
          zc * Math.cos(twist) - yc * Math.sin(twist),
        ]);
      }
      rows.push(row);
    }
    return rows;
  };
  const main = new Kit();
  const R = rng.range(5.2, 5.4);
  const nb = rng.pick([3, 4]);
  const bladeRows = blade(R, 0.3, 0.025, 0.35);
  for (let b = 0; b < nb; b++) {
    const yaw = (b / nb) * Math.PI * 2;
    const rows = bladeRows.map(r => r.map(p => place(p, [0, 0, 0], 0, yaw)));
    main.surf(new Sheet(rows, 1).S, Mat.metal, {
      segU: 8,
      segV: 8,
      doubleSided: true,
    });
    tube(
      main,
      [
        place([0.1, 0, 0], [0, 0, 0], 0, yaw),
        place([0.4, 0, 0], [0, 0, 0], 0, yaw),
      ],
      0.04,
      Mat.metal,
      {along: 1, seg: 5},
    );
  }
  blob(main, [0, 0.05, 0], [0.22, 0.1, 0.22], Mat.metal, {segU: 10, segV: 4});
  blob(main, [0, 0.16, 0], [0.12, 0.08, 0.12], Mat.metal, {segU: 8, segV: 3});
  const tail = new Kit();
  const tr = 0.82;
  const tRows = blade(tr, 0.16, 0.015, 0.08);
  for (let b = 0; b < 2; b++) {
    const ang = b * Math.PI;
    // Blades in the y/z plane spinning about x: rotate the +x blade to +y first.
    const rows = tRows.map(r =>
      r.map(p => {
        const q: Vec3 = [p[1], p[0], p[2]];
        const c = Math.cos(ang),
          s = Math.sin(ang);
        return [-q[0], c * q[1] - s * q[2], s * q[1] + c * q[2]] as Vec3;
      }),
    );
    tail.surf(new Sheet(rows, 1).S, Mat.metal, {
      segU: 8,
      segV: 6,
      doubleSided: true,
    });
  }
  blob(tail, [0, 0, 0], [0.06, 0.07, 0.07], Mat.metal, {segU: 8, segV: 3});
  const L = zNose - (zBoomEnd - 0.4);
  return {
    name: 'helicopter',
    kind: 'helicopter',
    size: [2.3, mastY + 0.3, L],
    body: kit.mesh,
    wheels: [],
    rotors: [
      {position: [0, mastY, 0], axis: [0, 1, 0], mesh: main.mesh},
      {
        position: [-0.18, 2.35, zBoomEnd - 0.12],
        axis: [1, 0, 0],
        mesh: tail.mesh,
      },
    ],
    driverEye: [0.38, 1.6, 0.55],
    headlights: [[0, 0.7, zNose - 0.4]],
    taillights: [[0, 2.8, zBoomEnd - 0.26]],
    palette: HELI_PALETTE,
  };
}
