// Skyline map for street-canyon sky visibility and the city reflection
// (lighting.wgsl skyH). Built in the primary city worker.

import type {Building} from './layout.ts';
import type {Heightfield} from './terrain.ts';

export const SKYLINE_N = 2048;
/** Bare-terrain offset in the skyline map (lighting.wgsl SKYLINE_TERRAIN). */
const SKYLINE_TERRAIN = 10000;

/**
 * Max of terrain and building tops on a 2048^2 grid (street-canyon sky
 * visibility, the city reflection). Cells that are bare terrain store
 * -(h + SKYLINE_TERRAIN) (lighting.wgsl skyH decodes), so the reflection
 * can tell a hillside from a facade: it drew every rise of the ground as
 * a building with lit windows (bright bars along the horizon in wet
 * night views of the asset lab, which has no buildings).
 */
export function buildSkyline(
  buildings: readonly Building[],
  heights: Heightfield,
  size: number,
): Float32Array {
  const N = SKYLINE_N;
  const cell = size / N;
  const out = new Float32Array(N * N);
  const built = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      out[j * N + i] = heights.sample(
        -size / 2 + (i + 0.5) * cell,
        -size / 2 + (j + 0.5) * cell,
      );
    }
  }
  for (const b of buildings) {
    const fp = b.footprint;
    let x0 = Infinity,
      x1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const q of fp) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      z0 = Math.min(z0, q[1]);
      z1 = Math.max(z1, q[1]);
    }
    const top = b.base + b.height;
    const i0 = Math.max(0, Math.floor((x0 + size / 2) / cell));
    const i1 = Math.min(N - 1, Math.floor((x1 + size / 2) / cell));
    const j0 = Math.max(0, Math.floor((z0 + size / 2) / cell));
    const j1 = Math.min(N - 1, Math.floor((z1 + size / 2) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = -size / 2 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const x = -size / 2 + (i + 0.5) * cell;
        let inside = false;
        for (let a = 0, c = fp.length - 1; a < fp.length; c = a++) {
          if (
            fp[a][1] > z !== fp[c][1] > z &&
            x <
              ((fp[c][0] - fp[a][0]) * (z - fp[a][1])) / (fp[c][1] - fp[a][1]) +
                fp[a][0]
          )
            inside = !inside;
        }
        if (inside && top > out[j * N + i]) {
          out[j * N + i] = top;
          built[j * N + i] = 1;
        }
      }
    }
  }
  for (let k = 0; k < N * N; k++)
    if (!built[k]) out[k] = -(out[k] + SKYLINE_TERRAIN);
  return out;
}
