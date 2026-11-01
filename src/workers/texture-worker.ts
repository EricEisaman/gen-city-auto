// Generated textures off the main thread: the sign atlas (2D canvas text) and
// the surface detail layers took about a second of main-thread time at
// startup, before the loading screen could update.

import type {SignLocale} from '../city/signs.ts';
import {detailLevels} from '../render/detail-tex.ts';
import {signAtlasLevels} from '../render/sign-atlas.ts';

export interface TextureRequest {
  /** Sign locale to paint the atlas in (the city's, signLocaleOf). */
  locale: SignLocale;
  /** Paint the detail layers too (only the first request needs them). */
  detail: boolean;
}

export interface TextureResult {
  locale: SignLocale;
  sign: Uint8ClampedArray[];
  detail: Uint8Array[][] | null;
  /** Absolute start / end times per texture (startup timeline). */
  spans: [string, number, number][];
}

const abs = () => performance.timeOrigin + performance.now();

self.onmessage = (e: MessageEvent<TextureRequest>) => {
  const {locale} = e.data;
  const t0 = abs();
  const sign = signAtlasLevels(locale);
  const t1 = abs();
  const detail = e.data.detail ? detailLevels() : null;
  const t2 = abs();
  const msg: TextureResult = {
    locale,
    sign,
    detail,
    spans: detail
      ? [
          ['sign atlas', t0, t1],
          ['detail layers', t1, t2],
        ]
      : [['sign atlas', t0, t1]],
  };
  (self as unknown as Worker).postMessage(msg, [
    ...sign.map(d => d.buffer),
    ...(detail ?? []).flat().map(d => d.buffer),
  ]);
};
