// Compare the driving surface (RoadNet.surfaceHeight) with the rendered road
// and junction meshes: node tools/drivecheck.ts [city] [seed]
import {CM, VERTEX_WORDS} from '../src/city/cmesh.ts';
import {PRESETS, type CityType} from '../src/city/config.ts';
import {buildBase} from '../src/city/gen-base.ts';
import {generateLayout} from '../src/city/layout.ts';
import {Heightfield} from '../src/city/terrain.ts';
import {RoadNet} from '../src/game/roadnet.ts';

const type = (process.argv[2] ?? 'neon') as CityType;
const L = generateLayout(PRESETS[type], Number(process.argv[3] ?? 1));
const base = buildBase(L);
const t = L.terrain.heights;
const hf = new Heightfield(L.params.size, t.cell, t.data);
const net = new RoadNet(
  {
    layout: {...L, heights: t.data, heightN: t.n, cell: t.cell},
    geom: base.geom,
  } as never,
  hf,
);
const m = base.mesh;
const P = (i: number) => [
  m.f32[i * VERTEX_WORDS],
  m.f32[i * VERTEX_WORDS + 1],
  m.f32[i * VERTEX_WORDS + 2],
];
const MAT = (i: number) => m.u32[i * VERTEX_WORDS + 6] & 0xff;
const drive = new Set<number>([CM.road, CM.asphaltPlain]);
const diffs: {d: number; x: number; z: number; mat: number}[] = [];
for (let k = 0; k < m.icount; k += 3) {
  const [a, b, c] = [m.idx[k], m.idx[k + 1], m.idx[k + 2]];
  if (!drive.has(MAT(a))) continue;
  const pa = P(a),
    pb = P(b),
    pc = P(c);
  // Sample the centroid and edge midpoints.
  for (const [u, v] of [
    [1 / 3, 1 / 3],
    [0.5, 0.25],
    [0.25, 0.5],
  ]) {
    const x = pa[0] + (pb[0] - pa[0]) * u + (pc[0] - pa[0]) * v;
    const y = pa[1] + (pb[1] - pa[1]) * u + (pc[1] - pa[1]) * v;
    const z = pa[2] + (pb[2] - pa[2]) * u + (pc[2] - pa[2]) * v;
    const s = net.surfaceHeight(x, z, y);
    diffs.push({d: y - s, x, z, mat: MAT(a)});
  }
}
const abs = diffs.map(d => Math.abs(d.d)).sort((a, b) => a - b);
const q = (f: number) => abs[Math.floor(abs.length * f)].toFixed(3);
console.log(
  `samples ${abs.length}  p50 ${q(0.5)}  p90 ${q(0.9)}  p99 ${q(0.99)}  max ${q(0.9999)}`,
);
for (const lim of [0.1, 0.3, 1])
  console.log(
    `|d| > ${lim}: ${((abs.filter(a => a > lim).length / abs.length) * 100).toFixed(2)}%`,
  );
diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
for (const d of diffs.slice(0, 12))
  console.log(
    d.d.toFixed(2),
    Math.round(d.x),
    Math.round(d.z),
    d.mat === CM.road ? 'road' : 'junction',
  );
