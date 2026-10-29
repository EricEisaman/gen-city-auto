// Terrain heightfield: rolling uplands cut by river valleys, flat bayside
// lowlands, and sea below 0 m. Roads later flatten the field along their paths.

import {Noise2D} from '../math/noise.ts';
import {Rng} from '../math/random.ts';
import {clamp, lerp, pointSegment, smoothstep, type Vec2} from '../math/vec.ts';
import type {CityParams} from './config.ts';

export const SEA_LEVEL = 0;

export class Heightfield {
  readonly n: number;
  readonly data: Float32Array;
  readonly size: number;
  readonly cell: number;

  constructor(size: number, cell: number, data?: Float32Array) {
    this.size = size;
    this.cell = cell;
    this.n = Math.round(size / cell) + 1;
    this.data = data ?? new Float32Array(this.n * this.n);
  }

  /** Grid coordinate of world x/z. */
  toGrid(x: number) {
    return (x + this.size / 2) / this.cell;
  }

  get(i: number, j: number) {
    const n = this.n;
    i = i < 0 ? 0 : i >= n ? n - 1 : i;
    j = j < 0 ? 0 : j >= n ? n - 1 : j;
    return this.data[j * n + i];
  }

  /** Bilinear height at world (x, z). */
  sample(x: number, z: number) {
    const gx = this.toGrid(x);
    const gz = this.toGrid(z);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const a = this.get(i, j);
    const b = this.get(i + 1, j);
    const c = this.get(i, j + 1);
    const d = this.get(i + 1, j + 1);
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
  }

  normal(x: number, z: number): [number, number, number] {
    const e = this.cell;
    const dx = this.sample(x + e, z) - this.sample(x - e, z);
    const dz = this.sample(x, z + e) - this.sample(x, z - e);
    const l = Math.hypot(dx, 2 * e, dz);
    return [-dx / l, (2 * e) / l, -dz / l];
  }
}

export interface Terrain {
  heights: Heightfield;
  rivers: Vec2[][];
  /** Approximate coastline distance function input: +1 land, -1 sea. */
  center: Vec2;
}

/** Signed "landness" for the sea layout: < 0 is sea. */
function seaField(p: CityParams, noise: Noise2D, x: number, z: number) {
  const S = p.size / 2;
  const wob = noise.fbm(x / 900, z / 900, 4) * 260 + noise.fbm(x / 230, z / 230, 3) * 60;
  switch (p.sea.side) {
    case 'south':
      return S * (1 - 2 * p.sea.extent) - z + wob;
    case 'east':
      return S * (1 - 2 * p.sea.extent) - x + wob;
    case 'harbour': {
      // A strait running east-west a little south of center.
      const c = S * 0.25 + noise.fbm(x / 1500, 3.7, 3) * 250;
      return Math.abs(z - c) - p.sea.extent * S * 0.9 + wob * 0.6;
    }
    default:
      return 1e6;
  }
}

function makeRiver(rng: Rng, noise: Noise2D, p: CityParams, k: number): Vec2[] {
  const S = p.size / 2;
  // Rivers start on the north/west edge and flow toward the sea side.
  const pts: Vec2[] = [];
  let x: number, z: number, dx: number, dz: number;
  if (p.sea.side === 'east') {
    x = -S;
    z = rng.range(-S * 0.6, S * 0.6);
    dx = 1;
    dz = 0;
  } else if (p.sea.side === 'none' && k === 1) {
    x = rng.range(-S * 0.5, S * 0.5);
    z = -S;
    dx = 0;
    dz = 1;
  } else {
    x = rng.range(-S * 0.7, S * 0.7) * (k === 0 ? 0.6 : 1);
    z = -S;
    dx = 0;
    dz = 1;
  }
  if (p.sea.side === 'none' && k === 0) {
    x = -S;
    z = rng.range(-S * 0.3, S * 0.3);
    dx = 1;
    dz = 0;
  }
  const step = 40;
  let heading = Math.atan2(dz, dx);
  const base = heading;
  for (let i = 0; i < 1000; i++) {
    pts.push([x, z]);
    const wiggle = noise.noise(i * 0.02 + k * 17, k * 3.1) * 0.9;
    heading = base + wiggle;
    x += Math.cos(heading) * step;
    z += Math.sin(heading) * step;
    if (Math.abs(x) > S + 200 || Math.abs(z) > S + 200) break;
  }
  return pts;
}

