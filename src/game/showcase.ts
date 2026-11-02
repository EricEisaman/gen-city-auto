// Showcase director: a curated programme of scenes for the unattended demo.
// Each scene is a place (game/highlights.ts), a subject (a car, the
// helicopter, a train or none), a time of day, weather and a few planned
// shots from wide to close. The next scene's location streams in while the
// current one plays; the cut happens once it is ready (or another scene is
// picked after a timeout). Subjects must keep moving: a stopped car is
// swapped for a moving one or the programme moves on.

import {Rng} from '../math/random.ts';
import type {Vec2, Vec3} from '../math/vec.ts';
import {sunDirection} from '../world/sky.ts';
import type {HighlightKind, Highlights, Place} from './highlights.ts';
import type {WeatherKind} from './weather.ts';

export type SceneKind =
  | 'expressway'
  | 'heli'
  | 'train'
  | 'junction'
  | 'bridge'
  | 'park'
  | 'signs'
  | 'rain'
  | 'nightAerial'
  | 'sunset';

export type Subject = 'car' | 'heli' | 'train' | 'none';

export const SCENE_KINDS: SceneKind[] = [
  'expressway',
  'heli',
  'train',
  'junction',
  'bridge',
  'park',
  'signs',
  'rain',
  'nightAerial',
  'sunset',
];

type Mood = 'day' | 'dusk' | 'night';

interface SceneDef {
  subject: Subject;
  mood: Mood;
  /** Highlight kinds the scene can be set at, in order of preference. */
  places: HighlightKind[];
}

export const SCENE_DEFS: Record<SceneKind, SceneDef> = {
  expressway: {subject: 'car', mood: 'day', places: ['expressway']},
  heli: {subject: 'heli', mood: 'day', places: ['towers', 'waterfront']},
  train: {subject: 'train', mood: 'day', places: ['station']},
  junction: {subject: 'car', mood: 'dusk', places: ['junction']},
  bridge: {subject: 'car', mood: 'day', places: ['bridge', 'waterfront']},
  park: {subject: 'car', mood: 'day', places: ['park']},
  signs: {subject: 'car', mood: 'night', places: ['signs']},
  rain: {subject: 'car', mood: 'night', places: ['signs', 'junction']},
  nightAerial: {subject: 'none', mood: 'night', places: ['expressway']},
  sunset: {subject: 'none', mood: 'dusk', places: ['towers']},
};

/** One planned shot (camera.ts shot names; 'vista' is a free camera move). */
export interface ShotPlan {
  name: string;
  dur: number;
  /** Vista: start eye, look point, eye drift (m/s) and field of view. */
  eye?: Vec3;
  look?: Vec3;
  move?: Vec3;
  fov?: number;
}

export interface Scene {
  kind: SceneKind;
  place: Place;
  subject: Subject;
  hour: number;
  weather: WeatherKind;
  shots: ShotPlan[];
  /** Car scenes: the lane the car starts on and its speed. */
  lane?: {chain: number; dir: 1 | -1; lane: number; s: number; speed: number};
  /** Car scenes: make the car signal a turn at the first junction. */
  signal?: boolean;
  /** Helicopter scenes: start, heading and wander area. */
  heli?: {p: Vec3; dir: Vec2; area: {c: Vec2; r: number; h: number}};
  /** Train scenes: approach distance to the station. */
  approach?: number;
  /** Points to stream around before cutting here. */
  focus: Vec3[];
  /** Seconds the subject may stand still before the director moves on. */
  stopLimit: number;
}

/** Planned length of a scene (its shots back to back). */
export const sceneLength = (s: Scene) => s.shots.reduce((a, b) => a + b.dur, 0);

/**
 * One loop of the programme: every kind once, shuffled so that two scenes
 * of the same mood (day, dusk, night) rarely follow each other and the
 * loop does not start with the kind the last one ended with.
 */
