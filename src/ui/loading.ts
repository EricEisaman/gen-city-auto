// Loading screen: a progress bar weighted by how long each phase really takes
// (it creeps on between updates so it never sits still), the city's map
// drawn as the generator finishes each part (terrain, streets, rail, blocks,
// buildings, then tiles lighting up as their meshes arrive), and control tips.
// Cheap on purpose: a 2D canvas redrawn only when something changes.

import {TILE_SIZE} from '../city/gen-tile.ts';
import type {Preview} from '../city/preview.ts';
import type {LoadListener} from '../world/city.ts';
import {counters, timed} from './timeline.ts';

/**
 * The generation steps the primary city worker reports, with their share of
 * the layout + base phase (measured on an M1 Max, neon seed 1, while the
 * vehicle workers run, scaled by 1.7; only the proportions matter, the bar
 * adapts to the device's speed). The terrain is shaded by every worker;
 * 'Layout done' includes sending the layout to the other workers.
 */
const STEPS: [string, number][] = [
  ['Shaping terrain', 5.0],
  ['Tracing streets', 2.7],
  ['Connecting streets', 1.1],
  ['Grading roads', 1.2],
  ['Elevated rail and expressways', 0.6],
  ['Subdividing blocks', 1.6],
  ['Grading blocks', 3.8],
  ['Designing buildings', 2.2],
  ['Open ground', 0.8],
  ['Layout done', 1.1],
  ['Building street meshes', 4.1],
  ['Uploading city', 0.9],
];
const STEP_TOTAL = STEPS.reduce((a, s) => a + s[1], 0);

/** Overall bar: [start, end] of each phase. */
const PHASE = {
  gpu: [0, 0.02],
  layout: [0.02, 0.85],
  tiles: [0.85, 0.97],
  finish: [0.97, 1],
} as const;

const TIPS_KEYS = [
  'Let go of the controls and the car drives itself while the director films it.',
  '<b>C</b> cycles cameras. The last one flies free: drag to look, wheel sets the speed.',
  '<b>V</b> swaps car and helicopter. <b>B</b> picks the next vehicle.',
  '<b>T</b> jumps an hour ahead. <b>Y</b> changes the weather.',
  '<b>L</b> copies a link to exactly what you are looking at.',
  '<b>N</b> generates a whole new city. <b>M</b> opens the menu and graphics settings.',
  '<b>K</b> turns the auto director on and off.',
];
const TIPS_ANY = [
  'Every city comes from its seed: the same seed always builds the same city.',
  'Every vehicle is built from NURBS surfaces while you wait.',
  'No stored models or textures: the streets, buildings and signs are all generated.',
  'At night thousands of street lights, signs and windows light the city.',
];

const COLORS = {
  bg: '#0a0f1c',
  grid: 'rgba(120,150,210,0.08)',
  water: [18, 34, 62],
  low: [30, 37, 52],
  high: [70, 74, 86],
  block: 'rgba(60,70,95,0.55)',
  park: 'rgba(40,96,64,0.6)',
  road: 'rgba(225,230,245,0.55)',
  rail: '#7fd3ff',
  expressway: '#ffd36e',
  tile: '255,211,110',
};

const now = () => performance.now();

/** Wait until the browser has had a chance to paint (or 50 ms, hidden tabs). */
export function nextPaint(): Promise<void> {
  return new Promise(res => {
    const t = setTimeout(res, 50);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(t);
        res();
      }, 0),
    );
  });
}

class LoadingScreen implements LoadListener {
  private root = () => document.getElementById('loading');
  private el = (id: string) => document.getElementById(id);
  private raf = 0;
  private visible = false;
  private key = '';
  // Bar state.
  private shown = 0;
  private target = 0;
  private ceil = 0.02;
  private tau = 1;
  private last = 0;
  private phaseName: keyof typeof PHASE = 'gpu';
  // Layout step timing (device speed estimate).
  private stepIdx = -1;
  private layoutT0 = 0;
  private speed = 1;
  private tileFrac = 0;
  private tilesSeen = 0;
  // Map.
  private size = 0;
  private layers = new Map<string, HTMLCanvasElement>();
  private fades = new Map<string, number>();
  private tileAt = new Map<number, number>();
  private tilesPerSide = 0;
  private dirty = false;
  private tipTimer = 0;
  private tipIdx = 0;

