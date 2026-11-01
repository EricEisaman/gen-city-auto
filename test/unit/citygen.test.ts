import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PRESETS} from '../../src/city/config.ts';
import {bandTrisData, buildBase, tileGeom} from '../../src/city/gen-base.ts';
import {CLUSTER_ALPHA, CM, clusterize} from '../../src/city/cmesh.ts';
import {buildTile, makeTileContext} from '../../src/city/gen-tile.ts';
import {LEAF_SOLID} from '../../src/city/lod.ts';
import {
  generateLayout,
  inTunnel,
  MAX_DECK_RISE,
  stableOrder,
  TERMINUS_OFFSET,
} from '../../src/city/layout.ts';
import {SEA_LEVEL} from '../../src/city/terrain.ts';
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

// LOD2 (far tiles) is the LOD1 shell thinned out: deterministic, a subset of
// LOD1's triangles plus one solid blob per tree crown, no cut-out leaves.
void test('LOD2 tiles thin the LOD1 shell', () => {
  const p = {...PRESETS.neon, size: 1024};
  const L = generateLayout(p, 3);
  const base = buildBase(L);
  const ctx = makeTileContext(L, base.geom, base.roadMask);
  let t1 = 0;
  let t2 = 0;
  for (let tile = 0; tile < 16; tile++) {
    const a = buildTile(ctx, tile, 2).mesh;
    const b = buildTile(ctx, tile, 2).mesh;
    assert.deepEqual(
      b.u32.subarray(0, b.vcount * 8),
      a.u32.subarray(0, a.vcount * 8),
    );
    t1 += buildTile(ctx, tile, 1).mesh.icount;
    t2 += a.icount;
    for (let v = 0; v < a.vcount; v++) {
      const mat = a.u32[v * 8 + 6];
      if ((mat & 0xff) === CM.leaves) assert.ok(mat & (LEAF_SOLID << 8));
    }
    const c = clusterize(a, 2, tile, 1);
    for (let i = 0; i < c.clusterCount; i++) {
      const flags = (c.clusters[i * 8 + 6] >>> 12) & 0xf;
      assert.equal(flags & CLUSTER_ALPHA, 0, `tile ${tile}: alpha cluster`);
    }
  }
  assert.ok(t2 < t1 * 0.7, `LOD2 ${t2 / 3} vs LOD1 ${t1 / 3} triangles`);
});

// Full-size layouts shared by the tests below (each takes a few seconds).
const layouts = new Map<string, ReturnType<typeof generateLayout>>();
const layoutOf = (type: keyof typeof PRESETS, seed: number) => {
  const k = `${type} ${seed}`;
  let L = layouts.get(k);
  if (!L) layouts.set(k, (L = generateLayout(PRESETS[type], seed)));
  return L;
};

void test('stableOrder keeps surviving items at their old index', () => {
  const before = ['a', 'b', 'c', 'd', 'e'];
  // b and d went, x is new: a and c keep 0 and 2; e (old 4, past the end)
  // and x fill the gaps in order.
  const out = stableOrder(['a', 'c', 'e', 'x'], s => s, before);
  assert.deepEqual(out, ['a', 'e', 'c', 'x']);
});

// Hong Kong seed 1 once had a lattice of ~20 long bridges across the
// harbour, crossing each other at junctions in mid-water.
void test('long water crossings do not meet in mid-water (harbour)', () => {
  for (const seed of [1, 2]) {
    const L = layoutOf('harbour', seed);
    const hf = L.terrain.heights;
    const wetLen = (ci: number) =>
      L.chains[ci].bridge.filter(b => b).length * 8;
    for (const j of L.junctions) {
      if (hf.sample(j.p[0], j.p[1]) > SEA_LEVEL + 0.5) continue;
      const long = j.arms.filter(a => wetLen(a.chain) > 150).length;
      assert.ok(
        long < 3,
        `seed ${seed}: ${long} long bridges meet at ${j.p.map(Math.round)}`,
      );
    }
    const long = L.chains.filter((_, ci) => wetLen(ci) > 400).length;
    assert.ok(long >= 1 && long <= 8, `seed ${seed}: ${long} long bridges`);
  }
});

// Hong Kong and Chongqing viaducts once stood 100-136 m over the valleys
// (held at a 3% grade off every hilltop) and ran off the end of the deck
// at the harbour. Lines now tunnel through hills, end at termini, and a
// loop that bridges a river stays a loop.
void test('rail viaducts follow the ground and end at termini', () => {
  for (const [type, seed] of [
    ['harbour', 1],
    ['harbour', 2],
    ['river', 1],
  ] as const) {
    const L = layoutOf(type, seed);
    const hf = L.terrain.heights;
    for (const e of L.elevated) {
      if (e.kind !== 'rail') continue;
      e.pts.forEach((q, i) => {
        const ground = Math.max(hf.sample(q[0], q[1]), SEA_LEVEL);
        // Clearance (<= 15) + MAX_DECK_RISE, plus a lift over another line.
        const above = e.heights[i] - ground;
        assert.ok(
          above < 15 + MAX_DECK_RISE + 12,
          `${type} ${seed}: deck ${above.toFixed(0)} m up at ${q.map(Math.round)}`,
        );
      });
      if (e.loop) continue;
      const n = e.pts.length;
      for (const [end, si] of [
        [0, TERMINUS_OFFSET],
        [n - 1, n - 1 - TERMINUS_OFFSET],
      ]) {
        assert.ok(
          e.stations.includes(si) || inTunnel(e, end, hf),
          `${type} ${seed}: open line ends at ${e.pts[end].map(Math.round)} without a terminus`,
        );
      }
    }
  }
  // Neon seed 1's loop line crosses a river: it used to be cut open there.
  assert.ok(layoutOf('neon', 1).elevated[0].loop);
});
