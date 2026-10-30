import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PRESETS} from '../../src/city/config.ts';
import {generateLayout, splitLots, type Lot} from '../../src/city/layout.ts';
import {extractFaces, insetPolygon, planarize} from '../../src/city/graph.ts';
import {Rng} from '../../src/math/random.ts';
import {pointSegment, polygonArea} from '../../src/math/vec.ts';
import {clusterize, CMesh, CLUSTER_WORDS} from '../../src/city/cmesh.ts';

void test('rng is deterministic', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.nextU32(), b.nextU32());
});

void test('planarize splits crossing segments into a 4-way junction', () => {
  const g = planarize([
    {
      pts: [
        [-10, 0],
        [10, 0],
      ],
      kind: 1,
    },
    {
      pts: [
        [0, -10],
        [0, 10],
      ],
      kind: 1,
    },
  ]);
  const center = g.nodes.findIndex(n => Math.hypot(n.p[0], n.p[1]) < 1e-6);
  assert.ok(center >= 0);
  assert.equal(g.degree(center), 4);
});

void test('faces of a grid are its cells', () => {
  const lines = [];
  for (let i = 0; i <= 2; i++) {
    lines.push({
      pts: [
        [i * 10, 0],
        [i * 10, 20],
      ] as [number, number][],
      kind: 1,
    });
    lines.push({
      pts: [
        [0, i * 10],
        [20, i * 10],
      ] as [number, number][],
      kind: 1,
    });
  }
  const faces = extractFaces(planarize(lines));
  assert.equal(faces.length, 4);
  for (const f of faces) assert.ok(Math.abs(f.area - 100) < 1e-6);
});

void test('inset shrinks a square uniformly', () => {
  const sq: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const r = insetPolygon(sq, [1, 1, 1, 1])!;
  assert.ok(Math.abs(polygonArea(r) - 64) < 1e-6);
});

void test('clusterize keeps every triangle and respects limits', () => {
  const m = new CMesh();
  for (let i = 0; i < 100; i++) m.box([i * 3, 0, 0], [1, 1, 1], 0);
  const c = clusterize(m, 0, 0);
  let tris = 0;
  for (let k = 0; k < c.clusterCount; k++) {
    const n = c.clusters[k * CLUSTER_WORDS + 6] & 0xff;
    assert.ok(n <= 128);
    tris += n;
  }
  assert.equal(tris, m.icount / 3);
});

void test('city layout is deterministic and populated', () => {
  const p = {...PRESETS.neon, size: 2048};
  const a = generateLayout(p, 5);
  const b = generateLayout(p, 5);
  assert.ok(a.buildings.length > 500, `buildings ${a.buildings.length}`);
  assert.ok(a.chains.length > 100);
  assert.equal(a.buildings.length, b.buildings.length);
  assert.deepEqual(a.buildings[10].footprint, b.buildings[10].footprint);
  // Not flat: meaningful relief on land.
  const h = a.terrain.heights.data;
  let max = -Infinity;
  for (const v of h) max = Math.max(max, v);
  assert.ok(max > 20, `max height ${max}`);
  // No building wall crosses an elevated rail deck (edges, not just corners).
  for (const e of a.elevated) {
    if (e.kind !== 'rail') continue;
    for (const bd of a.buildings) {
      const fp = bd.footprint;
      for (let j = 0; j < fp.length; j++) {
        const p = fp[j];
        const q = fp[(j + 1) % fp.length];
        for (let i = 0; i + 1 < e.pts.length; i++) {
          const r = e.pts[i];
          if (Math.abs(r[0] - p[0]) > 120 || Math.abs(r[1] - p[1]) > 120)
            continue;
          // Sample the wall every metre against the deck half-width.
          const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]));
          for (let k = 0; k <= n; k++) {
            const t = k / Math.max(1, n);
            const x: [number, number] = [
              p[0] + (q[0] - p[0]) * t,
              p[1] + (q[1] - p[1]) * t,
            ];
            assert.ok(
              pointSegment(x, r, e.pts[i + 1])[0] > 5.2,
              `building ${bd.id} wall crosses the rail deck`,
            );
          }
        }
      }
    }
  }
});

void test('lot subdivision gives narrow street-front plots', () => {
  const block: [number, number][] = [
    [0, 0],
    [60, 0],
    [60, 40],
    [0, 40],
  ];
  const lots: Lot[] = [];
  const rule = {
    width: [6, 13] as [number, number],
    depth: 22,
    gap: 0,
    merge: 0,
  };
  splitLots(new Rng(3), block, [true, true, true, true], rule, lots);
  assert.ok(lots.length >= 10, `lots ${lots.length}`);
  let area = 0;
  for (const l of lots) {
    area += polygonArea(l.poly);
    assert.ok(
      l.frontage.some(f => f),
      'every lot faces a street',
    );
  }
  // No gaps: the lots tile the block.
  assert.ok(Math.abs(area - 60 * 40) < 1, `area ${area}`);
});
