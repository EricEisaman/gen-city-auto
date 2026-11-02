// Graphics settings: persisted in localStorage, overridable from the URL
// (?scale=, ?gfx=, ?clouds=, ?shadows=, ?phone=; tests and the profiler rely on URL
// params, which are applied on top and never saved), applied live.

export const RENDER_SCALES = ['auto', 'dynamic', 50, 67, 75, 85, 100] as const;
export type RenderScale = (typeof RENDER_SCALES)[number];
export type Preset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

export interface Settings {
  preset: Preset;
  /** Internal resolution: % of the display, 'auto' by display size, 'dynamic' by frame time. */
  scale: RenderScale;
  /** Frame-rate target of the dynamic render scale. */
  targetFps: number;
  /** 0 off .. 4 ultra (renderer CLOUD_LEVELS). */
  clouds: number;
  /** Shadow map size per cascade; 0 = no shadows. */
  shadows: number;
  reflections: 'off' | 'half' | 'full';
  ao: boolean;
  contact: boolean;
  godrays: boolean;
  bloom: number;
  motionBlur: boolean;
  dof: boolean;
  taa: boolean;
  sharpen: number;
  /** Rain particle count multiplier. */
  rain: number;
  /** LOD2 distance in metres (0 = LOD1 shells everywhere). */
  drawDist: number;
  /** Fine-detail cull distance multiplier. */
  detail: number;
  /** Traffic density multiplier. */
  traffic: number;
  /** Field-of-view multiplier for the gameplay cameras. */
  fov: number;
  /** FPS / frame ms / GPU ms readout. */
  readout: boolean;
  /** Controls help overlay (H toggles it). */
  help: boolean;
  /**
   * Mobile geometry budget (on by default on phones and tablets): far
   * vehicle LOD, fewer vehicle shadows and pedestrians, a coarser terrain,
   * no farthest shadow cascade (see Game.applySettings).
   */
  lean: boolean;
}

export const DEFAULTS: Settings = {
  preset: 'high',
  scale: 'auto',
  targetFps: 60,
  clouds: 2,
  shadows: 2048,
  reflections: 'half',
  ao: true,
  contact: true,
  godrays: true,
  bloom: 1,
  motionBlur: true,
  dof: true,
  taa: true,
  sharpen: 0.22,
  rain: 1,
  drawDist: 1500,
  detail: 1,
  traffic: 1,
  fov: 1,
  readout: false,
  help: false,
  lean: false,
};

/**
 * The defaults on this device: on low-memory devices (caps.ts: phones,
 * tablets) the low preset at a dynamic render scale, the mobile geometry
 * budget and half the traffic; DEFAULTS elsewhere.
 */
export function deviceDefaults(lowMemory: boolean): Settings {
  return lowMemory
    ? {
        ...DEFAULTS,
        preset: 'low',
        ...PRESETS.low,
        // Phones are geometry-bound, not pixel-bound (an iPhone 15 Pro probe:
        // 8.8 ms GPU at 67%, 8.1 ms at 25%), so render as sharp as the frame
        // budget allows; the dynamic scale also backs off when it throttles.
        scale: 'dynamic',
        lean: true,
        traffic: 0.5,
      }
    : DEFAULTS;
}

type PresetKeys =
  | 'scale'
  | 'clouds'
  | 'shadows'
  | 'reflections'
  | 'ao'
  | 'contact'
  | 'godrays'
  | 'drawDist'
  | 'detail';

/** What each quality preset sets (the other settings are left alone). */
export const PRESETS: Record<
  Exclude<Preset, 'custom'>,
  Pick<Settings, PresetKeys>
> = {
  low: {
    scale: 67,
    clouds: 1,
    shadows: 1024,
    reflections: 'off',
    ao: false,
    contact: false,
    godrays: false,
    drawDist: 800,
    detail: 0.6,
  },
  medium: {
    scale: 'auto',
    clouds: 2,
    shadows: 1536,
    reflections: 'half',
    ao: true,
    contact: false,
    godrays: true,
    drawDist: 1100,
    detail: 0.8,
  },
  high: {
    scale: 'auto',
    clouds: 2,
    shadows: 2048,
    reflections: 'half',
    ao: true,
    contact: true,
    godrays: true,
    drawDist: 1500,
    detail: 1,
  },
  ultra: {
    scale: 100,
    clouds: 4,
    shadows: 3072,
    reflections: 'full',
    ao: true,
    contact: true,
    godrays: true,
    drawDist: 2500,
    detail: 1.5,
  },
};

