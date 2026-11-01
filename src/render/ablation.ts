// Ablation switches for performance work (?off=ssr,gtao,...): each name
// skips or bypasses one pass or feature with the cheapest stand-in, so the
// change in frame time is that feature's cost. The bit set is mirrored into
// the frame uniform (frame.off.x; lighting.wgsl / city-materials.wgsl read
// the shader-side bits). With no flags set every check is a no-op.
//
// Flags past bit 31 are worth 2 ** (32 + k): the set is a plain number (up
// to 2 ** 53), so combine with orOff() / test with hasOff(), not | and &.
// (& still works for the low flags: ToInt32 keeps the low word.) The high
// word is mirrored into frame.off.z.

const HI = 2 ** 32;

export const OFF_BITS = {
  ssr: 1 << 0, // lighting: screen-space reflections
  cityrefl: 1 << 1, // lighting: height-map skyline reflection march
  skyvis: 1 << 2, // lighting: sky-visibility horizon search
  contact: 1 << 3, // lighting: contact shadows + vehicle contact occlusion
  lights: 1 << 4, // no point lights uploaded
  shadows: 1 << 5, // no shadow passes, shadow lookups = 1
  gtao: 1 << 6, // no GTAO dispatch, AO = 1
  godrays: 1 << 7, // no god-ray dispatch
  mdof: 1 << 8, // no motion blur / DOF pass (tonemap reads TAA output)
  bloom: 1 << 9, // no bloom chain
  taa: 1 << 10, // no TAA (and no motion blur / DOF)
  clouds: 1 << 11, // no cloud march dispatch
  rain: 1 << 12, // rain hook skipped
  sprites: 1 << 13, // light sprite hook skipped
  vehicles: 1 << 14, // vehicle hook skipped (all passes)
  matcheap: 1 << 15, // city-materials: flat colour per material
  terrain: 1 << 16, // terrain draw skipped
  water: 1 << 17, // water draw skipped
  city: 1 << 18, // city G-buffer draw skipped
  lit: 1 << 19, // lighting kernel: albedo + emissive only
  peds: 1 << 20, // pedestrians not drawn
  traffic: 1 << 21, // traffic not drawn
  c3: 1 << 22, // farthest shadow cascade not rendered
  c2: 1 << 23, // third shadow cascade not rendered
  facfar: 1 << 24, // city-materials: far facade path at every distance (not a saving)
  farcull: 1 << 25, // cull: no distance cut of fine base detail (a cost; A/B shots)
  streak: 1 << 26, // lighting: no wet-ground lamp streaks / film glow (wetGround = 0)
  reach: 1 << 27, // lighting: tile light cull without the wet streak reach (2.5x radius)
  gndrefl: 1 << 28, // lighting: no SSR / skyline reflection on CLASS_GROUND
  roadrain: 1 << 29, // city-materials: road / junction rain layer skipped
  rcvcull: 1 << 30, // cull: shadow casters not culled to their cascade's receivers (A/B shots)
  shcache: HI * (1 << 0), // shadows: no static shadow-map cache (every cascade redrawn every frame)
  hrefl: HI * (1 << 1), // lighting: SSR + skyline reflections traced at full res in the lighting kernel
  ctile: HI * (1 << 3), // lighting: vehicle contact occlusion not culled per tile (every pixel walks every car)
  hskyvis: HI * (1 << 4), // sky visibility traced at full res in lighting (not at half res in the GTAO pass)
  farshade: HI * (1 << 5), // city: no far-specialised material pipeline (every opaque cluster through cityOpaque)
} as const;

export type OffName = keyof typeof OFF_BITS;

/** Low (frame.off.x) and high (frame.off.z) words of a flag set. */
export function offWords(bits: number): [number, number] {
  return [(bits % HI) >>> 0, Math.floor(bits / HI) >>> 0];
}

export function hasOff(bits: number, name: OffName): boolean {
  const [lo, hi] = offWords(bits);
  const [blo, bhi] = offWords(OFF_BITS[name]);
  return ((lo & blo) | (hi & bhi)) !== 0;
}

export function orOff(a: number, b: number): number {
  const [alo, ahi] = offWords(a);
  const [blo, bhi] = offWords(b);
  return ((ahi | bhi) >>> 0) * HI + ((alo | blo) >>> 0);
}

export function parseOff(list: string | null | undefined): number {
  let bits = 0;
  for (const n of (list ?? '').split(',')) {
    const b = OFF_BITS[n.trim() as OffName];
    if (b) bits = orOff(bits, b);
  }
  return bits;
}
