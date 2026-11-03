// WebGPU device creation with loud error reporting. Every WebGPU object in the
// project carries a label so the messages printed here identify the culprit.

import {begin, timed} from '../ui/timeline.ts';
import {trackGpuMemory} from './memtrack.ts';

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  canvas: HTMLCanvasElement;
  format: GPUTextureFormat;
  features: {
    timestamp: boolean;
    f16: boolean;
    float32Filterable: boolean;
    rg11b10: boolean;
  };
}

declare global {
  interface Window {
    __errors: string[];
    __ready: boolean;
    __stats: Record<string, unknown>;
  }
}

window.__errors = [];
window.__ready = false;
window.__stats = {};

/** Times each distinct message was reported (repeats only count). */
const seen = new Map<string, {n: number; line: HTMLDivElement | null}>();

/**
 * Show an error on screen (the #errors box: phones have no console) and in
 * the console and window.__errors. A message seen before only bumps its
 * count, so an error every frame doesn't bury the first one.
 */
export function reportError(msg: string) {
  const key = msg.slice(0, 300);
  const old = seen.get(key);
  if (old) {
    old.n++;
    if (old.line) old.line.dataset.n = `×${old.n}`;
    if (old.n === 2 || old.n % 100 === 0) console.error(`(×${old.n}) ${msg}`);
    return;
  }
  console.error(msg);
  window.__errors.push(msg);
  const el = document.getElementById('errors');
  let line: HTMLDivElement | null = null;
  if (el && seen.size < 40) {
    el.style.display = 'block';
    line = document.createElement('div');
    line.textContent = msg;
    el.append(line);
  }
  seen.set(key, {n: 1, line});
}

/** Uncaught exceptions and promise rejections anywhere on the page. */
window.addEventListener('error', e => {
  const err = e.error as unknown;
  reportError(
    `[uncaught] ${err instanceof Error ? (err.stack ?? err.message) : e.message}` +
      (e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''),
  );
});
window.addEventListener('unhandledrejection', e => {
  const r = e.reason as unknown;
  reportError(
    `[unhandled rejection] ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`,
  );
});

/** The device was lost (set once device.lost resolves). */
export let deviceLost: GPUDeviceLostInfo | null = null;

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!navigator.gpu)
    throw new Error('WebGPU is not supported in this browser');
  const endAdapter = begin('requestAdapter');
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  endAdapter();
  if (!adapter) throw new Error('No WebGPU adapter available');

  const wanted: GPUFeatureName[] = [
    'timestamp-query',
    'shader-f16',
    'float32-filterable',
    'rg11b10ufloat-renderable',
    'indirect-first-instance',
  ];
  const requiredFeatures = wanted.filter(f => adapter.features.has(f));
  const L = adapter.limits;
  const endDevice = begin('requestDevice');
  const device = await adapter.requestDevice({
    label: 'gen-city-auto device',
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(
        L.maxStorageBufferBindingSize,
        1 << 30,
      ),
      maxBufferSize: Math.min(L.maxBufferSize, 1 << 30),
      maxStorageBuffersPerShaderStage: Math.min(
        L.maxStorageBuffersPerShaderStage,
        10,
      ),
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
      maxColorAttachmentBytesPerSample: Math.min(
        L.maxColorAttachmentBytesPerSample,
        64,
      ),
    },
  });

  endDevice();
  trackGpuMemory(device);
  device.addEventListener('uncapturederror', e => {
    const err = (e as GPUUncapturedErrorEvent).error;
    reportError(`[WebGPU] ${err.constructor.name}: ${err.message}`);
  });
  void device.lost.then(info => {
    deviceLost = info;
    reportError(
      `[WebGPU] device lost (reason: ${info.reason ?? 'unknown'}): ` +
        `${info.message || '(no message)'} — the view stops drawing; ` +
        'reload the page. (Often the GPU ran out of memory or a frame ' +
        'took too long.)',
    );
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Could not get a webgpu canvas context');
  const format = navigator.gpu.getPreferredCanvasFormat();
  timed('context.configure', () =>
    context.configure({device, format, alphaMode: 'opaque'}),
  );

  return {
    adapter,
    device,
    context,
    canvas,
    format,
    features: {
      timestamp: device.features.has('timestamp-query'),
      f16: device.features.has('shader-f16'),
      float32Filterable: device.features.has('float32-filterable'),
      rg11b10: device.features.has('rg11b10ufloat-renderable'),
    },
  };
}

/** Create a shader module and print its compilation messages with the label. */
export function createShader(
  device: GPUDevice,
  label: string,
  code: string,
): GPUShaderModule {
  const module = timed(`createShaderModule ${label}`, () =>
    device.createShaderModule({label, code}),
  );
  const endInfo = begin(`shader info ${label}`, 'gpu');
  void module.getCompilationInfo().then(info => {
    endInfo();
    for (const m of info.messages) {
      const line = code.split('\n')[m.lineNum - 1] ?? '';
      const msg = `[WGSL ${m.type}] ${label}:${m.lineNum}:${m.linePos} ${m.message}\n    ${line.trim()}`;
      if (m.type === 'error') reportError(msg);
      else console.warn(msg);
    }
  });
  return module;
}

/** Resize the canvas to its CSS size (no devicePixelRatio scaling, by design). */
export function resizeToCss(canvas: HTMLCanvasElement) {
  const w = Math.max(1, Math.floor(canvas.clientWidth));
  const h = Math.max(1, Math.floor(canvas.clientHeight));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}
