import {PRESETS} from '../src/city/config.ts';
import {generateLayout} from '../src/city/layout.ts';
import {pointSegment} from '../src/math/vec.ts';
const L = generateLayout(PRESETS.neon, 1);
const hf = L.terrain.heights;
let bad = 0, total = 0, worst = 0;
for (const b of L.blocks.filter(b => b.curb.some(q => Math.hypot(q[0] - 40, q[1] + 880) < 60))) {
  for (const q of b.curb) {
    // nearest chain height
    let bd = 1e9, bh = 0;
    for (const c of L.chains) {
      for (let i = 0; i + 1 < c.pts.length; i++) {
        const a = c.pts[i];
        if (Math.abs(a[0] - q[0]) > 40 || Math.abs(a[1] - q[1]) > 40) continue;
        const [d, t] = pointSegment(q, a, c.pts[i + 1]);
        if (d < bd) { bd = d; bh = c.heights[i] + (c.heights[i + 1] - c.heights[i]) * t; }
      }
    }
    const diff = hf.sample(q[0], q[1]) - bh;
    total++;
    console.log(q.map(Math.round), "terrain", hf.sample(q[0], q[1]).toFixed(2), "road", bh.toFixed(2), "d", bd.toFixed(1));
    if (Math.abs(diff) > 0.5) bad++;
    if (Math.abs(diff) > 1.5) (globalThis as any).b15 = ((globalThis as any).b15 ?? 0) + 1;
    if (bd > 9) (globalThis as any).far = ((globalThis as any).far ?? 0) + 1;
    worst = Math.max(worst, Math.abs(diff));
  }
}
console.log({total, bad, worst, b15: (globalThis as any).b15, far: (globalThis as any).far});
