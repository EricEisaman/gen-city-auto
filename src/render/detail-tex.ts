// Tileable surface detail textures generated at startup: one 512x512 layer
// per material with a full mip chain. Channels: RG = tangent-space normal XY,
// B = albedo multiplier (0.5 = unchanged), A = cavity (1 = exposed, 0 = deep).
import {Rng} from '../math/random.ts';

const N = 512;

/** Layer indices (match DETAIL_* in city-materials.wgsl). */
export const DETAIL = {
  asphalt: 0,
  pavers: 1,
  concrete: 2,
  tile: 3,
  ballast: 4,
} as const;

interface Layer {
  h: Float32Array;
  a: Float32Array;
  /** Normal strength (height units per pixel). */
  bump: number;
}

const idx = (x: number, y: number) =>
  (((y % N) + N) % N) * N + (((x % N) + N) % N);

/** Periodic value noise with `cells` lattice cells across the tile. */
function noise(cells: number, seed: number) {
  const rng = new Rng(seed);
  const g = Float32Array.from({length: cells * cells}, () => rng.next());
  const at = (i: number, j: number) =>
    g[
      (((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)
    ];
  return (x: number, y: number) => {
    const fx = (x / N) * cells;
    const fy = (y / N) * cells;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const su = u * u * (3 - 2 * u);
    const sv = v * v * (3 - 2 * v);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * su;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * su;
    return a + (b - a) * sv;
  };
}

function fbm(octaves: [number, number][], seed: number) {
  const ns = octaves.map(([c], k) => noise(c, seed + k * 101));
  return (x: number, y: number) =>
    ns.reduce((s, f, k) => s + f(x, y) * octaves[k][1], 0);
}

function layer(): Layer {
  return {
    h: new Float32Array(N * N),
    a: new Float32Array(N * N).fill(0.5),
    bump: 1,
  };
}

/** Rounded stones scattered with wrap-around; max-blended into the height. */
function stones(
  L: Layer,
  rng: Rng,
  count: number,
  r0: number,
  r1: number,
  tone: () => number,
  lift: number,
  angular = false,
) {
  for (let i = 0; i < count; i++) {
    const cx = rng.range(0, N);
    const cy = rng.range(0, N);
    const r = rng.range(r0, r1);
    // Slightly elongated, rotated ellipse.
    const ang = rng.range(0, Math.PI);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const sq = rng.range(0.6, 1);
    const t = tone();
    const top = lift + r * 0.5;
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const u = (dx * ca + dy * sa) / r;
        const v = (-dx * sa + dy * ca) / (r * sq);
        const d2 = u * u + v * v;
        if (d2 >= 1) continue;
        // Angular (crushed rock): an octagonal pyramid with a flattened
        // crown, so the stones get facets and crisp ridges, not domes.
        const m = Math.max(
          Math.abs(u),
          Math.abs(v),
          (Math.abs(u) + Math.abs(v)) * 0.72,
        );
        if (angular && m >= 1) continue;
        const h = angular
          ? top * Math.min(1, (1 - m) * 1.8)
          : top * Math.sqrt(1 - d2);
        const k = idx(Math.round(cx) + dx, Math.round(cy) + dy);
        if (h > L.h[k]) {
          L.h[k] = h;
          L.a[k] = t;
        }
      }
    }
  }
}

