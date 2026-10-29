// Frame orchestration: atmosphere LUTs, GPU culling, shadow cascades, G-buffer,
// Hi-Z, clouds, tiled lighting, TAA, bloom, exposure and tonemapping.

import {createShader, type Gpu} from '../gpu/device.ts';
import {frustumPlanes, mat4, type Mat4} from '../math/mat4.ts';
import {cross3, norm3, sub3, type Vec3} from '../math/vec.ts';
import atmosphereWgsl from '../shaders/atmosphere.wgsl';
import cityMaterialsWgsl from '../shaders/city-materials.wgsl';
import cityWgsl from '../shaders/city.wgsl';
import cloudsWgsl from '../shaders/clouds.wgsl';
import commonWgsl from '../shaders/common.wgsl';
import aoWgsl from '../shaders/ao.wgsl';
import cullWgsl from '../shaders/cull.wgsl';
import lightingWgsl from '../shaders/lighting.wgsl';
import postWgsl from '../shaders/post.wgsl';
import surfaceWgsl from '../shaders/surface.wgsl';
import terrainWgsl from '../shaders/terrain.wgsl';
import {computeSky, type SkyState} from '../world/sky.ts';
import {ClusterPool, type PoolHandle} from './cluster-pool.ts';
import {F, FrameData} from './frame.ts';
import {createLeafTexture, createSignAtlasTexture} from './sign-atlas.ts';
import type {ClusterData} from '../city/cmesh.ts';

export interface Weather {
  cloud: number;
  rain: number;
  wetness: number;
  fog: number;
  lightning: number;
  wind: [number, number];
}

export interface ViewParams {
  eye: Vec3;
  target: Vec3;
  fov: number;
  near: number;
  time: number;
  dt: number;
  hour: number;
  weather: Weather;
  debug: number;
  /** 0 = low (no SSR/AO, cheaper clouds), 1 = high. */
  quality?: number;
}

/** Hook for other systems (vehicles, rain) to add draws into renderer passes. */
export interface DrawHook {
  gbuffer?(pass: GPURenderPassEncoder): void;
  shadow?(pass: GPURenderPassEncoder, cascade: number): void;
  forward?(pass: GPURenderPassEncoder): void;
  prepare?(encoder: GPUCommandEncoder): void;
}

export const GBUFFER_FORMATS: GPUTextureFormat[] = ['rgba8unorm', 'rgba16float', 'rgba16float', 'rg16float'];
const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
const SHADOW_SIZE = 2048;
const CASCADES = 4;
const VIEWS = 1 + CASCADES;
const MAX_LIGHTS = 1024;
const TERRAIN_GRID = 32;

const halton = (i: number, b: number) => {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
};

interface Targets {
  w: number;
  h: number;
  gbuf: GPUTexture[];
  depth: GPUTexture;
  lit: GPUTexture;
  history: GPUTexture[];
  hiz: GPUTexture;
  hizMips: number;
  bloomDown: GPUTexture[];
  bloomUp: GPUTexture[];
  clouds: GPUTexture[];
  ao: GPUTexture;
}

export class Renderer {
  readonly gpu: Gpu;
  readonly device: GPUDevice;
  readonly pool: ClusterPool;
  readonly frame = new FrameData();
  sky: SkyState = computeSky(12, 0.3, 0, 1, 1);
  hooks: DrawHook[] = [];
  readonly stats: Record<string, number | string> = {};

  readonly frameBuffer: GPUBuffer;
  private atmoBuffer: GPUBuffer;
  private linear: GPUSampler;
  private linearRepeat: GPUSampler;
  private shadowSampler: GPUSampler;
  private signAtlas: GPUTexture;
  private leafTex: GPUTexture;
  private whiteTex: GPUTexture;
  private shadowMap: GPUTexture;
  private transmittance: GPUTexture;
  private multiScat: GPUTexture;
  private skyView: GPUTexture;
  private apVolume: GPUTexture;
  private cloudNoise: GPUTexture;
  private exposureBuffer: GPUBuffer;
  private lightBuffer: GPUBuffer;
  private tileLodBuffer: GPUBuffer;
  private patchBuffer: GPUBuffer;
  private terrainIndex: GPUBuffer;
  private terrainIndexCount: number;
  private heightTex: GPUTexture | null = null;
  private landTex: GPUTexture | null = null;
  private worldSize = 6144;
  private heightCell = 4;
  private heightN = 1537;

  private cullViewBuffers: GPUBuffer[] = [];
  private visibleBuffers: GPUBuffer[] = [];
  private argsBuffers: GPUBuffer[] = [];
  readonly shadowViewBuffers: GPUBuffer[] = [];

  private p!: Record<string, GPURenderPipeline | GPUComputePipeline>;
  private targets: Targets | null = null;
  private frameIndex = 0;
  private prevViewProj = mat4.create();
  private lutsReady = false;
  private noiseReady = false;
  private lastSkyKey = '';
  private cullCount = 0;
  private lightCount = 0;
  private patchCount = 0;
  private useOcclusion = false;
  private lastViewDir: Vec3 = [0, 0, -1];
  private cascadeMats: Mat4[] = [];

