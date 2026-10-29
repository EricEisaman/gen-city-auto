// Vehicle turntable: renders one vehicle design for inspection by the vehicle
// designer and judge agents.
//
//   vehicles.html?design=sedan&seed=1&view=three-quarter&color=0
//   views: front, rear, side, three-quarter, top, interior, orbit
// Back faces render magenta so inverted normals are obvious.

import {
  createShader,
  initGpu,
  reportError,
  resizeToCss,
} from '../gpu/device.ts';
import {mat4} from '../math/mat4.ts';
import type {Vec3} from '../math/vec.ts';
import type {Mesh} from '../nurbs/mesh.ts';
import {designs} from '../vehicles/designs/index.ts';
import {person} from '../vehicles/person.ts';
import type {VehicleDesign} from '../vehicles/types.ts';

const shader = /* wgsl */ `
struct U {
  viewProj: mat4x4f,
  model: mat4x4f,
  color: vec4f,
  color2: vec4f,
  camPos: vec4f,
  params: vec4f, // x = lights on
};
@group(0) @binding(0) var<uniform> u: U;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) mat: u32,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) m: u32) -> VOut {
  var o: VOut;
  let w = u.model * vec4f(p, 1);
  o.pos = u.viewProj * w;
  o.world = w.xyz;
  o.normal = (u.model * vec4f(n, 0)).xyz;
  o.mat = m;
  return o;
}

struct Surf { albedo: vec3f, rough: f32, metal: f32, emissive: vec3f, alpha: f32 };

fn material(id: u32) -> Surf {
  var s = Surf(vec3f(0.5), 0.5, 0.0, vec3f(0), 1.0);
  let lights = u.params.x;
  switch id {
    case 0u: { s.albedo = u.color.rgb; s.rough = 0.25; s.metal = 0.3; }
    case 1u: { s.albedo = u.color2.rgb; s.rough = 0.3; s.metal = 0.2; }
    case 2u: { s.albedo = vec3f(0.02, 0.03, 0.035); s.rough = 0.05; s.metal = 0.0; s.alpha = 0.6; }
    case 3u: { s.albedo = vec3f(0.95); s.rough = 0.08; s.metal = 1.0; }
    case 4u: { s.albedo = vec3f(0.03); s.rough = 0.85; }
    case 5u: { s.albedo = vec3f(0.05); s.rough = 0.6; }
    case 6u: { s.albedo = vec3f(0.9); s.rough = 0.1; s.emissive = vec3f(8.0) * lights; }
    case 7u: { s.albedo = vec3f(0.5, 0.02, 0.02); s.rough = 0.2; s.emissive = vec3f(3.0, 0.1, 0.05) * lights; }
    case 8u: { s.albedo = vec3f(0.12, 0.11, 0.1); s.rough = 0.8; }
    case 9u: { s.albedo = vec3f(0.18, 0.16, 0.15); s.rough = 0.9; }
    case 10u: { s.albedo = vec3f(0.04); s.rough = 0.5; s.emissive = vec3f(0.2, 0.6, 1.0) * lights; }
    case 11u: { s.albedo = vec3f(0.06); s.rough = 0.5; s.metal = 0.8; }
    case 12u: { s.albedo = vec3f(0.7); s.rough = 0.25; s.metal = 1.0; }
    case 13u: { s.albedo = vec3f(1.0, 0.45, 0.0); s.rough = 0.2; s.emissive = vec3f(2.0, 0.8, 0.0) * lights; }
    case 14u: { s.albedo = vec3f(0.02); s.rough = 0.2; s.emissive = vec3f(1.5, 0.8, 0.1); }
    case 15u: { s.albedo = vec3f(0.62, 0.46, 0.36); s.rough = 0.6; }
    case 16u: { s.albedo = u.color.rgb; s.rough = 0.9; }
    case 17u: { s.albedo = vec3f(0.12, 0.13, 0.16); s.rough = 0.9; }
    default: { s.albedo = vec3f(1, 0, 1); }
  }
  return s;
}

fn skyColor(d: vec3f) -> vec3f {
  return mix(vec3f(0.35, 0.33, 0.3), vec3f(0.35, 0.55, 0.9), clamp(d.y * 0.5 + 0.5, 0.0, 1.0));
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  if (!ff) { return vec4f(1, 0, 1, 1); }
  let s = material(i.mat);
  let n = normalize(i.normal);
  let v = normalize(u.camPos.xyz - i.world);
  let l = normalize(vec3f(0.5, 0.8, 0.3));
  let h = normalize(l + v);
  let ndl = max(dot(n, l), 0.0);
  let a = s.rough * s.rough;
  let ndh = max(dot(n, h), 0.0);
  let d = a * a / (3.14159 * pow(ndh * ndh * (a * a - 1.0) + 1.0, 2.0));
  let f0 = mix(vec3f(0.04), s.albedo, s.metal);
  let fres = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  let spec = fres * d * 0.25;
  let diffuse = s.albedo * (1.0 - s.metal);
  var c = (diffuse / 3.14159 + spec) * ndl * vec3f(3.0);
  c += diffuse * skyColor(n) * 0.35;
  c += fres * skyColor(reflect(-v, n)) * (1.0 - s.rough);
  c += s.emissive;
  c = c / (1.0 + c);
  return vec4f(pow(c, vec3f(1.0 / 2.2)), 1);
}

@vertex fn vsGround(@builtin(vertex_index) vi: u32) -> VOut {
  var o: VOut;
  let q = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(1,1), vec2f(-1,-1), vec2f(1,1), vec2f(-1,1));
  let p = vec3f(q[vi].x * 30.0, 0.0, q[vi].y * 30.0);
  o.pos = u.viewProj * vec4f(p, 1);
  o.world = p;
  o.normal = vec3f(0, 1, 0);
  o.mat = 0u;
  return o;
}

@fragment fn fsGround(i: VOut) -> @location(0) vec4f {
  let g = step(0.97, fract(i.world.x)) + step(0.97, fract(i.world.z));
  let c = mix(vec3f(0.25), vec3f(0.35), clamp(g, 0.0, 1.0));
  return vec4f(c, 1);
}
`;

