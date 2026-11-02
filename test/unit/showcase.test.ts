import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Highlights, Place} from '../../src/game/highlights.ts';
import {
  Programme,
  SCENE_DEFS,
  SCENE_KINDS,
  Showcase,
  shuffleLoop,
  sunsetHour,
  type Scene,
  type ShowcaseHost,
} from '../../src/game/showcase.ts';
import {Rng} from '../../src/math/random.ts';
import {sunDirection} from '../../src/world/sky.ts';

const place = (
  kind: Place['kind'],
  x: number,
  z: number,
  score = 1,
): Place => ({
  kind,
  name: `${kind} ${x},${z}`,
  p: [x, 0, z],
  score,
});

/** Two places of every kind, 2 km apart. */
function highlights(): Highlights {
  const kinds: Place['kind'][] = [
    'expressway',
    'bridge',
    'station',
    'park',
    'signs',
    'towers',
    'waterfront',
    'junction',
  ];
  const h = {} as Highlights;
  for (const k of kinds) h[k] = [place(k, 0, 0), place(k, 2000, 0)];
  return h;
}

void test('a loop plays every scene once, moods mostly alternating', () => {
  const rng = new Rng(1);
  for (let i = 0; i < 20; i++) {
    const loop = shuffleLoop(rng, SCENE_KINDS, 'rain');
    assert.deepEqual([...loop].sort(), [...SCENE_KINDS].sort());
    assert.notEqual(loop[0], 'rain');
    let same = 0;
    for (let k = 1; k < loop.length; k++)
      if (SCENE_DEFS[loop[k]].mood === SCENE_DEFS[loop[k - 1]].mood) same++;
    // 5 day, 2 dusk, 3 night scenes: at most one day pair is unavoidable.
    assert.ok(same <= 1, `adjacent moods ${same}: ${loop.join(' ')}`);
  }
});

void test('the programme loops through the playable kinds', () => {
  const hl = highlights();
  hl.station = [];
  const p = new Programme(hl, 5, {maxJump: Infinity});
  assert.ok(!p.playable().includes('train'));
  const seen = Array.from({length: 18}, () => p.nextKind()!);
  assert.deepEqual([...seen.slice(0, 9)].sort(), [...p.playable()].sort());
  assert.deepEqual([...seen.slice(9, 18)].sort(), [...p.playable()].sort());
});

void test('phones only jump nearby; places are not repeated at once', () => {
  const hl = highlights();
  const p = new Programme(hl, 9, {maxJump: 1600});
  for (let i = 0; i < 10; i++) {
    const q = p.pickPlace('bridge', [100, 0])!;
    assert.ok(Math.hypot(q.p[0] - 100, q.p[2]) <= 1600, q.name);
  }
  const far = new Programme(hl, 9, {maxJump: Infinity});
  const a = far.pickPlace('park', [0, 0]);
  const b = far.pickPlace('park', [0, 0]);
  assert.notEqual(a, b);
});

void test('sunset hour puts the sun low in the evening', () => {
  const h = sunsetHour(0.07);
  assert.ok(h > 16 && h < 20, String(h));
  assert.ok(Math.abs(sunDirection(h)[1] - 0.07) < 0.005);
});

/** A host whose locations become ready on demand. */
function fakeHost() {
  const log: string[] = [];
  const host = {
    readyNow: true,
    speed: 10,
    canTake: true,
    started: [] as Scene[],
    build: (kind, p) => ({
      kind,
      place: p,
      subject: SCENE_DEFS[kind].subject,
      hour: 12,
      weather: 'sunny',
      shots: [
        {name: 'chase', dur: 5},
        {name: 'side', dur: 5},
      ],
      focus: [p.p],
      stopLimit: 2,
    }),
    ready: () => host.readyNow,
    prefetch: f => log.push(`prefetch ${f.length}`),
    start: sc => host.started.push(sc),
    subjectSpeed: () => host.speed,
    takeOver: () => {
      log.push('take');
      return host.canTake;
    },
    position: () => [0, 0],
  } as ShowcaseHost & {
    readyNow: boolean;
    speed: number;
    canTake: boolean;
    started: Scene[];
  };
  return {host, log};
}

function run(sc: Showcase, secs: number) {
  for (let t = 0; t < secs; t += 0.1) sc.update(0.1);
}

void test('cuts when the scene ends and the next place is ready', () => {
  const {host} = fakeHost();
  const sc = new Showcase(
    host,
    new Programme(highlights(), 3, {maxJump: Infinity}),
  );
  sc.begin(host.build('expressway', place('expressway', 0, 0), new Rng(1))!);
  assert.ok(sc.next);
  run(sc, 9.5);
  assert.equal(host.started.length, 0);
  run(sc, 1);
  assert.equal(host.started.length, 1);
});

void test('waits for the next place, then skips to another after a timeout', () => {
  const {host} = fakeHost();
  host.readyNow = false;
  const sc = new Showcase(
    host,
    new Programme(highlights(), 3, {maxJump: Infinity}),
  );
  sc.begin(host.build('expressway', place('expressway', 0, 0), new Rng(1))!);
  const first = sc.next!;
  run(sc, 15);
  assert.equal(host.started.length, 0);
  run(sc, 5);
  assert.notEqual(sc.next, first);
  assert.match(sc.note, /timeout/);
  host.readyNow = true;
  run(sc, 0.2);
  assert.equal(host.started.length, 1);
});

void test('a stopped car is swapped for a moving one', () => {
  const {host, log} = fakeHost();
  host.readyNow = false;
  const sc = new Showcase(
    host,
    new Programme(highlights(), 3, {maxJump: Infinity}),
  );
  sc.begin(host.build('signs', place('signs', 0, 0), new Rng(1))!);
  host.speed = 0;
  run(sc, 2.5);
  assert.ok(log.includes('take'));
  assert.equal(host.started.length, 0);
  // With the next place ready, a stop moves on to it instead.
  host.readyNow = true;
  log.length = 0;
  run(sc, 2.5);
  assert.equal(host.started.length, 1);
});
