// Instanced rendering of NURBS vehicles: body, wheels, rotors and steering
// wheel per instance, three LODs, G-buffer + shadow + forward glass passes.

import {createShader} from '../gpu/device.ts';
import {mat4, type Mat4} from '../math/mat4.ts';
import type {Vec3} from '../math/vec.ts';
import commonWgsl from '../shaders/common.wgsl';
import surfaceWgsl from '../shaders/surface.wgsl';
import vehicleWgsl from '../shaders/vehicle.wgsl';
import type {VehicleVariant} from '../workers/vehicle-worker.ts';
import type {DrawHook, Renderer} from './renderer.ts';

const INSTANCE_FLOATS = 44;
const MAX_INSTANCES = 8192;

interface Part {
  firstIndex: number;
  indexCount: number;
  baseVertex: number;
}

interface VariantGpu {
  info: VehicleVariant;
  lods: {body: Part; wheel: Part | null; rotors: Part[]; steering: Part | null}[];
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
  /** Force a LOD (e.g. the player's car in first person). */
  lod?: number;
  /** Skip drawing (still casts shadows when shadowOnly). */
  hidden?: boolean;
}

const tmp = mat4.create();

function rotX(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function rotY(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

function rotAxis(axis: Vec3, a: number): Mat4 {
  const [x, y, z] = axis;
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return new Float32Array([t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1]);
}

function translate(p: Vec3): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1]);
}

const mul = (...ms: Mat4[]) => ms.reduce((acc, m) => mat4.multiply(mat4.create(), acc, m));

export class VehicleRenderer implements DrawHook {
  variants: VariantGpu[] = [];
  ready = false;
  errors: string[] = [];
  private renderer: Renderer;
  private device: GPUDevice;
  private vb: GPUBuffer | null = null;
  private ib: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer;
  private instanceData = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
  private draws: {part: Part; first: number; count: number; body: boolean; lod: number}[] = [];
  private gbufferPipe!: GPURenderPipeline;
  private glassPipe!: GPURenderPipeline;
  private shadowPipe!: GPURenderPipeline;
  private frameBuffer: GPUBuffer;
  private shadowViews: GPUBuffer[];
  private groups: Map<string, {part: Part; lod: number; body: boolean; data: number[]}> = new Map();
  eye: Vec3 = [0, 0, 0];
  instanceCount = 0;