  /** Show the screen for a city (no-op if already showing that city). */
  show(cityName: string, seed: number) {
    const key = `${cityName}#${seed}`;
    const root = this.root();
    if (!root) return;
    root.style.display = '';
    if (this.visible && key === this.key) return;
    this.key = key;
    this.visible = true;
    const city = this.el('loadcity');
    if (city) city.textContent = `${cityName} · seed ${seed}`;
    this.shown = this.target = 0;
    this.ceil = PHASE.gpu[1];
    this.tau = 1;
    this.phaseName = 'gpu';
    this.stepIdx = -1;
    this.layoutT0 = 0;
    this.speed = 1;
    this.tileFrac = 0;
    this.tilesSeen = 0;
    this.size = 0;
    this.layers.clear();
    this.fades.clear();
    this.tileAt.clear();
    this.tilesPerSide = 0;
    root.classList.add('active', 'scanning');
    this.dirty = true;
    this.startTips();
    this.last = now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(t => this.tick(t));
  }

  hide() {
    this.visible = false;
    cancelAnimationFrame(this.raf);
    clearInterval(this.tipTimer);
    const root = this.root();
    if (root) {
      root.style.display = 'none';
      root.classList.remove('active', 'scanning');
    }
  }

  /** Set the phase label (and enter a phase). */
  phase(label: string, name?: keyof typeof PHASE) {
    if (name && name !== this.phaseName) {
      this.phaseName = name;
      const [a, b] = PHASE[name];
      this.target = Math.max(this.target, a);
      this.ceil = name === 'finish' ? b - 0.005 : a + (b - a) * 0.15;
      this.tau = name === 'finish' ? 1.5 : 3;
    }
    const m = this.el('loadmsg');
    if (m) m.textContent = label;
  }

  // ---- LoadListener (city workers) ----

  step(msg: string, f: number, sub?: number) {
    const [a, b] = PHASE.layout;
    if (this.phaseName === 'gpu') {
      this.phaseName = 'layout';
      this.layoutT0 = now();
    }
    if (sub !== undefined) {
      this.subStep(msg, sub);
      return;
    }
    this.phase(msg);
    let i = STEPS.findIndex(s => s[0] === msg);
    let start: number, end: number;
    if (i < 0) {
      // Unknown step: trust the worker's own estimate.
      start = Math.min(1, f / 0.75);
      end = Math.min(1, start + 0.05);
      i = this.stepIdx;
    } else {
      let cum = 0;
      for (let k = 0; k < i; k++) cum += STEPS[k][1];
      start = cum / STEP_TOTAL;
      end = (cum + STEPS[i][1]) / STEP_TOTAL;
      // Device speed: time so far against the reference.
      const el = (now() - this.layoutT0) / 1000;
      if (cum > 2 && el > 0) this.speed = Math.min(6, Math.max(0.3, el / cum));
      this.tau = Math.max(0.3, STEPS[i][1] * this.speed);
    }
    this.stepIdx = i;
    this.target = Math.max(this.target, a + (b - a) * start);
    this.ceil = a + (b - a) * end;
  }

  /** How far the current layout step has got: label and bar move on. */
  private subStep(msg: string, sub: number) {
    const i = STEPS.findIndex(s => s[0] === msg);
    if (i < 0 || i !== this.stepIdx) return;
    this.phase(`${msg} ${Math.floor(sub * 100)}%`);
    const [a, b] = PHASE.layout;
    let cum = 0;
    for (let k = 0; k < i; k++) cum += STEPS[k][1];
    const at = (cum + STEPS[i][1] * Math.min(1, sub)) / STEP_TOTAL;
    this.target = Math.max(this.target, a + (b - a) * at);
  }

  preview(p: Preview) {
    this.size = p.size;
    const c = this.layer(p.kind === 'streets' ? 'roads' : p.kind);
    if (!c) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    timed(`map: ${p.kind}`, () => {
      if (p.kind === 'terrain') {
        this.root()?.classList.remove('scanning');
        this.drawTerrain(c, p.n, p.h, p.sea);
      } else this.drawShapes(g, c.width, p);
    });
    this.fades.set(p.kind === 'streets' ? 'roads' : p.kind, now());
    this.dirty = true;
  }

  tiles(f: number) {
    if (this.phaseName !== 'tiles')
      this.phase('Building the streets and buildings', 'tiles');
    this.tileFrac = Math.max(this.tileFrac, f);
    const [a, b] = PHASE.tiles;
    this.target = Math.max(this.target, a + (b - a) * this.tileFrac);
    this.ceil = a + (b - a) * Math.min(1, this.tileFrac + 0.12);
    this.tau = 1;
  }

  tile(tile: number, tilesPerSide: number) {
    this.tilesPerSide = tilesPerSide;
    this.tilesSeen++;
    if (!this.tileAt.has(tile)) this.tileAt.set(tile, now());
    this.dirty = true;
  }

  // ---- animation ----

