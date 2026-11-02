// Road furniture that belongs to one direction of travel stands on, faces
// and hangs over that traffic's own side, for both driving sides: checked
// against the lanes RoadNet actually drives.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nearside, PRESETS} from '../../src/city/config.ts';
import {signalSpots} from '../../src/city/gen-base.ts';
import {guideSpots} from '../../src/city/gen-tile.ts';
import {generateLayout, Road} from '../../src/city/layout.ts';
import {chainAt, computeRoadGeom} from '../../src/city/roadgeom.ts';
import {RoadNet} from '../../src/game/roadnet.ts';
import type {LayoutSummary} from '../../src/workers/city-worker.ts';

const base = generateLayout(PRESETS.metro, 1);
const geom = computeRoadGeom(base);
const hf = base.terrain.heights;
type V2 = readonly [number, number];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
/** World-space left of travel direction d (y up, right-handed). */
const leftOf = (d: V2): V2 => [d[1], -d[0]];

for (const drive of ['left', 'right'] as const) {
  const L = {...base, params: {...base.params, drive}};
  const net = new RoadNet({layout: L, geom} as unknown as LayoutSummary, hf);
  /** Curb lane point of traffic on chain ci travelling dir, s along it. */
  const lane = (ci: number, dir: 1 | -1, s: number) => {
    const q = net.lanePos(ci, dir, 0, s);
    return [q.p[0], q.p[2]] as V2;
  };
  const sgn = drive === 'left' ? 1 : -1;

  void test(`${drive}: lanes keep to nearside()`, () => {
    let n = 0;
    L.chains.forEach((c, ci) => {
      if (n > 200 || net.length(ci) < 20) return;
      n++;
      const total = net.length(ci);
      const q = chainAt(c, geom.arc[ci], total / 2);
      for (const dir of [1, -1] as const) {
        const d: V2 = [q.d[0] * dir, q.d[1] * dir];
        const p = lane(ci, dir, total / 2);
        const off: V2 = [p[0] - q.p[0], p[1] - q.p[1]];
        assert.ok(dot(off, nearside(L.params, d)) > 0.5, `chain ${ci}`);
        assert.ok(dot(off, leftOf(d)) * sgn > 0.5, `chain ${ci} ${drive}`);
      }
    });
  });

  void test(`${drive}: signal heads on the far nearside corner, over the reader's lanes`, () => {
    let n = 0;
    let over = 0;
    L.junctions.forEach((j, ji) => {
      const jg = geom.junctions[ji];
      signalSpots(L, geom, hf, ji, (p, armDir, reach, k, face) => {
        const a = jg.arms[k];
        // The reader crosses the box toward this arm, along a.dir.
        const v: V2 = a.dir;
        assert.ok(dot(face, v) < -0.99, 'heads face the reader');
        const along = (p[0] - j.p[0]) * v[0] + (p[2] - j.p[1]) * v[1];
        assert.ok(along > a.setback, 'pole past the box');
        // The reader's departing lane on this arm, level with the pole, in
        // the lane's own frame (arms may curve away from a.dir).
        const dir = a.end === 0 ? 1 : -1;
        const len = net.length(a.chain);
        const c = net.smoothAt(a.chain, dir === 1 ? along : len - along);
        const d: V2 = [c.d[0] * dir, c.d[1] * dir];
        const rel = (x: number, z: number) =>
          dot([x - c.p[0], z - c.p[1]], leftOf(d));
        const lp = lane(a.chain, dir, along);
        const lat = rel(lp[0], lp[1]);
        const pole = rel(p[0], p[2]);
        // The head hangs 0.7 m in from the arm's end (gen-tile signal()).
        const r = reach - 0.7;
        const head = rel(p[0] + armDir[0] * r, p[2] + armDir[1] * r);
        assert.ok(lat * sgn > 0.5, 'reader keeps to its side');
        assert.ok(
          pole * lat > 0,
          `junction ${ji} arm ${k}: pole on the far side`,
        );
        assert.ok(Math.abs(head) < Math.abs(pole), 'the arm reaches in');
        // (A long arm on an odd junction may reach past the centreline.)
        if (head * lat > 0) over++;
        n++;
      });
    });
    assert.ok(n > 50, `${n} signal poles`);
    assert.ok(over > n * 0.98, `${over} of ${n} heads over the reader's lanes`);
  });

  void test(`${drive}: guide signs on the reader's kerb`, () => {
    let n = 0;
    L.chains.forEach((c, ci) => {
      if (c.kind < Road.avenue) return;
      const arc = geom.arc[ci];
      const total = arc[arc.length - 1];
      for (const g of guideSpots(L, geom, ci)) {
        const q = chainAt(c, arc, g.s);
        // The tile's frame: kerb side g.side of l (-dz, dx).
        const l: V2 = [-q.d[1], q.d[0]];
        const d: V2 = [q.d[0] * g.dir, q.d[1] * g.dir];
        const lp = lane(ci, g.dir, g.dir === 1 ? g.s : total - g.s);
        const lat = dot([lp[0] - q.p[0], lp[1] - q.p[1]], l);
        assert.ok(
          lat * g.side > 0,
          `chain ${ci} at ${g.s}: sign off the lanes`,
        );
        assert.ok(dot(l, nearside(L.params, d)) * g.side > 0.99);
        n++;
      }
    });
    assert.ok(n > 10, `${n} guide signs`);
  });
}
