// Frame orchestration: atmosphere LUTs, GPU culling, shadow cascades, G-buffer,
// Hi-Z, clouds, tiled lighting, TAA, bloom, exposure and tonemapping.

import {release} from '../mem.ts';
import {createShader, type Gpu} from '../gpu/device.ts';
import {addSpan, begin, fromWorker, pipeline, timed} from '../ui/timeline.ts';
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
import skyvisWgsl from '../shaders/skyvis.wgsl';
import surfaceWgsl from '../shaders/surface.wgsl';
import terrainWgsl from '../shaders/terrain.wgsl';
import {computeSky, type SkyState} from '../world/sky.ts';
import {ClusterPool, type PoolHandle} from './cluster-pool.ts';
import {F, FrameData} from './frame.ts';
import {CpuProfiler, FrameTimer, GpuProfiler} from './profiler.ts';
import {OFF_BITS, hasOff, offWords, orOff, type OffName} from './ablation.ts';
import {receiverPlanes} from './shadow-cull.ts';
import {
  CACHE_TOL,
  cacheTouches,
  cacheValid,
  type CascadeCache,
} from './shadow-cache.ts';
import {createLeafTexture, uploadSignAtlas, vinylWgsl} from './sign-atlas.ts';
import {signWaysWgsl} from '../city/signs.ts';
import {uploadDetailTexture} from './detail-tex.ts';
import type {TextureResult} from '../workers/texture-worker.ts';
import {MAT_GROUPS, groupMatMask, type ClusterData} from '../city/cmesh.ts';

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
  /** Rain drops on the lens (bumper / first-person cameras). */
  lensDrops?: boolean;
  /** Camera inside a vehicle (no god rays). */
  interior?: boolean;
  /** Motion blur amount 0..1, depth of field aperture (0 = off) and focus distance (m). */
  motionBlur?: number;
  dofAperture?: number;
  focus?: number;
}

/** Hook for other systems (vehicles, rain) to add draws into renderer passes. */
export interface DrawHook {
  /** Pass label suffix for the GPU profiler. */
  readonly name?: string;
  gbuffer?(pass: GPURenderPassEncoder): void;
  shadow?(pass: GPURenderPassEncoder, cascade: number): void;
  forward?(pass: GPURenderPassEncoder): void;
  prepare?(encoder: GPUCommandEncoder): void;
}

export const GBUFFER_FORMATS: GPUTextureFormat[] = [
  'rgba8unorm',
  'rgba16float',
  'rgba16float',
  'rg16float',
];
const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
/** city-materials.wgsl FAR_FOOT (m per pixel where far shading starts). */
const FAR_FOOT = 0.8;
/** Opaque draw lists of the main view: material group x near / far. */
const LISTS = 2 * MAT_GROUPS;
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

/** Internal-resolution targets (render scale x the canvas). */
interface Targets {
  w: number;
  h: number;
  gbuf: GPUTexture[];
  depth: GPUTexture;
  lit: GPUTexture;
  hiz: GPUTexture;
  hizMips: number;
  ao: GPUTexture;
  /** Half-res reflections (lighting.wgsl reflectHalf): skyline, SSR. */
  refl: GPUTexture[];
  rays: GPUTexture;
}

/** Display-resolution targets (the canvas size). */
interface OutTargets {
  w: number;
  h: number;
  history: GPUTexture[];
  bloomDown: GPUTexture[];
  bloomUp: GPUTexture[];
  /** Motion blur / DOF output when upscaling (else it writes `lit`). */
  post: GPUTexture | null;
}

/** Cloud march modes (frame.extra) per cloud quality: off .. ultra. */
export const CLOUD_LEVELS = [
  {div: 8, mode: 0, steps: 1},
  {div: 8, mode: 2, steps: 0.6},
  {div: 4, mode: 2, steps: 1},
  {div: 4, mode: 1, steps: 1},
  {div: 2, mode: 2, steps: 1},
] as const;

export interface RendererOptions {
  /** Smaller cluster pool (see City.lowMemory). */
  lowMemory?: boolean;
}

export class Renderer {
  readonly gpu: Gpu;
  readonly device: GPUDevice;
  readonly pool: ClusterPool;
  readonly frame = new FrameData();
  sky: SkyState = computeSky(12, 0.3, 0, 1, 1);
  hooks: DrawHook[] = [];
  readonly stats: Record<string, number | string> = {};
  /**
   * Count visible clusters and triangles per cull view (stats.view*), read
   * back every few frames. Off by default (one extra atomic per cluster).
   */
  cullStats = false;
  /** Scales the fine-detail cull distances (cmesh CLUSTER_FAR_SHIFT). */
  farCullScale = 1;
  /**
   * Internal render resolution as a fraction of the canvas (per axis). Below
   * 1 the G-buffer and every screen-space pass run smaller and TAA upsamples
   * into the display-resolution history (post.wgsl taau).
   */
  renderScale = 1;
  /** Contrast-adaptive sharpening in tonemap (0.22 = the original look). */
  sharpen = 0.22;
  /** Bloom strength (0 = off: only the exposure meter's levels are built). */
  bloom = 1;
  /** Cloud quality 0..4 (CLOUD_LEVELS): off, low, medium, high, ultra. */
  cloudQuality = 3;
  /** Shadow map size per cascade (setShadowSize). */
  shadowSize = 2048;
  /** Feature switches from the settings (ablation bits, OR'ed with offBits). */
  userOff = 0;
  /**
   * Whole-frame GPU time (ms, smoothed) when measureGpu is set: timestamps
   * around the frame if available, else submit -> onSubmittedWorkDone.
   */
  gpuMs = 0;
  measureGpu = false;
  private frameTimer: FrameTimer | null = null;
  private gpuPending = false;
  private gpuSamples = 0;
  private gpuFallbackMs = 0;
  private cullStatsBuf: GPUBuffer | null = null;
  private cullStatsBusy = false;

  readonly frameBuffer: GPUBuffer;
  private atmoBuffer: GPUBuffer;
  private linear: GPUSampler;
  private linearRepeat: GPUSampler;
  private shadowSampler: GPUSampler;
  private signAtlas!: GPUTexture;
  private leafTex: GPUTexture;
  private detailTex!: GPUTexture;
  private detailSampler: GPUSampler;
  private anisoClamp: GPUSampler;
  private whiteTex: GPUTexture;
  private shadowMap: GPUTexture;
  private transmittance: GPUTexture;
  private multiScat: GPUTexture;
  private skyView: GPUTexture;
  private apVolume: GPUTexture;
  private cloudNoise: GPUTexture;
  private exposureBuffer: GPUBuffer;
  private lightBuffer: GPUBuffer;
  private contactBuffer: GPUBuffer;
  private tileLodBuffer: GPUBuffer;
  private patchBuffer: GPUBuffer;
  private terrainIndex: GPUBuffer;
  private terrainIndexCount: number;
  private heightTex: GPUTexture | null = null;
  private landTex: GPUTexture | null = null;
  private skylineTex: GPUTexture | null = null;
  private worldSize = 6144;
  private heightCell = 4;
  private heightN = 1537;

  private cullViewBuffers: GPUBuffer[] = [];
  private visibleBuffers: GPUBuffer[] = [];
  private argsBuffers: GPUBuffer[] = [];
  /** Alpha-tested clusters (cmesh CLUSTER_ALPHA): their own list and draw. */
  private visibleAlphaBuffers: GPUBuffer[] = [];
  private argsAlphaBuffers: GPUBuffer[] = [];
  readonly shadowViewBuffers: GPUBuffer[] = [];

  private p!: Record<string, GPURenderPipeline | GPUComputePipeline>;
  private targets: Targets | null = null;
  private out: OutTargets | null = null;
  private clouds: GPUTexture[] = [];
  /** Frames rendered into the current cloud textures (their history age). */
  private cloudFrames = 0;
  private frameIndex = 0;
  private prevViewProj = mat4.create();
  private lutsReady = false;
  private noiseReady = false;
  private lastSkyKey = '';
  private cullCount = 0;
  private lightCount = 0;
  // This frame's lights (setLights), culled to the view in render().
  private lightSrc = new Float32Array(MAX_LIGHTS * 8);
  private lightSrcCount = 0;
  private lightUpload = new Float32Array(4 + MAX_LIGHTS * 8);
  private patchCount = 0;
  private useOcclusion = false;
  private lastViewDir: Vec3 = [0, 0, -1];
  private cascadeMats: Mat4[] = [];
  private cascadeRadii: number[] = [];
  /** Static city depth per cascade (shadow-cache.ts) and what it covers. */
  private shadowStatic: GPUTexture;
  private shadowCache: (CascadeCache | null)[] = [null, null, null, null];
  /** Cascades whose city depth is redrawn this frame. */
  private shadowRedraw = [true, true, true, true];
  /** Cascade redraws (stats: how often the cache misses). */
  shadowRedraws = 0;
  /** The tile LODs last published, and each tile's geometry bounds. */
  private tileLodsCpu = new Uint32Array(0);
  private tileBounds = new Map<number, [Vec3, Vec3]>();
  /** GPU pass timer (only with ?prof=1; see enableProfiler). */
  prof: GpuProfiler | null = null;
  /** CPU marks inside render() when profiling. */
  cpuProf: CpuProfiler | null = null;
  private cpass: GPUComputePassEncoder | null = null;
  /** Profiler mode: every segment its own timed pass (else whole passes). */
  private splitPasses = false;
  /** Ablation bits (?off=..., see ablation.ts); 0 normally. */
  offBits = 0;
  /** offBits | userOff for the frame being rendered. */
  private bits = 0;
  /** Ablation: city material ids (bit per id) drawn as a flat colour. */
  offMats = 0;

