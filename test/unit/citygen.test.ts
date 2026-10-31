import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PRESETS} from '../../src/city/config.ts';
import {bandTrisData, buildBase, tileGeom} from '../../src/city/gen-base.ts';
import {buildTile, makeTileContext} from '../../src/city/gen-tile.ts';
import {generateLayout} from '../../src/city/layout.ts';
import {computeRoadGeom} from '../../src/city/roadgeom.ts';

// river seed 5 once had a kerb-return crossing extrapolated 55 km out of its
// junction; landing()'s plate grid then took ~700 MB per city worker and the
// page ran out of memory while loading.
void test('junction plates stay near their junction (river seed 5)', () => {
  const L = generateLayout(PRESETS.river, 5);
  const geom = computeRoadGeom(L);
  let worst = 0;
  geom.junctions.forEach((jg, ji) => {
    const p = L.junctions[ji].p;
    const polys = [jg.plate, ...jg.cover, ...jg.slivers.map(s => s.pts)];
    for (const poly of polys)
      for (const q of poly)
        worst = Math.max(worst, Math.hypot(q[0] - p[0], q[1] - p[1]));
  });
  assert.ok(worst < 400, `plate vertex ${worst.toFixed(0)} m from junction`);
});

// Non-primary city workers build their tile context with tileGeom() instead
// of buildBase(); the tiles must not change.
void test('tileGeom() tiles match buildBase() tiles', () => {
  const p = {...PRESETS.neon, size: 1024};
  const La = generateLayout(p, 3);
  const base = buildBase(La);
  const a = makeTileContext(La, base.geom, base.roadMask);
  const Lb = generateLayout(p, 3);
  const t = tileGeom(Lb, bandTrisData(base.geom));
  const b = makeTileContext(Lb, t.geom, t.roadMask);
  assert.deepEqual(t.roadMask, base.roadMask);
  for (const lod of [1, 0])
    for (let tile = 0; tile < 16; tile += lod ? 1 : 3) {
      const ra = buildTile(a, tile, lod);
      const rb = buildTile(b, tile, lod);
      assert.equal(rb.mesh.vcount, ra.mesh.vcount, `tile ${tile} lod ${lod}`);
      assert.deepEqual(
        rb.mesh.u32.subarray(0, rb.mesh.vcount * 8),
        ra.mesh.u32.subarray(0, ra.mesh.vcount * 8),
      );
      assert.deepEqual(
        rb.mesh.idx.subarray(0, rb.mesh.icount),
        ra.mesh.idx.subarray(0, ra.mesh.icount),
      );
      assert.deepEqual(rb.lights, ra.lights);
    }
});
