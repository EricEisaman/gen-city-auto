// Rain streak particles drawn in the forward pass.

import {createShader} from '../gpu/device.ts';
import commonWgsl from '../shaders/common.wgsl';
import rainWgsl from '../shaders/rain.wgsl';
import type {DrawHook} from './renderer.ts';

export class RainRenderer implements DrawHook {
  readonly name = 'rain';
  intensity = 0;
  /** Particle count multiplier (graphics setting). */
  density = 1;
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;

  constructor(
    device: GPUDevice,
    frameBuffer: GPUBuffer,
    format: GPUTextureFormat,
  ) {
    const module = createShader(
      device,
      'shader/rain',
      commonWgsl + '\n' + rainWgsl,
    );
    this.pipeline = device.createRenderPipeline({
      label: 'pipeline/rain',
      layout: 'auto',
      vertex: {module, entryPoint: 'vs'},
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
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
    this.bindGroup = device.createBindGroup({
      label: 'bg/rain',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{binding: 0, resource: {buffer: frameBuffer}}],
    });
  }

  forward(pass: GPURenderPassEncoder) {
    const n = Math.floor(this.intensity * 26000 * this.density);
    if (n <= 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6, n);
  }
}