interface Draw {
  vb: GPUBuffer;
  ib: GPUBuffer;
  count: number;
  ub: GPUBuffer;
  bg: GPUBindGroup;
  model: () => Float32Array;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const name = params.get('design') ?? Object.keys(designs)[0];
  const seed = Number(params.get('seed') ?? 1);
  const view = params.get('view') ?? 'orbit';
  const lights = params.get('lights') === '1' ? 1 : 0;

  const canvas = document.querySelector('canvas')!;
  resizeToCss(canvas);
  const gpu = await initGpu(canvas);
  const {device} = gpu;

  const gen = name === 'person' ? person : designs[name];
  if (!gen)
    throw new Error(
      `unknown design "${name}". Known: ${Object.keys(designs).join(', ')}`,
    );
  const design: VehicleDesign = gen(seed);
  const color = design.palette[
    Number(params.get('color') ?? 0) % design.palette.length
  ] ?? [0.6, 0.05, 0.05];

  const module = createShader(device, 'turntable/shader', shader);
  const bgl = device.createBindGroupLayout({
    label: 'turntable/bgl',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {},
      },
    ],
  });
  const layout = device.createPipelineLayout({
    label: 'turntable/layout',
    bindGroupLayouts: [bgl],
  });
  const depthFormat: GPUTextureFormat = 'depth24plus';
  const pipeline = device.createRenderPipeline({
    label: 'turntable/mesh pipeline',
    layout,
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: 28,
          attributes: [
            {shaderLocation: 0, offset: 0, format: 'float32x3'},
            {shaderLocation: 1, offset: 12, format: 'float32x3'},
            {shaderLocation: 2, offset: 24, format: 'uint32'},
          ],
        },
      ],
    },
    fragment: {module, entryPoint: 'fs', targets: [{format: gpu.format}]},
    primitive: {topology: 'triangle-list', cullMode: 'none'},
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  });
  const groundPipeline = device.createRenderPipeline({
    label: 'turntable/ground pipeline',
    layout,
    vertex: {module, entryPoint: 'vsGround'},
    fragment: {module, entryPoint: 'fsGround', targets: [{format: gpu.format}]},
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  });

  let triangles = 0;
  const makeDraw = (
    label: string,
    mesh: Mesh,
    model: () => Float32Array,
  ): Draw => {
    const nv = mesh.positions.length / 3;
    const data = new ArrayBuffer(nv * 28);
    const f = new Float32Array(data);
    const u32 = new Uint32Array(data);
    for (let i = 0; i < nv; i++) {
      f.set(mesh.positions.slice(i * 3, i * 3 + 3), i * 7);
      f.set(mesh.normals.slice(i * 3, i * 3 + 3), i * 7 + 3);
      u32[i * 7 + 6] = mesh.materials[i];
    }
    const vb = device.createBuffer({
      label: `turntable/${label}/vertices`,
      size: Math.max(28, data.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vb, 0, data);
    const idx = new Uint32Array(mesh.indices);
    const ib = device.createBuffer({
      label: `turntable/${label}/indices`,
      size: Math.max(4, idx.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(ib, 0, idx);
    const ub = device.createBuffer({
      label: `turntable/${label}/uniforms`,
      size: 192,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bg = device.createBindGroup({
      label: `turntable/${label}/bind group`,
      layout: bgl,
      entries: [{binding: 0, resource: {buffer: ub}}],
    });
    triangles += mesh.indices.length / 3;
    return {vb, ib, count: mesh.indices.length, ub, bg, model};
  };

  const identity = mat4.create();
  const draws: Draw[] = [makeDraw('body', design.body, () => identity)];
  let time = 0;
  if (design.wheelMesh) {
    design.wheels.forEach((w, i) => {
      const m = mat4.create();
      draws.push(
        makeDraw(`wheel${i}`, design.wheelMesh!, () => {
          const flip = w.position[0] < 0 ? -1 : 1;
          const spin = time * 2;
          const c = Math.cos(spin),
            s = Math.sin(spin);
          // Rotate about x (spin) then mirror left side by rotating 180 about y.
          mat4.identity(m);
          m[0] = flip;
          m[5] = c;
          m[6] = s * flip;
          m[9] = -s;
          m[10] = c * flip;
          m[8] = 0;
          m[4] = 0;
          m[1] = 0;
          m[2] = 0;
          m[12] = w.position[0];
          m[13] = w.position[1];
          m[14] = w.position[2];
          return m;
        }),
      );
    });
  }
  design.rotors.forEach((r, i) => {
    const m = mat4.create();
    draws.push(
      makeDraw(`rotor${i}`, r.mesh, () => {
        const a = time * 20;
        // Rodrigues rotation about r.axis.
        const [x, y, z] = r.axis;
        const c = Math.cos(a),
          s = Math.sin(a),
          t = 1 - c;
        m.set([
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
          r.position[0],
          r.position[1],
          r.position[2],
          1,
        ]);
        return m;
      }),
    );
  });
  if (design.steeringWheel) {
    const sw = design.steeringWheel;
    const m = mat4.create();
    draws.push(
      makeDraw('steering', sw.mesh, () => {
        const c = Math.cos(sw.tilt),
          s = Math.sin(sw.tilt);
        m.set([
          1,
          0,
          0,
          0,
          0,
          c,
          -s,
          0,
          0,
          s,
          c,
          0,
          sw.position[0],
          sw.position[1],
          sw.position[2],
          1,
        ]);
        return m;
      }),
    );
  }
  const groundUb = device.createBuffer({
    label: 'turntable/ground/uniforms',
    size: 192,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const groundBg = device.createBindGroup({
    label: 'turntable/ground/bind group',
    layout: bgl,
    entries: [{binding: 0, resource: {buffer: groundUb}}],
  });

  const hud = document.getElementById('hud')!;
  hud.textContent = `${design.name} (${design.kind}) ${design.size.map(v => v.toFixed(2)).join(' x ')} m, ${triangles} tris`;
  window.__stats = {
    name: design.name,
    kind: design.kind,
    triangles,
    size: design.size,
  };

  let depth: GPUTexture | null = null;
  const viewProj = mat4.create();
  const proj = mat4.create();
  const viewM = mat4.create();
  const uData = new Float32Array(48);
  let frames = 0;

  const frame = (t: number) => {
    time = t / 1000;
    resizeToCss(canvas);
    if (
      !depth ||
      depth.width !== canvas.width ||
      depth.height !== canvas.height
    ) {
      depth?.destroy();
      depth = device.createTexture({
        label: 'turntable/depth',
        size: [canvas.width, canvas.height],
        format: depthFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    const L = Math.max(
      design.size[2],
      design.size[0] * 2,
      design.size[1] * 1.5,
    );
    const target: Vec3 = [0, design.size[1] * 0.45, 0];
    let eye: Vec3;
    const d = L * 1.25;
    switch (view) {
      case 'front':
        eye = [0, design.size[1] * 0.6, d];
        break;
      case 'rear':
        eye = [0, design.size[1] * 0.6, -d];
        break;
      case 'side':
        eye = [d, design.size[1] * 0.5, 0];
        break;
      case 'top':
        eye = [0.01, d * 1.3, 0];
        break;
      case 'three-quarter':
        eye = [d * 0.7, design.size[1] * 0.9 + 1, d * 0.75];
        break;
      case 'interior': {
        eye = [...design.driverEye];
        target[0] = design.driverEye[0] * 0.3;
        target[1] = design.driverEye[1] - 0.15;
        target[2] = design.driverEye[2] + 3;
        break;
      }
      default: {
        const a = time * 0.4;
        eye = [Math.sin(a) * d, design.size[1] * 0.8 + 1, Math.cos(a) * d];
      }
    }
    const fov = view === 'interior' ? 1.4 : 0.6;
    mat4.perspectiveReverseZ(proj, fov, canvas.width / canvas.height, 0.05);
    // Turntable uses a regular depth range: swap to standard perspective.
    const f = 1 / Math.tan(fov / 2);
    const near = 0.05,
      far = 200;
    proj.fill(0);
    proj[0] = f / (canvas.width / canvas.height);
    proj[5] = f;
    proj[10] = far / (near - far);
    proj[11] = -1;
    proj[14] = (near * far) / (near - far);
    mat4.lookAt(viewM, eye, target, [0, 1, 0]);
    mat4.multiply(viewProj, proj, viewM);

    const writeU = (ub: GPUBuffer, model: Float32Array) => {
      uData.set(viewProj, 0);
      uData.set(model, 16);
      uData.set([...color, 1], 32);
      uData.set([...(design.palette[1] ?? [0.9, 0.9, 0.9]), 1], 36);
      uData.set([...eye, 1], 40);
      uData.set([lights, 0, 0, 0], 44);
      device.queue.writeBuffer(ub, 0, uData);
    };
    for (const dr of draws) writeU(dr.ub, dr.model());
    writeU(groundUb, identity);

    const encoder = device.createCommandEncoder({label: 'turntable/frame'});
    const pass = encoder.beginRenderPass({
      label: 'turntable/pass',
      colorAttachments: [
        {
          view: gpu.context
            .getCurrentTexture()
            .createView({label: 'turntable/swapchain view'}),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0.55, 0.65, 0.8, 1],
        },
      ],
      depthStencilAttachment: {
        view: depth.createView({label: 'turntable/depth view'}),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 1,
      },
    });
    if (view !== 'interior') {
      pass.setPipeline(groundPipeline);
      pass.setBindGroup(0, groundBg);
      pass.draw(6);
    }
    pass.setPipeline(pipeline);
    for (const dr of draws) {
      pass.setBindGroup(0, dr.bg);
      pass.setVertexBuffer(0, dr.vb);
      pass.setIndexBuffer(dr.ib, 'uint32');
      pass.drawIndexed(dr.count);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    if (++frames === 3) window.__ready = true;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch(e =>
  reportError(`[turntable] ${e instanceof Error ? e.stack : e}`),
);
