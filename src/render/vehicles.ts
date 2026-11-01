// Instanced rendering of NURBS vehicles: body, wheels, rotors and steering
// wheel per instance, three LODs, G-buffer + shadow + forward glass passes.

import {createShader} from '../gpu/device.ts';
import {begin, counters, pipeline} from '../ui/timeline.ts';
import {mat4, type Mat4} from '../math/mat4.ts';
import type {Vec3} from '../math/vec.ts';
import commonWgsl from '../shaders/common.wgsl';
import surfaceWgsl from '../shaders/surface.wgsl';
import vehicleWgsl from '../shaders/vehicle.wgsl';
import {designs} from '../vehicles/designs/index.ts';
import type {VehicleVariant} from '../workers/vehicle-worker.ts';
import type {DrawHook, Renderer} from './renderer.ts';

const INSTANCE_FLOATS = 44;

interface Group {
  part: Part;
  lod: number;
  body: boolean;
  data: Float32Array;
  n: number;
}
const MAX_INSTANCES = 8192;

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

export class VehicleRenderer implements DrawHook {
  readonly name = 'vehicles';
  variants: VariantGpu[] = [];
  ready = false;
  errors: string[] = [];
  private renderer: Renderer;
  private device: GPUDevice;
  private vb: GPUBuffer | null = null;
  private ib: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer;
  private instanceData = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
  private draws: {
    part: Part;
    first: number;
    count: number;
    body: boolean;
    lod: number;
  }[] = [];
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
      Math.min(names.length, (navigator.hardwareConcurrency || 4) - 1),
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
    [this.gbufferPipe, this.glassPipe, this.shadowPipe] = await pipes;
    this.ready = true;
  }

  variantsOf(kind: string): number[] {
    return this.variants
      .map((v, i) => (v.info.kind === kind ? i : -1))
      .filter(i => i >= 0);
  }

  begin(eye: Vec3) {
    this.eye = eye;
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
    this.fill(g, o, inst);
  }

  private slot(key: number, part: Part, lod: number, body: boolean): Group {
    let g = this.groups.get(key);
    if (!g) {
      g = {part, lod, body, data: new Float32Array(INSTANCE_FLOATS * 16), n: 0};
      this.groups.set(key, g);
    }
    if (g.n === 0) this.order.push(g);
    if ((g.n + 1) * INSTANCE_FLOATS > g.data.length) {
      const grown = new Float32Array(g.data.length * 2);
      grown.set(g.data);
      g.data = grown;
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
    this.fill(g, o, inst);
  }

  add(inst: VehicleInstance) {
    if (!this.ready || inst.hidden) return;
    const v = this.variants[inst.variant];
    if (!v) return;
    const m = inst.model;
    const dist = Math.hypot(
      m[12] - this.eye[0],
      m[13] - this.eye[1],
      m[14] - this.eye[2],
    );
    const sz = v.info.size;
    const size = Math.max(sz[0], sz[1], sz[2]);
    if (dist > 900 + size * 10) return;
    // LOD with hysteresis so vehicles near a threshold don't pop every frame.
    const prevLod = this.lodMemory.get(inst.model);
    const b0 = 18 + size * 2;
    const b1 = 70 + size * 6;
    const k = (l: number) =>
      prevLod === undefined ? 1 : prevLod <= l ? 1.12 : 0.9;
    const lod = inst.lod ?? (dist < b0 * k(0) ? 0 : dist < b1 * k(1) ? 1 : 2);
    this.lodMemory.set(inst.model, lod);
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
          m[0],
          m[2],
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
    this.draws = [];
    let n = 0;
    for (const g of this.order) {
      const count = g.n;
      if (n + count > MAX_INSTANCES) break;
      this.instanceData.set(
        g.data.subarray(0, count * INSTANCE_FLOATS),
        n * INSTANCE_FLOATS,
      );
      this.draws.push({
        part: g.part,
        first: n,
        count,
        body: g.body,
        lod: g.lod,
      });
      n += count;
    }
    this.instanceCount = n;
    if (n)
      this.device.queue.writeBuffer(
        this.instanceBuffer,
        0,
        this.instanceData,
        0,
        n * INSTANCE_FLOATS,
      );
    void tmp;
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
    if (!this.draws.length) return;
    this.bind(pass, this.gbufferPipe, 'gbuffer', [
      {binding: 0, resource: {buffer: this.frameBuffer}},
    ]);
    for (const d of this.draws)
      pass.drawIndexed(
        d.part.indexCount,
        d.count,
        d.part.firstIndex,
        d.part.baseVertex,
        d.first,
      );
  }

  forward(pass: GPURenderPassEncoder) {
    if (!this.draws.length) return;
    this.bind(pass, this.glassPipe, 'glass', [
      {binding: 0, resource: {buffer: this.frameBuffer}},
    ]);
    for (const d of this.draws)
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
    if (!this.draws.length || cascade > 2) return;
    this.bind(pass, this.shadowPipe, `shadow${cascade}`, [
      {binding: 1, resource: {buffer: this.shadowViews[cascade]}},
    ]);
    for (const d of this.draws)
      if (d.lod >= (cascade === 0 ? 0 : 1) || cascade > 0)
        pass.drawIndexed(
          d.part.indexCount,
          d.count,
          d.part.firstIndex,
          d.part.baseVertex,
          d.first,
        );
  }
}
