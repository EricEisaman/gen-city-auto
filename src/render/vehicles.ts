// Instanced rendering of NURBS vehicles: body, wheels, rotors and steering
// wheel per instance, three LODs, G-buffer + shadow + forward glass passes.

import {cores, lowMemory} from '../caps.ts';
import {createShader} from '../gpu/device.ts';
import {begin, counters, pipeline} from '../ui/timeline.ts';
import {mat4, type Mat4} from '../math/mat4.ts';
import type {Vec3} from '../math/vec.ts';
import commonWgsl from '../shaders/common.wgsl';
import surfaceWgsl from '../shaders/surface.wgsl';
import vehicleWgsl from '../shaders/vehicle.wgsl';
import {designs} from '../vehicles/designs/index.ts';
import type {VehicleVariant} from '../workers/vehicle-worker.ts';
import type {DrawHook, HookCull, Renderer} from './renderer.ts';

const INSTANCE_FLOATS = 44;

interface Group {
  part: Part;
  lod: number;
  body: boolean;
  data: Float32Array;
  /** Per instance: the index of its vehicle (add() call) this frame. */
  vid: Uint32Array;
  n: number;
}
/**
 * Instances uploaded per frame, over every pass: each pass (the view, each
 * shadow cascade) gets its own culled copy of the instances it draws.
 */
const MAX_INSTANCES = 16384;
/** Passes with their own instance lists: 0 the view, 1 + c cascade c. */
const PASSES = 4;

interface Draw {
  part: Part;
  first: number;
  count: number;
  body: boolean;
  lod: number;
}

/** Sphere (x, y, z, r) inside every plane (xyz inward normal, w)? */
function inside(pl: Float32Array, x: number, y: number, z: number, r: number) {
  for (let i = 0; i < pl.length; i += 4)
    if (pl[i] * x + pl[i + 1] * y + pl[i + 2] * z + pl[i + 3] < -r)
      return false;
  return true;
}

interface Part {
  firstIndex: number;
  indexCount: number;
  baseVertex: number;
}

interface VariantGpu {
  info: VehicleVariant;
  lods: {
    body: Part;
    wheel: Part | null;
    rotors: Part[];
    steering: Part | null;
  }[];
}

export interface VehicleInstance {
  variant: number;
  model: Mat4;
  prevModel: Mat4;
  color: Vec3;
  metallic: number;
  color2: Vec3;
  lights: number;
  brake: number;
  indicator: number;
  wheelSpin: number;
  steer: number;
  rotor: number;
  /** Previous frame's rotor/animation phase (for correct motion vectors). */
  prevRotor?: number;
  /** Force a LOD (e.g. the player's car in first person). */
  lod?: number;
  /** Skip drawing (still casts shadows when shadowOnly). */
  hidden?: boolean;
}

const tmp = mat4.create();

// Per-instance part matrices come from a ring of scratch matrices (no
// allocation per wheel / rotor): each is consumed (copied by push) within the
// same part, long before the ring wraps.
const ring = Array.from({length: 16}, () => new Float32Array(16));
let ringIndex = 0;
const scratch = () => ring[ringIndex++ & 15];

function setM(...v: number[]): Mat4 {
  const m = scratch();
  for (let i = 0; i < 16; i++) m[i] = v[i];
  return m;
}

function rotX(a: number): Mat4 {
  const c = Math.cos(a),
    s = Math.sin(a);
  return setM(1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1);
}

function rotAxis(axis: Vec3, a: number): Mat4 {
  const [x, y, z] = axis;
  const c = Math.cos(a),
    s = Math.sin(a),
    t = 1 - c;
  return setM(
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  );
}

function translate(p: Vec3): Mat4 {
  return setM(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1);
}

const mul = (...ms: Mat4[]) =>
  ms.reduce((acc, m) => mat4.multiply(scratch(), acc, m));

