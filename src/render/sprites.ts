// Distant night light sprites (street lamps, far traffic) in the forward pass.

import {createShader} from '../gpu/device.ts';
import commonWgsl from '../shaders/common.wgsl';
import spritesWgsl from '../shaders/sprites.wgsl';
import type {DrawHook} from './renderer.ts';

const CARS_PER_SEG = 4;

export class LightSprites implements DrawHook {
  private device: GPUDevice;
  private cars: GPURenderPipeline;
  private lampsPipe: GPURenderPipeline;
  private frameBuffer: GPUBuffer;
  private bindGroups: GPUBindGroup[] = [];
  private buffers: GPUBuffer[] = [];
  private segCount = 0;
  private lampCount = 0;

  constructor(
    device: GPUDevice,
    frameBuffer: GPUBuffer,
    format: GPUTextureFormat,
  ) {
    this.device = device;
    this.frameBuffer = frameBuffer;
    const module = createShader(
      device,
      'shader/sprites',
      commonWgsl + '\n' + spritesWgsl,
    );
    const make = (entryPoint: string) =>
      device.createRenderPipeline({
        label: `pipeline/sprites ${entryPoint}`,
        layout: 'auto',
        vertex: {module, entryPoint},
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format,
              blend: {
                color: {srcFactor: 'one', dstFactor: 'one'},
                alpha: {srcFactor: 'zero', dstFactor: 'one'},
              },
            },
          ],
        },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: false,
          depthCompare: 'greater',
        },
      });
    this.cars = make('vsCars');
    this.lampsPipe = make('vsLamps');
  }

  /** segs: 8 floats per lane segment; lamps: 4 floats per lamp head. */
  setData(segs: Float32Array, lamps: Float32Array) {
    for (const b of this.buffers) b.destroy();
    const buf = (label: string, data: Float32Array) => {
      const b = this.device.createBuffer({
        label,
        size: Math.max(16, data.byteLength),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const s = buf(
      'sprites/lane segments',
      segs.length ? segs : new Float32Array(8),
    );
    const l = buf('sprites/lamps', lamps.length ? lamps : new Float32Array(4));
    this.buffers = [s, l];
    this.segCount = segs.length / 8;
    this.lampCount = lamps.length / 4;
    this.bindGroups = [this.cars, this.lampsPipe].map((p, i) =>
      this.device.createBindGroup({
        label: `bg/sprites ${i ? 'lamps' : 'cars'}`,
        layout: p.getBindGroupLayout(0),
        entries: [
          {binding: 0, resource: {buffer: this.frameBuffer}},
          {binding: 1, resource: {buffer: s}},
          {binding: 2, resource: {buffer: l}},
        ],
      }),
    );
  }

  forward(pass: GPURenderPassEncoder) {
    if (!this.bindGroups.length) return;
    if (this.segCount) {
      pass.setPipeline(this.cars);
      pass.setBindGroup(0, this.bindGroups[0]);
      pass.draw(6, this.segCount * CARS_PER_SEG);
    }
    if (this.lampCount) {
      pass.setPipeline(this.lampsPipe);
      pass.setBindGroup(0, this.bindGroups[1]);
      pass.draw(6, this.lampCount);
    }
  }
}