  private constructor(gpu: Gpu, opts: RendererOptions) {
    this.gpu = gpu;
    const device = gpu.device;
    this.device = device;
    const lim = device.limits.maxStorageBufferBindingSize;
    // A whole city's LOD1 shells plus the LOD0 ring need ~24M vertices
    // (neon seed 1 at load: 487 MB of packed vertex words, city/vpack.ts,
    // 16M triangles, 130k clusters); with less the last tiles to stream in
    // fail to upload and whole districts show as bare streets.
    // Low-memory devices stream less (City.lowMemory) into a smaller pool.
    const mb = opts.lowMemory ? 384 : 512;
    const maxWords = Math.floor(
      Math.min(lim, device.limits.maxBufferSize, mb * 1024 * 1024) / 4,
    );
    this.pool = new ClusterPool(
      device,
      maxWords,
      Math.min(Math.floor(lim / 4), mb * 40_000),
      mb * 400,
    );
    this.frameBuffer = device.createBuffer({
      label: 'frame/uniforms',
      size: this.frame.f.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.atmoBuffer = device.createBuffer({
      label: 'sky/atmosphere params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.linear = device.createSampler({
      label: 'sampler/linear clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    // Sign atlas and leaf cards: clamp, trilinear, 8x anisotropic so sign
    // text keeps its strokes at grazing angles (city-materials atlasGrad).
    this.anisoClamp = device.createSampler({
      label: 'sampler/aniso clamp',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 8,
    });
    this.linearRepeat = device.createSampler({
      label: 'sampler/linear repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });
    this.shadowSampler = device.createSampler({
      label: 'sampler/shadow compare',
      compare: 'less-equal',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    // (The sign atlas and detail layers come from the texture worker.)
    this.leafTex = timed('leaf texture', () => createLeafTexture(device));
    this.detailSampler = device.createSampler({
      label: 'sampler/detail aniso repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: 8,
    });
    this.whiteTex = device.createTexture({
      label: 'texture/white',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      {texture: this.whiteTex},
      new Uint8Array([255, 255, 255, 255]),
      {},
      [1, 1],
    );
    [this.shadowMap, this.shadowStatic] = this.createShadowMaps();
    const lut = (label: string, w: number, h: number, d = 1) =>
      device.createTexture({
        label,
        size: [w, h, d],
        dimension: d > 1 ? '3d' : '2d',
        format: 'rgba16float',
        usage:
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.transmittance = lut('sky/transmittance LUT', 256, 64);
    this.multiScat = lut('sky/multiscatter LUT', 32, 32);
    this.skyView = lut('sky/sky-view LUT', 192, 108);
    this.apVolume = lut('sky/aerial perspective volume', 32, 32, 32);
    this.cloudNoise = device.createTexture({
      label: 'clouds/noise volume',
      size: [64, 64, 64],
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.exposureBuffer = device.createBuffer({
      label: 'post/exposure',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this.exposureBuffer,
      0,
      new Float32Array([0, 0, 0, 0]),
    );
    this.lightBuffer = device.createBuffer({
      label: 'lights/visible list',
      size: 16 + MAX_LIGHTS * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.contactBuffer = device.createBuffer({
      label: 'vehicles/contact occlusion',
      size: 16 + 128 * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.contactBuffer, 0, new Uint32Array(4));
    this.tileLodBuffer = device.createBuffer({
      label: 'city/tile lod',
      size: 4 * 4096,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.patchBuffer = device.createBuffer({
      label: 'terrain/patches',
      size: 16 * 2048,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
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
    this.terrainIndex = device.createBuffer({
      label: 'terrain/patch indices',
      size: idx.length * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.terrainIndex, 0, new Uint32Array(idx));
    for (let v = 0; v < VIEWS; v++) {
      const name = v === 0 ? 'main' : `cascade${v - 1}`;
      this.cullViewBuffers.push(
        device.createBuffer({
          label: `cull/${name}/view`,
          size: 320,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      // The main view's opaque clusters in LISTS lists (cull.wgsl args).
      const lists = v === 0 ? LISTS : 1;
      this.visibleBuffers.push(
        device.createBuffer({
          label: `cull/${name}/visible clusters`,
          size: this.pool.maxClusters * 4 * lists,
          usage: GPUBufferUsage.STORAGE,
        }),
      );
      this.argsBuffers.push(
        device.createBuffer({
          label: `cull/${name}/indirect args`,
          size: 32 * lists,
          usage:
            GPUBufferUsage.STORAGE |
            GPUBufferUsage.INDIRECT |
            GPUBufferUsage.COPY_DST |
            GPUBufferUsage.COPY_SRC,
        }),
      );
      this.visibleAlphaBuffers.push(
        device.createBuffer({
          label: `cull/${name}/visible alpha-tested clusters`,
          size: this.pool.maxClusters * 4,
          usage: GPUBufferUsage.STORAGE,
        }),
      );
      this.argsAlphaBuffers.push(
        device.createBuffer({
          label: `cull/${name}/indirect args alpha-tested`,
          size: 32,
          usage:
            GPUBufferUsage.STORAGE |
            GPUBufferUsage.INDIRECT |
            GPUBufferUsage.COPY_DST |
            GPUBufferUsage.COPY_SRC,
        }),
      );
      if (v > 0)
        this.shadowViewBuffers.push(
          device.createBuffer({
            label: `shadow/${name}/view`,
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          }),
        );
    }
  }

  private createShadowMaps(): [GPUTexture, GPUTexture] {
    const n = this.shadowSize;
    return [
      this.device.createTexture({
        label: 'shadow/cascades',
        size: [n, n, CASCADES],
        format: DEPTH_FORMAT,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST,
      }),
      this.device.createTexture({
        label: 'shadow/static cascades',
        size: [n, n, CASCADES],
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      }),
    ];
  }

  /** Change the shadow map resolution (recreates both cascade arrays). */
  setShadowSize(n: number) {
    if (n === this.shadowSize) return;
    this.shadowSize = n;
    this.shadowMap.destroy();
    this.shadowStatic.destroy();
    [this.shadowMap, this.shadowStatic] = this.createShadowMaps();
    this.shadowCache.fill(null);
  }

  /**
   * Resolves once every pipeline is compiled and the generated textures are
   * uploaded; render() needs it. create() starts both and returns at once,
   * so they run while the city generates.
   */
  ready!: Promise<void>;

  static create(gpu: Gpu, opts: RendererOptions = {}): Renderer {
    const r = timed('renderer resources', () => new Renderer(gpu, opts));
    const endAll = begin('renderer pipelines + textures');
    r.ready = Promise.all([r.createPipelines(), r.loadTextures()]).then(endAll);
    return r;
  }

  /** Sign atlas and detail layers, painted in a worker. */
  private loadTextures() {
    const w = new Worker(new URL('./texture-worker.js', import.meta.url), {
      type: 'module',
      name: 'texture-worker',
    });
    return new Promise<void>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<TextureResult>) => {
        w.terminate();
        const m = e.data;
        for (const [name, t0, t1] of m.spans)
          addSpan(name, fromWorker(t0), fromWorker(t1), 'textures');
        timed('upload generated textures', () => {
          this.signAtlas = uploadSignAtlas(this.device, m.sign);
          this.detailTex = uploadDetailTexture(this.device, m.detail);
        });
        resolve();
      };
      w.onerror = e => reject(new Error(`[texture worker] ${e.message}`));
      w.postMessage(null);
    });
  }

  private async createPipelines() {
    const d = this.device;
    const mod = (label: string, ...parts: string[]) =>
      createShader(d, label, parts.join('\n'));
    const cityMod = mod(
      'shader/city',
      commonWgsl,
      surfaceWgsl,
      vinylWgsl(),
      signWaysWgsl(),
      cityMaterialsWgsl,
      cityWgsl,
    );
    const terrainMod = mod(
      'shader/terrain',
      commonWgsl,
      surfaceWgsl,
      terrainWgsl,
    );
    const cullMod = mod('shader/cull', cullWgsl);
    const atmoMod = mod('shader/atmosphere', commonWgsl, atmosphereWgsl);
    const lightMod = mod(
      'shader/lighting',
      commonWgsl,
      surfaceWgsl.replace(/struct GOut[\s\S]*$/, ''),
      skyvisWgsl,
      lightingWgsl,
    );
    const postMod = mod('shader/post', commonWgsl, postWgsl);
    const cloudMod = mod('shader/clouds', commonWgsl, cloudsWgsl);
    const aoMod = mod('shader/ao', commonWgsl, skyvisWgsl, aoWgsl);
    const gTargets: GPUColorTargetState[] = GBUFFER_FORMATS.map(format => ({
      format,
    }));
    const gDepth: GPUDepthStencilState = {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: 'greater',
    };
    const compute = (
      label: string,
      module: GPUShaderModule,
      entryPoint: string,
      constants?: Record<string, number>,
    ) =>
      d.createComputePipelineAsync({
        label,
        layout: 'auto',
        compute: {module, entryPoint, constants},
      });
    const endCalls = begin('create*PipelineAsync calls');
    const entries: [string, Promise<GPURenderPipeline | GPUComputePipeline>][] =
      [
        [
          'city',
          d.createRenderPipelineAsync({
            label: 'pipeline/city gbuffer',
            layout: 'auto',
            vertex: {module: cityMod, entryPoint: 'vs'},
            fragment: {module: cityMod, entryPoint: 'fs', targets: gTargets},
            primitive: {cullMode: 'back'},
            depthStencil: gDepth,
          }),
        ],
        // The main view's opaque lists (cull.wgsl args): material group g
        // near (list g) and far (MAT_GROUPS + g), each compiled with only
        // its group's material code and the far ones with far shading.
        ...Array.from(
          {length: LISTS},
          (_, k): [string, Promise<GPURenderPipeline>] => [
            `cityList${k}`,
            d.createRenderPipelineAsync({
              label: `pipeline/city gbuffer ${k < MAT_GROUPS ? 'near' : 'far'} group ${k % MAT_GROUPS}`,
              layout: 'auto',
              vertex: {
                module: cityMod,
                entryPoint: 'vs',
                constants: {LIST: k, LISTS},
              },
              fragment: {
                module: cityMod,
                entryPoint: 'fsOpaque',
                targets: gTargets,
                constants: {
                  FAR_SHADE: k < MAT_GROUPS ? 0 : 1,
                  MAT_ON: groupMatMask(k % MAT_GROUPS),
                },
              },
              primitive: {cullMode: 'back'},
              depthStencil: gDepth,
            }),
          ],
        ),
        [
          'cityShadowOpaque',
          d.createRenderPipelineAsync({
            label: 'pipeline/city shadow opaque',
            layout: 'auto',
            vertex: {module: cityMod, entryPoint: 'vsShadow'},
            primitive: {cullMode: 'none'},
            depthStencil: {
              format: DEPTH_FORMAT,
              depthWriteEnabled: true,
              depthCompare: 'less',
              depthBias: 2,
              depthBiasSlopeScale: 2.5,
            },
          }),
        ],
        [
          'cityShadow',
          d.createRenderPipelineAsync({
            label: 'pipeline/city shadow',
            layout: 'auto',
            vertex: {module: cityMod, entryPoint: 'vsShadow'},
            fragment: {module: cityMod, entryPoint: 'fsShadow', targets: []},
            primitive: {cullMode: 'none'},
            depthStencil: {
              format: DEPTH_FORMAT,
              depthWriteEnabled: true,
              depthCompare: 'less',
              depthBias: 2,
              depthBiasSlopeScale: 2.5,
            },
          }),
        ],
        [
          'terrain',
          d.createRenderPipelineAsync({
            label: 'pipeline/terrain gbuffer',
            layout: 'auto',
            vertex: {module: terrainMod, entryPoint: 'vs'},
            fragment: {module: terrainMod, entryPoint: 'fs', targets: gTargets},
            primitive: {cullMode: 'back'},
            depthStencil: gDepth,
          }),
        ],
        [
          'water',
          d.createRenderPipelineAsync({
            label: 'pipeline/water gbuffer',
            layout: 'auto',
            vertex: {module: terrainMod, entryPoint: 'vsWater'},
            fragment: {
              module: terrainMod,
              entryPoint: 'fsWater',
              targets: gTargets,
            },
            primitive: {cullMode: 'none'},
            depthStencil: gDepth,
          }),
        ],
        ['cull', compute('pipeline/cull', cullMod, 'main', {MAT_GROUPS})],
        [
          'transmittance',
          compute('pipeline/sky transmittance', atmoMod, 'transmittanceLut'),
        ],
        [
          'multiScat',
          compute('pipeline/sky multiscatter', atmoMod, 'multiScatLut'),
        ],
        ['skyView', compute('pipeline/sky view', atmoMod, 'skyViewLut')],
        [
          'aerial',
          compute('pipeline/aerial perspective', atmoMod, 'aerialPerspective'),
        ],
        // Variants: reflections / sky visibility at half res (r1 s1, the
        // default) or traced in the kernel (?off=hrefl, hskyvis).
        ...[0, 1, 2, 3].map(
          k =>
            [
              `lighting:r${k & 1}s${k >> 1}`,
              compute(
                `pipeline/lighting r${k & 1}s${k >> 1}`,
                lightMod,
                'main',
                {
                  HALF_REFL: k & 1,
                  HALF_SKYVIS: k >> 1,
                },
              ),
            ] as [string, Promise<GPUComputePipeline>],
        ),
        [
          'reflect',
          compute('pipeline/reflections half res', lightMod, 'reflectHalf'),
        ],
        ['taa', compute('pipeline/taa', postMod, 'taa')],
        ['taau', compute('pipeline/taa upsample', postMod, 'taau')],
        [
          'motionDof',
          compute('pipeline/motion blur + dof', postMod, 'motionDof'),
        ],
        ['godRays', compute('pipeline/god rays', postMod, 'godRays')],
        [
          'hizFromDepth',
          compute('pipeline/hiz from depth', postMod, 'hizFromDepth'),
        ],
        ['hizDown', compute('pipeline/hiz downsample', postMod, 'hizDown')],
        ['bloomDown', compute('pipeline/bloom down', postMod, 'bloomDown')],
        ['bloomUp', compute('pipeline/bloom up', postMod, 'bloomUp')],
        ['exposure', compute('pipeline/exposure', postMod, 'exposure')],
        [
          'tonemap',
          d.createRenderPipelineAsync({
            label: 'pipeline/tonemap',
            layout: 'auto',
            vertex: {module: postMod, entryPoint: 'vsFull'},
            fragment: {
              module: postMod,
              entryPoint: 'fsTonemap',
              targets: [{format: this.gpu.format}],
            },
          }),
        ],
        ['cloudNoise', compute('pipeline/cloud noise', cloudMod, 'genNoise')],
        ['clouds', compute('pipeline/clouds', cloudMod, 'march')],
        ['ao', compute('pipeline/ssao', aoMod, 'main')],
      ];
    endCalls();
    const done = await Promise.all(entries.map(([k, p]) => pipeline(k, p)));
    this.p = Object.fromEntries(entries.map(([k], i) => [k, done[i]]));
  }

  private bg(
    pipeline: string,
    group: number,
    entries: (GPUBindingResource | null)[],
    label: string,
  ): GPUBindGroup {
    const p = this.p[pipeline];
    return this.device.createBindGroup({
      label,
      layout: p.getBindGroupLayout(group),
      entries: entries
        .map((resource, binding) => ({binding, resource}))
        .filter(e => e.resource !== null) as GPUBindGroupEntry[],
    });
  }

  private ubuf(b: GPUBuffer): GPUBufferBinding {
    return {buffer: b};
  }

  /** Turn on per-pass GPU timing (needs the timestamp-query feature). */
  enableProfiler(split = true) {
    if (!this.gpu.features.timestamp || this.prof) return;
    this.prof = new GpuProfiler(this.device);
    this.splitPasses = split;
  }

  private off(name: OffName) {
    return hasOff(this.bits, name);
  }

  /** Hooks minus the ones switched off by ablation flags. */
  private activeHooks() {
    if (!this.bits) return this.hooks;
    return this.hooks.filter(
      hk => !(hk.name && hk.name in OFF_BITS && this.off(hk.name as OffName)),
    );
  }

  /**
   * A compute segment. Without the profiler consecutive segments share one
   * compute pass until endCompute(); with it each segment is its own timed pass.
   */
  private compute(enc: GPUCommandEncoder, label: string) {
    if (this.cpass && !this.splitPasses) return this.cpass;
    this.cpass?.end();
    this.cpass = enc.beginComputePass({
      label: `pass/${label}`,
      timestampWrites:
        this.prof?.writes(label) ??
        (label === 'sky luts' ? this.frameTimer?.first() : undefined),
    });
    return this.cpass;
  }

  private endCompute() {
    this.cpass?.end();
    this.cpass = null;
  }

  /**
   * A render pass whose draws can be split into separately timed segments
   * when profiling: seg() ends the pass and continues in a new one that loads
   * the attachments. Without the profiler seg() returns the same pass.
   */
  private renderPass(
    enc: GPUCommandEncoder,
    desc: GPURenderPassDescriptor,
    label: string,
  ) {
    const prof = this.prof;
    const split = this.splitPasses;
    let pass = enc.beginRenderPass({
      ...desc,
      label: `pass/${label}`,
      timestampWrites:
        prof?.writes(label) ??
        (label === 'tonemap' ? this.frameTimer?.last() : undefined),
    });
    const cont: GPURenderPassDescriptor = {
      colorAttachments: [...desc.colorAttachments].map(a =>
        a ? {...a, loadOp: 'load' as const} : a,
      ),
      depthStencilAttachment: desc.depthStencilAttachment
        ? desc.depthStencilAttachment.depthReadOnly
          ? desc.depthStencilAttachment
          : {...desc.depthStencilAttachment, depthLoadOp: 'load' as const}
        : undefined,
    };
    return {
      get pass() {
        return pass;
      },
      seg(l: string): GPURenderPassEncoder {
        if (!prof || !split) return pass;
        pass.end();
        pass = enc.beginRenderPass({
          ...cont,
          label: `pass/${l}`,
          timestampWrites: prof.writes(l),
        });
        return pass;
      },
      end() {
        pass.end();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // City data

  setTerrain(
    heights: Float32Array,
    n: number,
    cell: number,
    size: number,
    landUse: Uint8Array,
  ) {
    this.worldSize = size;
    this.heightCell = cell;
    this.heightN = n;
    this.heightTex?.destroy();
    this.landTex?.destroy();
    this.heightTex = this.device.createTexture({
      label: 'terrain/heightmap',
      size: [n, n],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      {texture: this.heightTex},
      heights,
      {bytesPerRow: n * 4},
      [n, n],
    );
    // r8unorm rows must be 256-byte aligned for writeTexture; pad rows.
    const row = Math.ceil(n / 256) * 256;
    const padded = new Uint8Array(row * n);
    for (let j = 0; j < n; j++)
      padded.set(landUse.subarray(j * n, j * n + n), j * row);
    this.landTex = this.device.createTexture({
      label: 'terrain/land use',
      size: [n, n],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      {texture: this.landTex},
      padded,
      {bytesPerRow: row},
      [n, n],
    );
  }

  /**
   * Uploads a cluster batch; null if the pool has no room. Once uploaded
   * the pool owns d's arrays and frees them when they are written.
   */
  uploadClusters(d: ClusterData): PoolHandle | null {
    if (!d.clusterCount) return this.pool.upload(d);
    // The batch's tile (every cluster of a batch shares it) and LOD.
    const tile = d.clusters[7];
    const lod = (d.clusters[6] >>> 8) & 0xf;
    const bounds = d.bounds;
    const h = this.pool.upload(d, () => {
      // (Written: the static shadow cache redraws what it covers.)
      if (this.shown(tile, lod)) this.shadowTouch(bounds[0], bounds[1]);
      release(d.vertices, d.tris, d.clusters);
    });
    if (h) {
      h.tile = tile;
      h.lod = lod;
      h.bounds = bounds;
      const b = this.tileBounds.get(tile);
      if (!b) this.tileBounds.set(tile, [[...bounds[0]], [...bounds[1]]]);
      else
        for (let k = 0; k < 3; k++) {
          b[0][k] = Math.min(b[0][k], bounds[0][k]);
          b[1][k] = Math.max(b[1][k], bounds[1][k]);
        }
    }
    return h;
  }

  freeClusters(h: PoolHandle) {
    this.pool.free(h);
    if (h.bounds && this.shown(h.tile!, h.lod!))
      this.shadowTouch(h.bounds[0], h.bounds[1]);
  }

  setTileLods(lods: Uint32Array) {
    this.device.queue.writeBuffer(this.tileLodBuffer, 0, lods);
    const prev = this.tileLodsCpu;
    if (prev.length === lods.length) {
      for (let t = 0; t < lods.length; t++) {
        if (prev[t] === lods[t]) continue;
        const b = this.tileBounds.get(t);
        if (b) this.shadowTouch(b[0], b[1]);
      }
      prev.set(lods);
    } else {
      this.tileLodsCpu = lods.slice();
      this.shadowCache.fill(null);
    }
  }

  /** Whether clusters of `tile` at `lod` are drawn (cull.wgsl's LOD test). */
  private shown(tile: number, lod: number) {
    return tile === 0xffffffff || this.tileLodsCpu[tile] === lod;
  }

  /** Drop the cached shadow cascades whose footprint the box reaches. */
  private shadowTouch(lo: Vec3, hi: Vec3) {
    for (let c = 0; c < CASCADES; c++) {
      const k = this.shadowCache[c];
      if (k && cacheTouches(k, lo, hi)) this.shadowCache[c] = null;
    }
  }

  /**
   * lights: packed x,y,z,radius,r,g,b,kind (already selected & scaled).
   * Uploaded by render(), culled to the view frustum.
   */
  setLights(lights: Float32Array, count: number) {
    const n = this.off('lights') ? 0 : Math.min(count, MAX_LIGHTS);
    this.lightSrc.set(lights.subarray(0, n * 8));
    this.lightSrcCount = n;
  }

  /**
   * Uploads the lights whose reach meets the view frustum (side planes of
   * `planes`, frustumPlanes() order): every lighting tile tests every
   * uploaded light, and of the ~1000 nearest, most are behind or beside the
   * camera (?off=lfrust: all of them). A street light reaches STREAK_REACH
   * (lighting.wgsl) times its radius on wet ground.
   */
  private uploadLights(planes: Float32Array) {
    const src = this.lightSrc;
    const out = this.lightUpload;
    const all = this.off('lfrust');
    let n = 0;
    for (let i = 0; i < this.lightSrcCount; i++) {
      const o = i * 8;
      const x = src[o],
        y = src[o + 1],
        z = src[o + 2];
      // (Margin: the TAA jitter and rounding.)
      const r = src[o + 3] * (src[o + 7] < 0.5 ? 2.5 : 1) * 1.01 + 0.5;
      let inside = true;
      for (let p = 0; p < 16 && !all; p += 4) {
        const dist =
          planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3];
        if (dist < -r) {
          inside = false;
          break;
        }
      }
      if (!inside) continue;
      out.set(src.subarray(o, o + 8), 4 + n * 8);
      n++;
    }
    new Uint32Array(out.buffer, 0, 4).set([n, 0, 0, 0]);
    this.device.queue.writeBuffer(this.lightBuffer, 0, out, 0, 4 + n * 8);
    this.lightCount = n;
  }

  /** Height of terrain + building tops for street-canyon sky visibility. */
  setSkyline(data: Float32Array, n: number) {
    this.skylineTex?.destroy();
    this.skylineTex = this.device.createTexture({
      label: 'lighting/skyline heights',
      size: [n, n],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      {texture: this.skylineTex},
      data,
      {bytesPerRow: n * 4},
      [n, n],
    );
  }

  /** Vehicles for contact occlusion: 12 floats each (see lighting.wgsl Contact). */
  setContacts(data: Float32Array, count: number) {
    const n = Math.min(count, 128);
    this.device.queue.writeBuffer(
      this.contactBuffer,
      0,
      new Uint32Array([n, 0, 0, 0]),
    );
    if (n)
      this.device.queue.writeBuffer(this.contactBuffer, 16, data, 0, n * 12);
  }

  // ---------------------------------------------------------------------------
  // Targets

  private tex(
    label: string,
    format: GPUTextureFormat,
    tw: number,
    th: number,
    usage: number,
    mips = 1,
  ) {
    return this.device.createTexture({
      label,
      size: [Math.max(1, tw), Math.max(1, th)],
      format,
      usage,
      mipLevelCount: mips,
    });
  }

  /** Internal render size for a canvas of ow x oh at the current scale. */
  internalSize(ow: number, oh: number): [number, number] {
    const s = Math.min(1, Math.max(0.25, this.renderScale));
    if (s >= 0.999) return [ow, oh];
    return [Math.max(1, Math.round(ow * s)), Math.max(1, Math.round(oh * s))];
  }

  /** Display-resolution targets: TAA history, bloom chain, post. */
  private ensureOut(scaled: boolean) {
    const {canvas} = this.gpu;
    const w = canvas.width;
    const h = canvas.height;
    let o = this.out;
    if (!o || o.w !== w || o.h !== h) {
      if (o)
        for (const x of [...o.history, ...o.bloomDown, ...o.bloomUp, o.post])
          x?.destroy();
      const ST =
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
      const bloomDown: GPUTexture[] = [];
      const bloomUp: GPUTexture[] = [];
      for (let i = 0; i < 6; i++) {
        const bw = Math.ceil(w / 2 ** (i + 1));
        const bh = Math.ceil(h / 2 ** (i + 1));
        bloomDown.push(this.tex(`bloom/down${i}`, 'rgba16float', bw, bh, ST));
        bloomUp.push(this.tex(`bloom/up${i}`, 'rgba16float', bw, bh, ST));
      }
      o = this.out = {
        w,
        h,
        history: [0, 1].map(i =>
          this.tex(`taa/history${i}`, 'rgba16float', w, h, ST),
        ),
        bloomDown,
        bloomUp,
        post: null,
      };
      // The history is gone: start the jitter / reprojection over.
      this.frameIndex = 0;
    }
    if (scaled && !o.post)
      o.post = this.tex(
        'post/motion blur + dof',
        'rgba16float',
        w,
        h,
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      );
    // Clouds: a fraction of the display size (their own quality setting,
    // independent of the render scale, so a scale change keeps their history).
    const lv = CLOUD_LEVELS[Math.max(0, Math.min(4, this.cloudQuality))];
    const cw = Math.ceil(w / lv.div);
    const ch = Math.ceil(h / lv.div);
    if (this.clouds[0]?.width !== cw || this.clouds[0]?.height !== ch) {
      for (const x of this.clouds) x.destroy();
      this.clouds = [0, 1].map(i =>
        this.tex(
          `clouds/accum${i}`,
          'rgba16float',
          cw,
          ch,
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        ),
      );
      this.cloudFrames = 0;
    }
    return o;
  }

  private ensureTargets() {
    const {canvas} = this.gpu;
    const [w, h] = this.internalSize(canvas.width, canvas.height);
    if (this.targets && this.targets.w === w && this.targets.h === h)
      return this.targets;
    const t = this.targets;
    if (t) {
      for (const x of [
        ...t.gbuf,
        t.depth,
        t.lit,
        t.hiz,
        t.ao,
        ...t.refl,
        t.rays,
      ])
        x.destroy();
    }
    const tex = this.tex.bind(this);
    const RT =
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const ST =
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const names = ['albedo', 'normal', 'emissive', 'motion'];
    const hw = Math.ceil(w / 2);
    const hh = Math.ceil(h / 2);
    const hizMips = Math.floor(Math.log2(Math.max(hw, hh))) + 1;
    this.targets = {
      w,
      h,
      gbuf: GBUFFER_FORMATS.map((f, i) =>
        tex(`gbuffer/${names[i]}`, f, w, h, RT),
      ),
      depth: tex('gbuffer/depth', DEPTH_FORMAT, w, h, RT),
      lit: tex(
        'lighting/hdr',
        'rgba16float',
        w,
        h,
        ST | GPUTextureUsage.RENDER_ATTACHMENT,
      ),
      hiz: tex('hiz/pyramid', 'r32float', hw, hh, ST, hizMips),
      hizMips,
      ao: tex('ssao/half res', 'rgba16float', hw, hh, ST),
      refl: [
        tex('reflect/skyline half res', 'rgba16float', hw, hh, ST),
        tex('reflect/ssr half res', 'rgba16float', hw, hh, ST),
      ],
      rays: tex('post/god rays', 'rgba16float', hw, hh, ST),
    };
    // (A render-scale change keeps the display-res history: no reset.)
    this.useOcclusion = false;
    return this.targets;
  }

  // ---------------------------------------------------------------------------
  // Per-frame setup

  private cascadeMatrices(
    eye: Vec3,
    fwd: Vec3,
    right: Vec3,
    up: Vec3,
    fovY: number,
    aspect: number,
    lightDir: Vec3,
    splits: number[],
    grow: boolean,
  ): CascadeCache[] {
    const out: CascadeCache[] = [];
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
              eye[0] +
                fwd[0] * z +
                right[0] * sx * th * aspect * z +
                up[0] * sy * th * z,
              eye[1] +
                fwd[1] * z +
                right[1] * sx * th * aspect * z +
                up[1] * sy * th * z,
              eye[2] +
                fwd[2] * z +
                right[2] * sx * th * aspect * z +
                up[2] * sy * th * z,
            ]);
          }
        }
      }
      const center: Vec3 = [0, 0, 0];
      for (const q of corners)
        for (let k = 0; k < 3; k++) center[k] += q[k] / 8;
      let radius = 0;
      for (const q of corners)
        radius = Math.max(
          radius,
          Math.hypot(q[0] - center[0], q[1] - center[1], q[2] - center[2]),
        );
      const sliceRadius = radius;
      // A cached cascade covers the slices of later frames too.
      if (grow) {
        const t = CACHE_TOL[c];
        radius +=
          t.move +
          Math.hypot(
            center[0] - eye[0],
            center[1] - eye[1],
            center[2] - eye[2],
          ) *
            t.turn;
      }
      radius = Math.ceil(radius * 16) / 16;
      // Snap the center to shadow texels in light space to avoid shimmering.
      const lz = norm3(lightDir);
      const lx = norm3(
        cross3(Math.abs(lz[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0], lz),
      );
      const ly = cross3(lz, lx);
      const texel = (radius * 2) / this.shadowSize;
      const cx =
        Math.round(
          (center[0] * lx[0] + center[1] * lx[1] + center[2] * lx[2]) / texel,
        ) * texel;
      const cy =
        Math.round(
          (center[0] * ly[0] + center[1] * ly[1] + center[2] * ly[2]) / texel,
        ) * texel;
      const cz = center[0] * lz[0] + center[1] * lz[1] + center[2] * lz[2];
      const snapped: Vec3 = [
        lx[0] * cx + ly[0] * cy + lz[0] * cz,
        lx[1] * cx + ly[1] * cy + lz[1] * cz,
        lx[2] * cx + ly[2] * cy + lz[2] * cz,
      ];
      const back = 1500;
      const eyeL: Vec3 = [
        snapped[0] + lz[0] * back,
        snapped[1] + lz[1] * back,
        snapped[2] + lz[2] * back,
      ];
      const view = mat4.lookAt(mat4.create(), eyeL, snapped, ly);
      const proj = mat4.ortho(
        mat4.create(),
        -radius,
        radius,
        -radius,
        radius,
        1,
        back + radius * 2,
      );
      out.push({
        eye: [...eye],
        fwd: [...fwd],
        light: [...lz],
        halfFov: fovY / 2,
        center,
        sliceRadius,
        key: '',
        mat: mat4.multiply(mat4.create(), proj, view),
        radius,
        lx,
        ly,
        cx,
        cy,
      });
    }
    return out;
  }

  private writeCullView(
    v: number,
    viewProj: Mat4,
    eye: Vec3,
    detail: number,
    occlusion: boolean,
    w: number,
    h: number,
    mips: number,
    extraPlanes: number[] = [],
    farDepth = 0,
  ) {
    const data = new ArrayBuffer(320);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    f.set(viewProj, 0);
    f.set(frustumPlanes(viewProj), 16);
    f.set(extraPlanes, 40);
    f.set([eye[0], eye[1], eye[2], detail], 64);
    u.set(
      [
        this.pool.clusterHighWater,
        occlusion ? 1 : 0,
        6 + extraPlanes.length / 4,
        this.cullStats ? 1 : 0,
      ],
      68,
    );
    f.set([w, h, mips, this.off('farcull') ? 0 : this.farCullScale], 72);
    const lists = v === 0 ? LISTS : 1;
    f.set([farDepth, v === 0 && !this.off('matgroup') ? 1 : 0, lists], 76);
    this.device.queue.writeBuffer(this.cullViewBuffers[v], 0, data);
    // Reset the indirect draws: 128 triangles * 3 vertices per instance
    // (cluster).
    const reset = new Uint32Array(8 * lists);
    for (let k = 0; k < lists; k++) reset[k * 8] = 128 * 3;
    this.device.queue.writeBuffer(this.argsBuffers[v], 0, reset);
    this.device.queue.writeBuffer(this.argsAlphaBuffers[v], 0, reset, 0, 8);
  }

  private updateTerrainPatches(eye: Vec3) {
    const patches: number[] = [];
    const root = 16384;
    const visit = (x: number, z: number, size: number) => {
      const cx = x + size / 2;
      const cz = z + size / 2;
      if (
        Math.abs(cx) - size / 2 > this.worldSize / 2 + 4000 ||
        Math.abs(cz) - size / 2 > this.worldSize / 2 + 4000
      )
        return;
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
    this.device.queue.writeBuffer(
      this.patchBuffer,
      0,
      new Float32Array(patches),
    );
  }

  // ---------------------------------------------------------------------------

  render(v: ViewParams) {
    const d = this.device;
    this.bits = orOff(this.offBits, this.userOff);
    const t = this.ensureTargets();
    const w = t.w;
    const h = t.h;
    const scaled = w !== this.gpu.canvas.width || h !== this.gpu.canvas.height;
    const o = this.ensureOut(scaled);
    const ow = o.w;
    const oh = o.h;
    const aspect = ow / oh;
    const fd = this.frame;
    const cloudLv = CLOUD_LEVELS[Math.max(0, Math.min(4, this.cloudQuality))];

    // Camera.
    const fwd = norm3(sub3(v.target, v.eye));
    const right = norm3(cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    const view = mat4.lookAt(mat4.create(), v.eye, v.target, [0, 1, 0]);
    const proj = mat4.perspectiveReverseZ(mat4.create(), v.fov, aspect, v.near);
    // Upsampling needs a longer jitter sequence: each display pixel should
    // see an internal sample land near its centre.
    const jn = scaled ? (w / ow < 0.7 ? 32 : 16) : 8;
    const jIndex = (this.frameIndex % jn) + 1;
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
    // Static shadow cache (shadow-cache.ts): reuse each cascade's city depth
    // while it still covers this frame's slice.
    const shadowsOn =
      (sky.sunUp > 0 || sky.moonLight > 0) && !this.off('shadows');
    const useCache = shadowsOn && !this.off('shcache');
    const cacheKey = `${aspect},${this.bits}`;
    const fresh = this.cascadeMatrices(
      v.eye,
      fwd,
      right,
      up,
      v.fov,
      aspect,
      lightDir,
      splits,
      useCache,
    );
    for (let c = 0; c < CASCADES; c++) {
      const k = this.shadowCache[c];
      fresh[c].key = cacheKey;
      if (useCache && cacheValid(k, c, fresh[c], this.shadowSize)) {
        this.cascadeMats[c] = k.mat;
        this.cascadeRadii[c] = k.radius;
        this.shadowRedraw[c] = false;
      } else {
        this.shadowCache[c] = useCache ? fresh[c] : null;
        this.cascadeMats[c] = fresh[c].mat;
        this.cascadeRadii[c] = fresh[c].radius;
        this.shadowRedraw[c] = true;
        if (useCache) this.shadowRedraws++;
      }
    }

    fd.set(F.viewProj, viewProj);
    fd.set(F.invViewProj, invViewProj);
    fd.set(
      F.prevViewProj,
      this.frameIndex === 0 ? viewProj : this.prevViewProj,
    );
    fd.set(F.view, view);
    fd.set(F.proj, proj);
    fd.set(F.camPos, [...v.eye, v.near]);
    fd.set(F.sunDir, [...sky.sunDir, sky.sunUp]);
    fd.set(F.sunColor, [...sky.sunColor, 1]);
    fd.set(F.moonDir, [...sky.moonDir, sky.moonLight]);
    fd.set(F.resolution, [w, h, 1 / w, 1 / h]);
    fd.set(F.jitter, [
      jx,
      jy,
      this.frameIndex === 0 ? jx : prevJ[0],
      this.frameIndex === 0 ? jy : prevJ[1],
    ]);
    fd.set(F.time, [v.time, v.dt, this.frameIndex, sky.night]);
    fd.set(F.weather, [
      v.weather.cloud,
      v.weather.rain,
      v.weather.wetness,
      v.weather.fog,
    ]);
    fd.set(F.wind, [
      v.weather.wind[0],
      v.weather.wind[1],
      v.dofAperture ?? 0,
      v.weather.lightning,
    ]);
    fd.set(F.world, [this.worldSize, this.heightCell, this.heightN, 0]);
    fd.set(F.cascadeSplits, splits);
    this.cascadeMats.forEach((m, i) => fd.set(F.cascades + i * 16, m));
    // Physical exposure baseline: an 18% grey card lit by sun + sky maps to
    // the key value. The histogram meter may only deviate a stop or two.
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const key = 0.17 + (0.05 - 0.17) * sky.night;
    const lit =
      (lum(sky.sunColor) * Math.max(sky.sunDir[1], 0.15)) / Math.PI +
      lum(sky.skyAmbient) +
      lum(sky.cityGlow) * 2;
    const eBase = key / (0.18 * Math.max(lit, 1e-4));
    fd.set(F.exposure, [
      v.motionBlur ?? 0,
      eBase,
      Math.max(-0.2, sky.sunDir[1]),
      v.focus ?? 0,
    ]);
    fd.set(F.skyAmbient, [...sky.skyAmbient, 0]);
    fd.set(F.groundAmbient, [...sky.groundAmbient, 0]);
    fd.set(F.cityGlow, [...sky.cityGlow, 0]);
    fd.set(F.misc, [
      v.debug,
      v.quality ?? 1,
      v.interior ? 2 : v.lensDrops ? 1 : 0,
      sky.moonPhase,
    ]);
    fd.set(F.upscale, [
      ow,
      oh,
      // Upsampled frames get a little more sharpening.
      this.sharpen + (scaled ? (1 - w / ow) * 0.25 : 0),
      w / ow,
    ]);
    fd.set(F.extra, [
      this.off('clouds') ? 0 : cloudLv.mode,
      cloudLv.steps,
      this.cloudFrames,
      this.bloom,
    ]);
    const [offLo, offHi] = offWords(this.bits);
    new Uint32Array(fd.f.buffer).set([offLo, this.offMats, offHi], F.off);
    d.queue.writeBuffer(this.frameBuffer, 0, fd.f);
    d.queue.writeBuffer(
      this.atmoBuffer,
      0,
      new Float32Array([haze, 1, 0.12, 24]),
    );

    // Occlusion culling is skipped for a frame after fast camera turns.
    const turn =
      fwd[0] * this.lastViewDir[0] +
      fwd[1] * this.lastViewDir[1] +
      fwd[2] * this.lastViewDir[2];
    this.lastViewDir = fwd;
    const occl = this.frameIndex > 2 && turn > 0.995 && v.debug !== 9;
    this.writeCullView(
      0,
      viewProjNoJ,
      v.eye,
      0.0015,
      occl && this.useOcclusion,
      Math.ceil(w / 2),
      Math.ceil(h / 2),
      t.hizMips,
      [],
      // Far-shading pipeline past the depth where a pixel spans FAR_FOOT
      // (city-materials.wgsl) of a surface facing the camera.
      this.off('farshade') ? 0 : (FAR_FOOT * h) / (2 * Math.tan(v.fov / 2)),
    );
    const camPlanes = frustumPlanes(viewProjNoJ);
    this.uploadLights(camPlanes);
    // A point of a slice is at most diag x its far depth from the eye.
    const th = Math.tan(v.fov / 2);
    const diag = Math.hypot(1, th * aspect, th);
    for (let c = 0; c < CASCADES; c++) {
      d.queue.writeBuffer(this.shadowViewBuffers[c], 0, this.cascadeMats[c]);
      if (!this.shadowRedraw[c]) continue;
      // A cached cascade's receivers are those of every frame that may
      // reuse it: the planes pushed out by its move / turn tolerance.
      const tol = useCache
        ? CACHE_TOL[c].move + diag * splits[c] * CACHE_TOL[c].turn
        : 0;
      this.writeCullView(
        1 + c,
        this.cascadeMats[c],
        v.eye,
        0.004 * (c + 1),
        false,
        0,
        0,
        0,
        this.off('rcvcull')
          ? []
          : receiverPlanes(
              camPlanes,
              v.eye,
              fwd,
              c === 0 ? 0 : splits[c - 1],
              splits[c],
              lightDir,
              // Margin: the receiver's normal offset (lighting.wgsl shadow():
              // 1.5 x split / 1024) plus the 3x3 PCF footprint, doubled.
              2 *
                (1.5 * (splits[c] / 1024) +
                  (3 * this.cascadeRadii[c]) / this.shadowSize) +
                0.5 +
                tol,
            ),
      );
    }
    this.updateTerrainPatches(v.eye);

    this.cpuProf?.mark('render setup');
    const enc = d.createCommandEncoder({label: 'frame'});
    this.prof?.beginFrame();
    // Whole-frame GPU timing (dynamic render scale / readout), not while the
    // pass profiler owns the timestamps.
    if (this.measureGpu && !this.prof && this.gpu.features.timestamp)
      this.frameTimer ??= new FrameTimer(d);
    else if (this.frameTimer && (!this.measureGpu || this.prof)) {
      this.frameTimer.destroy();
      this.frameTimer = null;
    }
    this.frameTimer?.beginFrame();
    const hooks = this.activeHooks();
    for (const hk of hooks) hk.prepare?.(enc);

    // --- Compute: sky LUTs, cloud noise, culling.
    {
      let pass = this.compute(enc, 'sky luts');
      const atmoG0 = (p: string) =>
        this.bg(
          p,
          0,
          [
            this.ubuf(this.frameBuffer),
            this.ubuf(this.atmoBuffer),
            this.linear,
          ],
          `bg/${p}/frame`,
        );
      const skyKey = `${haze.toFixed(2)}`;
      if (!this.lutsReady || skyKey !== this.lastSkyKey) {
        this.lastSkyKey = skyKey;
        pass.setPipeline(this.p.transmittance as GPUComputePipeline);
        pass.setBindGroup(0, atmoG0('transmittance'));
        pass.setBindGroup(
          1,
          this.bg(
            'transmittance',
            1,
            [this.transmittance.createView()],
            'bg/transmittance/out',
          ),
        );
        pass.dispatchWorkgroups(256 / 8, 64 / 8);
        pass.setPipeline(this.p.multiScat as GPUComputePipeline);
        pass.setBindGroup(0, atmoG0('multiScat'));
        pass.setBindGroup(
          1,
          this.bg(
            'multiScat',
            1,
            [
              null,
              this.transmittance.createView(),
              null,
              this.multiScat.createView(),
            ],
            'bg/multiscatter',
          ),
        );
        pass.dispatchWorkgroups(4, 4);
        this.lutsReady = true;
      }
      if (!this.noiseReady) {
        pass.setPipeline(this.p.cloudNoise as GPUComputePipeline);
        pass.setBindGroup(
          0,
          this.bg(
            'cloudNoise',
            0,
            [this.ubuf(this.frameBuffer), this.linearRepeat],
            'bg/cloud noise/frame',
          ),
        );
        pass.setBindGroup(
          1,
          this.bg(
            'cloudNoise',
            1,
            [this.cloudNoise.createView()],
            'bg/cloud noise',
          ),
        );
        pass.dispatchWorkgroups(16, 16, 16);
        this.noiseReady = true;
      }
      pass.setPipeline(this.p.skyView as GPUComputePipeline);
      pass.setBindGroup(0, atmoG0('skyView'));
      pass.setBindGroup(
        1,
        this.bg(
          'skyView',
          1,
          [
            null,
            this.transmittance.createView(),
            this.multiScat.createView(),
            null,
            this.skyView.createView(),
          ],
          'bg/sky view',
        ),
      );
      pass.dispatchWorkgroups(192 / 8, Math.ceil(108 / 8));
      pass.setPipeline(this.p.aerial as GPUComputePipeline);
      pass.setBindGroup(0, atmoG0('aerial'));
      pass.setBindGroup(
        1,
        this.bg(
          'aerial',
          1,
          [
            null,
            this.transmittance.createView(),
            this.multiScat.createView(),
            null,
            null,
            this.apVolume.createView(),
          ],
          'bg/aerial perspective',
        ),
      );
      pass.dispatchWorkgroups(4, 4);

      // Cluster culling for the main view and each shadow cascade.
      const hizView = t.hiz.createView({label: 'hiz/all mips'});
      pass = this.compute(enc, 'cull');
      pass.setPipeline(this.p.cull as GPUComputePipeline);
      const groups = Math.ceil(Math.max(1, this.pool.clusterHighWater) / 64);
      for (let vi = 0; vi < VIEWS; vi++) {
        if (vi > 0 && !this.shadowRedraw[vi - 1]) continue;
        pass.setBindGroup(
          0,
          this.bg(
            'cull',
            0,
            [
              this.ubuf(this.cullViewBuffers[vi]),
              this.ubuf(this.pool.clusterBuffer),
              this.ubuf(this.tileLodBuffer),
              this.ubuf(this.visibleBuffers[vi]),
              this.ubuf(this.argsBuffers[vi]),
              hizView,
              this.ubuf(this.visibleAlphaBuffers[vi]),
              this.ubuf(this.argsAlphaBuffers[vi]),
            ],
            `bg/cull/view${vi}`,
          ),
        );
        pass.dispatchWorkgroups(Math.min(groups, 65535));
      }
      this.endCompute();
      this.cullCount = groups;
    }

    // --- Shadows.
    const cityG1 = (pipe: string, list: GPUBuffer, label: string) =>
      this.bg(
        pipe,
        1,
        [
          this.ubuf(this.pool.vertexBuffer),
          this.ubuf(this.pool.triBuffer),
          this.ubuf(this.pool.clusterBuffer),
          this.ubuf(list),
        ],
        label,
      );
    for (let c = 0; c < CASCADES; c++) {
      const skipCascade =
        !shadowsOn ||
        (c === 3 && this.off('c3')) ||
        (c === 2 && this.off('c2'));
      const layer = (tex: GPUTexture, load: boolean) => ({
        colorAttachments: [],
        depthStencilAttachment: {
          view: tex.createView({
            dimension: '2d',
            baseArrayLayer: c,
            arrayLayerCount: 1,
            label: `${tex.label} c${c} view`,
          }),
          depthClearValue: 1,
          depthLoadOp: load ? ('load' as const) : ('clear' as const),
          depthStoreOp: 'store' as const,
        },
      });
      // Cached: the city goes to the static layer (only when it is redrawn),
      // which is copied into the live map; the hooks draw over the copy.
      const cityPass = useCache
        ? this.shadowRedraw[c]
          ? this.renderPass(
              enc,
              layer(this.shadowStatic, false),
              `shadow c${c} city`,
            )
          : null
        : this.renderPass(
            enc,
            layer(this.shadowMap, false),
            `shadow c${c} city`,
          );
      if (cityPass && !skipCascade) {
        const pass = cityPass.pass;
        // Opaque clusters: depth only, no fragment stage.
        pass.setPipeline(this.p.cityShadowOpaque as GPURenderPipeline);
        pass.setBindGroup(
          0,
          this.bg(
            'cityShadowOpaque',
            0,
            [null, this.ubuf(this.shadowViewBuffers[c])],
            `bg/city shadow opaque/cascade${c}`,
          ),
        );
        pass.setBindGroup(
          1,
          cityG1(
            'cityShadowOpaque',
            this.visibleBuffers[1 + c],
            `bg/city shadow opaque/view${1 + c}`,
          ),
        );
        pass.drawIndirect(this.argsBuffers[1 + c], 0);
        // Alpha-tested clusters: leaf cutout.
        pass.setPipeline(this.p.cityShadow as GPURenderPipeline);
        pass.setBindGroup(
          0,
          this.bg(
            'cityShadow',
            0,
            [null, this.ubuf(this.shadowViewBuffers[c])],
            `bg/city shadow/cascade${c}`,
          ),
        );
        pass.setBindGroup(
          1,
          cityG1(
            'cityShadow',
            this.visibleAlphaBuffers[1 + c],
            `bg/city shadow/view${1 + c}`,
          ),
        );
        pass.setBindGroup(
          2,
          this.bg(
            'cityShadow',
            2,
            [null, this.linear, this.leafTex.createView()],
            `bg/city shadow/leaves${c}`,
          ),
        );
        pass.drawIndirect(this.argsAlphaBuffers[1 + c], 0);
      }
      let rp = cityPass;
      if (useCache) {
        cityPass?.end();
        enc.copyTextureToTexture(
          {texture: this.shadowStatic, origin: [0, 0, c]},
          {texture: this.shadowMap, origin: [0, 0, c]},
          [this.shadowSize, this.shadowSize, 1],
        );
        rp = this.renderPass(
          enc,
          layer(this.shadowMap, true),
          `shadow c${c} dynamic`,
        );
      }
      if (!skipCascade)
        for (const hk of hooks)
          if (hk.shadow) hk.shadow(rp!.seg(`shadow c${c} ${hk.name}`), c);
      rp!.end();
    }

    // --- G-buffer.
    {
      const rp = this.renderPass(
        enc,
        {
          colorAttachments: t.gbuf.map((tx, i) => ({
            view: tx.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: i === 1 ? [0, 0, 1, 0] : [0, 0, 0, 0],
          })),
          depthStencilAttachment: {
            view: t.depth.createView({label: 'gbuffer/depth view'}),
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        },
        'gbuffer city',
      );
      let pass = rp.pass;
      const frameG0 = (p: string) =>
        this.bg(p, 0, [this.ubuf(this.frameBuffer)], `bg/${p}/frame`);
      // Opaque clusters first (no discard: hidden-surface removal stays on),
      // then the alpha-tested ones (leaf cards, widened tubes).
      const cityDraw = (
        pipe: string,
        list: GPUBuffer,
        args: GPUBuffer,
        label: string,
        offset = 0,
      ) => {
        pass.setPipeline(this.p[pipe] as GPURenderPipeline);
        pass.setBindGroup(0, frameG0(pipe));
        pass.setBindGroup(1, cityG1(pipe, list, `bg/${label}/main`));
        pass.setBindGroup(
          2,
          this.bg(
            pipe,
            2,
            [
              this.signAtlas.createView(),
              this.anisoClamp,
              this.leafTex.createView(),
              this.detailTex.createView({dimension: '2d-array'}),
              this.detailSampler,
            ],
            `bg/${label}/textures`,
          ),
        );
        pass.drawIndirect(args, offset);
      };
      if (!this.off('city')) {
        for (let k = 0; k < LISTS; k++)
          cityDraw(
            `cityList${k}`,
            this.visibleBuffers[0],
            this.argsBuffers[0],
            `city opaque ${k}`,
            k * 32,
          );
        cityDraw(
          'city',
          this.visibleAlphaBuffers[0],
          this.argsAlphaBuffers[0],
          'city alpha',
        );
      }
      if (this.heightTex && this.landTex) {
        pass = rp.seg('gbuffer terrain');
        pass.setPipeline(this.p.terrain as GPURenderPipeline);
        pass.setBindGroup(0, frameG0('terrain'));
        pass.setBindGroup(
          1,
          this.bg(
            'terrain',
            1,
            [
              this.heightTex.createView(),
              this.landTex.createView(),
              this.ubuf(this.patchBuffer),
            ],
            'bg/terrain',
          ),
        );
        pass.setIndexBuffer(this.terrainIndex, 'uint32');
        if (!this.off('terrain'))
          pass.drawIndexed(this.terrainIndexCount, this.patchCount);
        pass = rp.seg('gbuffer water');
        pass.setPipeline(this.p.water as GPURenderPipeline);
        pass.setBindGroup(0, frameG0('water'));
        pass.setBindGroup(
          1,
          this.bg('water', 1, [this.heightTex.createView()], 'bg/water'),
        );
        if (!this.off('water')) pass.draw(64 * 64 * 6);
      }
      for (const hk of hooks)
        if (hk.gbuffer) hk.gbuffer(rp.seg(`gbuffer ${hk.name}`));
      rp.end();
    }

    // --- Hi-Z pyramid for next frame's occlusion culling.
    {
      let pass = this.compute(enc, 'hiz');
      const pg0 = (p: string) =>
        this.bg(
          p,
          0,
          [this.ubuf(this.frameBuffer), this.linear],
          `bg/${p}/frame`,
        );
      pass.setPipeline(this.p.hizFromDepth as GPUComputePipeline);
      pass.setBindGroup(0, pg0('hizFromDepth'));
      pass.setBindGroup(
        1,
        this.bg(
          'hizFromDepth',
          1,
          [
            t.depth.createView(),
            null,
            t.hiz.createView({baseMipLevel: 0, mipLevelCount: 1}),
          ],
          'bg/hiz/mip0',
        ),
      );
      pass.dispatchWorkgroups(
        Math.ceil(t.hiz.width / 8),
        Math.ceil(t.hiz.height / 8),
      );
      pass.setPipeline(this.p.hizDown as GPUComputePipeline);
      pass.setBindGroup(0, pg0('hizDown'));
      for (let m = 1; m < t.hizMips; m++) {
        pass.setBindGroup(
          1,
          this.bg(
            'hizDown',
            1,
            [
              null,
              t.hiz.createView({baseMipLevel: m - 1, mipLevelCount: 1}),
              t.hiz.createView({baseMipLevel: m, mipLevelCount: 1}),
            ],
            `bg/hiz/mip${m}`,
          ),
        );
        pass.dispatchWorkgroups(
          Math.ceil(Math.max(1, t.hiz.width >> m) / 8),
          Math.ceil(Math.max(1, t.hiz.height >> m) / 8),
        );
      }
      // Clouds (reduced resolution, temporal; skips texels hidden behind
      // this frame's geometry, so after the Hi-Z pyramid).
      pass = this.compute(enc, 'clouds');
      {
        const cIn = this.clouds[this.frameIndex % 2];
        const cOut = this.clouds[(this.frameIndex + 1) % 2];
        pass.setPipeline(this.p.clouds as GPUComputePipeline);
        pass.setBindGroup(
          0,
          this.bg(
            'clouds',
            0,
            [this.ubuf(this.frameBuffer), this.linearRepeat],
            'bg/clouds/frame',
          ),
        );
        pass.setBindGroup(
          1,
          this.bg(
            'clouds',
            1,
            [
              this.cloudNoise.createView(),
              cIn.createView(),
              cOut.createView(),
              t.hiz.createView({label: 'hiz/all mips (clouds)'}),
            ],
            'bg/clouds',
          ),
        );
        pass.dispatchWorkgroups(
          Math.ceil(cOut.width / 8),
          Math.ceil(cOut.height / 8),
        );
        this.cloudFrames++;
      }
      // (Also traces sky visibility: runs with ?off=gtao too, writing AO 1.)
      pass = this.compute(enc, 'gtao');
      {
        pass.setPipeline(this.p.ao as GPUComputePipeline);
        pass.setBindGroup(
          0,
          this.bg('ao', 0, [this.ubuf(this.frameBuffer)], 'bg/ssao/frame'),
        );
        pass.setBindGroup(
          1,
          this.bg(
            'ao',
            1,
            [
              t.depth.createView(),
              t.gbuf[1].createView(),
              t.ao.createView(),
              (this.skylineTex ?? this.heightTex!).createView(),
            ],
            'bg/ssao',
          ),
        );
        pass.dispatchWorkgroups(
          Math.ceil(t.ao.width / 8),
          Math.ceil(t.ao.height / 8),
        );
      }
      this.endCompute();
      this.useOcclusion = true;
    }

    // --- Lighting.
    const histPrev = o.history[this.frameIndex % 2];
    const histNext = o.history[(this.frameIndex + 1) % 2];
    {
      const half = !this.off('hrefl');
      const inputs = (pipe: string, refl: boolean, main: boolean) =>
        this.bg(
          pipe,
          1,
          [
            main ? t.gbuf[0].createView() : null,
            t.gbuf[1].createView(),
            t.gbuf[2].createView(),
            t.depth.createView(),
            main ? this.shadowMap.createView({dimension: '2d-array'}) : null,
            main ? this.shadowSampler : null,
            main ? this.skyView.createView() : null,
            main ? this.transmittance.createView() : null,
            main ? this.apVolume.createView() : null,
            this.linear,
            main ? this.clouds[(this.frameIndex + 1) % 2].createView() : null,
            refl ? histPrev.createView() : null,
            main ? t.lit.createView() : null,
            main ? this.ubuf(this.lightBuffer) : null,
            main ? t.ao.createView() : null,
            main ? this.ubuf(this.contactBuffer) : null,
            (this.skylineTex ?? this.heightTex!).createView(),
            main ? t.refl[0].createView() : null,
            main ? t.refl[1].createView() : null,
          ],
          `bg/${pipe}/inputs`,
        );
      if (half) {
        // Reflections at half resolution (one pixel per 2x2 block).
        const pass = this.compute(enc, 'reflect');
        pass.setPipeline(this.p.reflect as GPUComputePipeline);
        pass.setBindGroup(
          0,
          this.bg(
            'reflect',
            0,
            [this.ubuf(this.frameBuffer)],
            'bg/reflect/frame',
          ),
        );
        pass.setBindGroup(1, inputs('reflect', true, false));
        pass.setBindGroup(
          2,
          this.bg(
            'reflect',
            2,
            [t.refl[0].createView(), t.refl[1].createView()],
            'bg/reflect/out',
          ),
        );
        pass.dispatchWorkgroups(
          Math.ceil(t.refl[0].width / 8),
          Math.ceil(t.refl[0].height / 8),
        );
      }
      const pipe = `lighting:r${half ? 1 : 0}s${this.off('hskyvis') ? 0 : 1}`;
      const pass = this.compute(enc, 'lighting');
      pass.setPipeline(this.p[pipe] as GPUComputePipeline);
      pass.setBindGroup(
        0,
        this.bg(pipe, 0, [this.ubuf(this.frameBuffer)], 'bg/lighting/frame'),
      );
      // (Both variants keep every binding: an override does not change
      // which ones are statically used.)
      pass.setBindGroup(1, inputs(pipe, true, true));
      pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
      this.endCompute();
    }

    // --- Forward (vehicle glass, rain) onto the lit HDR image.
    const fwdHooks = hooks.filter(hk => hk.forward);
    if (fwdHooks.length) {
      const rp = this.renderPass(
        enc,
        {
          colorAttachments: [
            {view: t.lit.createView(), loadOp: 'load', storeOp: 'store'},
          ],
          depthStencilAttachment: {
            view: t.depth.createView(),
            depthReadOnly: true,
          },
        },
        `fwd ${fwdHooks[0].name}`,
      );
      fwdHooks.forEach((hk, i) =>
        hk.forward!(i ? rp.seg(`fwd ${hk.name}`) : rp.pass),
      );
      rp.end();
    }

    // --- TAA, bloom, exposure.
    let post = t.lit;
    {
      const taa = !this.off('taa');
      // Motion blur / DOF only when either is in use (most shots have no
      // DOF, and no blur while the car stands still): otherwise tonemap
      // reads the TAA output directly (the pass would copy it unchanged).
      const blurOrDof =
        (v.motionBlur ?? 0) > 0 ||
        ((v.dofAperture ?? 0) > 0 && (v.focus ?? 0) > 0);
      const mdof = taa && !this.off('mdof') && blurOrDof;
      // What bloom reads (the resolved frame) and what tonemap reads.
      const resolved = taa ? histNext : t.lit;
      // Motion blur / DOF output: the free lit texture, or a display-size
      // one when upsampling.
      const mbOut = scaled ? o.post! : t.lit;
      post = mdof ? mbOut : resolved;
      let pass = this.compute(enc, 'taa');
      const pg0 = (p: string) =>
        this.bg(
          p,
          0,
          [this.ubuf(this.frameBuffer), this.linear],
          `bg/${p}/frame`,
        );
      if (taa) {
        const tp = scaled ? 'taau' : 'taa';
        pass.setPipeline(this.p[tp] as GPUComputePipeline);
        pass.setBindGroup(0, pg0(tp));
        pass.setBindGroup(
          1,
          this.bg(
            tp,
            1,
            [
              t.lit.createView(),
              histPrev.createView(),
              t.gbuf[3].createView(),
              t.depth.createView(),
              histNext.createView(),
            ],
            `bg/${tp}`,
          ),
        );
        pass.dispatchWorkgroups(Math.ceil(ow / 8), Math.ceil(oh / 8));
      }
      pass = this.compute(enc, 'god rays');
      if (!this.off('godrays')) {
        pass.setPipeline(this.p.godRays as GPUComputePipeline);
        pass.setBindGroup(0, pg0('godRays'));
        pass.setBindGroup(
          1,
          this.bg(
            'godRays',
            1,
            [t.depth.createView(), t.rays.createView()],
            'bg/god rays',
          ),
        );
        pass.dispatchWorkgroups(
          Math.ceil(t.rays.width / 8),
          Math.ceil(t.rays.height / 8),
        );
      }
      // Motion blur + DOF into the (now free) lit texture; history stays clean.
      pass = this.compute(enc, 'motion blur + dof');
      if (mdof) {
        pass.setPipeline(this.p.motionDof as GPUComputePipeline);
        pass.setBindGroup(0, pg0('motionDof'));
        pass.setBindGroup(
          1,
          this.bg(
            'motionDof',
            1,
            [
              histNext.createView(),
              t.gbuf[3].createView(),
              t.depth.createView(),
              mbOut.createView(),
            ],
            'bg/motion blur + dof',
          ),
        );
        pass.dispatchWorkgroups(Math.ceil(ow / 8), Math.ceil(oh / 8));
      }
      pass = this.compute(enc, 'bloom');
      if (!this.off('bloom')) {
        // (Bloom off in the settings still builds the down chain the
        // exposure meter reads.)
        pass.setPipeline(this.p.bloomDown as GPUComputePipeline);
        pass.setBindGroup(0, pg0('bloomDown'));
        for (let i = 0; i < o.bloomDown.length; i++) {
          const src = i === 0 ? resolved : o.bloomDown[i - 1];
          pass.setBindGroup(
            1,
            this.bg(
              'bloomDown',
              1,
              [src.createView(), o.bloomDown[i].createView()],
              `bg/bloom down ${i}`,
            ),
          );
          pass.dispatchWorkgroups(
            Math.ceil(o.bloomDown[i].width / 8),
            Math.ceil(o.bloomDown[i].height / 8),
          );
        }
        pass.setPipeline(this.p.bloomUp as GPUComputePipeline);
        pass.setBindGroup(0, pg0('bloomUp'));
        for (let i = o.bloomUp.length - 2; i >= 0 && this.bloom > 0; i--) {
          const src =
            i === o.bloomUp.length - 2 ? o.bloomDown[i + 1] : o.bloomUp[i + 1];
          pass.setBindGroup(
            1,
            this.bg(
              'bloomUp',
              1,
              [
                src.createView(),
                o.bloomUp[i].createView(),
                o.bloomDown[i].createView(),
              ],
              `bg/bloom up ${i}`,
            ),
          );
          pass.dispatchWorkgroups(
            Math.ceil(o.bloomUp[i].width / 8),
            Math.ceil(o.bloomUp[i].height / 8),
          );
        }
      }
      pass = this.compute(enc, 'exposure');
      pass.setPipeline(this.p.exposure as GPUComputePipeline);
      pass.setBindGroup(0, pg0('exposure'));
      pass.setBindGroup(
        1,
        this.bg(
          'exposure',
          1,
          [o.bloomDown[3].createView(), this.ubuf(this.exposureBuffer)],
          'bg/exposure',
        ),
      );
      pass.dispatchWorkgroups(1);
      this.endCompute();
    }

    // --- Tonemap to the swapchain.
    {
      const rp = this.renderPass(
        enc,
        {
          colorAttachments: [
            {
              view: this.gpu.context
                .getCurrentTexture()
                .createView({label: 'swapchain view'}),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 1],
            },
          ],
        },
        'tonemap',
      );
      const pass = rp.pass;
      pass.setPipeline(this.p.tonemap as GPURenderPipeline);
      pass.setBindGroup(
        0,
        this.bg(
          'tonemap',
          0,
          [this.ubuf(this.frameBuffer), this.linear],
          'bg/tonemap/frame',
        ),
      );
      pass.setBindGroup(
        1,
        this.bg(
          'tonemap',
          1,
          [
            post.createView(),
            o.bloomUp[0].createView(),
            this.ubuf(this.exposureBuffer),
            t.rays.createView(),
          ],
          'bg/tonemap',
        ),
      );
      pass.draw(3);
      rp.end();
    }

    this.prof?.endFrame(enc);
    this.frameTimer?.endFrame(enc);
    this.cpuProf?.mark('render encode');
    d.queue.submit([enc.finish()]);
    this.prof?.afterSubmit();
    this.frameTimer?.afterSubmit();
    if (this.measureGpu) this.sampleGpuTime();
    if (this.cullStats && !this.cullStatsBusy && this.frameIndex % 8 === 0)
      this.readCullStats();
    this.prevViewProj = viewProj;
    this.frameIndex++;
    const ps = this.pool.stats;
    Object.assign(this.stats, {
      clusters: ps.clusters,
      alphaClusters: ps.alphaClusters,
      tris: ps.tris,
      verts: ps.verts,
      vertsTop: ps.vertsTop,
      trisTop: ps.trisTop,
      clustersTop: ps.clustersTop,
      lights: this.lightCount,
      patches: this.patchCount,
      cullGroups: this.cullCount,
    });
  }

  /** Folds the latest whole-frame GPU time into gpuMs. */
  private sampleGpuTime() {
    const ft = this.frameTimer;
    let ms = 0;
    if (ft) {
      if (ft.samples !== this.gpuSamples) {
        this.gpuSamples = ft.samples;
        ms = ft.ms;
      }
    } else if (this.prof) {
      ms = this.prof.averages.span ?? 0;
    } else if (!this.gpuPending) {
      // No timestamps: submit -> work done (an overestimate when the GPU is
      // still busy with earlier frames, which only errs toward a lower scale).
      this.gpuPending = true;
      const t0 = performance.now();
      void this.device.queue.onSubmittedWorkDone().then(() => {
        this.gpuPending = false;
        this.gpuFallbackMs = performance.now() - t0;
      });
    }
    if (!ft && !this.prof && this.gpuFallbackMs) {
      ms = this.gpuFallbackMs;
      this.gpuFallbackMs = 0;
    }
    if (ms > 0) this.gpuMs = this.gpuMs ? this.gpuMs * 0.9 + ms * 0.1 : ms;
  }

  /** Copies the indirect args out and publishes stats.viewClusters/Tris. */
  private readCullStats() {
    const d = this.device;
    this.cullStatsBuf ??= d.createBuffer({
      label: 'cull/stats readback',
      // Per view: the alpha-tested args, then its opaque lists.
      size: (2 * VIEWS - 1 + LISTS) * 32,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const buf = this.cullStatsBuf;
    const enc = d.createCommandEncoder({label: 'cull stats'});
    // Per view: the alpha-tested list, then the opaque lists (LISTS for the
    // main view, one per shadow view).
    let o = 0;
    for (let v = 0; v < VIEWS; v++) {
      const lists = v === 0 ? LISTS : 1;
      enc.copyBufferToBuffer(this.argsAlphaBuffers[v], 0, buf, o, 32);
      enc.copyBufferToBuffer(this.argsBuffers[v], 0, buf, o + 32, 32 * lists);
      o += 32 * (1 + lists);
    }
    d.queue.submit([enc.finish()]);
    this.cullStatsBusy = true;
    void buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const u = new Uint32Array(buf.getMappedRange().slice(0));
        buf.unmap();
        this.cullStatsBusy = false;
        const name = (v: number) => (v === 0 ? 'main' : `shadow${v - 1}`);
        let sc = 0;
        let st = 0;
        let o = 0;
        for (let v = 0; v < VIEWS; v++) {
          const lists = v === 0 ? LISTS : 1;
          let clusters = 0;
          let tris = 0;
          for (let k = 0; k <= lists; k++) {
            clusters += u[o + k * 8 + 1];
            tris += u[o + k * 8 + 4];
          }
          this.stats[`${name(v)}AlphaClusters`] = u[o + 1];
          o += 8 * (1 + lists);
          this.stats[`${name(v)}Clusters`] = clusters;
          this.stats[`${name(v)}Tris`] = tris;
          if (v > 0) {
            sc += clusters;
            st += tris;
          }
        }
        this.stats.shadowClusters = sc;
        this.stats.shadowTris = st;
      },
      () => (this.cullStatsBusy = false),
    );
  }

  /** Internal render size of the last frame. */
  get renderSize(): [number, number] {
    return [this.targets?.w ?? 0, this.targets?.h ?? 0];
  }

  get viewProj() {
    return this.prevViewProj;
  }
}
