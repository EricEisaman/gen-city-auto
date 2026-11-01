// Paints the business sign atlas (Japanese shop signs, station boards and
// billboards) with Canvas 2D text, then uploads it as a texture.

import {Rng} from '../math/random.ts';
import {
  ATLAS_H,
  ATLAS_W,
  BRAND_WORDS,
  GUIDE_FACES,
  SIGN,
  type GuideFace,
  HORIZONTAL_WORDS,
  STATION_NAMES,
  signColor,
  signRect,
  verticalWord,
} from '../city/signs.ts';

const FONT =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", "Meiryo", sans-serif';

/** Romaji for the station board's sub-line (STATION_NAMES). */
const STATION_ROMAJI: Record<string, string> = {
  新宿: 'Shinjuku',
  渋谷: 'Shibuya',
  池袋: 'Ikebukuro',
  上野: 'Ueno',
  品川: 'Shinagawa',
  秋葉原: 'Akihabara',
  有楽町: 'Yurakucho',
  代々木: 'Yoyogi',
};

function css(c: [number, number, number], k = 1) {
  return `rgb(${Math.round(Math.min(1, c[0] * k) * 255)}, ${Math.round(Math.min(1, c[1] * k) * 255)}, ${Math.round(Math.min(1, c[2] * k) * 255)})`;
}

// Shop sign cells are masks (see SIGN_WAYS in src/city/signs.ts), painted
// white on black into three layers: lettering (R), frame ring and letter
// outlines (G), and the lettering's bevel height (B, the lettering blurred).
interface MaskLayers {
  text: OffscreenCanvasRenderingContext2D;
  edge: OffscreenCanvasRenderingContext2D;
}

/** Frame ring of shop sign `id`; returns its cell. */
function maskCell(L: MaskLayers, id: number) {
  const [x, y, w, h] = signRect(id);
  const lw = Math.max(4, Math.min(w, h) * 0.05);
  const e = L.edge;
  e.strokeStyle = '#fff';
  e.lineWidth = lw;
  e.strokeRect(x + lw * 1.5, y + lw * 1.5, w - lw * 3, h - lw * 3);
  for (const g of [L.text, L.edge]) {
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.fillStyle = '#fff';
    g.strokeStyle = '#fff';
    g.lineJoin = 'round';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
  }
  return {x, y, w, h};
}

function endCell(L: MaskLayers) {
  L.text.restore();
  L.edge.restore();
}

/**
 * Lettering at (tx, ty): fill into the text layer and, on every other sign,
 * a heavy outline into the edge layer (a contrasting rim, as on many
 * Japanese shop signs).
 */
function letter(
  L: MaskLayers,
  id: number,
  ch: string,
  tx: number,
  ty: number,
  size: number,
) {
  const font = `bold ${size}px ${FONT}`;
  L.text.font = font;
  L.edge.font = font;
  if (id % 2 === 0) {
    L.edge.lineWidth = Math.max(3, size * 0.14);
    L.edge.strokeText(ch, tx, ty);
  }
  L.text.fillText(ch, tx, ty);
}

// In vertical writing these turn a quarter (the long-vowel mark becomes a
// vertical bar, brackets open downwards), and small kana sit in the upper
// right of their cell.
const VERTICAL_ROTATE = /[ー〜～…‥－―—\-~()（）「」『』【】〈〉《》［］]/;
const SMALL_KANA = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/;

/**
 * One character of vertical text centred at (tx, ty), drawn by `draw` into
 * the contexts `g` (rotated a quarter turn where vertical writing turns it).
 */