export function generateTerrain(p: CityParams, seed: number): Terrain {
  const rng = new Rng(seed ^ 0x7e44a1);
  const noise = new Noise2D(seed);
  const noise2 = new Noise2D(seed + 101);
  const hf = new Heightfield(p.size, p.cell);
  const n = hf.n;
  const S = p.size / 2;

  const rivers: Vec2[][] = [];
  for (let k = 0; k < p.rivers; k++) rivers.push(makeRiver(rng, noise2, p, k));

  // Distance-to-river lookup on a coarse grid to keep generation fast.
  const coarse = 16;
  const cn = Math.ceil(p.size / coarse) + 1;
  const riverDist = new Float32Array(cn * cn).fill(1e9);
  for (let j = 0; j < cn; j++) {
    for (let i = 0; i < cn; i++) {
      const q: Vec2 = [-S + i * coarse, -S + j * coarse];
      let best = 1e9;
      for (const r of rivers) {
        for (let s = 0; s + 1 < r.length; s++) {
          const a = r[s];
          if (Math.abs(a[0] - q[0]) > 900 || Math.abs(a[1] - q[1]) > 900) continue;
          best = Math.min(best, pointSegment(q, a, r[s + 1])[0]);
        }
      }
      riverDist[j * cn + i] = best;
    }
  }
  const riverAt = (x: number, z: number) => {
    const gx = clamp((x + S) / coarse, 0, cn - 1.001);
    const gz = clamp((z + S) / coarse, 0, cn - 1.001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const r = (a: number, b: number) => riverDist[b * cn + a];
    return lerp(lerp(r(i, j), r(i + 1, j), fx), lerp(r(i, j + 1), r(i + 1, j + 1), fx), fz);
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -S + i * p.cell;
      const z = -S + j * p.cell;
      // Uplands: broad plateaus with rounded hills and some sharper ridges.
      const broad = noise.fbm(x / p.hillScale, z / p.hillScale, 5, 2, 0.5);
      const hills = noise.fbm(x / (p.hillScale * 0.35), z / (p.hillScale * 0.35), 4, 2, 0.5);
      const ridges = noise.ridge(x / (p.hillScale * 0.8) + 3.3, z / (p.hillScale * 0.8) - 1.7, 4);
      let h = p.relief * (0.45 + 0.4 * broad + 0.25 * hills + 0.35 * (ridges - 0.35));
      // Terrace the uplands a little (plateau look).
      const terr = Math.floor(h / 12) * 12;
      h = lerp(h, terr + smoothstep(0, 1, (h - terr) / 12) * 12, 0.35);

      // Lowlands near the sea are flat (reclaimed land / shitamachi).
      const land = seaField(p, noise, x, z);
      const lowland = smoothstep(0, 1300, land);
      h = lerp(2.5 + noise.fbm(x / 400, z / 400, 2) * 1.5, h, lowland);

      // River valleys: wide gentle valleys with a channel below sea level.
      const rd = riverAt(x, z);
      const channel = 38 + noise.noise(x / 500, z / 500) * 10;
      if (rd < 600) {
        const valley = smoothstep(channel, 600, rd);
        h = lerp(Math.min(h, 3), h, valley * valley);
      }
      if (rd < channel) h = lerp(-4, 2, smoothstep(channel * 0.6, channel, rd));
      else if (rd < channel + 6) h = Math.min(h, 2);

      // Sea: embankment then seabed.
      if (land < 0) h = Math.max(-18, -2 + land * 0.05);
      else if (land < 30) h = Math.min(h, lerp(-2, 2.5, land / 30));

      // Map edges fall away so the world has a soft boundary.
      const edge = Math.max(Math.abs(x), Math.abs(z));
      if (edge > S - 150) h = lerp(h, Math.min(h, h * 0.5 - 5), smoothstep(S - 150, S, edge));

      hf.data[j * n + i] = h;
    }
  }
  return {heights: hf, rivers, center: [0, -S * 0.15]};
}

/** True when the point is under water. */
export const isWater = (hf: Heightfield, x: number, z: number) => hf.sample(x, z) < SEA_LEVEL + 0.3;
