import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PRESETS} from '../../src/city/config.ts';
import {buildBase} from '../../src/city/gen-base.ts';
import {buildTile, makeTileContext} from '../../src/city/gen-tile.ts';
import {
  CLUSTER_WORDS,
  clusterize,
  CMesh,
  VERTEX_WORDS,
  type ClusterData,
} from '../../src/city/cmesh.ts';
import {baseFarOf} from '../../src/city/lod.ts';
import {generateLayout} from '../../src/city/layout.ts';
import {
  gridStep,
  packClusters,
  RAW_SHIFT,
  unpackVertex,
  VSHIFT_SHIFT,
} from '../../src/city/vpack.ts';

/**
 * Every vertex of `c` decoded from its packed form: normal, uv, mat and aux
 * bit-exact, position within half a grid step. Returns the cluster count
 * per shift.
 */
function checkPacked(c: ClusterData) {
  const p = packClusters(c);
  const f = new Float32Array(c.vertices.buffer, c.vertices.byteOffset);
  const shifts: Record<number, number> = {};
  assert.equal(p.tris, c.tris);
  for (let i = 0; i < c.clusterCount; i++) {
    for (const w of [0, 1, 2, 3, 5, 6, 7])
      assert.equal(
        p.clusters[i * CLUSTER_WORDS + w],
        c.clusters[i * CLUSTER_WORDS + w],
      );
    const k = p.clusters[i * CLUSTER_WORDS + 4] >>> VSHIFT_SHIFT;
    shifts[k] = (shifts[k] ?? 0) + 1;
    const v0 = c.clusters[i * CLUSTER_WORDS + 4];
    const v1 =
      i + 1 < c.clusterCount
        ? c.clusters[(i + 1) * CLUSTER_WORDS + 4]
        : c.vertices.length / VERTEX_WORDS;
    const tol = k === RAW_SHIFT ? 0 : gridStep(k) / 2 + 1e-9;
    for (let l = 0; l < v1 - v0; l++) {
      const d = unpackVertex(p.vertices, p.clusters, i, l);
      const o = (v0 + l) * VERTEX_WORDS;
      for (let a = 0; a < 3; a++)
        assert.ok(
          Math.abs(d[a] - f[o + a]) <= tol,
          `cluster ${i} vertex ${l} axis ${a}: ${d[a]} vs ${f[o + a]}`,
        );
      for (let w = 3; w < 8; w++) assert.equal(d[w], c.vertices[o + w]);
    }
  }
  return {shifts, words: p.vertices.length};
}

void test('packed city vertices decode to the originals', () => {
  const p = {...PRESETS.neon, size: 1024};
  const L = generateLayout(p, 3);
  const base = buildBase(L);
  const ctx = makeTileContext(L, base.geom, base.roadMask);
  let raw = 0;
  let packed = 0;
  const all: Record<number, number> = {};
  const add = (c: ClusterData) => {
    const r = checkPacked(c);
    raw += c.vertices.length;
    packed += r.words;
    for (const [k, n] of Object.entries(r.shifts)) all[+k] = (all[+k] ?? 0) + n;
  };
  add(clusterize(base.mesh, 0, 0xffffffff, 1, baseFarOf(base.mesh)));
  add(clusterize(base.piers, 0, 0xffffffff, 0));
  for (const lod of [0, 1, 2])
    for (let tile = 0; tile < 16; tile += 5)
      add(clusterize(buildTile(ctx, tile, lod).mesh, lod, tile, 1));
  // Most clusters on the finest grid, a few raw; ~1/3 fewer words.
  const n = Object.values(all).reduce((a, b) => a + b, 0);
  assert.ok((all[0] ?? 0) > 0.75 * n, JSON.stringify(all));
  assert.ok((all[RAW_SHIFT] ?? 0) < 0.05 * n, JSON.stringify(all));
  assert.ok(packed < raw * 0.7, `${packed} of ${raw} words`);
});

void test('a shared vertex decodes identically in every cluster', () => {
  const m = new CMesh();
  // A long strip: many clusters share the vertices along their seams.
  for (let i = 0; i < 400; i++) {
    const x = 1000.123456 + i * 0.37;
    const a = m.vertex([x, 12.3456789, -2047.987654], [0, 1, 0], 0, 0, 3);
    const b = m.vertex([x, 12.3456789, -2049.5], [0, 1, 0], 0, 1, 3);
    const c = m.vertex(
      [x + 0.37, 12.3456789, -2047.987654],
      [0, 1, 0],
      1,
      0,
      3,
    );
    const d = m.vertex([x + 0.37, 12.3456789, -2049.5], [0, 1, 0], 1, 1, 3);
    m.tri(a, b, c);
    m.tri(c, b, d);
  }
  const c = clusterize(m, 0, 0, 0);
  const p = packClusters(c);
  // Every decoded position, keyed by its source position.
  const seen = new Map<string, string>();
  const f = new Float32Array(c.vertices.buffer, c.vertices.byteOffset);
  for (let i = 0; i < c.clusterCount; i++) {
    const v0 = c.clusters[i * CLUSTER_WORDS + 4];
    const v1 =
      i + 1 < c.clusterCount
        ? c.clusters[(i + 1) * CLUSTER_WORDS + 4]
        : c.vertices.length / VERTEX_WORDS;
    for (let l = 0; l < v1 - v0; l++) {
      const o = (v0 + l) * VERTEX_WORDS;
      const key = `${f[o]},${f[o + 1]},${f[o + 2]}`;
      const got = unpackVertex(p.vertices, p.clusters, i, l)
        .slice(0, 3)
        .join(',');
      if (seen.has(key)) assert.equal(got, seen.get(key));
      else seen.set(key, got);
    }
  }
  assert.ok(c.clusterCount > 4);
});

void test('a cluster too large for the grid keeps 32-byte vertices', () => {
  const m = new CMesh();
  const a = m.vertex([-2900, 0, 0], [0, 1, 0], 0, 0, 16);
  const b = m.vertex([2900, 0, 1], [0, 1, 0], 5800, 0, 16);
  const c = m.vertex([0, 0, 2], [0, 1, 0], 1, 1, 16);
  m.tri(a, b, c);
  const cd = clusterize(m, 0, 0, 0);
  const p = packClusters(cd);
  assert.equal(p.clusters[4] >>> VSHIFT_SHIFT, RAW_SHIFT);
  checkPacked(cd);
});
