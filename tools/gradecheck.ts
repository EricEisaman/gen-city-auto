// Road grade report and layout fingerprint for every preset.
//   node tools/gradecheck.ts [seeds=1,2] [out.json]
// Grades: road chain segments (and expressway decks), junction approach
// grades (first ~20 m of each arm), and terrain "wall" cells (ground steeper
// than 50 degrees within 40 m of a road). The fingerprint (road / junction /
// block / building counts and a hash of chain and footprint x/z) must not
// change when only heights change.
import fs from 'node:fs';
import {PRESETS, type CityType} from '../src/city/config.ts';
import {gradeStats} from '../src/city/grade.ts';
import {generateLayout, type CityLayout} from '../src/city/layout.ts';
import {SEA_LEVEL} from '../src/city/terrain.ts';

const seeds = (process.argv[2] ?? '1,2').split(',').map(Number);
const out = process.argv[3];

function fnv(h: number, v: number) {
  const x = Math.round(v * 1000) | 0;
  h ^= x;
  return Math.imul(h, 16777619) >>> 0;
}

function fingerprint(L: CityLayout) {
  let roads = 2166136261;
  for (const c of L.chains)
    for (const p of c.pts) roads = fnv(fnv(roads, p[0]), p[1]);
  let lots = 2166136261;
  for (const b of L.buildings) {
    lots = fnv(lots, b.id);
    for (const p of b.footprint) lots = fnv(fnv(lots, p[0]), p[1]);
  }
  let blocks = 2166136261;
  for (const b of L.blocks)
    for (const p of b.curb) blocks = fnv(fnv(blocks, p[0]), p[1]);
  return {
    chains: L.chains.length,
    junctions: L.junctions.length,
    blocks: L.blocks.length,
    buildings: L.buildings.length,
    elevated: L.elevated.length,
    roads,
    blocksHash: blocks,
    lots,
  };
}

function junctionGrades(L: CityLayout) {
  const g: {pts: [number, number][]; heights: number[]}[] = [];
  for (const j of L.junctions) {
    for (const a of j.arms) {
      const c = L.chains[a.chain];
      const n = c.pts.length;
      // Point ~20 m along the arm.
      let k = 0;
      let d = 0;
      while (k + 1 < n && d < 20) {
        const i = a.end === 0 ? k : n - 1 - k;
        const i2 = a.end === 0 ? k + 1 : n - 2 - k;
        d += Math.hypot(c.pts[i2][0] - c.pts[i][0], c.pts[i2][1] - c.pts[i][1]);
        k++;
      }
      const i = a.end === 0 ? k : n - 1 - k;
      if (c.bridge[i]) continue;
      g.push({pts: [j.p, c.pts[i]], heights: [j.h, c.heights[i]]});
    }
  }
  return gradeStats(g);
}

function wallCells(L: CityLayout) {
  const hf = L.terrain.heights;
  const n = hf.n;
  const cell = hf.cell;
  const S = hf.size / 2;
  const near = new Uint8Array(n * n);
  const R = 40;
  for (const c of L.chains)
    for (const p of c.pts) {
      const gx = Math.round((p[0] + S) / cell);
      const gz = Math.round((p[1] + S) / cell);
      const r = Math.ceil(R / cell);
      for (let z = Math.max(0, gz - r); z <= Math.min(n - 1, gz + r); z++)
        for (let x = Math.max(0, gx - r); x <= Math.min(n - 1, gx + r); x++)
          near[z * n + x] = 1;
    }
  let walls = 0;
  let worst = 0;
  const d = hf.data;
  for (let z = 1; z < n - 1; z++)
    for (let x = 1; x < n - 1; x++) {
      const k = z * n + x;
      if (!near[k] || d[k] < SEA_LEVEL + 0.5) continue;
      const sx = (d[k + 1] - d[k - 1]) / (2 * cell);
      const sz = (d[k + n] - d[k - n]) / (2 * cell);
      const s = Math.hypot(sx, sz);
      worst = Math.max(worst, s);
      if (s > 1.2) walls++;
    }
  return {walls, worstSlope: +worst.toFixed(2)};
}

const r3 = (v: number) => +v.toFixed(3);
const report: Record<string, unknown> = {};
for (const city of Object.keys(PRESETS) as CityType[]) {
  for (const seed of seeds) {
    const t = performance.now();
    const L = generateLayout(PRESETS[city], seed);
    // Land runs of each chain (bridge decks are graded on their own).
    const land: {pts: [number, number][]; heights: number[]}[] = [];
    for (const c of L.chains) {
      let run: {pts: [number, number][]; heights: number[]} | null = null;
      c.pts.forEach((p, i) => {
        if (c.bridge[i]) return void (run = null);
        if (!run) land.push((run = {pts: [], heights: []}));
        run.pts.push(p);
        run.heights.push(c.heights[i]);
      });
    }
    const roads = gradeStats(land);
    const ex = gradeStats(L.elevated.filter(e => e.kind === 'expressway'));
    const jg = junctionGrades(L);
    const w = wallCells(L);
    const row = {
      roadMax: r3(roads.max),
      roadP99: r3(roads.p99),
      roadOver15: roads.over15,
      roadSegs: roads.segments,
      junctionMax: r3(jg.max),
      junctionP99: r3(jg.p99),
      junctionOver15: jg.over15,
      exprMax: r3(ex.max),
      ...w,
      ms: Math.round(performance.now() - t),
      fp: fingerprint(L),
    };
    report[`${city}/${seed}`] = row;
    const {fp, ...rest} = row;
    console.log(`${city}/${seed}`, JSON.stringify(rest), JSON.stringify(fp));
  }
}
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