  private tick(t: number) {
    if (!this.visible) return;
    const dt = Math.min(0.25, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    if (this.shown < this.target)
      this.shown += (this.target - this.shown) * Math.min(1, dt * 5);
    else if (this.shown < this.ceil)
      this.shown =
        this.ceil - (this.ceil - this.shown) * Math.exp(-dt / this.tau);
    const bar = this.el('loadbar');
    if (bar) bar.style.width = `${(this.shown * 100).toFixed(2)}%`;
    const d = this.el('loaddetail');
    if (d) d.textContent = this.detail();
    this.compose(t);
    this.raf = requestAnimationFrame(tt => this.tick(tt));
  }

  private detail() {
    const parts: string[] = [`${Math.floor(this.shown * 100)}%`];
    const p = counters.pipelines;
    if (p.total) parts.push(`shaders ${p.done}/${p.total}`);
    const v = counters.vehicles;
    if (v.total) parts.push(`vehicles ${v.done}/${v.total}`);
    if (this.tilesSeen) parts.push(`tiles ${this.tilesSeen}`);
    return parts.join(' · ');
  }

  private startTips() {
    const el = this.el('loadtip');
    if (!el) return;
    const touch = matchMedia('(pointer: coarse)').matches;
    const tips = touch ? TIPS_ANY : [...TIPS_KEYS, ...TIPS_ANY];
    // Interleave: shuffle once per load, start with a controls tip.
    const order = tips.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const showTip = () => {
      el.classList.remove('show');
      setTimeout(() => {
        el.innerHTML = tips[order[this.tipIdx++ % order.length]];
        el.classList.add('show');
      }, 400);
    };
    clearInterval(this.tipTimer);
    showTip();
    this.tipTimer = window.setInterval(showTip, 6000);
  }

  // ---- map ----

  private canvas() {
    return this.el('loadmap') as HTMLCanvasElement | null;
  }

  /** Square backing size of the map (CSS size x DPR, capped). */
  private px() {
    const c = this.canvas();
    if (!c) return 0;
    const n = Math.min(
      1024,
      Math.round(c.clientWidth * Math.min(2, devicePixelRatio || 1)),
    );
    if (n > 0 && c.width !== n) {
      c.width = c.height = n;
      this.dirty = true;
    }
    return c.width;
  }

  private layer(name: string) {
    let c = this.layers.get(name);
    const n = this.px();
    if (!n) return null;
    if (!c) {
      c = document.createElement('canvas');
      this.layers.set(name, c);
    }
    c.width = c.height = n;
    return c;
  }

  private drawTerrain(
    c: HTMLCanvasElement,
    n: number,
    h: Float32Array,
    sea: number,
  ) {
    const img = new ImageData(n, n);
    let hi = sea + 1;
    for (const v of h) hi = Math.max(hi, v);
    const W = COLORS.water,
      L = COLORS.low,
      H = COLORS.high;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const v = h[k];
        let r, g, b;
        if (v <= sea + 0.3) [r, g, b] = W;
        else {
          // Height tint plus a simple north-west hillshade.
          const t = Math.min(1, (v - sea) / (hi - sea));
          const dx =
            h[j * n + Math.min(n - 1, i + 1)] - h[j * n + Math.max(0, i - 1)];
          const dz =
            h[Math.min(n - 1, j + 1) * n + i] - h[Math.max(0, j - 1) * n + i];
          const s = Math.max(-0.35, Math.min(0.35, (dx + dz) * -0.02));
          r = (L[0] + (H[0] - L[0]) * t) * (1 + s);
          g = (L[1] + (H[1] - L[1]) * t) * (1 + s);
          b = (L[2] + (H[2] - L[2]) * t) * (1 + s);
        }
        img.data[k * 4] = r;
        img.data[k * 4 + 1] = g;
        img.data[k * 4 + 2] = b;
        img.data[k * 4 + 3] = 255;
      }
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = n;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(tmp, 0, 0, c.width, c.height);
  }

