// Paints the business sign atlas (Japanese shop signs, station boards and
// billboards) with Canvas 2D text, then uploads it as a texture.

import {Rng} from '../math/random.ts';
import {
  ATLAS_SIZE,
  BRAND_WORDS,
  SHOP_WORDS,
  STATION_NAMES,
  signColor,
  signRect,
} from '../city/signs.ts';

const FONT =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", "Meiryo", sans-serif';

function css(c: [number, number, number], k = 1) {
  return `rgb(${Math.round(Math.min(1, c[0] * k) * 255)}, ${Math.round(Math.min(1, c[1] * k) * 255)}, ${Math.round(Math.min(1, c[2] * k) * 255)})`;
}

function paintSign(g: OffscreenCanvasRenderingContext2D, id: number, rng: Rng) {
  const [x, y, w, h] = signRect(id);
  const col = signColor(id);
  const style = rng.int(0, 4);
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  // Background: lit box (bright) or dark panel with neon text.
  const lightBox = style < 2;
  if (lightBox) {
    const grad = g.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, css(col, 1));
    grad.addColorStop(1, css(col, 0.7));
    g.fillStyle = grad;
  } else {
    g.fillStyle = '#0b0b10';
  }
  g.fillRect(x, y, w, h);
  // Border.
  g.strokeStyle = lightBox ? 'rgba(255,255,255,0.85)' : css(col);
  g.lineWidth = Math.max(4, Math.min(w, h) * 0.05);
  g.strokeRect(
    x + g.lineWidth,
    y + g.lineWidth,
    w - g.lineWidth * 2,
    h - g.lineWidth * 2,
  );
  const textCol = lightBox
    ? rng.chance(0.5)
      ? '#ffffff'
      : '#101010'
    : css(col);
  g.fillStyle = textCol;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (!lightBox) {
    g.shadowColor = css(col);
    g.shadowBlur = 18;
  }
  return {x, y, w, h, textCol};
}

export function paintSignAtlas(seed = 1): OffscreenCanvas {
  const canvas = new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  const rng = new Rng(seed);
  // Vertical shop signs: characters stacked top to bottom.
  for (let id = 0; id < 32; id++) {
    const {x, y, w, h} = paintSign(g, id, rng);
    const word = SHOP_WORDS[(id * 5 + 3) % SHOP_WORDS.length];
    const chars = [...word].slice(0, 6);
    const size = Math.min(w * 0.72, (h * 0.86) / chars.length);
    g.font = `bold ${size}px ${FONT}`;
    chars.forEach((ch, i) => {
      g.fillText(
        ch,
        x + w / 2,
        y +
          h * 0.07 +
          size * (i + 0.5) * 1.02 +
          (h * 0.86 - size * chars.length) / 2,
      );
    });
    g.restore();
  }
  // Horizontal shop signs.
  for (let id = 32; id < 44; id++) {
    const {x, y, w, h} = paintSign(g, id, rng);
    const word = SHOP_WORDS[(id * 7 + 1) % SHOP_WORDS.length];
    const size = Math.min(h * 0.6, (w * 0.85) / Math.max(2, [...word].length));
    g.font = `bold ${size}px ${FONT}`;
    g.fillText(word, x + w / 2, y + h / 2);
    g.restore();
  }
  // Station name boards: white with a green line stripe (JR-style).
  for (let k = 0; k < 4; k++) {
    const [x, y, w, h] = signRect(44 + k);
    g.fillStyle = '#f2f2f2';
    g.fillRect(x, y, w, h);
    g.fillStyle = ['#2e9b3a', '#e4501e', '#1f6fd1', '#9a3fb4'][k];
    g.fillRect(x, y + h * 0.72, w, h * 0.14);
    g.fillStyle = '#111';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${h * 0.45}px ${FONT}`;
    g.fillText(
      STATION_NAMES[(k * 3) % STATION_NAMES.length],
      x + w / 2,
      y + h * 0.38,
    );
  }
  // Billboards: gradients, shapes and brand names.
  for (let k = 0; k < 8; k++) {
    const id = 48 + k;
    const [x, y, w, h] = signRect(id);
    const c1 = signColor(id + 3);
    const c2 = signColor(id + 6);
    const grad = g.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, css(c1, 0.9));
    grad.addColorStop(1, css(c2, 0.5));
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
    g.globalAlpha = 0.35;
    for (let s = 0; s < 6; s++) {
      g.fillStyle = s % 2 ? '#fff' : css(c2);
      g.beginPath();
      g.arc(
        x + rng.range(0, w),
        y + rng.range(0, h),
        rng.range(20, 120),
        0,
        Math.PI * 2,
      );
      g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.font = `900 ${h * 0.3}px ${FONT}`;
    g.fillText(BRAND_WORDS[k % BRAND_WORDS.length], x + w * 0.06, y + h * 0.48);
    g.font = `bold ${h * 0.14}px ${FONT}`;
    g.fillText(
      SHOP_WORDS[(k * 11) % SHOP_WORDS.length] +
        ' ' +
        SHOP_WORDS[(k * 13 + 2) % SHOP_WORDS.length],
      x + w * 0.06,
      y + h * 0.75,
    );
  }
  return canvas;
}

export function createSignAtlasTexture(device: GPUDevice): GPUTexture {
  const canvas = paintSignAtlas();
  const tex = device.createTexture({
    label: 'signs/atlas',
    size: [ATLAS_SIZE, ATLAS_SIZE],
    format: 'rgba8unorm-srgb',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({source: canvas}, {texture: tex}, [
    ATLAS_SIZE,
    ATLAS_SIZE,
  ]);
  return tex;
}

/** Leaf cluster texture for tree cards: grey leaves (tinted in the shader) with alpha. */
export function createLeafTexture(device: GPUDevice): GPUTexture {
  const size = 256;
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d')!;
  const rng = new Rng(99);
  g.clearRect(0, 0, size, size);
  for (let i = 0; i < 260; i++) {
    const r = Math.hypot(rng.range(-1, 1), rng.range(-1, 1));
    const a = rng.range(0, Math.PI * 2);
    const d = Math.sqrt(rng.next()) * size * 0.46;
    const x = size / 2 + Math.cos(a) * d;
    const y = size / 2 + Math.sin(a) * d;
    const v = Math.round(rng.range(90, 255));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.beginPath();
    g.ellipse(
      x,
      y,
      rng.range(5, 11),
      rng.range(2.5, 5),
      rng.range(0, Math.PI),
      0,
      Math.PI * 2,
    );
    g.fill();
    void r;
  }
  const tex = device.createTexture({
    label: 'trees/leaf cards',
    size: [size, size],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({source: canvas}, {texture: tex}, [
    size,
    size,
  ]);
  return tex;
}