function asphalt(): Layer {
  const L = layer();
  const rng = new Rng(11);
  const fine = fbm(
    [
      [128, 0.6],
      [64, 0.4],
    ],
    3,
  );
  for (let k = 0; k < N * N; k++) {
    L.h[k] = fine(k % N, (k / N) | 0) * 0.8;
    L.a[k] = 0.36;
  }
  // Mostly dark aggregate with a few pale chips, 3-10 mm: read by relief,
  // not speckle.
  stones(
    L,
    rng,
    9000,
    1.4,
    4.5,
    () => (rng.next() < 0.07 ? rng.range(0.6, 0.78) : rng.range(0.44, 0.56)),
    0.6,
  );
  // Small dark pits between the chips.
  for (let i = 0; i < 1500; i++) {
    const cx = rng.range(0, N);
    const cy = rng.range(0, N);
    const r = rng.range(0.8, 1.6);
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const d2 = (dx * dx + dy * dy) / (r * r);
        if (d2 >= 1) continue;
        const k = idx(Math.round(cx) + dx, Math.round(cy) + dy);
        L.h[k] -= 0.6 * (1 - d2);
        L.a[k] = 0.15;
      }
  }
  L.bump = 0.5;
  return L;
}

function pavers(): Layer {
  // Running bond 200 x 100 mm blocks over 1.2 m: 85 x 43 px.
  const L = layer();
  const rng = new Rng(21);
  const fine = fbm(
    [
      [96, 0.5],
      [32, 0.5],
    ],
    5,
  );
  const bw = N / 6;
  const bh = N / 12;
  const tones = Float32Array.from({length: 6 * 12}, () =>
    rng.range(0.45, 0.55),
  );
  const tilt = Float32Array.from({length: 6 * 12 * 2}, () => rng.range(-1, 1));
  for (let y = 0; y < N; y++) {
    const row = Math.floor(y / bh);
    const off = row % 2 ? bw / 2 : 0;
    for (let x = 0; x < N; x++) {
      const xs = (x + off) % N;
      const col = Math.floor(xs / bw);
      const fx = xs - col * bw;
      const fy = y - row * bh;
      const edge = Math.min(fx, bw - fx, fy, bh - fy);
      const bevel = Math.min(1, Math.max(0, (edge - 1) / 4));
      const id = row * 6 + col;
      const k = idx(x, y);
      L.h[k] =
        bevel *
          (6 +
            tilt[id * 2] * (fx / bw - 0.5) * 2 +
            tilt[id * 2 + 1] * (fy / bh - 0.5) * 2) +
        fine(x, y) * 0.8;
      L.a[k] = edge < 1.5 ? 0.2 : tones[id] * (0.85 + 0.3 * fine(x * 3, y * 3));
    }
  }
  L.bump = 0.5;
  return L;
}

function concrete(): Layer {
  const L = layer();
  const rng = new Rng(31);
  const blot = fbm(
    [
      [4, 0.5],
      [8, 0.3],
      [32, 0.2],
    ],
    7,
  );
  const fine = fbm(
    [
      [128, 0.7],
      [256, 0.3],
    ],
    9,
  );
  for (let k = 0; k < N * N; k++) {
    const x = k % N;
    const y = (k / N) | 0;
    L.h[k] = fine(x, y) * 0.6;
    L.a[k] = 0.32 + blot(x, y) * 0.3 + (fine(x, y) - 0.5) * 0.08;
  }
  // Air-bubble pores.
  for (let i = 0; i < 2500; i++) {
    const cx = Math.floor(rng.range(0, N));
    const cy = Math.floor(rng.range(0, N));
    const r = rng.range(0.6, 2);
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy) / r;
        if (d >= 1) continue;
        const k = idx(cx + dx, cy + dy);
        L.h[k] -= (1 - d) * 1.5;
        L.a[k] *= 0.6 + 0.4 * d;
      }
  }
  L.bump = 0.4;
  return L;
}