/** out = translate(p) * rotY(ay) * rotX(ax), without temporaries. */
function wheelLocal(out: Mat4, p: Vec3, ay: number, ax: number): Mat4 {
  const cy = Math.cos(ay),
    sy = Math.sin(ay),
    cb = Math.cos(ax),
    sb = Math.sin(ax);
  out[0] = cy;
  out[1] = 0;
  out[2] = -sy;
  out[3] = 0;
  out[4] = sb * sy;
  out[5] = cb;
  out[6] = sb * cy;
  out[7] = 0;
  out[8] = cb * sy;
  out[9] = -sb;
  out[10] = cb * cy;
  out[11] = 0;
  out[12] = p[0];
  out[13] = p[1];
  out[14] = p[2];
  out[15] = 1;
  return out;
}

/** out = translate(p) * rotAxis(axis, a). */
function rotorLocal(out: Mat4, p: Vec3, axis: Vec3, a: number): Mat4 {
  const [x, y, z] = axis;
  const c = Math.cos(a),
    s = Math.sin(a),
    t = 1 - c;
  out[0] = t * x * x + c;
  out[1] = t * x * y + s * z;
  out[2] = t * x * z - s * y;
  out[3] = 0;
  out[4] = t * x * y - s * z;
  out[5] = t * y * y + c;
  out[6] = t * y * z + s * x;
  out[7] = 0;
  out[8] = t * x * z + s * y;
  out[9] = t * y * z - s * x;
  out[10] = t * z * z + c;
  out[11] = 0;
  out[12] = p[0];
  out[13] = p[1];
  out[14] = p[2];
  out[15] = 1;
  return out;
}

