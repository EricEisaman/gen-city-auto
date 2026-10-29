import {PRESETS} from '../src/city/config.ts';
import {generateLayout} from '../src/city/layout.ts';
import {buildBase} from '../src/city/gen-base.ts';
import {buildTile, makeTileContext} from '../src/city/gen-tile.ts';
import {clusterize} from '../src/city/cmesh.ts';
const t0 = performance.now();
const L = generateLayout(PRESETS.neon, 1);
const t1 = performance.now();
const base = buildBase(L);
const t2 = performance.now();
console.log(
  `layout ${((t1 - t0) / 1000).toFixed(2)}s base ${((t2 - t1) / 1000).toFixed(2)}s verts ${base.mesh.vcount} tris ${base.mesh.icount / 3} lights ${base.lights.length / 8}`,
);
const ctx = makeTileContext(L, base.geom, base.roadMask);
let v1 = 0,
  t1c = 0,
  l1 = 0;
const t3 = performance.now();
for (let t = 0; t < ctx.tilesPerSide ** 2; t++) {
  const r = buildTile(ctx, t, 1);
  v1 += r.mesh.vcount;
  t1c += r.mesh.icount / 3;
  l1 += r.lights.length / 8;
}
const t4 = performance.now();
console.log(
  `LOD1 all tiles ${((t4 - t3) / 1000).toFixed(2)}s verts ${v1} tris ${t1c} lights ${l1}`,
);
let v0 = 0,
  t0c = 0;
const t5 = performance.now();
let cl = 0;
const center =
  Math.floor(ctx.tilesPerSide / 2) * ctx.tilesPerSide +
  Math.floor(ctx.tilesPerSide / 2);
for (let d = -2; d <= 2; d++)
  for (let e = -2; e <= 2; e++) {
    const r = buildTile(ctx, center + d * ctx.tilesPerSide + e, 0);
    v0 += r.mesh.vcount;
    t0c += r.mesh.icount / 3;
    cl += clusterize(r.mesh, 0, 0).clusterCount;
  }
console.log(
  `LOD0 25 central tiles ${((performance.now() - t5) / 1000).toFixed(2)}s verts ${v0} tris ${t0c} clusters ${cl}`,
);