  constructor(renderer: Renderer, frameBuffer: GPUBuffer, shadowViews: GPUBuffer[]) {
    this.renderer = renderer;
    this.device = renderer.device;
    this.frameBuffer = frameBuffer;
    this.shadowViews = shadowViews;
    this.instanceBuffer = this.device.createBuffer({label: 'vehicles/instances', size: this.instanceData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
  }

  async init(gbufferFormats: GPUTextureFormat[], litFormat: GPUTextureFormat) {
    const d = this.device;
    const module = createShader(d, 'shader/vehicle', [commonWgsl, surfaceWgsl, vehicleWgsl].join('\n'));
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
    const depth = (write: boolean, cmp: GPUCompareFunction): GPUDepthStencilState => ({format: 'depth32float', depthWriteEnabled: write, depthCompare: cmp});
    [this.gbufferPipe, this.glassPipe, this.shadowPipe] = await Promise.all([
      d.createRenderPipelineAsync({label: 'pipeline/vehicle gbuffer', layout: 'auto', vertex: {module, entryPoint: 'vs', buffers}, fragment: {module, entryPoint: 'fs', targets: gbufferFormats.map(format => ({format}))}, primitive: {cullMode: 'none'}, depthStencil: depth(true, 'greater')}),
      d.createRenderPipelineAsync({
        label: 'pipeline/vehicle glass',
        layout: 'auto',
        vertex: {module, entryPoint: 'vs', buffers},
        fragment: {
          module,
          entryPoint: 'fsGlass',
          targets: [{format: litFormat, blend: {color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'}, alpha: {srcFactor: 'zero', dstFactor: 'one'}}}],
        },
        primitive: {cullMode: 'none'},
        depthStencil: depth(false, 'greater'),
      }),
      d.createRenderPipelineAsync({label: 'pipeline/vehicle shadow', layout: 'auto', vertex: {module, entryPoint: 'vsShadow', buffers}, primitive: {cullMode: 'none'}, depthStencil: {format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2}}),
    ]);
    const variants = await new Promise<VehicleVariant[]>((resolve, reject) => {
      const w = new Worker(new URL('./vehicle-worker.js', import.meta.url), {type: 'module', name: 'vehicle-worker'});
      w.onmessage = e => {
        this.errors = e.data.errors;
        resolve(e.data.variants);
        w.terminate();
      };
      w.onerror = e => reject(new Error(`[vehicle worker] ${e.message}`));
      w.postMessage('go');
    });
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
    this.vb = d.createBuffer({label: 'vehicles/vertices', size: Math.max(28, vBytes), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST});
    this.ib = d.createBuffer({label: 'vehicles/indices', size: Math.max(4, iCount * 4), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST});
    let vOff = 0;
    let iOff = 0;
    const put = (m: {vertices: ArrayBuffer; indices: Uint32Array} | null): Part | null => {
      if (!m) return null;
      d.queue.writeBuffer(this.vb!, vOff, m.vertices);
      d.queue.writeBuffer(this.ib!, iOff * 4, m.indices);
      const p = {firstIndex: iOff, indexCount: m.indices.length, baseVertex: vOff / 28};
      vOff += m.vertices.byteLength;
      iOff += m.indices.length;
      return p;
    };
    this.variants = variants.map(info => ({
      info,
      lods: info.lods.map(l => ({body: put(l.body)!, wheel: put(l.wheel), rotors: l.rotors.map(r => put(r)!), steering: put(l.steering)})),
    }));
    this.ready = true;
  }

  variantsOf(kind: string): number[] {
    return this.variants.map((v, i) => (v.info.kind === kind ? i : -1)).filter(i => i >= 0);
  }

  begin(eye: Vec3) {
    this.eye = eye;
    this.groups.clear();
  }

  private push(key: string, part: Part, lod: number, body: boolean, model: Mat4, prev: Mat4, inst: VehicleInstance) {
    let g = this.groups.get(key);
    if (!g) this.groups.set(key, (g = {part, lod, body, data: []}));
    g.data.push(...model, ...prev, ...inst.color, inst.metallic, ...inst.color2, 0.2, inst.lights, inst.brake, inst.indicator, 0.15);
  }

  add(inst: VehicleInstance) {
    if (!this.ready || inst.hidden) return;
    const v = this.variants[inst.variant];
    if (!v) return;
    const m = inst.model;
    const dist = Math.hypot(m[12] - this.eye[0], m[13] - this.eye[1], m[14] - this.eye[2]);
    const size = Math.max(...v.info.size);
    if (dist > 900 + size * 10) return;
    const lod = inst.lod ?? (dist < 18 + size * 2 ? 0 : dist < 70 + size * 6 ? 1 : 2);
    const L = v.lods[lod];
    const key = `${inst.variant}|${lod}`;
    this.push(`${key}|body`, L.body, lod, true, m, inst.prevModel, inst);
    if (L.wheel && lod < 2 + (size > 8 ? 1 : 0)) {
      v.info.wheels.forEach((w, k) => {
        const left = w.position[0] < 0;
        const local = mul(translate(w.position), rotY((w.steer ? inst.steer : 0) + (left ? Math.PI : 0)), rotX(left ? -inst.wheelSpin : inst.wheelSpin));
        const wm = mat4.multiply(mat4.create(), m, local);
        const wp = mat4.multiply(mat4.create(), inst.prevModel, local);
        this.push(`${key}|wheel`, L.wheel!, lod, false, wm, wp, inst);
        void k;
      });
    } else if (L.wheel) {
      v.info.wheels.forEach(w => {
        const local = mul(translate(w.position), rotY(w.position[0] < 0 ? Math.PI : 0));
        this.push(`${key}|wheel`, L.wheel!, lod, false, mat4.multiply(mat4.create(), m, local), mat4.multiply(mat4.create(), inst.prevModel, local), inst);
      });
    }
    v.info.rotors.forEach((r, k) => {
      const local = mul(translate(r.position), rotAxis(r.axis, inst.rotor * (k === 0 ? 1 : 4.3)));
      this.push(`${key}|rotor${k}`, L.rotors[k], lod, false, mat4.multiply(mat4.create(), m, local), mat4.multiply(mat4.create(), inst.prevModel, local), inst);
    });
    if (L.steering && v.info.steeringWheel && lod === 0) {
      const sw = v.info.steeringWheel;
      const local = mul(translate(sw.position), rotX(sw.tilt), rotAxis([0, 0, 1], -inst.steer * 6));
      this.push(`${key}|steer`, L.steering, lod, false, mat4.multiply(mat4.create(), m, local), mat4.multiply(mat4.create(), inst.prevModel, local), inst);
    }
  }

  finish() {
    this.draws = [];
    let n = 0;
    for (const g of this.groups.values()) {
      const count = g.data.length / INSTANCE_FLOATS;
      if (n + count > MAX_INSTANCES) break;
      this.instanceData.set(g.data, n * INSTANCE_FLOATS);
      this.draws.push({part: g.part, first: n, count, body: g.body, lod: g.lod});
      n += count;
    }
    this.instanceCount = n;
    if (n) this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instanceData, 0, n * INSTANCE_FLOATS);
    void tmp;
  }

  private bind(pass: GPURenderPassEncoder, pipe: GPURenderPipeline, g0: GPUBindGroupEntry[]) {
    pass.setPipeline(pipe);
    pass.setBindGroup(0, this.device.createBindGroup({label: 'bg/vehicles/frame', layout: pipe.getBindGroupLayout(0), entries: g0}));
    pass.setBindGroup(1, this.device.createBindGroup({label: 'bg/vehicles/instances', layout: pipe.getBindGroupLayout(1), entries: [{binding: 0, resource: {buffer: this.instanceBuffer}}]}));
    pass.setVertexBuffer(0, this.vb!);
    pass.setIndexBuffer(this.ib!, 'uint32');
  }

  gbuffer(pass: GPURenderPassEncoder) {
    if (!this.draws.length) return;
    this.bind(pass, this.gbufferPipe, [{binding: 0, resource: {buffer: this.frameBuffer}}]);
    for (const d of this.draws) pass.drawIndexed(d.part.indexCount, d.count, d.part.firstIndex, d.part.baseVertex, d.first);
  }

  forward(pass: GPURenderPassEncoder) {
    if (!this.draws.length) return;
    this.bind(pass, this.glassPipe, [{binding: 0, resource: {buffer: this.frameBuffer}}]);
    for (const d of this.draws) if (d.body && d.lod < 2) pass.drawIndexed(d.part.indexCount, d.count, d.part.firstIndex, d.part.baseVertex, d.first);
  }

  shadow(pass: GPURenderPassEncoder, cascade: number) {
    if (!this.draws.length || cascade > 2) return;
    this.bind(pass, this.shadowPipe, [{binding: 1, resource: {buffer: this.shadowViews[cascade]}}]);
    for (const d of this.draws) if (d.lod >= (cascade === 0 ? 0 : 1) || cascade > 0) pass.drawIndexed(d.part.indexCount, d.count, d.part.firstIndex, d.part.baseVertex, d.first);
  }
}