type Opt = [string, Settings[keyof Settings]];

export interface Field {
  key: keyof Settings;
  label: string;
  options: Opt[];
  /** Set by the quality preset. */
  preset?: boolean;
}

const pct = (v: number[]) => v.map((x): Opt => [`${Math.round(x * 100)}%`, x]);

export const FIELDS: Field[] = [
  {
    key: 'preset',
    label: 'Quality preset',
    options: [
      ['Low', 'low'],
      ['Medium', 'medium'],
      ['High', 'high'],
      ['Ultra', 'ultra'],
      ['Custom', 'custom'],
    ],
  },
  {
    key: 'scale',
    label: 'Render scale',
    preset: true,
    options: [
      ['Auto (by display size)', 'auto'],
      ['Dynamic (frame-rate target)', 'dynamic'],
      ['50%', 50],
      ['67%', 67],
      ['75%', 75],
      ['85%', 85],
      ['100%', 100],
    ],
  },
  {
    key: 'targetFps',
    label: 'Dynamic target',
    options: [
      ['30 fps', 30],
      ['45 fps', 45],
      ['60 fps', 60],
      ['90 fps', 90],
      ['120 fps', 120],
    ],
  },
  {
    key: 'clouds',
    label: 'Clouds',
    preset: true,
    options: [
      ['Off', 0],
      ['Low', 1],
      ['Medium', 2],
      ['High', 3],
      ['Ultra', 4],
    ],
  },
  {
    key: 'shadows',
    label: 'Shadows',
    preset: true,
    options: [
      ['Off', 0],
      ['Low (1024)', 1024],
      ['Medium (1536)', 1536],
      ['High (2048)', 2048],
      ['Ultra (3072)', 3072],
    ],
  },
  {
    key: 'reflections',
    label: 'Reflections',
    preset: true,
    options: [
      ['Off', 'off'],
      ['Half res', 'half'],
      ['Full res', 'full'],
    ],
  },
  {
    key: 'ao',
    label: 'Ambient occlusion',
    preset: true,
    options: [
      ['On', true],
      ['Off', false],
    ],
  },
  {
    key: 'contact',
    label: 'Contact shadows',
    preset: true,
    options: [
      ['On', true],
      ['Off', false],
    ],
  },
  {
    key: 'godrays',
    label: 'God rays',
    preset: true,
    options: [
      ['On', true],
      ['Off', false],
    ],
  },
  {
    key: 'drawDist',
    label: 'Draw distance',
    preset: true,
    options: [
      ['Near (800 m)', 800],
      ['Medium (1100 m)', 1100],
      ['Far (1500 m)', 1500],
      ['Very far (2500 m)', 2500],
      ['Full detail everywhere', 0],
    ],
  },
  {
    key: 'detail',
    label: 'Detail distance',
    preset: true,
    options: pct([0.6, 0.8, 1, 1.5, 2]),
  },
  {
    key: 'taa',
    label: 'Anti-aliasing',
    options: [
      ['TAA', true],
      ['Off', false],
    ],
  },
  {
    key: 'sharpen',
    label: 'Sharpening',
    options: [
      ['Off', 0],
      ['Low', 0.12],
      ['Normal', 0.22],
      ['High', 0.4],
      ['Max', 0.6],
    ],
  },
  {
    key: 'bloom',
    label: 'Bloom',
    options: [
      ['Off', 0],
      ['Low', 0.5],
      ['Normal', 1],
      ['High', 1.8],
    ],
  },
  {
    key: 'motionBlur',
    label: 'Motion blur',
    options: [
      ['On', true],
      ['Off', false],
    ],
  },
  {
    key: 'dof',
    label: 'Depth of field',
    options: [
      ['On', true],
      ['Off', false],
    ],
  },
  {key: 'rain', label: 'Rain particles', options: pct([0, 0.25, 0.5, 1, 1.5])},
  {
    key: 'traffic',
    label: 'Traffic density',
    options: pct([0, 0.25, 0.5, 1, 1.5]),
  },
  {
    key: 'fov',
    label: 'Field of view',
    options: [
      ['Narrow (-15%)', 0.85],
      ['Normal', 1],
      ['Wide (+15%)', 1.15],
      ['Wider (+30%)', 1.3],
    ],
  },
  {
    key: 'lean',
    label: 'Mobile geometry budget',
    options: [
      ['Off', false],
      ['On', true],
    ],
  },
  {
    key: 'readout',
    label: 'FPS / GPU readout',
    options: [
      ['Off', false],
      ['On', true],
    ],
  },
  {
    key: 'help',
    label: 'Controls help (H)',
    options: [
      ['Off', false],
      ['On', true],
    ],
  },
];

