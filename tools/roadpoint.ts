import {PRESETS} from '../src/city/config.ts';
import {generateLayout} from '../src/city/layout.ts';
const L = generateLayout(PRESETS.neon, 1);
const want = (process.argv[2] ?? '0,0').split(',').map(Number);
let best = null as null | {
  x: number;
  z: number;
  h: number;
  dir: number;
  kind: number;
};
let bd = 1e9;
for (const c of L.chains) {
  if (c.kind < Number(process.argv[3] ?? 2)) continue;
  for (let i = 1; i < c.pts.length - 1; i++) {
    const p = c.pts[i];
    const d = Math.hypot(p[0] - want[0], p[1] - want[1]);
    if (d < bd) {
      bd = d;
      const q = c.pts[i + 1];
      best = {
        x: p[0],
        z: p[1],
        h: c.heights[i],
        dir: Math.atan2(q[0] - p[0], -(q[1] - p[1])),
        kind: c.kind,
      };
    }
  }
}
console.log(JSON.stringify(best));
console.log('hubs', JSON.stringify(L.hubs.map(h => h.p.map(Math.round))));
console.log(
  'stations',
  JSON.stringify(
    L.elevated
      .filter(e => e.kind === 'rail')
      .flatMap(e =>
        e.stations.map(s => [
          Math.round(e.pts[s][0]),
          Math.round(e.pts[s][1]),
          Math.round(e.heights[s]),
        ]),
      ),
  ),
);
