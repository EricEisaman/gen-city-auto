// Paints the business sign atlas (Japanese shop signs, station boards and
// billboards) with Canvas 2D text, then uploads it as a texture.

import {Rng} from '../math/random.ts';
import {
  ATLAS_H,
  ATLAS_W,
  BRAND_WORDS,
  HORIZONTAL_WORDS,
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
  const canvas = new OffscreenCanvas(ATLAS_W, ATLAS_H);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS_W, ATLAS_H);
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
    const word = HORIZONTAL_WORDS[id - 32];
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
  // Square cube signs (projecting light boxes): one or two big glyphs, in a
  // circle or a plain square, or a short Latin word.
  const SQUARE_TEXT = [
    'P',
    '24H',
    'BAR',
    '酒',
    '湯',
    '薬',
    '寿司',
    '質',
    '茶',
    'ATM',
    '肉',
    '鮨',
    'NEW',
    '麺',
    '占',
    'OPEN',
  ];
  for (let k = 0; k < 16; k++) {
    const id = 72 + k;
    const {x, y, w, h, textCol} = paintSign(g, id, rng);
    const text = SQUARE_TEXT[k];
    const n = [...text].length;
    if (k % 3 === 0) {
      // Disc logo.
      g.shadowBlur = 0;
      g.beginPath();
      g.arc(x + w / 2, y + h / 2, w * 0.36, 0, Math.PI * 2);
      g.fillStyle = textCol;
      g.fill();
      g.fillStyle =
        textCol === '#ffffff' || textCol === '#101010'
          ? css(signColor(id), 0.6)
          : '#0b0b10';
    }
    const size =
      n === 1 ? h * 0.62 : n === 2 ? h * 0.4 : (w * 0.8) / (n * 0.62);
    g.font = `bold ${size}px ${FONT}`;
    if (n === 2 && /[^ -~]/.test(text)) {
      // Two kanji stacked, as on a corner light box.
      [...text].forEach((ch, i) =>
        g.fillText(ch, x + w / 2, y + h * (0.3 + i * 0.4)),
      );
    } else {
      g.fillText(text, x + w / 2, y + h / 2 + size * 0.04);
    }
    g.restore();
  }
  return canvas;
}

export function createSignAtlasTexture(device: GPUDevice): GPUTexture {
  const canvas = paintSignAtlas();
  // Mipmapped so distant sign text filters instead of shimmering (the
  // shader clamps the level so neighbouring signs never bleed in).
  const levels = 5;
  const tex = device.createTexture({
    label: 'signs/atlas',
    size: [ATLAS_W, ATLAS_H],
    format: 'rgba8unorm-srgb',
    mipLevelCount: levels,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  let src: OffscreenCanvas = canvas;
  for (let l = 0; l < levels; l++) {
    const w = ATLAS_W >> l,
      h = ATLAS_H >> l;
    if (l > 0) {
      const c = new OffscreenCanvas(w, h);
      const cg = c.getContext('2d')!;
      cg.imageSmoothingQuality = 'high';
      cg.drawImage(src, 0, 0, w, h);
      src = c;
    }
    device.queue.copyExternalImageToTexture(
      {source: src},
      {texture: tex, mipLevel: l},
      [w, h],
    );
  }
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
  // Mip chain with coverage-preserving alpha: averaged alpha drifts toward
  // the mean leaf density, so an alpha test at 0.5 would thin distant crowns
  // out (or fill them in). Scale each level's alpha so the fraction of texels
  // passing 0.5 matches the top level.
  const levels = Math.log2(size) + 1;
  const coverage = (a: Uint8ClampedArray, k: number) => {
    let n = 0;
    for (let i = 3; i < a.length; i += 4) if (a[i] * k >= 127.5) n++;
    return n / (a.length / 4);
  };
  const target = coverage(g.getImageData(0, 0, size, size).data, 1);
  const preserve = (c: OffscreenCanvas, s: number): OffscreenCanvas => {
    const img = c.getContext('2d')!.getImageData(0, 0, s, s);
    const d = img.data;
    let lo = 0.5,
      hi = 8;
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      if (coverage(d, mid) < target) lo = mid;
      else hi = mid;
    }
    const k = (lo + hi) / 2;
    for (let i = 3; i < d.length; i += 4) d[i] = Math.min(255, d[i] * k);
    const out = new OffscreenCanvas(s, s);
    out.getContext('2d')!.putImageData(img, 0, 0);
    return out;
  };
  const tex = device.createTexture({
    label: 'trees/leaf cards',
    size: [size, size],
    format: 'rgba8unorm',
    mipLevelCount: levels,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  let src: OffscreenCanvas = canvas;
  for (let l = 0; l < levels; l++) {
    const s = size >> l;
    if (l > 0) {
      const c = new OffscreenCanvas(s, s);
      const cg = c.getContext('2d')!;
      cg.imageSmoothingQuality = 'high';
      cg.drawImage(src, 0, 0, s, s);
      src = c;
    }
    device.queue.copyExternalImageToTexture(
      {source: l > 0 ? preserve(src, s) : src},
      {texture: tex, mipLevel: l},
      [s, s],
    );
  }
  return tex;
}
