// Generated textures off the main thread: the sign atlas (2D canvas text) and
// the surface detail layers took about a second of main-thread time at
// startup, before the loading screen could update.

import {detailLevels} from '../render/detail-tex.ts';
import {signAtlasLevels} from '../render/sign-atlas.ts';

export interface TextureResult {
  sign: Uint8ClampedArray[];
  detail: Uint8Array[][];
  /** Absolute start / end times per texture (startup timeline). */
  spans: [string, number, number][];
}

const abs = () => performance.timeOrigin + performance.now();

self.onmessage = () => {
  const t0 = abs();
  const sign = signAtlasLevels();
  const t1 = abs();
  const detail = detailLevels();
  const t2 = abs();
  const msg: TextureResult = {
    sign,
    detail,
    spans: [
      ['sign atlas', t0, t1],
      ['detail layers', t1, t2],
    ],
  };
  (self as unknown as Worker).postMessage(msg, [
    ...sign.map(d => d.buffer),
    ...detail.flat().map(d => d.buffer),
  ]);
};