function verticalGlyph(
  draw: (ch: string, x: number, y: number) => void,
  g: OffscreenCanvasRenderingContext2D[],
  ch: string,
  tx: number,
  ty: number,
  size: number,
) {
  if (VERTICAL_ROTATE.test(ch)) {
    for (const c of g) {
      c.save();
      c.translate(tx, ty);
      c.rotate(Math.PI / 2);
    }
    draw(ch, 0, 0);
    for (const c of g) c.restore();
  } else if (SMALL_KANA.test(ch)) {
    draw(ch, tx + size * 0.12, ty - size * 0.12);
  } else {
    draw(ch, tx, ty);
  }
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

// Guide sign colours (sRGB). signMat shows a billboard cell at 0.6 of its
// linear colour by day (floodlit at night, as lit guide signs are), so the
// blue is painted a little lighter than the 0, 80, 160 of the standard.
const GUIDE_BLUE = 'rgb(18, 92, 182)';
const GUIDE_WHITE = 'rgb(246, 246, 242)';

/**
 * One road guide sign face in (x, y, w, h): a 4 px blue margin (the panel
 * edge), a rounded white border, then the face. Advance-direction faces: a
 * crossroads arrow (straight shaft, cross bar with arrowheads to the arms
 * present), the destinations ahead / left / right as kanji over romaji, a
 * national-route shield (blue shield, white outline and number) on the
 * shaft, a metropolitan-route hexagon on an arm, and the cross street's
 * name in a white box. Distance faces: three rows of kanji over romaji with
 * the distance in km.
 */
function paintGuideSign(
  g: OffscreenCanvasRenderingContext2D,
  f: GuideFace,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = GUIDE_BLUE;
  g.fillRect(x, y, w, h);
  g.strokeStyle = GUIDE_WHITE;
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(x + 5, y + 5, w - 10, h - 10, 7);
  g.stroke();
  g.fillStyle = GUIDE_WHITE;
  g.textBaseline = 'middle';
  const text = (
    s: string,
    tx: number,
    ty: number,
    size: number,
    align: CanvasTextAlign,
    maxW: number,
    weight = 'bold',
  ) => {
    if (!s) return;
    g.textAlign = align;
    g.font = `${weight} ${size}px ${FONT}`;
    g.fillText(s, tx, ty, maxW);
  };
  const dest = (
    d: [string, string],
    tx: number,
    ty: number,
    align: CanvasTextAlign,
    maxW: number,
  ) => {
    text(d[0], tx, ty, 21, align, maxW);
    text(d[1], tx, ty + 17, 11, align, maxW, '600');
  };
  if (f.kind === 'dist') {
    f.rows.forEach(([k, r, km], i) => {
      const ry = y + 22 + i * 36;
      text(k, x + 14, ry, 22, 'left', w * 0.5);
      text(r, x + 14, ry + 15, 10, 'left', w * 0.5, '600');
      text(`${km}`, x + w - 46, ry + 4, 26, 'right', w * 0.3);
      text('km', x + w - 14, ry + 9, 13, 'right', 30);
    });
    g.restore();
    return;
  }
  // Crossroads arrow: shaft and head, cross bar and its heads.
  const cx = x + w / 2;
  const by = y + h * 0.62;
  const top = y + 40;
  const shaft = 11;
  const bar = 8;
  g.fillRect(cx - shaft / 2, top + 8, shaft, y + h - 9 - (top + 8));
  g.beginPath();
  g.moveTo(cx, top - 6);
  g.lineTo(cx + 13, top + 12);
  g.lineTo(cx - 13, top + 12);
  g.closePath();
  g.fill();
  const lx = x + w * 0.24;
  const rx = x + w * 0.76;
  const head = (tx: number, dir: number) => {
    g.beginPath();
    g.moveTo(tx - dir * 12, by);
    g.lineTo(tx + dir * 4, by - 11);
    g.lineTo(tx + dir * 4, by + 11);
    g.closePath();
    g.fill();
  };
  if (f.t & 1) {
    g.fillRect(lx, by - bar / 2, cx - lx, bar);
    head(lx, 1);
  }
  if (f.t & 2) {
    g.fillRect(cx, by - bar / 2, rx - cx, bar);
    head(rx, -1);
  }
  // Destinations: ahead over the arrowhead, left / right over their arms.
  dest(f.ahead, cx, y + 17, 'center', w * 0.6);
  if (f.t & 1) dest(f.left, x + 12, by - 30, 'left', w * 0.36);
  if (f.t & 2) dest(f.right, x + w - 12, by - 30, 'right', w * 0.36);
  // National route shield on the shaft below the bar.
  const sy = by + 25;
  g.beginPath();
  g.moveTo(cx - 12, sy - 11);
  g.lineTo(cx + 12, sy - 11);
  g.lineTo(cx + 12, sy + 2);
  g.quadraticCurveTo(cx + 10, sy + 9, cx, sy + 13);
  g.quadraticCurveTo(cx - 10, sy + 9, cx - 12, sy + 2);
  g.closePath();
  g.fillStyle = GUIDE_BLUE;
  g.fill();
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = GUIDE_WHITE;
  text(f.route, cx, sy - 1, f.route.length > 2 ? 10 : 13, 'center', 20);
  // Metropolitan route hexagon (white, blue number) under one arm.
  const hx = f.t & 1 ? lx + 26 : rx - 26;
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const px = hx + Math.cos(a) * 14;
    const py = by + 22 + Math.sin(a) * 10;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.closePath();
  g.fill();
  g.fillStyle = GUIDE_BLUE;
  text(f.metro, hx, by + 23, 10, 'center', 22);
  // Cross street name: white box, blue lettering, under the other arm.
  const nx = f.t & 1 ? (f.t & 2 ? rx - 22 : cx + 50) : lx + 22;
  const nw = 50;
  g.fillStyle = GUIDE_WHITE;
  g.fillRect(nx - nw / 2, by + 13, nw, 16);
  g.fillStyle = GUIDE_BLUE;
  text(f.street[0], nx, by + 21.5, 11, 'center', nw - 4);
  g.restore();
}

export function paintSignAtlas(): OffscreenCanvas {
  const canvas = new OffscreenCanvas(ATLAS_W, ATLAS_H);
  const g = canvas.getContext('2d', {willReadFrequently: true})!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS_W, ATLAS_H);
  const layer = () => {
    const c = new OffscreenCanvas(ATLAS_W, ATLAS_H);
    const cg = c.getContext('2d', {willReadFrequently: true})!;
    cg.fillStyle = '#000';
    cg.fillRect(0, 0, ATLAS_W, ATLAS_H);
    return cg;
  };
  const L: MaskLayers = {text: layer(), edge: layer()};
  // Vertical shop signs: characters stacked top to bottom.
  for (let id = 0; id < 32; id++) {
    const {x, y, w, h} = maskCell(L, id);
    const chars = [...verticalWord(id)].slice(0, 6);
    const size = Math.min(w * 0.66, (h * 0.84) / chars.length);
    chars.forEach((ch, i) => {
      verticalGlyph(
        (c, tx, ty) => letter(L, id, c, tx, ty, size),
        [L.text, L.edge],
        ch,
        x + w / 2,
        y +
          h * 0.08 +
          size * (i + 0.5) * 1.02 +
          (h * 0.84 - size * chars.length) / 2,
        size,
      );
    });
    endCell(L);
  }
  // Horizontal shop signs.
  for (let id = 32; id < 44; id++) {
    const {x, y, w, h} = maskCell(L, id);
    const word = HORIZONTAL_WORDS[id - 32];
    const size = Math.min(h * 0.56, (w * 0.82) / Math.max(2, [...word].length));
    letter(L, id, word, x + w / 2, y + h / 2, size);
    endCell(L);
  }
  // Station name boards (JR style), one 2.4 x 0.6 m board unit per cell
  // (213 px/m), in grey levels the shader reads as masks
  // (railNameBoard in city-materials.wgsl): white face, black name in
  // bold kanji with its romaji under it, and a mid-grey band (the shader
  // paints it in the line colour) carrying the adjacent stations in white,
  // with arrows: "◀ prev" at the left, "next ▶" at the right.
  for (let k = 0; k < 4; k++) {
    const [x, y, w, h] = signRect(44 + k);
    const ppm = w / 2.4;
    // Board metres (from the bottom edge) to cell pixels.
    const Y = (m: number) => y + h - m * ppm;
    const N = STATION_NAMES.length;
    const name = STATION_NAMES[k % N];
    const prev = STATION_NAMES[(k + 5) % N];
    const next = STATION_NAMES[(k + 6) % N];
    g.fillStyle = '#fff';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#808080';
    g.fillRect(x, Y(0.17), w, 0.13 * ppm);
    g.textBaseline = 'middle';
    g.fillStyle = '#000';
    g.textAlign = 'center';
    g.font = `bold ${0.22 * ppm}px ${FONT}`;
    g.fillText(name, x + w / 2, Y(0.385), w * 0.6);
    g.font = `bold ${0.055 * ppm}px ${FONT}`;
    g.fillText(STATION_ROMAJI[name] ?? '', x + w / 2, Y(0.225));
    // Adjacent stations in the band, white, with arrow heads.
    g.fillStyle = '#fff';
    g.font = `bold ${0.085 * ppm}px ${FONT}`;
    const by = Y(0.105);
    const ah = 0.045 * ppm;
    g.textAlign = 'left';
    g.beginPath();
    g.moveTo(x + 0.08 * ppm, by);
    g.lineTo(x + 0.08 * ppm + ah * 1.2, by - ah);
    g.lineTo(x + 0.08 * ppm + ah * 1.2, by + ah);
    g.fill();
    g.fillText(prev, x + 0.22 * ppm, by);
    g.textAlign = 'right';
    g.beginPath();
    g.moveTo(x + w - 0.08 * ppm, by);
    g.lineTo(x + w - 0.08 * ppm - ah * 1.2, by - ah);
    g.lineTo(x + w - 0.08 * ppm - ah * 1.2, by + ah);
    g.fill();
    g.fillText(next, x + w - 0.22 * ppm, by);
  }
  // Billboards: flat, hard-edged poster graphics (no gradients or soft
  // shapes, so they stay crisp in the mip chain and read from across the
  // street): a bold colour field, one big shape, the brand name in heavy
  // outlined type and a tagline bar.
  for (let k = 0; k < SIGN.billboard.count; k++) {
    const [x, y, w, h] = signRect(48 + k);
    paintBillboard(g, k, x, y, w, h);
  }
  // Road guide signs, four 256x128 faces per guide cell.
  GUIDE_FACES.forEach((f, k) => {
    const [x, y, w, h] = signRect(SIGN.guide.first + (k >> 2));
    const sw = w / 2;
    const sh = h / 2;
    paintGuideSign(g, f, x + (k & 1) * sw, y + ((k >> 1) & 1) * sh, sw, sh);
  });
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
    const {x, y, w, h} = maskCell(L, id);
    const text = SQUARE_TEXT[k];
    const n = [...text].length;
    const size =
      n === 1 ? h * 0.58 : n === 2 ? h * 0.38 : (w * 0.76) / (n * 0.62);
    if (k % 3 === 0) {
      // Disc logo in the frame colour, its glyph knocked out of it so the
      // background shows through.
      const e = L.edge;
      e.beginPath();
      e.arc(x + w / 2, y + h / 2, w * 0.36, 0, Math.PI * 2);
      e.fill();
      e.globalCompositeOperation = 'destination-out';
      e.font = `bold ${size}px ${FONT}`;
      e.fillText(text, x + w / 2, y + h / 2 + size * 0.04);
      e.globalCompositeOperation = 'source-over';
    } else if (n === 2 && /[^ -~]/.test(text)) {
      // Two kanji stacked, as on a corner light box.
      [...text].forEach((ch, i) =>
        letter(L, id + 1, ch, x + w / 2, y + h * (0.3 + i * 0.4), size),
      );
    } else {
      letter(L, id + 1, text, x + w / 2, y + h / 2 + size * 0.04, size);
    }
    endCell(L);
  }
  // Bevel height: the lettering (and disc logos) blurred a little.
  const height = layer();
  height.filter = 'blur(3px)';
  height.drawImage(L.text.canvas, 0, 0);
  height.globalCompositeOperation = 'lighten';
  for (let k = 0; k < 16; k += 3) {
    const [x, y, w, h] = signRect(72 + k);
    height.drawImage(L.edge.canvas, x, y, w, h, x, y, w, h);
  }
  height.filter = 'none';
  // Pack the masks into the shop sign rows.
  for (const [y0, y1] of MASK_ROWS) {
    const img = g.getImageData(0, y0, ATLAS_W, y1 - y0);
    const t = L.text.getImageData(0, y0, ATLAS_W, y1 - y0).data;
    const e = L.edge.getImageData(0, y0, ATLAS_W, y1 - y0).data;
    const hh = height.getImageData(0, y0, ATLAS_W, y1 - y0).data;
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = t[i];
      d[i + 1] = e[i];
      d[i + 2] = hh[i];
    }
    g.putImageData(img, 0, y0);
  }
  return canvas;
}

