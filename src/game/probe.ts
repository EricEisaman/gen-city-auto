// On-device performance probe (?probe=1): after the city loads, holds the
// camera still and steps through a list of configurations (features off,
// lower resolution, ...), a few seconds each, measuring per configuration:
//   - frame interval from requestAnimationFrame (median and mean -> fps),
//   - CPU ms inside game.frame() (main thread JS + WebGPU encoding),
//   - GPU ms: timestamp queries when the device has them, else the
//     submit -> onSubmittedWorkDone latency (an upper bound),
//   - drawn city clusters / triangles per view (the GPU cull's counters),
//   - render / compute passes, draws, dispatches and queue writes per frame.
// Then it shows a large table to screenshot and logs it as JSON
// (window.__probe holds the result for tests).
//
// For devices we cannot profile directly (phones): the deltas between rows
// say what the frame time is spent on. Off by default; nothing here runs
// unless main.ts calls runProbe().

import {OFF_BITS, orOff, type OffName} from '../render/ablation.ts';
import {CpuProfiler} from '../render/profiler.ts';
import type {Settings} from '../ui/settings.ts';
import type {Game} from './game.ts';

interface Config {
  name: string;
  off?: OffName[];
  set?: Partial<Settings>;
  /** City LOD override (shells only). */
  lod2?: boolean;
  /**
   * Run the simulation (traffic, pedestrians, player). Off by default: a
   * frozen simulation renders the same image every frame, so rows compare.
   */
  live?: boolean;
  /** The director's chase camera instead of the fixed view (implies live). */
  chase?: boolean;
  /** Extra setup / teardown on the game. */
  apply?: (g: Game) => void;
  undo?: (g: Game) => void;
}

const POST: OffName[] = ['taa', 'bloom', 'godrays', 'mdof', 'clouds', 'rain'];

const CONFIGS: Config[] = [
  {name: 'baseline'},
  {name: 'shadows off', off: ['shadows']},
  {name: 'scale 50%', set: {scale: 50}},
  {name: 'scale 25%', set: {scale: 25 as Settings['scale']}},
  {name: 'city shells only (LOD2)', lod2: true},
  {
    name: 'city cut at 1500 m',
    apply: g => (g.renderer.cityMaxDist = 1500),
    undo: g => (g.renderer.cityMaxDist = 0),
  },
  {name: 'city G-buffer off', off: ['city']},
  {name: 'city off + shadows off', off: ['city', 'shadows']},
  {name: 'traffic+peds not drawn', off: ['traffic', 'peds']},
  {name: 'all vehicles off', off: ['vehicles']},
  {name: 'post minimal', off: POST},
  {name: 'lighting: albedo only', off: ['lit', 'lights']},
  {name: 'flat materials', off: ['matcheap']},
  {name: 'terrain+water off', off: ['terrain', 'water']},
  {
    name: 'mobile budget toggled',
    apply: g => (g.settings.lean = !g.settings.lean),
    undo: g => (g.settings.lean = !g.settings.lean),
  },
  {
    name: 'nearly empty frame',
    off: [
      'city',
      'shadows',
      'vehicles',
      'terrain',
      'water',
      'sprites',
      ...POST,
      'lit',
      'lights',
    ],
  },
  {name: 'baseline (again)'},
  // (Last: these move the cars, so the fixed view changes after them.)
  {name: 'simulation live', live: true},
  {name: 'chase cam, driving', chase: true},
];

const SETTLE_MS = 1200;
const MEASURE_MS = 2500;

