import assert from 'node:assert/strict';
import {test} from 'node:test';
import {keepLeft, PRESETS} from '../../src/city/config.ts';
import {generateLayout} from '../../src/city/layout.ts';
import {computeRoadGeom} from '../../src/city/roadgeom.ts';
import {RoadNet} from '../../src/game/roadnet.ts';
import {Traffic} from '../../src/game/traffic.ts';
import type {VehicleRenderer} from '../../src/render/vehicles.ts';
import type {LayoutSummary} from '../../src/workers/city-worker.ts';

void test('only New York keeps right', () => {
  for (const [type, p] of Object.entries(PRESETS))
    assert.equal(keepLeft(p), type === 'metro' ? -1 : 1, type);
});

// One metro layout, its road network as generated (keep right) and the same
// layout marked keep-left.
const L = generateLayout(PRESETS.metro, 1);
const geom = computeRoadGeom(L);
const netOf = (drive: 'left' | 'right') =>
  new RoadNet(
    {
      layout: {...L, params: {...L.params, drive}},
      geom,
    } as unknown as LayoutSummary,
    L.terrain.heights,
  );
const right = netOf('right');
const left = netOf('left');

/** Signed lateral offset of p from the chain centreline, + = left of travel. */
function lateral(net: RoadNet, chain: number, dir: 1 | -1, s: number) {
  const q = net.lanePos(chain, dir, 0, s);
  const a = dir === 1 ? s : net.length(chain) - s;
  const c = net.smoothAt(chain, a);
  const rx = q.p[0] - c.p[0];
  const rz = q.p[2] - c.p[1];
  // Left of travel direction d is (dz, -dx) (RoadNet.lanePos).
  return rx * q.d[1] - rz * q.d[0];
}

void test('lanes are on the kerb side of the travel direction', () => {
  assert.equal(right.side, -1);
  assert.equal(left.side, 1);
  let n = 0;
  right.chains.forEach((c, ci) => {
    if (n > 200 || right.length(ci) < 20) return;
    n++;
    const s = right.length(ci) / 2;
    for (const dir of [1, -1] as const) {
      const r = lateral(right, ci, dir, s);
      const l = lateral(left, ci, dir, s);
      assert.ok(r < -0.5, `chain ${ci} dir ${dir}: ${r} not right of travel`);
      assert.ok(l > 0.5, `chain ${ci} dir ${dir}: ${l} not left of travel`);
      assert.ok(Math.abs(r + l) < 1e-9, 'mirror images');
    }
  });
});

void test('right-hand traffic keeps right and keeps moving', () => {
  const kinds = ['car', 'car', 'taxi', 'van', 'truck', 'bus'];
  const variants = kinds.map((kind, i) => ({
    info: {
      kind,
      name: kind + i,
      size: [1.8, 1.6, kind === 'bus' ? 11 : 4.5],
      wheels: [],
      palette: [[0.5, 0.5, 0.5]],
    },
  }));
  const vr = {
    variants,
    variantsOf: (k: string) =>
      variants.flatMap((v, i) => (v.info.kind === k ? [i] : [])),
    add() {},
  } as unknown as VehicleRenderer;
  const tr = new Traffic(right, vr);
  tr.target = 120;
  const hub = L.hubs[1] ?? L.hubs[0];
  const focus: [number, number, number] = [hub.p[0], 0, hub.p[1]];
  let t = 0;
  let travelled = 0;
  for (let i = 0; i < 30 * 30; i++) {
    tr.update(1 / 30, t, focus);
    t += 1 / 30;
    for (const c of tr.cars) travelled += c.f.speed / 30;
  }
  assert.ok(tr.cars.length > 60, `${tr.cars.length} cars`);
  // Mean speed over the run (signals stop about half the cars at a time).
  const mean = travelled / (30 * tr.cars.length);
  assert.ok(mean > 2, `mean speed ${mean} m/s`);
  for (const c of tr.cars) {
    const f = c.f;
    if (f.turn) continue;
    const a = f.ref.dir === 1 ? f.s : right.length(f.ref.chain) - f.s;
    const q = right.smoothAt(f.ref.chain, a);
    const d = f.ref.dir === 1 ? q.d : [-q.d[0], -q.d[1]];
    const side = (f.pos[0] - q.p[0]) * d[1] - (f.pos[2] - q.p[1]) * d[0];
    assert.ok(side < 0, 'car left of the centreline');
  }
});
