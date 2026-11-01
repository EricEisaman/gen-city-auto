// GPU memory accounting: wraps device.createBuffer / createTexture (and the
// objects' destroy) to keep a live byte count per category (the label's first
// path segment, e.g. 'city/pool/vertices' -> 'city'), the peak total and the
// totals at that peak. window.__gpuMem() returns a snapshot (puppeteer:
// test/puppeteer/mem.mjs). Sizes are the bytes asked for; drivers add some
// padding and alignment on top.

export interface GpuMemEntry {
  label: string;
  kind: 'buffer' | 'texture';
  bytes: number;
  desc: string;
}

export interface GpuMemSnapshot {
  total: number;
  peak: number;
  byCategory: Record<string, number>;
  peakByCategory: Record<string, number>;
  /** The largest live resources. */
  top: GpuMemEntry[];
}

declare global {
  interface Window {
    __gpuMem?: () => GpuMemSnapshot;
  }
}

const TEXEL_BYTES: Record<string, number> = {
  r8unorm: 1,
  r8snorm: 1,
  r8uint: 1,
  r8sint: 1,
  stencil8: 1,
  r16uint: 2,
  r16sint: 2,
  r16float: 2,
  r16unorm: 2,
  rg8unorm: 2,
  rg8snorm: 2,
  rg8uint: 2,
  rg8sint: 2,
  depth16unorm: 2,
  r32uint: 4,
  r32sint: 4,
  r32float: 4,
  rg16uint: 4,
  rg16sint: 4,
  rg16float: 4,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  rgba8snorm: 4,
  rgba8uint: 4,
  rgba8sint: 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rgb10a2unorm: 4,
  rgb10a2uint: 4,
  rg11b10ufloat: 4,
  rgb9e5ufloat: 4,
  depth24plus: 4,
  'depth24plus-stencil8': 4,
  depth32float: 4,
  'depth32float-stencil8': 5,
  rg32uint: 8,
  rg32sint: 8,
  rg32float: 8,
  rgba16uint: 8,
  rgba16sint: 8,
  rgba16float: 8,
  rgba32uint: 16,
  rgba32sint: 16,
  rgba32float: 16,
};

function extent(size: GPUExtent3D): [number, number, number] {
  if (Symbol.iterator in Object(size)) {
    const a = Array.from(size as Iterable<number>);
    return [a[0] ?? 1, a[1] ?? 1, a[2] ?? 1];
  }
  const d = size as GPUExtent3DDict;
  return [d.width, d.height ?? 1, d.depthOrArrayLayers ?? 1];
}

/** Bytes of a texture (every mip level and sample). */
export function textureBytes(t: GPUTextureDescriptor) {
  const [w, h, d] = extent(t.size);
  const bpp = TEXEL_BYTES[t.format] ?? 4;
  const is3d = t.dimension === '3d';
  let sum = 0;
  for (let m = 0; m < (t.mipLevelCount ?? 1); m++) {
    const mw = Math.max(1, w >> m);
    const mh = Math.max(1, h >> m);
    const md = is3d ? Math.max(1, d >> m) : d;
    sum += mw * mh * md;
  }
  return sum * bpp * (t.sampleCount ?? 1);
}

const category = (label: string) => label.split(/[/ ]/)[0] || '(unlabelled)';

/** Start accounting every buffer and texture made on `device`. */
export function trackGpuMemory(device: GPUDevice) {
  const live = new Map<object, GpuMemEntry>();
  const byCat = new Map<string, number>();
  let total = 0;
  let peak = 0;
  let peakByCat: Record<string, number> = {};
  const add = (obj: object, e: GpuMemEntry) => {
    live.set(obj, e);
    const c = category(e.label);
    byCat.set(c, (byCat.get(c) ?? 0) + e.bytes);
    total += e.bytes;
    if (total > peak) {
      peak = total;
      peakByCat = Object.fromEntries(byCat);
    }
  };
  const remove = (obj: object) => {
    const e = live.get(obj);
    if (!e) return;
    live.delete(obj);
    const c = category(e.label);
    byCat.set(c, (byCat.get(c) ?? 0) - e.bytes);
    total -= e.bytes;
  };
  const wrapDestroy = (obj: {destroy(): void}) => {
    const destroy = obj.destroy.bind(obj);
    obj.destroy = () => {
      remove(obj);
      destroy();
    };
  };
  const createBuffer = device.createBuffer.bind(device);
  device.createBuffer = (desc: GPUBufferDescriptor) => {
    const b = createBuffer(desc);
    add(b, {
      label: desc.label ?? '',
      kind: 'buffer',
      bytes: desc.size,
      desc: `usage 0x${desc.usage.toString(16)}`,
    });
    wrapDestroy(b);
    return b;
  };
  const createTexture = device.createTexture.bind(device);
  device.createTexture = (desc: GPUTextureDescriptor) => {
    const t = createTexture(desc);
    const [w, h, d] = extent(desc.size);
    add(t, {
      label: desc.label ?? '',
      kind: 'texture',
      bytes: textureBytes(desc),
      desc: `${desc.format} ${w}x${h}x${d} mips ${desc.mipLevelCount ?? 1}`,
    });
    wrapDestroy(t);
    return t;
  };
  window.__gpuMem = () => ({
    total,
    peak,
    byCategory: Object.fromEntries(byCat),
    peakByCategory: peakByCat,
    top: [...live.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 40),
  });
}
