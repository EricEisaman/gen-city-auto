// Sign atlas layout shared by geometry generation, the atlas painter and the
// shaders. The atlas is 2048x2048:
//   rows    0..1023  vertical shop signs   128x512, 16 x 2 = 32 (ids 0..31)
//   rows 1024..1407  horizontal shop signs 512x128,  4 x 3 = 12 (ids 32..43)
//   rows 1408..1535  station name boards   512x128,  4 x 1 =  4 (ids 44..47)
//   rows 1536..2047  billboards            512x256,  4 x 2 =  8 (ids 48..55)

export const ATLAS_SIZE = 2048;
export const SIGN = {
  vertical: {first: 0, count: 32},
  horizontal: {first: 32, count: 12},
  station: {first: 44, count: 4},
  billboard: {first: 48, count: 8},
} as const;

/** Atlas rectangle (pixels) for a sign id: [x, y, w, h]. */
export function signRect(id: number): [number, number, number, number] {
  if (id < 32) return [(id % 16) * 128, Math.floor(id / 16) * 512, 128, 512];
  if (id < 48) {
    const k = id - 32;
    return [(k % 4) * 512, 1024 + Math.floor(k / 4) * 128, 512, 128];
  }
  const k = (id - 48) % 8;
  return [(k % 4) * 512, 1536 + Math.floor(k / 4) * 256, 512, 256];
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