const KEY = 'gen-city-auto/settings/v1';

const valid = (f: Field, v: unknown) => f.options.some(([, x]) => x === v);

/** Keep only known keys with allowed values. */
function sanitize(raw: unknown): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const f of FIELDS)
    if (f.key in r && valid(f, r[f.key]))
      (out as Record<string, unknown>)[f.key] = r[f.key];
  return out;
}

export function loadStored(): Partial<Settings> {
  try {
    const s = localStorage.getItem(KEY);
    return s ? sanitize(JSON.parse(s)) : {};
  } catch {
    return {};
  }
}

export function saveStored(s: Partial<Settings>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode, quota): settings last this session.
  }
}

export function clearStored() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Settings from the URL (applied on top of the stored ones, not saved). */
export function urlOverrides(params: URLSearchParams): Partial<Settings> {
  const o: Partial<Settings> = {};
  const gfx = params.get('gfx');
  if (gfx && gfx in PRESETS) {
    o.preset = gfx as Preset;
    Object.assign(o, PRESETS[gfx as keyof typeof PRESETS]);
  }
  const scale = params.get('scale');
  if (scale) {
    const n = Number(scale);
    if (scale === 'auto' || scale === 'dynamic') o.scale = scale;
    // Any percentage 25..100 (the menu lists the common ones).
    else if (n >= 25 && n <= 100) o.scale = Math.round(n) as RenderScale;
  }
  const num = (k: string, key: keyof Settings) => {
    const v = params.get(k);
    if (v !== null && Number.isFinite(Number(v)))
      (o as Record<string, unknown>)[key] = Number(v);
  };
  num('clouds', 'clouds');
  num('shadows', 'shadows');
  num('fps', 'targetFps');
  // (Drop values the menu does not offer, e.g. ?clouds=9.)
  for (const f of FIELDS)
    if (f.key !== 'scale' && f.key in o && !valid(f, o[f.key])) delete o[f.key];
  if (params.get('readout') === '1') o.readout = true;
  const phone = params.get('phone');
  if (phone === '1' || phone === '0') o.lean = phone === '1';
  return o;
}

/** Display-size render scale for 'auto' (fraction). */
export function autoScale(w: number, h: number): number {
  const px = w * h;
  // >= ~1440p: 75%; >= ~1080p: 85%; smaller displays render native.
  if (px >= 2560 * 1440 * 0.9) return 0.75;
  if (px >= 1920 * 1080 * 0.9) return 0.85;
  return 1;
}

/**
 * Dynamic render scale: steers the internal resolution so the whole-frame
 * GPU time sits inside [0.75, 1] x the frame budget. Steps down quickly (a
 * jump sized by the pixel ratio), up slowly in 5% steps, and waits for fresh
 * measurements after every change.
 */
export class DynamicScale {
  scale = 1;
  private since = 0;
  min = 0.5;
  max = 1;

  /** One frame; returns the scale to render at. */
  update(gpuMs: number, targetFps: number): number {
    this.since++;
    const budget = (1000 / targetFps) * 0.9;
    if (!(gpuMs > 0) || this.since < 30) return this.scale;
    let s = this.scale;
    if (gpuMs > budget) {
      // GPU time ~ pixels ~ scale^2.
      const want = s * Math.sqrt(budget / gpuMs);
      s = Math.min(s - 0.05, Math.max(want, s - 0.2));
    } else if (gpuMs < budget * 0.75 && this.since >= 90) {
      s += 0.05;
    }
    s = Math.round(Math.min(this.max, Math.max(this.min, s)) * 20) / 20;
    if (s !== this.scale) {
      this.scale = s;
      this.since = 0;
    }
    return this.scale;
  }
}