/**
 * Atlas rows (at mip 0) holding shop sign masks: vertical and horizontal
 * signs, and the square signs. They are linear data, so the upload encodes
 * them to sRGB for the -srgb texture to decode back.
 */
const MASK_ROWS: [number, number][] = [
  [0, 1408],
  [2048, 2560],
];

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

/** Linear byte to sRGB-encoded byte. */
const TO_SRGB = Uint8Array.from({length: 256}, (_, i) => {
  const v = i / 255;
  const e = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(e * 255);
});

/** Sign atlas mip levels. */
export const SIGN_ATLAS_LEVELS = 5;

/**
 * Paint the sign atlas and its mip chain as RGBA bytes: sRGB-encoded colour
 * from the atlas, alpha from the vinyl mask. CPU / 2D canvas work only (runs
 * in the texture worker).
 */
export function signAtlasLevels(): Uint8ClampedArray[] {
  const canvas = paintSignAtlas();
  const mask = paintVinylMask();
  const scale = (from: OffscreenCanvas, w: number, h: number) => {
    const c = new OffscreenCanvas(w, h);
    const cg = c.getContext('2d')!;
    cg.imageSmoothingQuality = 'high';
    cg.drawImage(from, 0, 0, w, h);
    return c;
  };
  let src: OffscreenCanvas = canvas;
  let msrc: OffscreenCanvas = mask;
  const out: Uint8ClampedArray[] = [];
  for (let l = 0; l < SIGN_ATLAS_LEVELS; l++) {
    const w = ATLAS_W >> l,
      h = ATLAS_H >> l;
    if (l > 0) {
      src = scale(src, w, h);
      msrc = scale(msrc, w, h);
    }
    // Colour from the sign atlas, alpha from the vinyl mask (ImageData is
    // unpremultiplied, so the colour survives under zero alpha).
    const d = src.getContext('2d')!.getImageData(0, 0, w, h).data;
    const m = msrc.getContext('2d')!.getImageData(0, 0, w, h).data;
    for (let i = 3; i < d.length; i += 4) d[i] = m[i - 3];
    for (const [y0, y1] of MASK_ROWS) {
      for (let i = (y0 >> l) * w * 4; i < (y1 >> l) * w * 4; i += 4) {
        d[i] = TO_SRGB[d[i]];
        d[i + 1] = TO_SRGB[d[i + 1]];
        d[i + 2] = TO_SRGB[d[i + 2]];
      }
    }
    out.push(d);
  }
  return out;
}

/**
 * Upload signAtlasLevels() output. Mipmapped so distant sign text filters
 * instead of shimmering (the shader clamps the level so neighbouring signs
 * never bleed in).
 */
export function uploadSignAtlas(
  device: GPUDevice,
  levels: Uint8ClampedArray[],
): GPUTexture {
  const tex = device.createTexture({
    label: 'signs/atlas',
    size: [ATLAS_W, ATLAS_H],
    format: 'rgba8unorm-srgb',
    mipLevelCount: SIGN_ATLAS_LEVELS,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  levels.forEach((d, l) => {
    const w = ATLAS_W >> l,
      h = ATLAS_H >> l;
    device.queue.writeTexture(
      {texture: tex, mipLevel: l},
      d,
      {bytesPerRow: w * 4},
      [w, h],
    );
  });
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