  private constructor(gpu: Gpu) {
    this.gpu = gpu;
    const device = gpu.device;
    this.device = device;
    const lim = device.limits.maxStorageBufferBindingSize;
    const maxVerts = Math.floor(Math.min(lim, 512 * 1024 * 1024) / 32);
    this.pool = new ClusterPool(device, maxVerts, Math.min(Math.floor(lim / 4), 24_000_000), 400_000);
    this.frameBuffer = device.createBuffer({label: 'frame/uniforms', size: this.frame.f.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    this.atmoBuffer = device.createBuffer({label: 'sky/atmosphere params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    this.linear = device.createSampler({label: 'sampler/linear clamp', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge'});
    this.linearRepeat = device.createSampler({label: 'sampler/linear repeat', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat'});
    this.shadowSampler = device.createSampler({label: 'sampler/shadow compare', compare: 'less-equal', magFilter: 'linear', minFilter: 'linear'});
    this.signAtlas = createSignAtlasTexture(device);
    this.leafTex = createLeafTexture(device);
    this.whiteTex = device.createTexture({label: 'texture/white', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture: this.whiteTex}, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
    this.shadowMap = device.createTexture({label: 'shadow/cascades', size: [SHADOW_SIZE, SHADOW_SIZE, CASCADES], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING});
    const lut = (label: string, w: number, h: number, d = 1) =>
      device.createTexture({label, size: [w, h, d], dimension: d > 1 ? '3d' : '2d', format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
    this.transmittance = lut('sky/transmittance LUT', 256, 64);
    this.multiScat = lut('sky/multiscatter LUT', 32, 32);
    this.skyView = lut('sky/sky-view LUT', 192, 108);
    this.apVolume = lut('sky/aerial perspective volume', 32, 32, 32);
    this.cloudNoise = device.createTexture({label: 'clouds/noise volume', size: [64, 64, 64], dimension: '3d', format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
    this.exposureBuffer = device.createBuffer({label: 'post/exposure', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(this.exposureBuffer, 0, new Float32Array([0, 0, 0, 0]));
    this.lightBuffer = device.createBuffer({label: 'lights/visible list', size: 16 + MAX_LIGHTS * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    this.tileLodBuffer = device.createBuffer({label: 'city/tile lod', size: 4 * 4096, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    this.patchBuffer = device.createBuffer({label: 'terrain/patches', size: 16 * 2048, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    // Terrain patch index buffer: (GRID+2)^2 quads over a (GRID+3)^2 vertex grid (with skirts).
    const side = TERRAIN_GRID + 3;
    const idx: number[] = [];
    for (let j = 0; j < side - 1; j++) {
      for (let i = 0; i < side - 1; i++) {
        const a = j * side + i;
        idx.push(a, a + side, a + 1, a + 1, a + side, a + side + 1);
      }
    }
    this.terrainIndexCount = idx.length;
    this.terrainIndex = device.createBuffer({label: 'terrain/patch indices', size: idx.length * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(this.terrainIndex, 0, new Uint32Array(idx));
    for (let v = 0; v < VIEWS; v++) {
      const name = v === 0 ? 'main' : `cascade${v - 1}`;
      this.cullViewBuffers.push(device.createBuffer({label: `cull/${name}/view`, size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
      this.visibleBuffers.push(device.createBuffer({label: `cull/${name}/visible clusters`, size: this.pool.maxClusters * 4, usage: GPUBufferUsage.STORAGE}));
      this.argsBuffers.push(device.createBuffer({label: `cull/${name}/indirect args`, size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST}));
      if (v > 0) this.shadowViewBuffers.push(device.createBuffer({label: `shadow/${name}/view`, size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST}));
    }
  }

  static async create(gpu: Gpu): Promise<Renderer> {
    const r = new Renderer(gpu);
    await r.createPipelines();
    return r;
  }

  private async createPipelines() {
    const d = this.device;
    const mod = (label: string, ...parts: string[]) => createShader(d, label, parts.join('\n'));
    const cityMod = mod('shader/city', commonWgsl, surfaceWgsl, cityMaterialsWgsl, cityWgsl);
    const terrainMod = mod('shader/terrain', commonWgsl, surfaceWgsl, terrainWgsl);
    const cullMod = mod('shader/cull', cullWgsl);
    const atmoMod = mod('shader/atmosphere', commonWgsl, atmosphereWgsl);
    const lightMod = mod('shader/lighting', commonWgsl, surfaceWgsl.replace(/struct GOut[\s\S]*$/, ''), lightingWgsl);
    const postMod = mod('shader/post', commonWgsl, postWgsl);
    const cloudMod = mod('shader/clouds', commonWgsl, cloudsWgsl);
    const aoMod = mod('shader/ao', commonWgsl, aoWgsl);
    const gTargets: GPUColorTargetState[] = GBUFFER_FORMATS.map(format => ({format}));
    const gDepth: GPUDepthStencilState = {format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater'};
    const compute = (label: string, module: GPUShaderModule, entryPoint: string) => d.createComputePipelineAsync({label, layout: 'auto', compute: {module, entryPoint}});
    const entries: [string, Promise<GPURenderPipeline | GPUComputePipeline>][] = [
      ['city', d.createRenderPipelineAsync({label: 'pipeline/city gbuffer', layout: 'auto', vertex: {module: cityMod, entryPoint: 'vs'}, fragment: {module: cityMod, entryPoint: 'fs', targets: gTargets}, primitive: {cullMode: 'back'}, depthStencil: gDepth})],
      ['cityShadow', d.createRenderPipelineAsync({label: 'pipeline/city shadow', layout: 'auto', vertex: {module: cityMod, entryPoint: 'vsShadow'}, fragment: {module: cityMod, entryPoint: 'fsShadow', targets: []}, primitive: {cullMode: 'none'}, depthStencil: {format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5}})],
      ['terrain', d.createRenderPipelineAsync({label: 'pipeline/terrain gbuffer', layout: 'auto', vertex: {module: terrainMod, entryPoint: 'vs'}, fragment: {module: terrainMod, entryPoint: 'fs', targets: gTargets}, primitive: {cullMode: 'back'}, depthStencil: gDepth})],
      ['water', d.createRenderPipelineAsync({label: 'pipeline/water gbuffer', layout: 'auto', vertex: {module: terrainMod, entryPoint: 'vsWater'}, fragment: {module: terrainMod, entryPoint: 'fsWater', targets: gTargets}, primitive: {cullMode: 'none'}, depthStencil: gDepth})],
      ['cull', compute('pipeline/cull', cullMod, 'main')],
      ['transmittance', compute('pipeline/sky transmittance', atmoMod, 'transmittanceLut')],
      ['multiScat', compute('pipeline/sky multiscatter', atmoMod, 'multiScatLut')],
      ['skyView', compute('pipeline/sky view', atmoMod, 'skyViewLut')],
      ['aerial', compute('pipeline/aerial perspective', atmoMod, 'aerialPerspective')],
      ['lighting', compute('pipeline/lighting', lightMod, 'main')],
      ['taa', compute('pipeline/taa', postMod, 'taa')],
      ['hizFromDepth', compute('pipeline/hiz from depth', postMod, 'hizFromDepth')],
      ['hizDown', compute('pipeline/hiz downsample', postMod, 'hizDown')],
      ['bloomDown', compute('pipeline/bloom down', postMod, 'bloomDown')],
      ['bloomUp', compute('pipeline/bloom up', postMod, 'bloomUp')],
      ['exposure', compute('pipeline/exposure', postMod, 'exposure')],
      ['tonemap', d.createRenderPipelineAsync({label: 'pipeline/tonemap', layout: 'auto', vertex: {module: postMod, entryPoint: 'vsFull'}, fragment: {module: postMod, entryPoint: 'fsTonemap', targets: [{format: this.gpu.format}]}})],
      ['cloudNoise', compute('pipeline/cloud noise', cloudMod, 'genNoise')],
      ['clouds', compute('pipeline/clouds', cloudMod, 'march')],
      ['ao', compute('pipeline/ssao', aoMod, 'main')],
    ];
    const done = await Promise.all(entries.map(([, p]) => p));
    this.p = Object.fromEntries(entries.map(([k], i) => [k, done[i]]));
  }

  private bg(pipeline: string, group: number, entries: (GPUBindingResource | null)[], label: string): GPUBindGroup {
    const p = this.p[pipeline];
    return this.device.createBindGroup({
      label,
      layout: p.getBindGroupLayout(group),
      entries: entries.map((resource, binding) => ({binding, resource})).filter(e => e.resource !== null) as GPUBindGroupEntry[],
    });
  }

  private ubuf(b: GPUBuffer): GPUBufferBinding {
    return {buffer: b};
  }

  // ---------------------------------------------------------------------------
  // City data

  setTerrain(heights: Float32Array, n: number, cell: number, size: number, landUse: Uint8Array) {
    this.worldSize = size;
    this.heightCell = cell;
    this.heightN = n;
    this.heightTex?.destroy();
    this.landTex?.destroy();
    this.heightTex = this.device.createTexture({label: 'terrain/heightmap', size: [n, n], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    this.device.queue.writeTexture({texture: this.heightTex}, heights, {bytesPerRow: n * 4}, [n, n]);
    // r8unorm rows must be 256-byte aligned for writeTexture; pad rows.
    const row = Math.ceil(n / 256) * 256;
    const padded = new Uint8Array(row * n);
    for (let j = 0; j < n; j++) padded.set(landUse.subarray(j * n, j * n + n), j * row);
    this.landTex = this.device.createTexture({label: 'terrain/land use', size: [n, n], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    this.device.queue.writeTexture({texture: this.landTex}, padded, {bytesPerRow: row}, [n, n]);
  }

  uploadClusters(d: ClusterData): PoolHandle | null {
    return this.pool.upload(d);
  }

  freeClusters(h: PoolHandle) {
    this.pool.free(h);
  }

  setTileLods(lods: Uint32Array) {
    this.device.queue.writeBuffer(this.tileLodBuffer, 0, lods);
  }

  /** lights: packed x,y,z,radius,r,g,b,kind (already selected & scaled). */
  setLights(lights: Float32Array, count: number) {
    const n = Math.min(count, MAX_LIGHTS);
    const head = new Uint32Array([n, 0, 0, 0]);
    this.device.queue.writeBuffer(this.lightBuffer, 0, head);
    if (n > 0) this.device.queue.writeBuffer(this.lightBuffer, 16, lights, 0, n * 8);
    this.lightCount = n;
  }

  // ---------------------------------------------------------------------------
  // Targets

  private ensureTargets() {
    const {canvas} = this.gpu;
    const w = canvas.width;
    const h = canvas.height;
    if (this.targets && this.targets.w === w && this.targets.h === h) return this.targets;
    const t = this.targets;
    if (t) {
      for (const x of [...t.gbuf, t.depth, t.lit, ...t.history, t.hiz, ...t.bloomDown, ...t.bloomUp, ...t.clouds, t.ao]) x.destroy();
    }
    const d = this.device;
    const tex = (label: string, format: GPUTextureFormat, tw: number, th: number, usage: number, mips = 1) =>
      d.createTexture({label, size: [Math.max(1, tw), Math.max(1, th)], format, usage, mipLevelCount: mips});
    const RT = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const ST = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const names = ['albedo', 'normal', 'emissive', 'motion'];
    const hw = Math.ceil(w / 2);
    const hh = Math.ceil(h / 2);
    const hizMips = Math.floor(Math.log2(Math.max(hw, hh))) + 1;
    const bloomDown: GPUTexture[] = [];
    const bloomUp: GPUTexture[] = [];
    for (let i = 0; i < 6; i++) {
      const bw = Math.ceil(w / 2 ** (i + 1));
      const bh = Math.ceil(h / 2 ** (i + 1));
      bloomDown.push(tex(`bloom/down${i}`, 'rgba16float', bw, bh, ST));
      bloomUp.push(tex(`bloom/up${i}`, 'rgba16float', bw, bh, ST));
    }
    this.targets = {
      w,
      h,
      gbuf: GBUFFER_FORMATS.map((f, i) => tex(`gbuffer/${names[i]}`, f, w, h, RT)),
      depth: tex('gbuffer/depth', DEPTH_FORMAT, w, h, RT),
      lit: tex('lighting/hdr', 'rgba16float', w, h, ST | GPUTextureUsage.RENDER_ATTACHMENT),
      history: [0, 1].map(i => tex(`taa/history${i}`, 'rgba16float', w, h, ST)),
      hiz: tex('hiz/pyramid', 'r32float', hw, hh, ST, hizMips),
      hizMips,
      bloomDown,
      bloomUp,
      clouds: [0, 1].map(i => tex(`clouds/accum${i}`, 'rgba16float', Math.ceil(w / 4), Math.ceil(h / 4), ST)),
      ao: tex('ssao/half res', 'rgba16float', hw, hh, ST),
    };
    this.frameIndex = 0;
    this.useOcclusion = false;
    return this.targets;
  }

  // ---------------------------------------------------------------------------
  // Per-frame setup

  private cascadeMatrices(eye: Vec3, fwd: Vec3, right: Vec3, up: Vec3, fovY: number, aspect: number, lightDir: Vec3, splits: number[]): Mat4[] {
    const out: Mat4[] = [];
    let prev = 0.1;
    const th = Math.tan(fovY / 2);
    for (let c = 0; c < CASCADES; c++) {
      const far = splits[c];
      const near = prev;
      prev = far;
      // Bounding sphere of the frustum slice.
      const corners: Vec3[] = [];
      for (const z of [near, far]) {
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            corners.push([
              eye[0] + fwd[0] * z + right[0] * sx * th * aspect * z + up[0] * sy * th * z,
              eye[1] + fwd[1] * z + right[1] * sx * th * aspect * z + up[1] * sy * th * z,
              eye[2] + fwd[2] * z + right[2] * sx * th * aspect * z + up[2] * sy * th * z,
            ]);
          }
        }
      }
      const center: Vec3 = [0, 0, 0];
      for (const q of corners) for (let k = 0; k < 3; k++) center[k] += q[k] / 8;
      let radius = 0;
      for (const q of corners) radius = Math.max(radius, Math.hypot(q[0] - center[0], q[1] - center[1], q[2] - center[2]));
      radius = Math.ceil(radius * 16) / 16;
      // Snap the center to shadow texels in light space to avoid shimmering.
      const lz = norm3(lightDir);
      const lx = norm3(cross3(Math.abs(lz[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0], lz));
      const ly = cross3(lz, lx);
      const texel = (radius * 2) / SHADOW_SIZE;
      const cx = Math.round((center[0] * lx[0] + center[1] * lx[1] + center[2] * lx[2]) / texel) * texel;
      const cy = Math.round((center[0] * ly[0] + center[1] * ly[1] + center[2] * ly[2]) / texel) * texel;
      const cz = center[0] * lz[0] + center[1] * lz[1] + center[2] * lz[2];
      const snapped: Vec3 = [lx[0] * cx + ly[0] * cy + lz[0] * cz, lx[1] * cx + ly[1] * cy + lz[1] * cz, lx[2] * cx + ly[2] * cy + lz[2] * cz];
      const back = 1500;
      const eyeL: Vec3 = [snapped[0] + lz[0] * back, snapped[1] + lz[1] * back, snapped[2] + lz[2] * back];
      const view = mat4.lookAt(mat4.create(), eyeL, snapped, ly);
      const proj = mat4.ortho(mat4.create(), -radius, radius, -radius, radius, 1, back + radius * 2);
      out.push(mat4.multiply(mat4.create(), proj, view));
    }
    return out;
  }

  private writeCullView(v: number, viewProj: Mat4, eye: Vec3, detail: number, occlusion: boolean, w: number, h: number, mips: number) {
    const data = new ArrayBuffer(256);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    f.set(viewProj, 0);
    f.set(frustumPlanes(viewProj), 16);
    f.set([eye[0], eye[1], eye[2], detail], 40);
    u.set([this.pool.clusterHighWater, occlusion ? 1 : 0, 6, 0], 44);
    f.set([w, h, mips, 0], 48);
    this.device.queue.writeBuffer(this.cullViewBuffers[v], 0, data);
    // Reset the indirect draw: 128 triangles * 3 vertices per instance (cluster).
    this.device.queue.writeBuffer(this.argsBuffers[v], 0, new Uint32Array([128 * 3, 0, 0, 0]));
  }

  private updateTerrainPatches(eye: Vec3) {
    const patches: number[] = [];
    const root = 16384;
    const visit = (x: number, z: number, size: number) => {
      const cx = x + size / 2;
      const cz = z + size / 2;
      if (Math.abs(cx) - size / 2 > this.worldSize / 2 + 4000 || Math.abs(cz) - size / 2 > this.worldSize / 2 + 4000) return;
      const d = Math.hypot(eye[0] - cx, eye[2] - cz, Math.max(0, eye[1] - 60));
      if (d < size * 1.4 && size > 64 && patches.length < 2000 * 4) {
        const h = size / 2;
        visit(x, z, h);
        visit(x + h, z, h);
        visit(x, z + h, h);
        visit(x + h, z + h, h);
      } else {
        patches.push(x, z, size, 0);
      }
    };
    visit(-root / 2, -root / 2, root);
    this.patchCount = patches.length / 4;
    this.device.queue.writeBuffer(this.patchBuffer, 0, new Float32Array(patches));
  }

  // ---------------------------------------------------------------------------

  render(v: ViewParams) {
    const d = this.device;
    const t = this.ensureTargets();
    const w = t.w;
    const h = t.h;
    const aspect = w / h;
    const fd = this.frame;

    // Camera.
    const fwd = norm3(sub3(v.target, v.eye));
    const right = norm3(cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    const view = mat4.lookAt(mat4.create(), v.eye, v.target, [0, 1, 0]);
    const proj = mat4.perspectiveReverseZ(mat4.create(), v.fov, aspect, v.near);
    const jIndex = (this.frameIndex % 8) + 1;
    const jx = ((halton(jIndex, 2) - 0.5) * 2) / w;
    const jy = ((halton(jIndex, 3) - 0.5) * 2) / h;
    const prevJ = [fd.f[F.jitter], fd.f[F.jitter + 1]];
    const projJ = mat4.copy(mat4.create(), proj);
    projJ[8] = -jx;
    projJ[9] = -jy;
    const viewProj = mat4.multiply(mat4.create(), projJ, view);
    const viewProjNoJ = mat4.multiply(mat4.create(), proj, view);
    const invViewProj = mat4.invert(mat4.create(), viewProj);

    // Sky and lighting constants.
    const haze = 1.3 + v.weather.fog * 3 + v.weather.rain * 2;
    this.sky = computeSky(v.hour, v.weather.cloud, v.weather.rain, haze, 1);
    const sky = this.sky;
    const lightDir: Vec3 = sky.sunDir[1] > -0.02 ? sky.sunDir : sky.moonDir;
    const splits = [22, 75, 240, 800];
    this.cascadeMats = this.cascadeMatrices(v.eye, fwd, right, up, v.fov, aspect, lightDir, splits);

    fd.set(F.viewProj, viewProj);
    fd.set(F.invViewProj, invViewProj);
    fd.set(F.prevViewProj, this.frameIndex === 0 ? viewProj : this.prevViewProj);
    fd.set(F.view, view);
    fd.set(F.proj, proj);
    fd.set(F.camPos, [...v.eye, v.near]);
    fd.set(F.sunDir, [...sky.sunDir, sky.sunUp]);
    fd.set(F.sunColor, [...sky.sunColor, 1]);
    fd.set(F.moonDir, [...sky.moonDir, sky.moonLight]);
    fd.set(F.resolution, [w, h, 1 / w, 1 / h]);
    fd.set(F.jitter, [jx, jy, this.frameIndex === 0 ? jx : prevJ[0], this.frameIndex === 0 ? jy : prevJ[1]]);
    fd.set(F.time, [v.time, v.dt, this.frameIndex, sky.night]);
    fd.set(F.weather, [v.weather.cloud, v.weather.rain, v.weather.wetness, v.weather.fog]);
    fd.set(F.wind, [v.weather.wind[0], v.weather.wind[1], 1, v.weather.lightning]);
    fd.set(F.world, [this.worldSize, this.heightCell, this.heightN, 0]);
    fd.set(F.cascadeSplits, splits);
    this.cascadeMats.forEach((m, i) => fd.set(F.cascades + i * 16, m));
    fd.set(F.exposure, [1, 0, 0, 0]);
    fd.set(F.skyAmbient, [...sky.skyAmbient, 0]);
    fd.set(F.groundAmbient, [...sky.groundAmbient, 0]);
    fd.set(F.cityGlow, [...sky.cityGlow, 0]);
    fd.set(F.misc, [v.debug, v.quality ?? 1, 0, sky.moonPhase]);
    d.queue.writeBuffer(this.frameBuffer, 0, fd.f);
    d.queue.writeBuffer(this.atmoBuffer, 0, new Float32Array([haze, 1, 0.12, 24]));

    // Occlusion culling is skipped for a frame after fast camera turns.
    const turn = fwd[0] * this.lastViewDir[0] + fwd[1] * this.lastViewDir[1] + fwd[2] * this.lastViewDir[2];
    this.lastViewDir = fwd;
    const occl = this.frameIndex > 2 && turn > 0.995 && v.debug !== 9;
    this.writeCullView(0, viewProjNoJ, v.eye, 0.0015, occl && this.useOcclusion, Math.ceil(w / 2), Math.ceil(h / 2), t.hizMips);
    for (let c = 0; c < CASCADES; c++) {
      this.writeCullView(1 + c, this.cascadeMats[c], v.eye, 0.004 * (c + 1), false, 0, 0, 0);
      d.queue.writeBuffer(this.shadowViewBuffers[c], 0, this.cascadeMats[c]);
    }
    this.updateTerrainPatches(v.eye);

    const enc = d.createCommandEncoder({label: 'frame'});
    for (const hk of this.hooks) hk.prepare?.(enc);

    // --- Compute: sky LUTs, cloud noise, culling.
    {
      const pass = enc.beginComputePass({label: 'pass/sky + cull'});
      const atmoG0 = (p: string) => this.bg(p, 0, [this.ubuf(this.frameBuffer), this.ubuf(this.atmoBuffer), this.linear], `bg/${p}/frame`);
      const skyKey = `${haze.toFixed(2)}`;
      if (!this.lutsReady || skyKey !== this.lastSkyKey) {
        this.lastSkyKey = skyKey;
        pass.setPipeline(this.p.transmittance as GPUComputePipeline);
        pass.setBindGroup(0, atmoG0('transmittance'));
        pass.setBindGroup(1, this.bg('transmittance', 1, [this.transmittance.createView()], 'bg/transmittance/out'));
        pass.dispatchWorkgroups(256 / 8, 64 / 8);
        pass.setPipeline(this.p.multiScat as GPUComputePipeline);
        pass.setBindGroup(0, atmoG0('multiScat'));
        pass.setBindGroup(1, this.bg('multiScat', 1, [null, this.transmittance.createView(), null, this.multiScat.createView()], 'bg/multiscatter'));
        pass.dispatchWorkgroups(4, 4);
        this.lutsReady = true;
      }
      if (!this.noiseReady) {
        pass.setPipeline(this.p.cloudNoise as GPUComputePipeline);
        pass.setBindGroup(0, this.bg('cloudNoise', 0, [this.ubuf(this.frameBuffer), this.linearRepeat], 'bg/cloud noise/frame'));
        pass.setBindGroup(1, this.bg('cloudNoise', 1, [this.cloudNoise.createView()], 'bg/cloud noise'));
        pass.dispatchWorkgroups(16, 16, 16);
        this.noiseReady = true;
      }
      pass.setPipeline(this.p.skyView as GPUComputePipeline);
      pass.setBindGroup(0, atmoG0('skyView'));
      pass.setBindGroup(1, this.bg('skyView', 1, [null, this.transmittance.createView(), this.multiScat.createView(), null, this.skyView.createView()], 'bg/sky view'));
      pass.dispatchWorkgroups(192 / 8, Math.ceil(108 / 8));
      pass.setPipeline(this.p.aerial as GPUComputePipeline);
      pass.setBindGroup(0, atmoG0('aerial'));
      pass.setBindGroup(1, this.bg('aerial', 1, [null, this.transmittance.createView(), this.multiScat.createView(), null, null, this.apVolume.createView()], 'bg/aerial perspective'));
      pass.dispatchWorkgroups(4, 4);

      // Clouds (quarter resolution, temporal).
      const cIn = t.clouds[this.frameIndex % 2];
      const cOut = t.clouds[(this.frameIndex + 1) % 2];
      pass.setPipeline(this.p.clouds as GPUComputePipeline);
      pass.setBindGroup(0, this.bg('clouds', 0, [this.ubuf(this.frameBuffer), this.linearRepeat], 'bg/clouds/frame'));
      pass.setBindGroup(1, this.bg('clouds', 1, [this.cloudNoise.createView(), cIn.createView(), cOut.createView()], 'bg/clouds'));
      pass.dispatchWorkgroups(Math.ceil(cOut.width / 8), Math.ceil(cOut.height / 8));

      // Cluster culling for the main view and each shadow cascade.
      const hizView = t.hiz.createView({label: 'hiz/all mips'});
      pass.setPipeline(this.p.cull as GPUComputePipeline);
      const groups = Math.ceil(Math.max(1, this.pool.clusterHighWater) / 64);
      for (let vi = 0; vi < VIEWS; vi++) {
        pass.setBindGroup(
          0,
          this.bg('cull', 0, [this.ubuf(this.cullViewBuffers[vi]), this.ubuf(this.pool.clusterBuffer), this.ubuf(this.tileLodBuffer), this.ubuf(this.visibleBuffers[vi]), this.ubuf(this.argsBuffers[vi]), hizView], `bg/cull/view${vi}`),
        );
        pass.dispatchWorkgroups(Math.min(groups, 65535));
      }
      pass.end();
      this.cullCount = groups;
    }

    // --- Shadows.
    const cityShadowG1 = (vi: number) =>
      this.bg('cityShadow', 1, [this.ubuf(this.pool.vertexBuffer), this.ubuf(this.pool.triBuffer), this.ubuf(this.pool.clusterBuffer), this.ubuf(this.visibleBuffers[vi])], `bg/city shadow/view${vi}`);
    for (let c = 0; c < CASCADES; c++) {
      const pass = enc.beginRenderPass({
        label: `pass/shadow cascade ${c}`,
        colorAttachments: [],
        depthStencilAttachment: {view: this.shadowMap.createView({dimension: '2d', baseArrayLayer: c, arrayLayerCount: 1, label: `shadow/cascade${c} view`}), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store'},
      });
      if (sky.sunUp > 0 || sky.moonLight > 0) {
        pass.setPipeline(this.p.cityShadow as GPURenderPipeline);
        pass.setBindGroup(0, this.bg('cityShadow', 0, [null, this.ubuf(this.shadowViewBuffers[c])], `bg/city shadow/cascade${c}`));
        pass.setBindGroup(1, cityShadowG1(1 + c));
        pass.setBindGroup(2, this.bg('cityShadow', 2, [null, this.linear, this.leafTex.createView()], `bg/city shadow/leaves${c}`));
        pass.drawIndirect(this.argsBuffers[1 + c], 0);
        for (const hk of this.hooks) hk.shadow?.(pass, c);
      }
      pass.end();
    }

    // --- G-buffer.
    {
      const pass = enc.beginRenderPass({
        label: 'pass/gbuffer',
        colorAttachments: t.gbuf.map((tx, i) => ({view: tx.createView(), loadOp: 'clear', storeOp: 'store', clearValue: i === 1 ? [0, 0, 1, 0] : [0, 0, 0, 0]})),
        depthStencilAttachment: {view: t.depth.createView({label: 'gbuffer/depth view'}), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store'},
      });
      const frameG0 = (p: string) => this.bg(p, 0, [this.ubuf(this.frameBuffer)], `bg/${p}/frame`);
      pass.setPipeline(this.p.city as GPURenderPipeline);
      pass.setBindGroup(0, frameG0('city'));
      pass.setBindGroup(1, this.bg('city', 1, [this.ubuf(this.pool.vertexBuffer), this.ubuf(this.pool.triBuffer), this.ubuf(this.pool.clusterBuffer), this.ubuf(this.visibleBuffers[0])], 'bg/city/main'));
      pass.setBindGroup(2, this.bg('city', 2, [this.signAtlas.createView(), this.linear, this.leafTex.createView()], 'bg/city/textures'));
      pass.drawIndirect(this.argsBuffers[0], 0);
      if (this.heightTex && this.landTex) {
        pass.setPipeline(this.p.terrain as GPURenderPipeline);
        pass.setBindGroup(0, frameG0('terrain'));
        pass.setBindGroup(1, this.bg('terrain', 1, [this.heightTex.createView(), this.landTex.createView(), this.ubuf(this.patchBuffer)], 'bg/terrain'));
        pass.setIndexBuffer(this.terrainIndex, 'uint32');
        pass.drawIndexed(this.terrainIndexCount, this.patchCount);
        pass.setPipeline(this.p.water as GPURenderPipeline);
        pass.setBindGroup(0, frameG0('water'));
        pass.setBindGroup(1, this.bg('water', 1, [this.heightTex.createView()], 'bg/water'));
        pass.draw(64 * 64 * 6);
      }
      for (const hk of this.hooks) hk.gbuffer?.(pass);
      pass.end();
    }

    // --- Hi-Z pyramid for next frame's occlusion culling.
    {
      const pass = enc.beginComputePass({label: 'pass/hiz'});
      const pg0 = (p: string) => this.bg(p, 0, [this.ubuf(this.frameBuffer), this.linear], `bg/${p}/frame`);
      pass.setPipeline(this.p.hizFromDepth as GPUComputePipeline);
      pass.setBindGroup(0, pg0('hizFromDepth'));
      pass.setBindGroup(1, this.bg('hizFromDepth', 1, [t.depth.createView(), null, t.hiz.createView({baseMipLevel: 0, mipLevelCount: 1})], 'bg/hiz/mip0'));
      pass.dispatchWorkgroups(Math.ceil(t.hiz.width / 8), Math.ceil(t.hiz.height / 8));
      pass.setPipeline(this.p.hizDown as GPUComputePipeline);
      pass.setBindGroup(0, pg0('hizDown'));
      for (let m = 1; m < t.hizMips; m++) {
        pass.setBindGroup(1, this.bg('hizDown', 1, [null, t.hiz.createView({baseMipLevel: m - 1, mipLevelCount: 1}), t.hiz.createView({baseMipLevel: m, mipLevelCount: 1})], `bg/hiz/mip${m}`));
        pass.dispatchWorkgroups(Math.ceil(Math.max(1, t.hiz.width >> m) / 8), Math.ceil(Math.max(1, t.hiz.height >> m) / 8));
      }
      pass.setPipeline(this.p.ao as GPUComputePipeline);
      pass.setBindGroup(0, this.bg('ao', 0, [this.ubuf(this.frameBuffer)], 'bg/ssao/frame'));
      pass.setBindGroup(1, this.bg('ao', 1, [t.depth.createView(), t.gbuf[1].createView(), t.ao.createView()], 'bg/ssao'));
      pass.dispatchWorkgroups(Math.ceil(t.ao.width / 8), Math.ceil(t.ao.height / 8));
      pass.end();
      this.useOcclusion = true;
    }

    // --- Lighting.
    const histPrev = t.history[this.frameIndex % 2];
    const histNext = t.history[(this.frameIndex + 1) % 2];
    {
      const pass = enc.beginComputePass({label: 'pass/lighting'});
      pass.setPipeline(this.p.lighting as GPUComputePipeline);
      pass.setBindGroup(0, this.bg('lighting', 0, [this.ubuf(this.frameBuffer)], 'bg/lighting/frame'));
      pass.setBindGroup(
        1,
        this.bg(
          'lighting',
          1,
          [
            t.gbuf[0].createView(),
            t.gbuf[1].createView(),
            t.gbuf[2].createView(),
            t.depth.createView(),
            this.shadowMap.createView({dimension: '2d-array'}),
            this.shadowSampler,
            this.skyView.createView(),
            this.transmittance.createView(),
            this.apVolume.createView(),
            this.linear,
            t.clouds[(this.frameIndex + 1) % 2].createView(),
            histPrev.createView(),
            t.lit.createView(),
            this.ubuf(this.lightBuffer),
            t.ao.createView(),
          ],
          'bg/lighting/inputs',
        ),
      );
      pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
      pass.end();
    }

    // --- Forward (vehicle glass, rain) onto the lit HDR image.
    if (this.hooks.some(hk => hk.forward)) {
      const pass = enc.beginRenderPass({
        label: 'pass/forward',
        colorAttachments: [{view: t.lit.createView(), loadOp: 'load', storeOp: 'store'}],
        depthStencilAttachment: {view: t.depth.createView(), depthReadOnly: true},
      });
      for (const hk of this.hooks) hk.forward?.(pass);
      pass.end();
    }

    // --- TAA, bloom, exposure.
    {
      const pass = enc.beginComputePass({label: 'pass/post'});
      const pg0 = (p: string) => this.bg(p, 0, [this.ubuf(this.frameBuffer), this.linear], `bg/${p}/frame`);
      pass.setPipeline(this.p.taa as GPUComputePipeline);
      pass.setBindGroup(0, pg0('taa'));
      pass.setBindGroup(1, this.bg('taa', 1, [t.lit.createView(), histPrev.createView(), t.gbuf[3].createView(), t.depth.createView(), histNext.createView()], 'bg/taa'));
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.setPipeline(this.p.bloomDown as GPUComputePipeline);
      pass.setBindGroup(0, pg0('bloomDown'));
      for (let i = 0; i < t.bloomDown.length; i++) {
        const src = i === 0 ? histNext : t.bloomDown[i - 1];
        pass.setBindGroup(1, this.bg('bloomDown', 1, [src.createView(), t.bloomDown[i].createView()], `bg/bloom down ${i}`));
        pass.dispatchWorkgroups(Math.ceil(t.bloomDown[i].width / 8), Math.ceil(t.bloomDown[i].height / 8));
      }
      pass.setPipeline(this.p.bloomUp as GPUComputePipeline);
      pass.setBindGroup(0, pg0('bloomUp'));
      for (let i = t.bloomUp.length - 2; i >= 0; i--) {
        const src = i === t.bloomUp.length - 2 ? t.bloomDown[i + 1] : t.bloomUp[i + 1];
        pass.setBindGroup(1, this.bg('bloomUp', 1, [src.createView(), t.bloomUp[i].createView(), t.bloomDown[i].createView()], `bg/bloom up ${i}`));
        pass.dispatchWorkgroups(Math.ceil(t.bloomUp[i].width / 8), Math.ceil(t.bloomUp[i].height / 8));
      }
      pass.setPipeline(this.p.exposure as GPUComputePipeline);
      pass.setBindGroup(0, pg0('exposure'));
      pass.setBindGroup(1, this.bg('exposure', 1, [t.bloomDown[3].createView(), this.ubuf(this.exposureBuffer)], 'bg/exposure'));
      pass.dispatchWorkgroups(1);
      pass.end();
    }

    // --- Tonemap to the swapchain.
    {
      const pass = enc.beginRenderPass({
        label: 'pass/tonemap',
        colorAttachments: [{view: this.gpu.context.getCurrentTexture().createView({label: 'swapchain view'}), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1]}],
      });
      pass.setPipeline(this.p.tonemap as GPURenderPipeline);
      pass.setBindGroup(0, this.bg('tonemap', 0, [this.ubuf(this.frameBuffer), this.linear], 'bg/tonemap/frame'));
      pass.setBindGroup(1, this.bg('tonemap', 1, [histNext.createView(), t.bloomUp[0].createView(), this.ubuf(this.exposureBuffer)], 'bg/tonemap'));
      pass.draw(3);
      pass.end();
    }

    d.queue.submit([enc.finish()]);
    this.prevViewProj = viewProj;
    this.frameIndex++;
    const ps = this.pool.stats;
    Object.assign(this.stats, {
      clusters: ps.clusters,
      tris: ps.tris,
      verts: ps.verts,
      lights: this.lightCount,
      patches: this.patchCount,
      cullGroups: this.cullCount,
    });
  }

  get viewProj() {
    return this.prevViewProj;
  }
}
