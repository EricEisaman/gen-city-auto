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
  'landry',
  'BAR',
  'CAFE',
  'HOTEL',
  '24H',
  'カレー',
  'ダイニング',
];

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
