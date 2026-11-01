// Sign atlas layout shared by geometry generation, the atlas painter and the
// shaders. The atlas is 2048x2560:
//   rows    0..1023  vertical shop signs   128x512, 16 x 2 = 32 (ids 0..31)
//   rows 1024..1407  horizontal shop signs 512x128,  4 x 3 = 12 (ids 32..43)
//   rows 1408..1535  station name boards   512x128,  4 x 1 =  4 (ids 44..47)
//   rows 1536..2047  billboards            512x256,  4 x 2 =  8 (ids 48..55)
//                    (ids 56..71 wrap onto the billboards; gen-base uses them)
//                    of which ids 54, 55 hold road guide signs (GUIDE_FACES):
//                    four 256x128 faces each, so billboards use 48..53.
//   rows 2048..2559  square cube signs     256x256,  8 x 2 = 16 (ids 72..87)

import type {CityType} from './config.ts';

export const ATLAS_W = 2048;
export const ATLAS_H = 2560;
export const SIGN = {
  vertical: {first: 0, count: 32},
  horizontal: {first: 32, count: 12},
  station: {first: 44, count: 4},
  billboard: {first: 48, count: 6},
  /** Road guide signs, four faces per cell (see guideFace). */
  guide: {first: 54, count: 2},
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

/**
 * Road guide sign faces painted into the guide cells (sign-atlas.ts
 * paintGuideSign), 256x128 each, four per cell (2 x 2): the overhead
 * advance-direction signs (方面及び方向の予告, kind 'dir': blue field, white
 * border, a crossroads arrow with destinations ahead / left / right in
 * kanji over romaji, route shields on the arms) and the post-junction
 * direction-and-distance signs (kind 'dist': three destinations with km).
 * `t` = arms present, as on a T junction: 1 left, 2 right, 3 both.
 *
 * Shader contract: the guide panel's face is M_SIGN with id SIGN.guide
 * (54, 55) and uv over one quarter of the cell (guideFace), so today it
 * takes signMat's billboard branch (albedo 0.6 x atlas colour by day,
 * floodlit from the top edge at night, as lit guide signs are). A branch
 * of its own for ids 54..55 (retroreflective sheeting: no flood, a faint
 * nightLight() glow) is the shader's call; the back stays CM.roadSign
 * 16 | 0x100.
 */
export type GuideFace =
  | {
      kind: 'dir';
      ahead: [string, string];
      left: [string, string];
      right: [string, string];
      route: string;
      metro: string;
      street: [string, string];
      t: number;
    }
  | {kind: 'dist'; rows: [string, string, number][]}
  | UsGuideFace;

/**
 * US (MUTCD) guide sign faces, for the 'nyc' locale: green field, white
 * border and Highway-Gothic-style lettering.
 *   'us'      overhead advance guide sign: route shields with a cardinal
 *             direction over them, one or two destination lines, an arrow
 *             (up, up-left, up-right, or down: one lane), and an optional
 *             exit tab (yellow-free, white on green, at the top right) and a
 *             bottom distance line ("1/2 MILE").
 *   'usDist'  distance sign: destinations with the miles to them.
 */
export type UsShield = {kind: 'interstate' | 'us' | 'state'; num: string};
export type UsGuideFace =
  | {
      kind: 'us';
      shields: UsShield[];
      cardinal: string;
      lines: string[];
      arrow: 'up' | 'left' | 'right' | 'down';
      exit?: string;
      dist?: string;
    }
  | {kind: 'usDist'; rows: [string, string][]};

const GUIDE_FACES_TOKYO: GuideFace[] = [
  {
    kind: 'dir',
    ahead: ['新宿', 'Shinjuku'],
    left: ['池袋', 'Ikebukuro'],
    right: ['渋谷', 'Shibuya'],
    route: '20',
    metro: '317',
    street: ['明治通り', 'Meiji-dori'],
    t: 3,
  },
  {
    kind: 'dir',
    ahead: ['上野', 'Ueno'],
    left: ['王子', 'Oji'],
    right: ['銀座', 'Ginza'],
    route: '4',
    metro: '305',
    street: ['春日通り', 'Kasuga-dori'],
    t: 3,
  },
  {
    kind: 'dir',
    ahead: ['品川', 'Shinagawa'],
    left: ['六本木', 'Roppongi'],
    right: ['新橋', 'Shimbashi'],
    route: '15',
    metro: '415',
    street: ['外堀通り', 'Sotobori-dori'],
    t: 3,
  },
  {
    kind: 'dir',
    ahead: ['中野', 'Nakano'],
    left: ['高田馬場', 'Takadanobaba'],
    right: ['', ''],
    route: '246',
    metro: '302',
    street: ['山手通り', 'Yamate-dori'],
    t: 1,
  },
  {
    kind: 'dir',
    ahead: ['東京駅', 'Tokyo Sta.'],
    left: ['', ''],
    right: ['赤坂', 'Akasaka'],
    route: '1',
    metro: '405',
    street: ['靖国通り', 'Yasukuni-dori'],
    t: 2,
  },
  {
    kind: 'dir',
    ahead: ['浅草', 'Asakusa'],
    left: ['秋葉原', 'Akihabara'],
    right: ['日本橋', 'Nihombashi'],
    route: '6',
    metro: '316',
    street: ['昭和通り', 'Showa-dori'],
    t: 3,
  },
  {
    kind: 'dist',
    rows: [
      ['新宿', 'Shinjuku', 3],
      ['中野', 'Nakano', 6],
      ['八王子', 'Hachioji', 38],
    ],
  },
  {
    kind: 'dist',
    rows: [
      ['渋谷', 'Shibuya', 2],
      ['品川', 'Shinagawa', 7],
      ['横浜', 'Yokohama', 29],
    ],
  },
];
const GUIDE_FACES_NYC: GuideFace[] = [
  {
    kind: 'us',
    shields: [{kind: 'interstate', num: '495'}],
    cardinal: 'EAST',
    lines: ['Queens', 'Midtown Tunnel'],
    arrow: 'up',
    dist: '1/2 MILE',
  },
  {
    kind: 'us',
    shields: [],
    cardinal: 'NORTH',
    lines: ['FDR Dr', 'Bronx'],
    arrow: 'right',
    exit: 'EXIT 12',
  },
  {
    kind: 'us',
    shields: [{kind: 'state', num: '9A'}],
    cardinal: 'NORTH',
    lines: ['West Side Hwy', 'G W Bridge'],
    arrow: 'up',
    dist: '1 MILE',
  },
  {
    kind: 'us',
    shields: [{kind: 'interstate', num: '278'}],
    cardinal: 'WEST',
    lines: ['Brooklyn', 'Staten Island'],
    arrow: 'left',
    exit: 'EXIT 2',
  },
  {
    kind: 'us',
    shields: [
      {kind: 'interstate', num: '78'},
      {kind: 'us', num: '1'},
    ],
    cardinal: 'WEST',
    lines: ['Holland Tunnel', 'New Jersey'],
    arrow: 'down',
  },
  {
    kind: 'us',
    shields: [{kind: 'interstate', num: '87'}],
    cardinal: 'NORTH',
    lines: ['Upstate New York', 'Albany'],
    arrow: 'up',
    dist: '2 MILES',
  },
  {
    kind: 'usDist',
    rows: [
      ['Midtown', '1/2'],
      ['Queens', '3'],
      ['Bronx', '8'],
    ],
  },
  {
    kind: 'usDist',
    rows: [
      ['Downtown', '1'],
      ['Brooklyn', '4'],
      ['JFK Airport', '15'],
    ],
  },
];
/**
 * Guide faces by locale. Every locale has the same number (8) and the same
 * split (GUIDE_DIR), so gen-tile picks the same face ids in every city.
 */
export const GUIDE_FACES = GUIDE_FACES_TOKYO;
/** Number of advance-direction faces (the rest are distance faces). */
export const GUIDE_DIR = 6;

/**
 * Sign id and uv rectangle [u0, v0, u1, v1] (uv 0..1 over the cell, v down)
 * of guide face `k`. Faces sit 2 x 2 in a cell; the uv keeps 0.4 % clear of
 * the quarter lines so fract() in signMat never wraps.
 */
export function guideFace(k: number): {
  id: number;
  uv: [number, number, number, number];
} {
  const i =
    ((k % GUIDE_FACES.length) + GUIDE_FACES.length) % GUIDE_FACES.length;
  const sub = i & 3;
  const u0 = (sub & 1) * 0.5;
  const v0 = (sub >> 1) * 0.5;
  const e = 0.004;
  return {
    id: SIGN.guide.first + (i >> 2),
    uv: [u0 + e, v0 + e, u0 + 0.5 - e, v0 + 0.5 - e],
  };
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

// ---------------------------------------------------------------------------
// Sign locales. Each city preset paints the shared atlas layout (ids above)
// with one locale's words, and gen-tile dresses shopfronts in its street
// style. Ids, counts and per-tenant id lists keep the same lengths in every
// locale, so the sign geometry draws the same random numbers everywhere.

export type SignLocale = 'tokyo' | 'nyc';
/** Locale index the city shader branches on (frame.off.w). */
export const SIGN_LOCALES: readonly SignLocale[] = ['tokyo', 'nyc'];

/** Sign locale of a city preset. */
export function signLocaleOf(type: CityType): SignLocale {
  return type === 'metro' ? 'nyc' : 'tokyo';
}

export interface SignSet {
  locale: SignLocale;
  /** CSS font stack for shop signs, boards and billboards. */
  font: string;
  /** Font stack for road guide signs. */
  guideFont: string;
  /** Words on the vertical signs, by id (32). */
  vertical: string[];
  /** Words on the horizontal (fascia) signs, ids 32..43 (12). */
  horizontal: string[];
  /** Horizontal sign ids per SHOP_TYPE. */
  tenantSigns: number[][];
  /** Vertical sign ids for nobori banners per SHOP_TYPE (empty: none). */
  tenantNobori: number[][];
  /** Text of the square cube signs, ids 72..87 (16). */
  square: string[];
  /** Square sign ids (A-boards) per SHOP_TYPE. */
  tenantSquares: number[][];
  /** Station names (the board cells use the first 4). */
  stations: string[];
  brands: string[];
  /** Road guide sign faces (GUIDE_FACES.length, GUIDE_DIR split). */
  guide: GuideFace[];
  /**
   * Street style (gen-tile): stacks of vertical blades and zakkyo sign
   * columns, nobori banners, noren and plastic-food cases (Tokyo); or
   * mostly fascia signs and awnings naming the shop, a few blades, neon
   * OPEN signs in the windows (New York).
   */
  street: 'tokyo' | 'nyc';
}

export const SIGNS_TOKYO: SignSet = {
  locale: 'tokyo',
  font: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", "Meiryo", sans-serif',
  guideFont:
    '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", "Meiryo", sans-serif',
  vertical: Array.from({length: 32}, (_, id) => verticalWord(id)),
  horizontal: HORIZONTAL_WORDS,
  tenantSigns: TENANT_SIGNS,
  tenantNobori: TENANT_NOBORI,
  square: [
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
  ],
  tenantSquares: TENANT_SQUARES,
  stations: STATION_NAMES,
  brands: BRAND_WORDS,
  guide: GUIDE_FACES_TOKYO,
  street: 'tokyo',
};

/**
 * New York: English words, Helvetica / Arial lettering, green MUTCD guide
 * signs and MTA station boards. Square sign k % 3 == 0 is painted as a disc
 * logo (sign-atlas.ts), so short marks sit there; OPEN (id 79) is a plain
 * cell, as the neon window signs use it.
 */
export const SIGNS_NYC: SignSet = {
  locale: 'nyc',
  font: '"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif',
  guideFont:
    '"Highway Gothic", "Roadgeek 2005 Series E", Overpass, "DIN Alternate", "Arial Narrow", Arial, sans-serif',
  vertical: [
    'HOTEL',
    'BAR',
    'THEATER',
    'PIZZA',
    'DELI',
    'CAFE',
    'DINER',
    'JAZZ',
    'PAWN',
    'TATTOO',
    'PUB',
    'GRILL',
    'HOTEL',
    'LIQUORS',
    'DRUGS',
    'BOOKS',
    'CINEMA',
    'TAVERN',
    'CLUB',
    'BAGELS',
    'LOANS',
    'STEAKS',
    'SHOES',
    'BAR',
    'PARKING',
    'HOTEL',
    'GYM',
    'NOODLES',
    'DANCE',
    'SALOON',
    'BILLIARDS',
    'ROOMS',
  ],
  horizontal: [
    'PIZZA',
    'DINER',
    'BAGELS',
    'BAR & GRILL',
    'COFFEE SHOP',
    'DELI GROCERY',
    'PHARMACY',
    'NAIL SALON',
    'CLEANERS',
    'BANK',
    'LAUNDROMAT',
    'LIQUORS',
  ],
  // konbini -> deli / pharmacy; restaurant; boutique -> salon, cleaners;
  // office -> bank, laundromat, liquor store (lobbies read as any of them).
  tenantSigns: [
    [37, 38],
    [32, 33, 34, 35, 36],
    [39, 40],
    [41, 42, 43],
  ],
  tenantNobori: [[], [], [], []],
  square: [
    'P',
    '24 HR',
    'BAR',
    'Rx',
    'BEER',
    'HOTEL',
    'ATM',
    'OPEN',
    'PIZZA',
    'DELI',
    'CAFE',
    'LOANS',
    'SALE',
    'GRILL',
    'TATTOO',
    'BAR',
  ],
  tenantSquares: [
    [73, 75],
    [74, 76, 80, 82, 85],
    [79, 84],
    [72, 78],
  ],
  stations: [
    'Times Sq-42 St',
    'Union Sq',
    'Canal St',
    'Grand Central',
    '14 St',
    'Fulton St',
    'Columbus Circle',
    'Delancey St',
  ],
  brands: [
    'SPARKLE',
    'METRO',
    'BOLT',
    'EMPIRE',
    'LIBERTY',
    'HUDSON',
    'SKYLINE',
    'GOTHAM',
    'GEN CITY',
    'NOVA',
  ],
  guide: GUIDE_FACES_NYC,
  street: 'nyc',
};

export const SIGN_SETS: Record<SignLocale, SignSet> = {
  tokyo: SIGNS_TOKYO,
  nyc: SIGNS_NYC,
};

/** Square sign id of the neon OPEN sign in shop windows (nyc street style). */
export const SIGN_OPEN = 79;

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
