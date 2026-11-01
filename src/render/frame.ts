// CPU mirror of the WGSL `Frame` uniform struct (see shaders/common.wgsl).

export const FRAME_FLOATS = 220;

export const F = {
  viewProj: 0,
  invViewProj: 16,
  prevViewProj: 32,
  view: 48,
  proj: 64,
  camPos: 80,
  sunDir: 84,
  sunColor: 88,
  moonDir: 92,
  resolution: 96,
  jitter: 100,
  time: 104,
  weather: 108,
  wind: 112,
  world: 116,
  cascadeSplits: 120,
  cascades: 124,
  exposure: 188,
  skyAmbient: 192,
  groundAmbient: 196,
  cityGlow: 200,
  misc: 204,
  off: 208,
  upscale: 212,
  extra: 216,
} as const;

export class FrameData {
  readonly f = new Float32Array(FRAME_FLOATS);

  set(offset: number, values: ArrayLike<number>) {
    this.f.set(values, offset);
  }
}
