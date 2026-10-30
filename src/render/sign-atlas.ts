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

// Billboard poster k (0..7) in the cell (x, y, w, h): four layouts (product
// on a sun disc, diagonal split, giant kanji, travel poster) in flat colours
// with heavy outlined type, all hard edges.
const POSTER_TAGS = [
  '新発売',
  '期間限定',
  '本日オープン',
  '全国ツアー',
  '冬のごちそう',
  '今だけ半額',
  'ゼロカロリー',
  '絶景の旅へ',
];
const POSTER_KANJI = ['旨', '夏', '光', '速', '冷', '祭', '新', '空'];

function paintBillboard(
  g: OffscreenCanvasRenderingContext2D,
  k: number,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const id = 48 + k;
  const c1 = signColor(id + 3);
  const c2 = signColor(id + 6 + (k >> 2));
  const ink = '#14161c';
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  const brand = BRAND_WORDS[k % BRAND_WORDS.length];
  const tag = POSTER_TAGS[k];
  const outlined = (
    text: string,
    tx: number,
    ty: number,
    size: number,
    fill: string,
    stroke: string,
  ) => {
    g.font = `900 ${size}px ${FONT}`;
    g.lineJoin = 'round';
    g.lineWidth = Math.max(4, size * 0.12);
    g.strokeStyle = stroke;
    g.strokeText(text, tx, ty);
    g.fillStyle = fill;
    g.fillText(text, tx, ty);
  };
  const layout = k % 4;
  if (layout === 0) {
    // Product on a sun disc: a drink can (body, band, rim) at the right.
    g.fillStyle = css(c1, 0.85);
    g.fillRect(x, y, w, h);
    g.fillStyle = css(c2);
    g.beginPath();
    g.arc(x + w * 0.76, y + h * 0.5, h * 0.46, 0, Math.PI * 2);
    g.fill();
    const cx = x + w * 0.76,
      cw = h * 0.3,
      ch = h * 0.66;
    g.fillStyle = '#f4f4f0';
    g.fillRect(cx - cw / 2, y + h * 0.17, cw, ch);
    g.fillStyle = ink;
    g.fillRect(cx - cw / 2, y + h * 0.38, cw, ch * 0.3);
    g.fillStyle = '#b8bcc4';
    g.fillRect(cx - cw / 2, y + h * 0.13, cw, h * 0.05);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    outlined(brand, x + w * 0.05, y + h * 0.52, h * 0.34, '#ffffff', ink);
  } else if (layout === 1) {
    // Diagonal split, the tagline in tall white type on the dark side.
    g.fillStyle = css(c1);
    g.fillRect(x, y, w, h);
    g.fillStyle = ink;
    g.beginPath();
    g.moveTo(x + w * 0.58, y);
    g.lineTo(x + w, y);
    g.lineTo(x + w, y + h);
    g.lineTo(x + w * 0.42, y + h);
    g.closePath();
    g.fill();
    g.fillStyle = css(c2);
    g.fillRect(x + w * 0.5, y, w * 0.03, h);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    outlined(brand, x + w * 0.05, y + h * 0.46, h * 0.3, ink, '#ffffff');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${h * 0.2}px ${FONT}`;
    g.fillStyle = '#ffffff';
    g.fillText(tag, x + w * 0.76, y + h * 0.5, w * 0.36);
  } else if (layout === 2) {
    // One giant kanji in the brand colour, outlined white, on navy.
    g.fillStyle = '#101a3a';
    g.fillRect(x, y, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    outlined(
      POSTER_KANJI[k],
      x + w * 0.27,
      y + h * 0.5,
      h * 0.82,
      css(c1),
      '#ffffff',
    );
    g.textAlign = 'left';
    outlined(brand, x + w * 0.52, y + h * 0.4, h * 0.24, '#ffffff', '#101a3a');
  } else {
    // Travel poster: flat sky bands, a white peak and a red sun.
    const bands = [css(c1, 0.95), css(c1, 0.75), css(c1, 0.55)];
    bands.forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect(x, y + (h * i) / 3, w, h / 3 + 1);
    });
    g.fillStyle = '#e8402a';
    g.beginPath();
    g.arc(x + w * 0.8, y + h * 0.3, h * 0.15, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#2a3348';
    g.beginPath();
    g.moveTo(x + w * 0.3, y + h);
    g.lineTo(x + w * 0.62, y + h * 0.3);
    g.lineTo(x + w * 0.95, y + h);
    g.closePath();
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(x + w * 0.62, y + h * 0.3);
    g.lineTo(x + w * 0.7, y + h * 0.47);
    g.lineTo(x + w * 0.65, y + h * 0.43);
    g.lineTo(x + w * 0.6, y + h * 0.49);
    g.lineTo(x + w * 0.55, y + h * 0.44);
    g.closePath();
    g.fill();
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    outlined(brand, x + w * 0.05, y + h * 0.42, h * 0.28, '#ffffff', ink);
  }
  // Tagline bar along the bottom (layout 1 carries its tagline already).
  if (layout !== 1) {
    g.fillStyle = '#ffffff';
    g.fillRect(x, y + h * 0.76, w * 0.5, h * 0.17);
    g.fillStyle = ink;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.font = `900 ${h * 0.12}px ${FONT}`;
    g.fillText(tag, x + w * 0.04, y + h * 0.846, w * 0.44);
  }
  // Frame.
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.strokeRect(x + 3, y + 3, w - 6, h - 6);
  g.restore();
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
  // Billboards: flat, hard-edged poster graphics (no gradients or soft
  // shapes, so they stay crisp in the mip chain and read from across the
  // street): a bold colour field, one big shape, the brand name in heavy
  // outlined type and a tagline bar.
  for (let k = 0; k < 8; k++) {
    const id = 48 + k;
    const [x, y, w, h] = signRect(id);
    // (The old painter's draws, so the cube signs below keep their styles.)
    for (let s = 0; s < 18; s++) rng.next();
    paintBillboard(g, k, x, y, w, h);
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

// Tenant lettering: the cut-vinyl names office and zakkyo tenants stick on
// their upper-floor windows, one big character per pane (カ|ラ|オ|ケ across
// four windows), with a phone-number strip below. Painted as a white-on-black
// mask into the sign atlas's alpha channel (unused by the colour signs):
//   rows    0..2047  glyph cells 128x128, 16 x 16: word w (of VINYL_WORDS)
//                    has its k-th character in cell w * 8 + k
//   rows 2048..2559  strips 512x64, 4 x 8 = 32: phone numbers, notices
// city-materials.wgsl vinyl() reads it; VINYL_LEN is generated from here.
export const VINYL_WORDS = [
  'カラオケ',
  '歯科',
  '麻雀',
  '英会話',
  '整骨院',
  '不動産',
  '学習塾',
  '美容室',
  '内科',
  '眼科',
  '皮膚科',
  '鍼灸院',
  '囲碁',
  '雀荘',
  '居酒屋',
  '司法書士',
  '税理士',
  '事務所',
  '空室',
  'テナント',
  'ネイル',
  'エステ',
  'ヨガ',
  '整体',
  '塾',
  '写真館',
  'ダンス',
  '中国語',
  '個別指導',
  '金券',
  '質',
  '占い',
];
const VINYL_GLYPH = 128;
const VINYL_STRIP_W = 512;
const VINYL_STRIP_H = 64;

/** WGSL constants matching the vinyl mask layout (prepended to the city shader). */
export function vinylWgsl(): string {
  const lens = VINYL_WORDS.map(w => `${[...w].length}u`).join(', ');
  const n = VINYL_WORDS.length;
  return [
    `const VINYL_WORDS = ${n}u;`,
    `const VINYL_LEN = array<u32, ${n}>(${lens});`,
  ].join('\n');
}

/** The vinyl lettering mask (white on black), laid out as described above. */
export function paintVinylMask(seed = 7): OffscreenCanvas {
  const canvas = new OffscreenCanvas(ATLAS_W, ATLAS_H);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS_W, ATLAS_H);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const G = VINYL_GLYPH;
  const cols = ATLAS_W / G;
  g.font = `bold ${G * 0.78}px ${FONT}`;
  VINYL_WORDS.forEach((word, w) => {
    [...word].slice(0, 8).forEach((ch, k) => {
      const cell = w * 8 + k;
      const x = (cell % cols) * G;
      const y = Math.floor(cell / cols) * G;
      g.fillText(ch, x + G / 2, y + G / 2 + G * 0.03);
    });
  });
  const rng = new Rng(seed);
  const digits = (n: number) =>
    Array.from({length: n}, () => rng.int(0, 10)).join('');
  const notes = [
    '空室あり',
    'テナント募集',
    '受付中',
    '予約制',
    'OPEN 10:00-22:00',
    '営業中',
    'WiFi完備',
    '初回無料',
  ];
  const sw = VINYL_STRIP_W;
  const sh = VINYL_STRIP_H;
  for (let k = 0; k < 32; k++) {
    const x = (k % 4) * sw;
    const y = 2048 + Math.floor(k / 4) * sh;
    const prefix = ['TEL ', '☎ ', ''][k % 3];
    const text =
      k < 24
        ? `${prefix}0${rng.int(3, 4)}-${digits(4)}-${digits(4)}`
        : notes[k - 24];
    const size = Math.min(
      sh * 0.72,
      (sw * 0.92) / Math.max(4, [...text].length * 0.62),
    );
    g.font = `bold ${size}px ${FONT}`;
    g.fillText(text, x + sw / 2, y + sh / 2 + sh * 0.03, sw * 0.92);
  }
  return canvas;
}

export function createSignAtlasTexture(device: GPUDevice): GPUTexture {
  const canvas = paintSignAtlas();
  const mask = paintVinylMask();
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
  const scale = (from: OffscreenCanvas, w: number, h: number) => {
    const c = new OffscreenCanvas(w, h);
    const cg = c.getContext('2d')!;
    cg.imageSmoothingQuality = 'high';
    cg.drawImage(from, 0, 0, w, h);
    return c;
  };
  let src: OffscreenCanvas = canvas;
  let msrc: OffscreenCanvas = mask;
  for (let l = 0; l < levels; l++) {
    const w = ATLAS_W >> l,
      h = ATLAS_H >> l;
    if (l > 0) {
      src = scale(src, w, h);
      msrc = scale(msrc, w, h);
    }
    // Colour from the sign atlas, alpha from the vinyl mask (ImageData is
    // unpremultiplied, so the colour survives under zero alpha).
    const img = src.getContext('2d')!.getImageData(0, 0, w, h);
    const m = msrc.getContext('2d')!.getImageData(0, 0, w, h).data;
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = m[i - 3];
    device.queue.copyExternalImageToTexture(
      {source: img},
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
