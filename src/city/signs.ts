// Sign atlas layout shared by geometry generation, the atlas painter and the
// shaders. The atlas is 2048x2560:
//   rows    0..1023  vertical shop signs   128x512, 16 x 2 = 32 (ids 0..31)
//   rows 1024..1407  horizontal shop signs 512x128,  4 x 3 = 12 (ids 32..43)
//   rows 1408..1535  station name boards   512x128,  4 x 1 =  4 (ids 44..47)
//   rows 1536..2047  billboards            512x256,  4 x 2 =  8 (ids 48..55)
//                    (ids 56..71 wrap onto the billboards; gen-base uses them)
//   rows 2048..2559  square cube signs     256x256,  8 x 2 = 16 (ids 72..87)

export const ATLAS_W = 2048;
export const ATLAS_H = 2560;
export const SIGN = {
  vertical: {first: 0, count: 32},
  horizontal: {first: 32, count: 12},
  station: {first: 44, count: 4},
  billboard: {first: 48, count: 8},
  square: {first: 72, count: 16},
} as const;

/** Sign material param flags (above the 8-bit atlas id). */
export const SIGN_FABRIC = 1 << 8; // unlit cloth: banners, awning valances
export const SIGN_STRIPES = 1 << 9; // striped awning canvas (no atlas lookup)

/** Atlas rectangle (pixels) for a sign id: [x, y, w, h]. */
export function signRect(id: number): [number, number, number, number] {
  if (id < 32) return [(id % 16) * 128, Math.floor(id / 16) * 512, 128, 512];
  if (id < 48) {
    const k = id - 32;
    return [(k % 4) * 512, 1024 + Math.floor(k / 4) * 128, 512, 128];
  }
  if (id < 72) {
    const k = (id - 48) % 8;
    return [(k % 4) * 512, 1536 + Math.floor(k / 4) * 256, 512, 256];
  }
  const k = (id - 72) % 16;
  return [(k % 8) * 256, 2048 + Math.floor(k / 8) * 256, 256, 256];
}

export const SHOP_WORDS = [
  'ラーメン',
  '居酒屋',
  'カラオケ',
  '焼肉',
  '寿司',
  '薬局',
  '不動産',
  'ホテル',
  '歯科',
  'カフェ',
  'パチンコ',
  '銀行',
  '書店',
  '美容室',
  '中華料理',
  '牛丼',
  '質屋',
  'ゲーム',
  'うどん',
  'そば',
  '眼科',
  '整骨院',
  '英会話',
  '麻雀',
  '天ぷら',
  '焼鳥',
  'バー',
  'スナック',
  '古着',
  '花屋',
  '時計',
  '電器',
  'ネットカフェ',
  'ランドリー',
  'BAR',
  'CAFE',
  'HOTEL',
  '24H',
  'カレー',
  'ダイニング',
];

/**
 * Word on vertical sign `id` (0..31). The stride is coprime to the word
 * count, so all 32 vertical signs carry different words.
 */
export function verticalWord(id: number) {
  return SHOP_WORDS[(id * 13 + 3) % SHOP_WORDS.length];
}

/**
 * Ground-floor tenant types, as the shader picks them per pair of shopfront
 * bays (city-materials.wgsl facadeMat: shopType = hashu(aux ^ (bayPair +
 * 3000)) % 4): konbini, restaurant, boutique, office lobby.
 */
export const SHOP_TYPE = {konbini: 0, restaurant: 1, boutique: 2, office: 3};

/**
 * Words on the horizontal (fascia) signs, ids 32..43, grouped by tenant type
 * so a fascia can name the business behind its glass (TENANT_SIGNS).
 */
export const HORIZONTAL_WORDS = [
  '焼鳥',
  '居酒屋',
  'ラーメン',
  '寿司',
  'そば',
  'FRESH MART',
  'コンビニ',
  '古着',
  'BOUTIQUE',
  '不動産',
  '歯科',
  '英会話',
];

/** Horizontal sign ids per SHOP_TYPE. */
export const TENANT_SIGNS: number[][] = [
  [37, 38],
  [32, 33, 34, 35, 36],
  [39, 40],
  [41, 42, 43],
];

/**
 * Vertical sign ids whose word suits a nobori banner outside each
 * SHOP_TYPE (konbini: 24H, cafe, curry; restaurants: their dishes;
 * boutiques: used clothes, watches, flowers; offices: none).
 */
const NOBORI_WORDS = [
  ['24H', 'カフェ', 'カレー'],
  [
    'ラーメン',
    '焼肉',
    '寿司',
    '牛丼',
    'うどん',
    'そば',
    '天ぷら',
    '焼鳥',
    'カレー',
    '居酒屋',
  ],
  ['古着', '時計', '花屋'],
  [],
];
export const TENANT_NOBORI: number[][] = NOBORI_WORDS.map(ws =>
  Array.from({length: 32}, (_, id) => id).filter(id =>
    ws.includes(verticalWord(id)),
  ),
);

/** Square (cube / A-board) sign ids per SHOP_TYPE (see SQUARE_TEXT). */
export const TENANT_SQUARES: number[][] = [
  [73, 81],
  [75, 78, 82, 83, 85],
  [84, 87],
  [72, 81],
];

export const STATION_NAMES = [
  '新宿',
  '渋谷',
  '池袋',
  '上野',
  '品川',
  '秋葉原',
  '有楽町',
  '代々木',
];