  private drawShapes(
    g: CanvasRenderingContext2D,
    n: number,
    p: Extract<Preview, {pts: Float32Array}>,
  ) {
    const k = n / p.size;
    const o = p.size / 2;
    const count = p.offs.length - 1;
    // Paths of a few hundred shapes each: one path with tens of thousands of
    // polygons took Skia seconds to fill.
    const path = (filter: (v: number) => boolean, close: boolean) => {
      const out: Path2D[] = [];
      let P = new Path2D();
      let m = 0;
      for (let s = 0; s < count; s++) {
        if (!filter(p.val[s])) continue;
        const a = p.offs[s],
          b = p.offs[s + 1];
        for (let q = a; q < b; q++) {
          const x = (p.pts[q * 2] + o) * k;
          const y = (p.pts[q * 2 + 1] + o) * k;
          if (q === a) P.moveTo(x, y);
          else P.lineTo(x, y);
        }
        if (close) P.closePath();
        if (++m === 256) {
          out.push(P);
          P = new Path2D();
          m = 0;
        }
      }
      if (m) out.push(P);
      return out;
    };
    const fill = (ps: Path2D[]) => ps.forEach(P => g.fill(P));
    const stroke = (ps: Path2D[]) => ps.forEach(P => g.stroke(P));
    const px = n / 512;
    g.lineCap = g.lineJoin = 'round';
    switch (p.kind) {
      case 'streets':
      case 'roads':
        // Road classes 0..3 (lane .. boulevard): wider and brighter.
        for (let cls = 0; cls <= 3; cls++) {
          g.strokeStyle = COLORS.road;
          g.globalAlpha = 0.45 + cls * 0.18;
          g.lineWidth = px * (0.5 + cls * 0.45);
          stroke(path(v => v === cls, false));
        }
        g.globalAlpha = 1;
        break;
      case 'rail':
        g.lineWidth = px * 1.6;
        g.strokeStyle = COLORS.expressway;
        stroke(path(v => v === 0, false));
        g.strokeStyle = COLORS.rail;
        g.setLineDash([px * 3, px * 2]);
        stroke(path(v => v === 1, false));
        g.setLineDash([]);
        break;
      case 'blocks':
        g.fillStyle = COLORS.block;
        fill(path(v => v === 0, true));
        g.fillStyle = COLORS.park;
        fill(path(v => v === 1, true));
        break;
      case 'buildings': {
        // Height bands: low = slate, towers = warm white.
        const bands: [number, number, string][] = [
          [0, 15, 'rgba(92,104,136,0.7)'],
          [15, 40, 'rgba(122,136,170,0.8)'],
          [40, 90, 'rgba(176,188,218,0.9)'],
          [90, 1e9, 'rgba(255,222,150,0.95)'],
        ];
        for (const [lo, hi, col] of bands) {
          g.fillStyle = col;
          fill(path(v => v >= lo && v < hi, true));
        }
        break;
      }
    }
  }

  /**
   * The finished map of the current city (terrain, blocks, buildings, roads,
   * rail) as one canvas, for the in-game map; null before the layout has
   * drawn. `size` is the world size it spans (centred on the origin).
   */
  mapSnapshot(): {img: HTMLCanvasElement; size: number} | null {
    const t = this.layers.get('terrain');
    if (!t || !this.size) return null;
    const n = t.width;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d')!;
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, n, n);
    for (const name of ['terrain', 'blocks', 'buildings', 'roads', 'rail']) {
      const l = this.layers.get(name);
      if (l) g.drawImage(l, 0, 0, n, n);
    }
    return {img: c, size: this.size};
  }

  /** Composite the layers (only when something changed or is fading). */
  private compose(t: number) {
    const c = this.canvas();
    const n = this.px();
    if (!c || !n) return;
    const fading = [...this.fades.values()].some(f => t - f < 700);
    const glowing = [...this.tileAt.values()].some(f => t - f < 900);
    if (!this.dirty && !fading && !glowing) return;
    this.dirty = false;
    const g = c.getContext('2d')!;
    g.globalAlpha = 1;
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, n, n);
    // Blueprint grid until the terrain arrives (and faintly after).
    g.strokeStyle = COLORS.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 16; i++) {
      const x = Math.round((i * n) / 16) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, n);
      g.moveTo(0, x);
      g.lineTo(n, x);
    }
    g.stroke();
    for (const name of ['terrain', 'blocks', 'buildings', 'roads', 'rail']) {
      const l = this.layers.get(name);
      if (!l) continue;
      const f = this.fades.get(name) ?? 0;
      g.globalAlpha = Math.min(1, (t - f) / 700);
      g.drawImage(l, 0, 0, n, n); // (drawn at an older size after a resize)
    }
    // Tiles light up as their meshes arrive, then settle to a faint wash.
    if (this.tilesPerSide && this.size) {
      const cell = (TILE_SIZE * n) / this.size;
      for (const [tile, at] of this.tileAt) {
        const age = (t - at) / 900;
        const a = age < 1 ? 0.45 * (1 - age) + 0.06 : 0.06;
        g.globalAlpha = 1;
        g.fillStyle = `rgba(${COLORS.tile},${a.toFixed(3)})`;
        const x = (tile % this.tilesPerSide) * cell;
        const y = Math.floor(tile / this.tilesPerSide) * cell;
        g.fillRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      }
    }
    g.globalAlpha = 1;
  }
}

/** The page's one loading screen. */
export const loading = new LoadingScreen();