export function shuffleLoop(
  rng: Rng,
  kinds: readonly SceneKind[],
  prev?: SceneKind,
): SceneKind[] {
  let best: SceneKind[] = [...kinds];
  let bestCost = Infinity;
  for (let k = 0; k < 400; k++) {
    const a = [...kinds];
    for (let i = a.length - 1; i > 0; i--) {
      const j = rng.int(0, i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    let cost = prev && a[0] === prev ? 10 : 0;
    const moods = a.map(x => SCENE_DEFS[x].mood);
    if (prev && SCENE_DEFS[prev].mood === moods[0]) cost += 1;
    for (let i = 1; i < a.length; i++) if (moods[i] === moods[i - 1]) cost++;
    if (cost < bestCost) {
      bestCost = cost;
      best = a;
    }
    if (cost === 0) break;
  }
  return best;
}

/** Evening hour at which the sun stands `elev` (sine) above the horizon. */
export function sunsetHour(elev = 0.07): number {
  let lo = 15;
  let hi = 21;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (sunDirection(m)[1] > elev) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

export interface ProgrammeOptions {
  /** Phones: farthest jump between scenes (m); Infinity elsewhere. */
  maxJump: number;
}

/** Which scene comes next and where (pure: the showcase's own RNG). */
export class Programme {
  readonly rng: Rng;
  private queue: SceneKind[] = [];
  private last?: SceneKind;
  /** Recently used places (not repeated within a few scenes). */
  private recent: Place[] = [];
  private hl: Highlights;
  private opts: ProgrammeOptions;

  constructor(hl: Highlights, seed: number, opts: ProgrammeOptions) {
    this.hl = hl;
    this.rng = new Rng(seed);
    this.opts = opts;
  }

  /** Kinds this city can show (some cities have no rail or no bridges). */
  playable(): SceneKind[] {
    return SCENE_KINDS.filter(k =>
      SCENE_DEFS[k].places.some(p => this.hl[p].length > 0),
    );
  }

  /** The next kind in the shuffled loop (a new loop when one ends). */
  nextKind(): SceneKind | null {
    if (!this.queue.length) {
      const kinds = this.playable();
      if (!kinds.length) return null;
      this.queue = shuffleLoop(this.rng, kinds, this.last);
    }
    this.last = this.queue.shift()!;
    return this.last;
  }

  /**
   * A place for `kind`, weighted by merit, not one of the last few used and
   * (on phones) within maxJump of `from`; the nearest one if none is.
   */
  pickPlace(
    kind: SceneKind,
    from: Vec2,
    skip: Place[] = [],
    within = this.opts.maxJump,
  ): Place | null {
    const all = SCENE_DEFS[kind].places
      .flatMap(p => this.hl[p])
      .filter(p => !skip.includes(p));
    if (!all.length) return null;
    const dist = (p: Place) => Math.hypot(p.p[0] - from[0], p.p[2] - from[1]);
    let list = all.filter(p => !this.recent.includes(p) && dist(p) <= within);
    if (!list.length) list = all.filter(p => dist(p) <= within);
    if (!list.length)
      list = [all.reduce((a, b) => (dist(a) < dist(b) ? a : b))];
    // The first place kind is preferred (e.g. towers over waterfront).
    const first = SCENE_DEFS[kind].places[0];
    const p = this.rng.weighted(
      list,
      list.map(q => Math.max(0.05, q.score) * (q.kind === first ? 2 : 1)),
    );
    this.recent.unshift(p);
    this.recent.length = Math.min(this.recent.length, 6);
    return p;
  }
}

/** What the showcase needs from the game. */
export interface ShowcaseHost {
  /** Concrete scene for a kind at a place (lanes, vistas), or null if it doesn't work there. */
  build(kind: SceneKind, place: Place, rng: Rng): Scene | null;
  /** True once a cut to these points shows finished geometry. */
  ready(focus: Vec3[]): boolean;
  /** Stream around these points (the next scene) besides the camera. */
  prefetch(focus: Vec3[]): void;
  /** Cut to the scene: time, weather, subject, traffic, camera plan. */
  start(scene: Scene): void;
  /** Speed of the filmed subject (m/s; Infinity for no subject). */
  subjectSpeed(): number;
  /** Film another, moving vehicle nearby; false if there is none. */
  takeOver(): boolean;
  /** Where the camera's subject is (x, z). */
  position(): Vec2;
}

/** Seconds past a scene's planned end to wait for the next location. */
const WAIT = 8;

export class Showcase {
  readonly programme: Programme;
  private host: ShowcaseHost;
  current: Scene | null = null;
  next: Scene | null = null;
  /** Seconds into the current scene. */
  t = 0;
  /** Seconds the subject has been (nearly) still. */
  stopped = 0;
  /** Seconds waited past the current scene's end. */
  private waited = 0;
  /** Scenes started (for logs and tests). */
  count = 0;
  /** Last decision, for logs. */
  note = '';
  /** The subject's speed last update (m/s). */
  speed = 0;

  constructor(host: ShowcaseHost, programme: Programme) {
    this.host = host;
    this.programme = programme;
  }

  /**
   * Begin with the scene already on screen (no cut): `scene` describes it
   * for timing; the next scene starts streaming now.
   */
  begin(scene: Scene) {
    this.current = scene;
    this.t = 0;
    this.stopped = 0;
    this.waited = 0;
    this.prepare();
  }

  /** Choose and stream the next scene (avoiding `skip` places). */
  private prepare(skip: Place[] = [], within?: number) {
    this.next = null;
    for (let tries = 0; tries < 6 && !this.next; tries++) {
      const kind = this.programme.nextKind();
      if (!kind) break;
      const place = this.programme.pickPlace(
        kind,
        this.host.position(),
        skip,
        within,
      );
      if (!place) continue;
      this.next = this.host.build(kind, place, this.programme.rng);
      if (!this.next) skip = [...skip, place];
    }
    this.host.prefetch(this.next?.focus ?? []);
  }

  private go() {
    const sc = this.next!;
    this.current = sc;
    this.next = null;
    this.t = 0;
    this.stopped = 0;
    this.waited = 0;
    this.count++;
    this.host.start(sc);
    this.prepare();
  }

  /** Stop (user input): the next begin() starts over from what is on screen. */
  end() {
    this.current = null;
    this.next = null;
    this.host.prefetch([]);
  }

  /** What is on screen, for logs and tests (null when not running). */
  status() {
    const c = this.current;
    if (!c) return null;
    return {
      scene: c.kind,
      place: c.place.name,
      subject: c.subject,
      subjectSpeed: c.subject === 'none' ? Infinity : this.speed,
      t: this.t,
      next: this.next?.kind ?? null,
      count: this.count,
      note: this.note,
    };
  }

  update(dt: number) {
    const cur = this.current;
    if (!cur) return;
    this.t += dt;
    const v = this.host.subjectSpeed();
    this.speed = v;
    this.stopped = v < 1 ? this.stopped + dt : 0;
    const ready = !!this.next && this.host.ready(this.next.focus);
    const len = sceneLength(cur);
    if (this.stopped > cur.stopLimit) {
      // Never film a subject standing still: the next scene if it is ready
      // and this one has had its say, else another moving car nearby.
      if (ready && this.t > len * 0.4) {
        this.note = 'stopped: next scene';
        this.go();
        return;
      }
      if (cur.subject === 'car' && this.host.takeOver()) {
        this.note = 'stopped: took over a moving car';
        this.stopped = 0;
        return;
      }
    }
    if (this.t < len) return;
    if (ready) {
      this.note = 'cut';
      this.go();
      return;
    }
    this.waited += dt;
    if (this.waited > WAIT) {
      // The next place is slow to stream: pick another one (the nearest
      // places to here are resident already).
      this.note = `timeout: skipped ${this.next?.kind ?? 'none'}`;
      this.waited = 0;
      const skip = this.next ? [this.next.place] : [];
      this.prepare(skip, 600);
      if (this.next && this.host.ready(this.next.focus)) this.go();
    }
  }
}
