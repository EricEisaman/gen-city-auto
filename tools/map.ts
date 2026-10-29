// Render a city layout to a PNG for inspection:
//   node tools/map.ts [type] [seed] [out.png] [zoomCenterX zoomCenterZ zoomSize]
import {PRESETS, type CityType} from '../src/city/config.ts';
import {generateLayout, ROAD_WIDTH} from '../src/city/layout.ts';
import {writePng} from './png.ts';

const type = (process.argv[2] ?? 'neon') as CityType;
const seed = Number(process.argv[3] ?? 1);
const out = process.argv[4] ?? 'test/out/map.png';
const t0 = performance.now();
const L = generateLayout(PRESETS[type], seed, (m, f) => console.log(`${(f * 100).toFixed(0)}% ${m} ${((performance.now() - t0) / 1000).toFixed(2)}s`));
console.log(`chains ${L.chains.length} junctions ${L.junctions.length} blocks ${L.blocks.length} buildings ${L.buildings.length} elevated ${L.elevated.length}`);
const S = L.params.size;
const W = 1600;
const zc = process.argv[5] ? [Number(process.argv[5]), Number(process.argv[6])] : [0, 0];
const zs = process.argv[7] ? Number(process.argv[7]) : S;
const img = new Uint8Array(W * W * 4);
const toPx = (x: number, z: number): [number, number] => [((x - zc[0]) / zs + 0.5) * W, ((z - zc[1]) / zs + 0.5) * W];
const hf = L.terrain.heights;
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const wx = (x / W - 0.5) * zs + zc[0], wz = (y / W - 0.5) * zs + zc[1];
  const h = hf.sample(wx, wz);
  const i = (y * W + x) * 4;
  if (h < 0) { img[i] = 20; img[i + 1] = 50; img[i + 2] = 100; }
  else { const c = 60 + h * 2.5; img[i] = c * 0.8; img[i + 1] = c; img[i + 2] = c * 0.7; }
  img[i + 3] = 255;
}
const plot = (x: number, z: number, r: number, g: number, b: number) => {
  const [px, py] = toPx(x, z).map(Math.round);
  if (px < 0 || py < 0 || px >= W || py >= W) return;
  const i = (py * W + px) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b;
};
const line = (a: number[], b: number[], c: number[]) => {
  const [ax, ay] = toPx(a[0], a[1]); const [bx, by] = toPx(b[0], b[1]);
  const n = Math.ceil(Math.hypot(bx - ax, by - ay)) + 1;
  for (let k = 0; k <= n; k++) { const t = k / n; const px = Math.round(ax + (bx - ax) * t), py = Math.round(ay + (by - ay) * t);
    if (px < 0 || py < 0 || px >= W || py >= W) continue; const i = (py * W + px) * 4; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; }
};
const fillPoly = (poly: number[][], c: number[]) => {
  const pts = poly.map(p => toPx(p[0], p[1]));
  const ys = pts.map(p => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(W - 1, Math.ceil(Math.max(...ys))); y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0])); }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(W - 1, Math.floor(xs[k + 1])); x++) {
      const i = (y * W + x) * 4; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; }
  }
};
for (const b of L.blocks) fillPoly(b.curb, b.park ? [40, 120, 40] : [150, 150, 150]);
for (const b of L.buildings) { const t = Math.min(1, b.height / 150); fillPoly(b.footprint, [80 + t * 175, 80 + (1 - t) * 60, 90]); line(b.footprint[0], b.footprint[1], [255, 255, 0]); }
for (const c of L.chains) for (let i = 0; i + 1 < c.pts.length; i++) line(c.pts[i], c.pts[i + 1], c.bridge[i] ? [255, 120, 0] : [30 + c.kind * 60, 30 + c.kind * 60, 40]);
for (const e of L.elevated) for (let i = 0; i + 1 < e.pts.length; i++) line(e.pts[i], e.pts[i + 1], e.kind === 'rail' ? [255, 0, 255] : [0, 255, 255]);
for (const e of L.elevated) for (const s of e.stations) for (let d = -3; d <= 3; d++) for (let k = -3; k <= 3; k++) plot(e.pts[s][0] + d * 3, e.pts[s][1] + k * 3, 255, 255, 255);
for (const j of L.junctions) if (j.signal) plot(j.p[0], j.p[1], 255, 0, 0);
void ROAD_WIDTH;
writePng(out, W, W, img);
console.log('wrote', out, ((performance.now() - t0) / 1000).toFixed(2) + 's');