/** d[o..o+16] = a * b (column-major), written in place. */
function mulInto(d: Float32Array, o: number, a: Mat4, b: Mat4) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4],
      b1 = b[c * 4 + 1],
      b2 = b[c * 4 + 2],
      b3 = b[c * 4 + 3];
    d[o + c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    d[o + c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    d[o + c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    d[o + c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}

const localA = new Float32Array(16);
const localB = new Float32Array(16);

/** Road vehicle kinds, modelled right-hand drive (VehicleRenderer.leftHand). */
const ROAD_KINDS = new Set(['car', 'taxi', 'van', 'truck', 'bus']);
const mirrorA = new Float32Array(16);
const mirrorB = new Float32Array(16);

/** out = m * diag(-1, 1, 1, 1): the model mirrored across its x = 0 plane. */
function mirrorX(out: Float32Array, m: Mat4) {
  out.set(m);
  out[0] = -m[0];
  out[1] = -m[1];
  out[2] = -m[2];
  out[3] = -m[3];
  return out;
}

export class VehicleRenderer implements DrawHook {
  readonly name = 'vehicles';
  variants: VariantGpu[] = [];
  ready = false;
  private meshesDone!: () => void;
  /** Resolves once the meshes are made and uploaded (before the pipelines). */
  readonly meshes = new Promise<void>(res => (this.meshesDone = res));
  errors: string[] = [];
  private renderer: Renderer;
  private device: GPUDevice;
  private vb: GPUBuffer | null = null;
  private ib: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer;
  private instanceData = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
  /** Per pass (0 the view, 1 + c shadow cascade c): this frame's draws. */
  private draws: Draw[][] = Array.from({length: PASSES}, () => []);
  /** This frame's vehicles: bounding sphere (x, y, z, r) per add() call. */
  private bounds = new Float32Array(1024 * 4);
  private masks = new Uint8Array(1024);
  private vehicleCount = 0;
  private vid = 0;
  /** False: every vehicle in every pass (A/B checks of the culling). */
  cull = true;
  /** Vehicles farther than this are not drawn (m; plus 10 x their size). */
  maxDist = 900;
  /** Scales the LOD switch distances (below 1: coarser LODs nearer). */
  lodScale = 1;
  /**
   * Distance (m, for a 4.5 m car; scaled by size) past which the far LOD 3
   * is drawn. Infinity = never (the default look).
   */
  farLod = Infinity;
  /** Shadow cascades vehicles cast into (the renderer has 4; at most 3). */
  shadowCascades = 3;
  private gbufferPipe!: GPURenderPipeline;
  private glassPipe!: GPURenderPipeline;
  private shadowPipe!: GPURenderPipeline;
  private frameBuffer: GPUBuffer;
  private shadowViews: GPUBuffer[];
  // Instance groups (one draw each) persist across frames so their
  // Float32Array storage is reused; `order` lists this frame's groups in
  // first-use order (the draw order).
  private groups: Map<number, Group> = new Map();
  private order: Group[] = [];
  eye: Vec3 = [0, 0, 0];
  private contacts: {d: number; v: number[]}[] = [];
  private lodMemory = new WeakMap<Float32Array, number>();
  instanceCount = 0;
  /**
   * Left-hand drive: road vehicles (modelled right-hand drive, for Tokyo's
   * keep-left traffic) are drawn mirrored across their centre plane, so the
   * driver, steering wheel and the bus's doors change sides. The shader
   * handles the mirrored winding (outwardFacing); add() flips the steering
   * and indicator signs to match.
   */
  leftHand = false;
  private mirrorInst = {} as VehicleInstance;

  constructor(
    renderer: Renderer,
    frameBuffer: GPUBuffer,
    shadowViews: GPUBuffer[],
  ) {
    this.renderer = renderer;
    this.device = renderer.device;
    this.frameBuffer = frameBuffer;
    this.shadowViews = shadowViews;
    this.instanceBuffer = this.device.createBuffer({
      label: 'vehicles/instances',
      size: this.instanceData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  async init(gbufferFormats: GPUTextureFormat[], litFormat: GPUTextureFormat) {
    const d = this.device;
    const module = createShader(
      d,
      'shader/vehicle',
      [commonWgsl, surfaceWgsl, vehicleWgsl].join('\n'),
    );
    const buffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 28,
        attributes: [
          {shaderLocation: 0, offset: 0, format: 'float32x3'},
          {shaderLocation: 1, offset: 12, format: 'float32x3'},
          {shaderLocation: 2, offset: 24, format: 'uint32'},
        ],
      },
    ];
    const depth = (
      write: boolean,
      cmp: GPUCompareFunction,
    ): GPUDepthStencilState => ({
      format: 'depth32float',
      depthWriteEnabled: write,
      depthCompare: cmp,
    });
    // Compiled while the workers tessellate (awaited at the end).
    const pipes = Promise.all(
      [
        d.createRenderPipelineAsync({
          label: 'pipeline/vehicle gbuffer',
          layout: 'auto',
          vertex: {module, entryPoint: 'vs', buffers},
          fragment: {
            module,
            entryPoint: 'fs',
            targets: gbufferFormats.map(format => ({format})),
          },
          primitive: {cullMode: 'none'},
          depthStencil: depth(true, 'greater'),
        }),
        d.createRenderPipelineAsync({
          label: 'pipeline/vehicle glass',
          layout: 'auto',
          vertex: {module, entryPoint: 'vs', buffers},
          fragment: {
            module,
            entryPoint: 'fsGlass',
            targets: [
              {
                format: litFormat,
                blend: {
                  color: {
                    srcFactor: 'src-alpha',
                    dstFactor: 'one-minus-src-alpha',
                  },
                  alpha: {srcFactor: 'zero', dstFactor: 'one'},
                },
              },
            ],
          },
          primitive: {cullMode: 'none'},
          depthStencil: depth(false, 'greater'),
        }),
        d.createRenderPipelineAsync({
          label: 'pipeline/vehicle shadow',
          layout: 'auto',
          vertex: {module, entryPoint: 'vsShadow', buffers},
          primitive: {cullMode: 'none'},
          depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'less',
            depthBias: 2,
            depthBiasSlopeScale: 2,
          },
        }),
      ].map((p, i) =>
        pipeline(`vehicle ${['gbuffer', 'glass', 'shadow'][i]}`, p),
      ),
    );
    // Tessellate designs in parallel across several workers.
    const endTess = begin('vehicle tessellation (workers)', 'vehicles');
    const names = [...Object.keys(designs), 'person'];
    const nWorkers = Math.max(
      2,
      Math.min(names.length, lowMemory() ? 2 : 16, cores() - 1),
    );
    const groups: string[][] = Array.from({length: nWorkers}, () => []);
    counters.vehicles.total += nWorkers;
    names.forEach((n, i) => groups[i % nWorkers].push(n));
    const results = await Promise.all(
      groups.map(
        (group, gi) =>
          new Promise<{variants: VehicleVariant[]; errors: string[]}>(
            (resolve, reject) => {
              const w = new Worker(
                new URL('./vehicle-worker.js', import.meta.url),
                {
                  type: 'module',
                  name: `vehicle-worker-${gi}`,
                },
              );
              w.onmessage = e => {
                counters.vehicles.done++;
                resolve(e.data);
                w.terminate();
              };
              w.onerror = e =>
                reject(new Error(`[vehicle worker] ${e.message}`));
              w.postMessage({names: group});
            },
          ),
      ),
    );
    endTess();
    const endUpload = begin('vehicle mesh upload');
    // Keep a stable order (registry order) regardless of worker grouping.
    const variants = results
      .flatMap(r => r.variants)
      .sort(
        (a, b) =>
          names.indexOf(a.name) - names.indexOf(b.name) || a.seed - b.seed,
      );
    this.errors = results.flatMap(r => r.errors);
    for (const e of this.errors) console.warn('[vehicles]', e);
    // Pack every mesh into one vertex and one index buffer.
    let vBytes = 0;
    let iCount = 0;
    for (const v of variants) {
      for (const l of v.lods) {
        for (const m of [l.body, l.wheel, ...l.rotors, l.steering]) {
          if (!m) continue;
          vBytes += m.vertices.byteLength;
          iCount += m.indices.length;
        }
      }
    }
    this.vb = d.createBuffer({
      label: 'vehicles/vertices',
      size: Math.max(28, vBytes),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.ib = d.createBuffer({
      label: 'vehicles/indices',
      size: Math.max(4, iCount * 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    let vOff = 0;
    let iOff = 0;
    const put = (
      m: {vertices: ArrayBuffer; indices: Uint32Array} | null,
    ): Part | null => {
      if (!m) return null;
      d.queue.writeBuffer(this.vb!, vOff, m.vertices);
      d.queue.writeBuffer(this.ib!, iOff * 4, m.indices);
      const p = {
        firstIndex: iOff,
        indexCount: m.indices.length,
        baseVertex: vOff / 28,
      };
      vOff += m.vertices.byteLength;
      iOff += m.indices.length;
      return p;
    };
    this.variants = variants.map(info => ({
      info,
      lods: info.lods.map(l => ({
        body: put(l.body)!,
        wheel: put(l.wheel),
        rotors: l.rotors.map(r => put(r)!),
        steering: put(l.steering),
      })),
    }));
    endUpload();
    this.meshesDone();
    [this.gbufferPipe, this.glassPipe, this.shadowPipe] = await pipes;
    this.ready = true;
  }

  /** Whether variant `i` is drawn mirrored (leftHand). */
  mirrored(i: number) {
    const v = this.variants[i];
    return this.leftHand && !!v && ROAD_KINDS.has(v.info.kind);
  }

  /** Driver eye of variant `i` in its (possibly mirrored) vehicle space. */
  driverEye(i: number): Vec3 | undefined {
    const e = this.variants[i]?.info.driverEye;
    if (!e) return undefined;
    return this.mirrored(i) ? [-e[0], e[1], e[2]] : e;
  }

  variantsOf(kind: string): number[] {
    return this.variants
      .map((v, i) => (v.info.kind === kind ? i : -1))
      .filter(i => i >= 0);
  }

  begin(eye: Vec3) {
    this.eye = eye;
    this.vehicleCount = 0;
    for (const g of this.order) g.n = 0;
    this.order = [];
    this.contacts = [];
  }

  /**
   * Instance of `part` whose matrices are model * local and prev * prevLocal,
   * written straight into the group's storage.
   */
  private pushLocal(
    key: number,
    part: Part,
    lod: number,
    model: Mat4,
    prev: Mat4,
    local: Mat4,
    prevLocal: Mat4,
    inst: VehicleInstance,
  ) {
    const g = this.slot(key, part, lod, false);
    const o = g.n * INSTANCE_FLOATS;
    mulInto(g.data, o, model, local);
    mulInto(g.data, o + 16, prev, prevLocal);
    g.vid[g.n] = this.vid;
    this.fill(g, o, inst);
  }

  private slot(key: number, part: Part, lod: number, body: boolean): Group {
    let g = this.groups.get(key);
    if (!g) {
      g = {
        part,
        lod,
        body,
        data: new Float32Array(INSTANCE_FLOATS * 16),
        vid: new Uint32Array(16),
        n: 0,
      };
      this.groups.set(key, g);
    }
    if (g.n === 0) this.order.push(g);
    if ((g.n + 1) * INSTANCE_FLOATS > g.data.length) {
      const grown = new Float32Array(g.data.length * 2);
      grown.set(g.data);
      g.data = grown;
      const vid = new Uint32Array(g.vid.length * 2);
      vid.set(g.vid);
      g.vid = vid;
    }
    return g;
  }

  private fill(g: Group, o: number, inst: VehicleInstance) {
    const d = g.data;
    d[o + 32] = inst.color[0];
    d[o + 33] = inst.color[1];
    d[o + 34] = inst.color[2];
    d[o + 35] = inst.metallic;
    d[o + 36] = inst.color2[0];
    d[o + 37] = inst.color2[1];
    d[o + 38] = inst.color2[2];
    d[o + 39] = 0.2;
    d[o + 40] = inst.lights;
    d[o + 41] = inst.brake;
    d[o + 42] = inst.indicator;
    d[o + 43] = 0.15;
    g.n++;
  }

  private push(
    key: number,
    part: Part,
    lod: number,
    body: boolean,
    model: Mat4,
    prev: Mat4,
    inst: VehicleInstance,
  ) {
    const g = this.slot(key, part, lod, body);
    const o = g.n * INSTANCE_FLOATS;
    g.data.set(model, o);
    g.data.set(prev, o + 16);
    g.vid[g.n] = this.vid;
    this.fill(g, o, inst);
  }

  add(inst: VehicleInstance) {
    if (!this.ready || inst.hidden) return;
    const v = this.variants[inst.variant];
    if (!v) return;
    // (LOD memory keyed by the caller's matrix, not the mirrored scratch.)
    const memo = inst.model;
    if (this.mirrored(inst.variant)) {
      const mi = Object.assign(this.mirrorInst, inst);
      mi.model = mirrorX(mirrorA, inst.model);
      mi.prevModel = mirrorX(mirrorB, inst.prevModel);
      mi.steer = -inst.steer;
      mi.indicator = -inst.indicator;
      inst = mi;
    }
    const m = inst.model;
    const dist = Math.hypot(
      m[12] - this.eye[0],
      m[13] - this.eye[1],
      m[14] - this.eye[2],
    );
    const sz = v.info.size;
    const size = Math.max(sz[0], sz[1], sz[2]);
    if (dist > this.maxDist * (1 + size / 90)) return;
    // LOD with hysteresis so vehicles near a threshold don't pop every frame.
    const prevLod = this.lodMemory.get(memo);
    const b0 = (18 + size * 2) * this.lodScale;
    const b1 = (70 + size * 6) * this.lodScale;
    const k = (l: number) =>
      prevLod === undefined ? 1 : prevLod <= l ? 1.12 : 0.9;
    // (The far LOD 3 only when farLod is set: vehicle-worker.ts.)
    const b2 = (this.farLod * size) / 4.5;
    const lod =
      inst.lod ??
      (dist < b0 * k(0)
        ? 0
        : dist < b1 * k(1)
          ? 1
          : dist < b2 * k(2) || v.lods.length < 4
            ? 2
            : 3);
    this.lodMemory.set(memo, lod);
    // Bounding sphere for the per-pass culling (prepare): the model's
    // origin sits at the ground, the parts reach about half the diagonal.
    if (this.vehicleCount * 4 >= this.bounds.length) {
      const grown = new Float32Array(this.bounds.length * 2);
      grown.set(this.bounds);
      this.bounds = grown;
      this.masks = new Uint8Array(grown.length / 4);
    }
    this.vid = this.vehicleCount++;
    const scale = Math.hypot(m[0], m[1], m[2]);
    this.bounds[this.vid * 4] = m[12];
    this.bounds[this.vid * 4 + 1] = m[13];
    this.bounds[this.vid * 4 + 2] = m[14];
    this.bounds[this.vid * 4 + 3] =
      (Math.hypot(sz[0], sz[1], sz[2]) * 0.5 + sz[1] * 0.5 + 1) * scale;
    const L = v.lods[lod];
    // Group key: variant, LOD, part (0 body, 1 wheel, 2 steering, 3+ rotors).
    const key = (inst.variant * 4 + lod) * 64;
    this.push(key, L.body, lod, true, m, inst.prevModel, inst);
    if (
      dist < 160 &&
      v.info.kind !== 'person' &&
      v.info.kind !== 'helicopter' &&
      v.info.kind !== 'train'
    ) {
      this.contacts.push({
        d: dist,
        v: [
          m[12],
          m[13],
          m[14],
          0,
          memo[0],
          memo[2],
          m[8],
          m[10],
          sz[0] / 2,
          sz[1] / 2,
          sz[2] / 2,
          0,
        ],
      });
    }
    const pm = inst.prevModel;
    if (L.wheel) {
      const spinning = lod < 2 + (size > 8 ? 1 : 0);
      for (const w of v.info.wheels) {
        const left = w.position[0] < 0;
        const local = spinning
          ? wheelLocal(
              localA,
              w.position,
              (w.steer ? inst.steer : 0) + (left ? Math.PI : 0),
              left ? -inst.wheelSpin : inst.wheelSpin,
            )
          : wheelLocal(localA, w.position, left ? Math.PI : 0, 0);
        this.pushLocal(key + 1, L.wheel, lod, m, pm, local, local, inst);
      }
    }
    const rotors = v.info.rotors;
    const person = v.info.kind === 'person';
    for (let k = 0; k < rotors.length; k++) {
      const r = rotors[k];
      const angle = (phase: number) =>
        person
          ? // Limbs swing: legs opposite each other, arms opposite their leg.
            Math.sin(phase + (k === 1 || k === 2 ? Math.PI : 0)) *
            (k < 2 ? 0.45 : 0.35)
          : phase * (k === 0 ? 1 : 4.3);
      const local = rotorLocal(localA, r.position, r.axis, angle(inst.rotor));
      const prevLocal = rotorLocal(
        localB,
        r.position,
        r.axis,
        angle(inst.prevRotor ?? inst.rotor),
      );
      this.pushLocal(
        key + 3 + k,
        L.rotors[k],
        lod,
        m,
        pm,
        local,
        prevLocal,
        inst,
      );
    }
    if (L.steering && v.info.steeringWheel && lod === 0) {
      const sw = v.info.steeringWheel;
      const local = mul(
        translate(sw.position),
        rotX(sw.tilt),
        rotAxis([0, 0, 1], -inst.steer * 6),
      );
      this.push(
        key + 2,
        L.steering,
        lod,
        false,
        mat4.multiply(scratch(), m, local),
        mat4.multiply(scratch(), inst.prevModel, local),
        inst,
      );
    }
  }

  finish() {
    this.contacts.sort((a, b) => a.d - b.d);
    const cn = Math.min(this.contacts.length, 128);
    const cd = new Float32Array(cn * 12);
    for (let i = 0; i < cn; i++) cd.set(this.contacts[i].v, i * 12);
    this.renderer.setContacts(cd, cn);
    void tmp;
  }

  /**
   * Inside render(), once the frame's culling volumes are known: each pass
   * gets the instances of the vehicles it can see (the view frustum; for a
   * shadow cascade, the casters that can shade a visible pixel), packed
   * pass by pass into the instance buffer.
   */
  prepare() {
    this.pack(this.cull ? this.renderer.hookCull : null);
  }

  private pack(cull: HookCull | null) {
    const nv = this.vehicleCount;
    const b = this.bounds;
    const masks = this.masks;
    for (let i = 0; i < nv; i++) {
      const x = b[i * 4];
      const y = b[i * 4 + 1];
      const z = b[i * 4 + 2];
      const r = b[i * 4 + 3];
      let mask = !cull || inside(cull.view, x, y, z, r) ? 1 : 0;
      for (let c = 0; c < this.shadowCascades; c++) {
        const pl = cull ? cull.casters[c] : null;
        if (!cull || (pl && inside(pl, x, y, z, r))) mask |= 2 << c;
      }
      masks[i] = mask;
    }
    const F = INSTANCE_FLOATS;
    const out = this.instanceData;
    let n = 0;
    for (let p = 0; p < PASSES; p++) {
      const draws: Draw[] = (this.draws[p] = []);
      const bit = 1 << p;
      for (const g of this.order) {
        const first = n;
        const src = g.data;
        const vid = g.vid;
        for (let j = 0; j < g.n && n < MAX_INSTANCES; j++) {
          if ((masks[vid[j]] & bit) === 0) continue;
          const o = n * F;
          const i = j * F;
          for (let k = 0; k < F; k++) out[o + k] = src[i + k];
          n++;
        }
        if (n > first)
          draws.push({
            part: g.part,
            first,
            count: n - first,
            body: g.body,
            lod: g.lod,
          });
      }
    }
    this.instanceCount = n;
    if (n)
      // (A subarray: given the whole array plus a size, Chrome took ~1 ms.)
      this.device.queue.writeBuffer(
        this.instanceBuffer,
        0,
        out.subarray(0, n * F),
      );
  }

  // Bind groups only reference buffers that live as long as the renderer:
  // made once per pipeline / cascade.
  private bindGroups = new Map<string, [GPUBindGroup, GPUBindGroup]>();

  private bind(
    pass: GPURenderPassEncoder,
    pipe: GPURenderPipeline,
    key: string,
    g0: GPUBindGroupEntry[],
  ) {
    let bgs = this.bindGroups.get(key);
    if (!bgs) {
      bgs = [
        this.device.createBindGroup({
          label: 'bg/vehicles/frame',
          layout: pipe.getBindGroupLayout(0),
          entries: g0,
        }),
        this.device.createBindGroup({
          label: 'bg/vehicles/instances',
          layout: pipe.getBindGroupLayout(1),
          entries: [{binding: 0, resource: {buffer: this.instanceBuffer}}],
        }),
      ];
      this.bindGroups.set(key, bgs);
    }
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bgs[0]);
    pass.setBindGroup(1, bgs[1]);
    pass.setVertexBuffer(0, this.vb!);
    pass.setIndexBuffer(this.ib!, 'uint32');
  }

  gbuffer(pass: GPURenderPassEncoder) {
    if (!this.draws[0].length) return;
    this.bind(pass, this.gbufferPipe, 'gbuffer', [
      {binding: 0, resource: {buffer: this.frameBuffer}},
    ]);
    for (const d of this.draws[0])
      pass.drawIndexed(
        d.part.indexCount,
        d.count,
        d.part.firstIndex,
        d.part.baseVertex,
        d.first,
      );
  }

  forward(pass: GPURenderPassEncoder) {
    if (!this.draws[0].some(d => d.body && d.lod < 2)) return;
    this.bind(pass, this.glassPipe, 'glass', [
      {binding: 0, resource: {buffer: this.frameBuffer}},
    ]);
    for (const d of this.draws[0])
      if (d.body && d.lod < 2)
        pass.drawIndexed(
          d.part.indexCount,
          d.count,
          d.part.firstIndex,
          d.part.baseVertex,
          d.first,
        );
  }

  shadow(pass: GPURenderPassEncoder, cascade: number) {
    const draws = this.draws[1 + cascade];
    if (cascade >= this.shadowCascades || !draws?.length) return;
    this.bind(pass, this.shadowPipe, `shadow${cascade}`, [
      {binding: 1, resource: {buffer: this.shadowViews[cascade]}},
    ]);
    for (const d of draws)
      pass.drawIndexed(
        d.part.indexCount,
        d.count,
        d.part.firstIndex,
        d.part.baseVertex,
        d.first,
      );
  }
}