interface Row {
  name: string;
  fps: number;
  frameMs: number;
  frameMean: number;
  cpuMs: number;
  gpuMs: number;
  gpuKind: 'timestamp' | 'done-latency' | '-';
  mainTris: number;
  mainClusters: number;
  shadowTris: number;
  shadowClusters: number;
  shadowRedraws: number;
  render: string;
  passes: number;
  draws: number;
  /** Triangles of the direct (non-indirect) draws, every pass. */
  directTris: number;
  dispatches: number;
  /** Bind groups + texture views created per frame. */
  objects: number;
  writeKB: number;
  cpuSub: Record<string, number>;
  gpuPasses: Record<string, number>;
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const mean = (a: number[]) =>
  a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Per-frame WebGPU call counters (patched prototypes; probe only). */
const counts = {
  passes: 0,
  draws: 0,
  dispatches: 0,
  writeBytes: 0,
  tris: 0,
  /** GPU objects created (bind groups, texture views). */
  objects: 0,
};

function wrap<T extends object>(
  proto: T | undefined,
  names: string[],
  f: (args: unknown[]) => void,
) {
  if (!proto) return;
  const p = proto as Record<string, unknown>;
  for (const n of names) {
    const orig = p[n];
    if (typeof orig !== 'function') continue;
    p[n] = function (this: unknown, ...args: unknown[]) {
      f(args);
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
}

function patchCounters() {
  const g = globalThis as unknown as Record<string, {prototype: object}>;
  wrap(
    g.GPUCommandEncoder?.prototype,
    ['beginRenderPass', 'beginComputePass'],
    () => counts.passes++,
  );
  wrap(
    g.GPURenderPassEncoder?.prototype,
    ['drawIndirect', 'drawIndexedIndirect'],
    () => counts.draws++,
  );
  // Direct draws also count their triangles (vehicles, terrain, water,
  // full-screen passes; the city's indirect draws come from the cull stats).
  wrap(g.GPURenderPassEncoder?.prototype, ['draw', 'drawIndexed'], a => {
    counts.draws++;
    counts.tris += ((a[0] as number) * ((a[1] as number | undefined) ?? 1)) / 3;
  });
  wrap(
    g.GPUComputePassEncoder?.prototype,
    ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect'],
    () => counts.dispatches++,
  );
  wrap(g.GPUDevice?.prototype, ['createBindGroup'], () => counts.objects++);
  wrap(g.GPUTexture?.prototype, ['createView'], () => counts.objects++);
  wrap(g.GPUQueue?.prototype, ['writeBuffer'], a => {
    const data = a[2] as ArrayBufferView | ArrayBuffer;
    const size = a[4] as number | undefined;
    const bpe =
      (data as unknown as {BYTES_PER_ELEMENT?: number}).BYTES_PER_ELEMENT ?? 1;
    counts.writeBytes +=
      size !== undefined ? size * bpe : (data as ArrayBuffer).byteLength;
  });
}

async function adapterInfo(game: Game): Promise<Record<string, unknown>> {
  const a = game.renderer.gpu.adapter as GPUAdapter & {
    info?: GPUAdapterInfo;
  };
  const i = a.info;
  return {
    vendor: i?.vendor,
    architecture: i?.architecture,
    device: i?.device,
    description: i?.description,
    timestamp: game.renderer.gpu.features.timestamp,
    f16: game.renderer.gpu.features.f16,
    ua: navigator.userAgent,
    dpr: devicePixelRatio,
    cores: navigator.hardwareConcurrency,
  };
}

export async function runProbe(game: Game) {
  patchCounters();
  const r = game.renderer;
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;left:0;top:0;right:0;z-index:1000;padding:6px 10px;' +
    'background:rgba(0,0,0,0.75);color:#fff;font:bold 16px/1.25 monospace;' +
    'pointer-events:none;white-space:pre';
  document.body.append(overlay);
  // Let tile streaming finish first (LOD0 / shell swaps change what is drawn).
  let quiet = 0;
  for (let t = 0; t < 240 && quiet < 4; t++) {
    const q = game.city?.stats.queue ?? 0;
    overlay.textContent = `probe: waiting for streaming (${q} jobs)`;
    quiet = q === 0 ? quiet + 1 : 0;
    await sleep(500);
  }
  // A few seconds of play (traffic spawns, the director settles).
  await sleep(3000);
  // Hold the camera where the director left it (free camera, same pose;
  // ?freecam= picks another) with the simulation frozen.
  const c = game.lastCam;
  if (c) {
    const d = [
      c.target[0] - c.eye[0],
      c.target[1] - c.eye[1],
      c.target[2] - c.eye[2],
    ];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    if (!new URLSearchParams(location.search).has('freecam'))
      game.freeCam.setPose(
        c.eye,
        Math.atan2(d[0], -d[2]),
        Math.asin(d[1] / l),
        c.fov,
      );
    game.freeMode = true;
  }
  game.cpuProf = new CpuProfiler();
  r.cpuProf = game.cpuProf;
  r.enableProfiler(false);
  const timestamps = !!r.prof;
  r.cullStats = true;

  // Frame intervals, CPU frame() time, GPU latency and call counts.
  const frameIntervals: number[] = [];
  const cpu: number[] = [];
  const latency: number[] = [];
  const perFrame: (typeof counts)[] = [];
  let latPending = false;
  let lastRaf = 0;
  const orig = game.frame.bind(game);
  game.frame = (dt: number) => {
    const t0 = performance.now();
    if (lastRaf) frameIntervals.push(t0 - lastRaf);
    lastRaf = t0;
    perFrame.push({...counts});
    counts.passes = counts.draws = counts.dispatches = counts.writeBytes = 0;
    counts.tris = counts.objects = 0;
    orig(dt);
    cpu.push(performance.now() - t0);
    if (!timestamps && !latPending) {
      latPending = true;
      const s = performance.now();
      void r.device.queue.onSubmittedWorkDone().then(() => {
        latency.push(performance.now() - s);
        latPending = false;
      });
    }
  };

  const info = await adapterInfo(game);
  const rows: Row[] = [];
  const settings = game.settings;
  for (let i = 0; i < CONFIGS.length; i++) {
    const cf = CONFIGS[i];
    overlay.textContent = `probe ${i + 1}/${CONFIGS.length}: ${cf.name}`;
    const saved: Partial<Settings> = {};
    for (const k of Object.keys(cf.set ?? {}) as (keyof Settings)[])
      (saved as Record<string, unknown>)[k] = settings[k];
    Object.assign(settings, cf.set ?? {});
    let bits = 0;
    for (const n of cf.off ?? []) bits = orOff(bits, OFF_BITS[n]);
    r.offBits = bits;
    if (game.city) game.city.forceLod2 = !!cf.lod2;
    game.freeze = !cf.live && !cf.chase;
    game.freeMode = !cf.chase;
    cf.apply?.(game);
    game.applySettings();
    await sleep(SETTLE_MS);
    frameIntervals.length = cpu.length = latency.length = perFrame.length = 0;
    const f0 = r.prof?.frameCount ?? 0;
    const sr0 = r.shadowRedraws;
    // Drawn counts: the median of the cull readbacks over the window.
    const drawn: Record<string, number[]> = {};
    const keys = ['mainTris', 'mainClusters', 'shadowTris', 'shadowClusters'];
    for (const key of keys) drawn[key] = [];
    for (let t = 0; t < MEASURE_MS; t += 250) {
      delete r.stats.mainTris;
      await sleep(250);
      if (r.stats.mainTris !== undefined)
        for (const key of keys) drawn[key].push(Number(r.stats[key]));
    }
    const n = Math.max(1, frameIntervals.length);
    const spans = r.prof
      ? r.prof.spans.filter((_, k) => r.prof!.spanFrames[k] > f0)
      : [];
    if (r.prof) r.prof.spans.length = r.prof.spanFrames.length = 0;
    const fm = median(frameIntervals);
    rows.push({
      name: cf.name,
      fps: 1000 / mean(frameIntervals),
      frameMs: fm,
      frameMean: mean(frameIntervals),
      cpuMs: median(cpu),
      gpuMs: timestamps ? median(spans) : median(latency),
      gpuKind: timestamps ? 'timestamp' : latency.length ? 'done-latency' : '-',
      mainTris: median(drawn.mainTris),
      mainClusters: median(drawn.mainClusters),
      shadowTris: median(drawn.shadowTris),
      shadowClusters: median(drawn.shadowClusters),
      shadowRedraws: (r.shadowRedraws - sr0) / n,
      render: r.renderSize.join('x'),
      passes: median(perFrame.map(p => p.passes)),
      draws: median(perFrame.map(p => p.draws)),
      directTris: median(perFrame.map(p => p.tris)),
      dispatches: median(perFrame.map(p => p.dispatches)),
      objects: median(perFrame.map(p => p.objects)),
      writeKB: mean(perFrame.map(p => p.writeBytes)) / 1024,
      cpuSub: {...game.cpuProf.averages},
      gpuPasses: {...(r.prof?.averages ?? {})},
    });
    cf.undo?.(game);
    Object.assign(settings, saved);
    game.applySettings();
    r.offBits = 0;
    if (game.city) game.city.forceLod2 = false;
  }
  game.freeze = false;
  game.freeMode = false;
  game.frame = orig;
  r.cullStats = false;

  const canvas = game.renderer.gpu.canvas;
  const result = {
    info: {
      ...info,
      canvas: `${canvas.width}x${canvas.height}`,
      css: `${canvas.clientWidth}x${canvas.clientHeight}`,
      settings: {...settings},
      residentTris: r.stats.tris,
      residentClusters: r.stats.clusters,
      lights: r.stats.lights,
    },
    rows,
  };
  (window as unknown as {__probe: unknown}).__probe = result;
  console.log('[probe] ' + JSON.stringify(result));
  showTable(overlay, result.info, rows);
}

const k = (v: number) =>
  Number.isNaN(v)
    ? '-'
    : v >= 1e6
      ? `${(v / 1e6).toFixed(2)}M`
      : v >= 1e4
        ? `${(v / 1e3).toFixed(0)}k`
        : `${Math.round(v)}`;
const f1 = (v: number) => (Number.isNaN(v) ? '-' : v.toFixed(1));

function showTable(
  el: HTMLElement,
  info: Record<string, unknown>,
  rows: Row[],
) {
  // Big enough to read on a phone screenshot; scrolls if it does not fit.
  el.style.cssText =
    'position:fixed;inset:0;z-index:1000;padding:4px 6px;overflow:auto;' +
    'background:rgba(0,0,0,0.88);color:#fff;font:bold 11px/1.2 monospace;' +
    'white-space:pre;pointer-events:auto';
  const gpuName = [
    info.vendor,
    info.architecture,
    info.device,
    info.description,
  ]
    .filter(Boolean)
    .join(' ');
  const head =
    `GPU ${gpuName || '?'}  ts:${info.timestamp ? 'y' : 'n'}  canvas ${info.canvas}` +
    ` dpr ${info.dpr}  cores ${info.cores}` +
    `  resident ${k(Number(info.residentTris))} tris\n` +
    `gpu col: ${rows[0]?.gpuKind}  (frame/cpu/gpu = median ms)\n`;
  const cols = [
    'config'.padEnd(24),
    'fps'.padStart(5),
    'frame'.padStart(6),
    'cpu'.padStart(5),
    'gpu'.padStart(6),
    'mTris'.padStart(6),
    'mClu'.padStart(5),
    'sTris'.padStart(6),
    'sClu'.padStart(5),
    'sRdr'.padStart(4),
    'res'.padStart(8),
    'pass'.padStart(4),
    'draw'.padStart(4),
    'dTris'.padStart(6),
    'disp'.padStart(4),
    'objs'.padStart(4),
  ];
  const lines = rows.map(r =>
    [
      r.name.slice(0, 24).padEnd(24),
      f1(r.fps).padStart(5),
      f1(r.frameMs).padStart(6),
      f1(r.cpuMs).padStart(5),
      f1(r.gpuMs).padStart(6),
      k(r.mainTris).padStart(6),
      k(r.mainClusters).padStart(5),
      k(r.shadowTris).padStart(6),
      k(r.shadowClusters).padStart(5),
      r.shadowRedraws.toFixed(1).padStart(4),
      r.render.padStart(8),
      k(r.passes).padStart(4),
      k(r.draws).padStart(4),
      k(r.directTris).padStart(6),
      k(r.dispatches).padStart(4),
      k(r.objects).padStart(4),
    ].join(' '),
  );
  const b = rows[0];
  const sub = Object.entries(b?.cpuSub ?? {})
    .filter(([, v]) => v >= 0.05)
    .map(([n, v]) => `${n} ${v.toFixed(1)}`)
    .join(', ');
  el.textContent =
    head +
    cols.join(' ') +
    '\n' +
    lines.join('\n') +
    `\n\nbaseline CPU ms: ${sub}\n` +
    '(JSON in the console as [probe]; tap to close)';
  el.onclick = () => el.remove();
  // Scale the font to the screen width (the table is ~105 columns).
  const fit = Math.max(7, Math.min(16, (innerWidth / 118) * 1.6));
  el.style.fontSize = `${fit}px`;
}
