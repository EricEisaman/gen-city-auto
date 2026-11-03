import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PRESETS} from '../../src/city/config.ts';
import {
  bandTrisData,
  buildBase,
  carriageway,
  tileGeom,
  tunnelPlan,
} from '../../src/city/gen-base.ts';
import {
  CLUSTER_ALPHA,
  CLUSTER_GROUP_SHIFT,
  CM,
  clusterize,
  groupMatMask,
  MAT_GROUPS,
  type ClusterData,
} from '../../src/city/cmesh.ts';
import {
  buildTile,
  edgeCover,
  exposedFlushWalls,
  makeTileContext,
  solidTop,
} from '../../src/city/gen-tile.ts';
import {baseFarOf, LEAF_SOLID} from '../../src/city/lod.ts';
import {
  clearRun,
  doubledRoads,
  generateLayout,
  inTunnel,
  type Building,
  type CityLayout,
  MAX_DECK_RISE,
  simplePolygon,
  stableOrder,
  TERMINUS_OFFSET,
} from '../../src/city/layout.ts';
import {SEA_LEVEL} from '../../src/city/terrain.ts';
import {computeRoadGeom} from '../../src/city/roadgeom.ts';
import {polygonArea, type Vec2} from '../../src/math/vec.ts';

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

// Each opaque cluster's triangles all shade with a material its group's
// pipeline compiles in (renderer.ts cityList*): anything else would draw
// as a flat colour.
void test('opaque clusters hold one material group', () => {
  const p = {...PRESETS.neon, size: 1024};
  const L = generateLayout(p, 3);
  const base = buildBase(L);
  const ctx = makeTileContext(L, base.geom, base.roadMask);
  const check = (c: ClusterData, what: string) => {
    const seen = new Set<number>();
    for (let i = 0; i < c.clusterCount; i++) {
      const packed = c.clusters[i * 8 + 6];
      const g = (packed >>> CLUSTER_GROUP_SHIFT) & 0xf;
      if ((packed >>> 12) & CLUSTER_ALPHA) {
        assert.equal(g, 0, `${what}: alpha-tested cluster in group ${g}`);
        continue;
      }
      seen.add(g);
      const mask = groupMatMask(g);
      const v0 = c.clusters[i * 8 + 4];
      const t0 = c.clusters[i * 8 + 5];
      for (let t = 0; t < (packed & 0xff); t++) {
        const pv = v0 + (c.tris[t0 + t] & 0xff);
        const id = c.vertices[pv * 8 + 6] & 0xff;
        assert.ok((mask >>> id) & 1, `${what}: material ${id} in group ${g}`);
      }
    }
    return seen;
  };
  const groups = check(
    clusterize(base.mesh, 0, 0xffffffff, 1, baseFarOf(base.mesh)),
    'base',
  );
  for (let tile = 0; tile < 16; tile++)
    for (const lod of [0, 1, 2])
      for (const g of check(
        clusterize(buildTile(ctx, tile, lod).mesh, lod, tile, 1),
        `tile ${tile} lod ${lod}`,
      ))
        groups.add(g);
  assert.equal(groups.size, MAT_GROUPS);
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

// Hong Kong and Chongqing rail lines came out of the hill (or a road cut
// into it) on the roads themselves: the portal's walls and dark opening
// stood across the lanes. No headwall stands on a carriageway now (a few
// mouths with nowhere to move to get none).
void test('rail tunnel portals stand off the roads', () => {
  for (const [type, seed] of [
    ['harbour', 1],
    ['harbour', 2],
    ['river', 1],
  ] as const) {
    const L = layoutOf(type, seed);
    const inRoad = carriageway(L, computeRoadGeom(L));
    for (const e of L.elevated) {
      if (e.kind !== 'rail') continue;
      const {under, noPortal} = tunnelPlan(e, L.terrain.heights, inRoad);
      assert.ok(noPortal.size <= 4, `${type} ${seed}: ${noPortal.size}`);
      for (let b = 1; b < e.pts.length; b++) {
        if (under[b] === under[b - 1] || noPortal.has(b)) continue;
        const a = e.pts[b - 1];
        const c = e.pts[b];
        const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
        const lat = [(a[1] - c[1]) / l, (c[0] - a[0]) / l];
        for (let s = -7; s <= 7; s += 0.5) {
          const q: Vec2 = [
            (a[0] + c[0]) / 2 + lat[0] * s,
            (a[1] + c[1]) / 2 + lat[1] * s,
          ];
          assert.ok(
            !inRoad(q, 0),
            `${type} ${seed}: portal on a road at ${q.map(Math.round)}`,
          );
        }
      }
    }
  }
});

// The street tracer sometimes ran a line back alongside itself (or a radial
// into the ring), and an expressway on one of the two boulevards stood its
// piers in the other's lanes, or ran its deck on top of its own.
void test('no carriageway or deck runs on top of an expressway', () => {
  for (const [type, seed] of [
    ['harbour', 1],
    ['harbour', 2],
    ['river', 1],
    ['neon', 1],
  ] as const) {
    const L = layoutOf(type, seed);
    const d = doubledRoads(L.chains, L.elevated);
    assert.equal(d.size, 0, `${type} ${seed}: roads ${[...d]} doubled`);
    const decks = L.elevated.filter(e => e.kind === 'expressway');
    decks.forEach((e, k) => {
      assert.deepEqual(
        clearRun(
          e.pts,
          decks.slice(0, k).map(o => o.pts),
        ),
        [0, e.pts.length],
        `${type} ${seed}: deck ${k} runs on top of a deck`,
      );
    });
  }
});

void test('simplePolygon keeps the main loop of a self-touching plan', () => {
  const square: Vec2[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  assert.equal(simplePolygon(square), square);
  // A 10 x 10 plot pinched at (10, 10) to a 4 x 4 lobe.
  const pinched: Vec2[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [14, 10],
    [14, 14],
    [10, 14],
    [10, 10],
    [0, 10],
  ];
  const s = simplePolygon(pinched);
  assert.equal(s.length, 4);
  assert.equal(polygonArea(s), 100);
  // A figure eight: the bigger lobe (same winding) wins.
  const eight: Vec2[] = [
    [0, 0],
    [20, 12],
    [20, 0],
    [0, 12],
  ];
  assert.ok(simplePolygon(eight).length === 3);
});

// Chongqing seed 1 had a glass tower on a plot that touched itself: its
// inset body and crown came out as a twisted box hanging past the podium.
void test('building plans do not cross themselves', () => {
  for (const [type, seed] of [
    ['river', 1],
    ['harbour', 1],
  ] as const) {
    const L = layoutOf(type, seed);
    const bad = L.buildings.filter(
      b => simplePolygon(b.footprint) !== b.footprint,
    );
    assert.ok(
      bad.length <= L.buildings.length * 0.0005,
      `${type} ${seed}: ${bad.length} self-crossing plans`,
    );
    const towers = bad.filter(b => b.kind === 'glass' || b.kind === 'tower');
    assert.equal(
      towers.length,
      0,
      `${type} ${seed}: towers ${towers.map(b => b.id)}`,
    );
  }
});

// A midrise's party wall against a tower used to be left out up to the
// tower's roof, but the tower stands back from its podium edge, so the wall
// went missing in plain view (harbour seed 1, building 207).
void test('walls flush against a tower are drawn above its podium', () => {
  const mk = (
    id: number,
    kind: Building['kind'],
    footprint: Vec2[],
    height: number,
  ): Building => ({
    id,
    kind,
    footprint,
    base: 10,
    low: 9,
    height,
    floorH: 3.3,
    style: 1234,
    front: 0,
    frontage: footprint.map((_, i) => i === 0),
    seed: 0x9e3779b9 + id,
    density: 0.5,
  });
  const sq = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
  const mid = mk(1, 'midrise', sq(0, 0, 20, 20), 66);
  const tower = mk(2, 'tower', sq(20, -10, 60, 30), 220);
  const L = {buildings: [mid, tower]} as unknown as CityLayout;
  assert.ok(solidTop(tower) < tower.base + 30);
  assert.ok(exposedFlushWalls(L, 0, b => b.base + b.height) > 500);
  assert.equal(exposedFlushWalls(L, 0, solidTop), 0);
  // The shared wall is covered to the podium top only.
  assert.equal(edgeCover(L, 0, 0.3)[1], solidTop(tower));
});