function tile(): Layer {
  // Japanese "nichokake" facade tiles: 4 across x 14 rows per 0.96 m tile
  // (240 x 69 mm pitch), half-bond, recessed grout.
  const L = layer();
  const rng = new Rng(41);
  const fine = fbm(
    [
      [64, 0.6],
      [256, 0.4],
    ],
    13,
  );
  const tw = N / 4;
  const th = N / 14;
  const tones = Float32Array.from({length: 4 * 14}, () =>
    rng.range(0.34, 0.66),
  );
  for (let y = 0; y < N; y++) {
    const row = Math.floor(y / th);
    const off = row % 2 ? tw / 2 : 0;
    for (let x = 0; x < N; x++) {
      const xs = (x + off) % N;
      const col = Math.floor(xs / tw);
      const fx = xs - col * tw;
      const fy = y - row * th;
      const edge = Math.min(fx, tw - fx, fy, th - fy);
      const k = idx(x, y);
      const face = Math.min(1, Math.max(0, (edge - 2.5) / 1.5));
      // Glazed face with a slight pillowing toward the edges.
      L.h[k] = face * (6 + Math.min(edge, 8) * 0.15) + fine(x, y) * 0.25;
      L.a[k] =
        face < 0.5 ? 0.3 : tones[row * 4 + col] * (0.92 + 0.16 * fine(x, y));
    }
  }
  L.bump = 0.6;
  return L;
}

function ballast(): Layer {
  const L = layer();
  const rng = new Rng(51);
  for (let k = 0; k < N * N; k++) L.a[k] = 0.15;
  // Crushed granite: angular, higher contrast, a fifth of the stones dark.
  // (The rust-tinted ones are tinted in the shader: this channel is grey.)
  const tone = () => {
    const r = rng.next();
    return r < 0.2 ? rng.range(0.22, 0.3) : rng.range(0.4, 0.78);
  };
  for (let pass = 0; pass < 3; pass++)
    stones(L, rng, 2600, 5, 12, tone, pass * 2, true);
  L.bump = 0.45;
  return L;
}

function encode(L: Layer): Uint8Array {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const k = idx(x, y);
      const dx = (L.h[idx(x + 1, y)] - L.h[idx(x - 1, y)]) * 0.5 * L.bump;
      const dy = (L.h[idx(x, y + 1)] - L.h[idx(x, y - 1)]) * 0.5 * L.bump;
      const inv = 1 / Math.hypot(dx, dy, 1);
      // Cavity: how far below the local 5x5 average height.
      let avg = 0;
      for (let j = -2; j <= 2; j++)
        for (let i = -2; i <= 2; i++) avg += L.h[idx(x + i, y + j)];
      avg /= 25;
      const cav = Math.min(1, Math.max(0, 1 + (L.h[k] - avg) * 0.25));
      out[k * 4] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      out[k * 4 + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      out[k * 4 + 2] = Math.round(Math.min(1, Math.max(0, L.a[k])) * 255);
      out[k * 4 + 3] = Math.round(cav * 255);
    }
  }
  return out;
}

function downsample(src: Uint8Array, s: number): Uint8Array {
  const h = s >> 1;
  const out = new Uint8Array(h * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < h; x++)
      for (let c = 0; c < 4; c++) {
        const p = (yy: number, xx: number) => src[(yy * s + xx) * 4 + c];
        out[(y * h + x) * 4 + c] = Math.round(
          (p(2 * y, 2 * x) +
            p(2 * y, 2 * x + 1) +
            p(2 * y + 1, 2 * x) +
            p(2 * y + 1, 2 * x + 1)) /
            4,
        );
      }
  return out;
}

export function createDetailTexture(device: GPUDevice): GPUTexture {
  const layers = [asphalt(), pavers(), concrete(), tile(), ballast()];
  const levels = Math.log2(N) + 1;
  const tex = device.createTexture({
    label: 'materials/detail layers',
    size: [N, N, layers.length],
    format: 'rgba8unorm',
    mipLevelCount: levels,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  layers.forEach((L, z) => {
    let data = encode(L);
    for (let l = 0; l < levels; l++) {
      const s = N >> l;
      if (l > 0) data = downsample(data, s * 2);
      device.queue.writeTexture(
        {texture: tex, mipLevel: l, origin: [0, 0, z]},
        data,
        {bytesPerRow: s * 4, rowsPerImage: s},
        [s, s, 1],
      );
    }
  });
  return tex;
}