export const BRAND_WORDS = [
  'NEO',
  'KIRA',
  'SORA',
  'HIKARI',
  'ZEN',
  'TOKI',
  'MIRAI',
  'AOI',
  'GEN CITY',
  'NOVA',
];

/** Dominant color of a sign (linear RGB), shared by the atlas painter and sign lights. */
export function signColor(id: number): [number, number, number] {
  const palette: [number, number, number][] = [
    [1.0, 0.15, 0.1],
    [1.0, 0.75, 0.1],
    [0.2, 0.9, 1.0],
    [1.0, 0.25, 0.7],
    [0.3, 1.0, 0.35],
    [1.0, 1.0, 0.95],
    [0.35, 0.4, 1.0],
    [1.0, 0.45, 0.05],
  ];
  return palette[(id * 7 + (id >> 3)) % palette.length];
}

/**
 * Shop sign colourways. The shop sign cells of the atlas (vertical,
 * horizontal and square ids) hold masks, not colours: R the lettering, G the
 * frame ring and letter outlines, B the lettering's bevel height. signMat in
 * city-materials.wgsl paints them in one of these schemes, so every word is
 * reused in many colourways:
 *   box      lit light box (the whole face glows, dark ink stays dark)
 *   channel  raised channel letters lit from inside, on an unlit panel
 *   neon     tube lettering on a dark backing, with a halo
 *   painted  printed / enamelled board: unlit, floodlit a little at night
 * Colours are linear RGB.
 */
export const SIGN_STYLE = {box: 0, channel: 1, neon: 2, painted: 3} as const;
type Rgb = [number, number, number];
const INK: Record<string, Rgb> = {
  black: [0.012, 0.012, 0.014],
  white: [0.86, 0.86, 0.83],
  unlitWhite: [0.6, 0.6, 0.58],
  red: [0.78, 0.025, 0.02],
  yellow: [0.98, 0.68, 0.02],
  blue: [0.015, 0.08, 0.5],
  navy: [0.008, 0.02, 0.12],
  sky: [0.12, 0.45, 0.9],
  green: [0.01, 0.32, 0.07],
  charcoal: [0.035, 0.035, 0.04],
  orange: [1.0, 0.28, 0.02],
  neonRed: [1.0, 0.06, 0.03],
  neonPink: [1.0, 0.08, 0.42],
  neonCyan: [0.08, 0.75, 1.0],
  steel: [0.3, 0.3, 0.31],
};
/** [background, lettering, frame/outline, style] */
export const SIGN_WAYS: [Rgb, Rgb, Rgb, number][] = [
  [INK.yellow, INK.black, INK.black, SIGN_STYLE.box],
  [INK.red, INK.white, INK.white, SIGN_STYLE.box],
  [INK.black, INK.red, INK.red, SIGN_STYLE.box],
  [INK.yellow, INK.red, INK.red, SIGN_STYLE.box],
  [INK.white, INK.red, INK.red, SIGN_STYLE.box],
  [INK.white, INK.black, INK.black, SIGN_STYLE.painted],
  [INK.blue, INK.red, INK.white, SIGN_STYLE.box],
  [INK.green, INK.white, INK.white, SIGN_STYLE.box],
  [INK.sky, INK.white, INK.white, SIGN_STYLE.box],
  [INK.navy, INK.white, INK.yellow, SIGN_STYLE.box],
  [INK.yellow, INK.blue, INK.blue, SIGN_STYLE.painted],
  [INK.white, INK.yellow, INK.red, SIGN_STYLE.box],
  [INK.unlitWhite, INK.white, INK.steel, SIGN_STYLE.channel],
  [INK.charcoal, INK.neonRed, INK.neonRed, SIGN_STYLE.neon],
  [INK.charcoal, INK.neonPink, INK.neonCyan, SIGN_STYLE.neon],
  [INK.charcoal, INK.orange, INK.steel, SIGN_STYLE.channel],
];
/** Param bits 10-13 of a shop sign: a per-building colourway offset. */
export const SIGN_WAY_SHIFT = 10;

/** Whether atlas id `id` is a mask-painted shop sign (recoloured by SIGN_WAYS). */
export function isShopSign(id: number) {
  return id < SIGN.station.first || id >= SIGN.square.first;
}

/** Colourway index of shop sign `id` with offset `bits` (0-15). */
export function signWay(id: number, bits: number) {
  return (id * 5 + bits) & 15;
}

/** Colour a shop sign casts on its surroundings at night (linear RGB). */
export function signGlow(id: number, bits: number): Rgb {
  if (!isShopSign(id)) return signColor(id);
  const [bg, fg, , style] = SIGN_WAYS[signWay(id, bits)];
  const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  if (style === SIGN_STYLE.box) return mix(bg, fg, 0.25);
  if (style === SIGN_STYLE.painted)
    return mix(bg, fg, 0.2).map(v => v * 0.4) as Rgb;
  return fg;
}

/** WGSL table of SIGN_WAYS (prepended to the city shader). */
export function signWaysWgsl(): string {
  const v = (c: Rgb) => `vec3f(${c.map(x => x.toFixed(3)).join(', ')})`;
  const rows = SIGN_WAYS.map(
    ([bg, fg, ed, st]) => `  SignWay(${v(bg)}, ${v(fg)}, ${v(ed)}, ${st}u)`,
  );
  return [
    'struct SignWay { bg: vec3f, fg: vec3f, edge: vec3f, style: u32 };',
    `const SIGN_WAYS = array<SignWay, ${SIGN_WAYS.length}>(\n${rows.join(',\n')}\n);`,
  ].join('\n');
}
