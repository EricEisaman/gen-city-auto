// Checks how well block terrain meets the surrounding road heights at curbs.
//   node tools/curbcheck.ts [type] [seed]
import {PRESETS, type CityType} from '../src/city/config.ts';
import {generateLayout} from '../src/city/layout.ts';
import {pointSegment} from '../src/math/vec.ts';

const L = generateLayout(
  PRESETS[(process.argv[2] ?? 'neon') as CityType],
  Number(process.argv[3] ?? 1),
);
const hf = L.terrain.heights;
let total = 0;
let over05 = 0;
let over15 = 0;
let worst = 0;
for (const b of L.blocks.slice(0, 600)) {
  for (const q of b.curb) {
    let bd = 1e9;
    let bh = 0;
    for (const c of L.chains) {
      for (let i = 0; i + 1 < c.pts.length; i++) {
        const a = c.pts[i];
        if (Math.abs(a[0] - q[0]) > 40 || Math.abs(a[1] - q[1]) > 40) continue;
        const [d, t] = pointSegment(q, a, c.pts[i + 1]);
        if (d < bd) {
          bd = d;
          bh = c.heights[i] + (c.heights[i + 1] - c.heights[i]) * t;
        }
      }
    }
    const diff = Math.abs(hf.sample(q[0], q[1]) - bh);
    total++;
    if (diff > 0.5) over05++;
    if (diff > 1.5) over15++;
    worst = Math.max(worst, diff);
  }
}
console.log({total, over05, over15, worst});
