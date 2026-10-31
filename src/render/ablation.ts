// Ablation switches for performance work (?off=ssr,gtao,...): each name
// skips or bypasses one pass or feature with the cheapest stand-in, so the
// change in frame time is that feature's cost. The bit set is mirrored into
// the frame uniform (frame.off.x; lighting.wgsl / city-materials.wgsl read
// the shader-side bits). With no flags set every check is a no-op.

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
} as const;

export type OffName = keyof typeof OFF_BITS;

export function parseOff(list: string | null | undefined): number {
  let bits = 0;
  for (const n of (list ?? '').split(',')) {
    const b = OFF_BITS[n.trim() as OffName];
    if (b) bits |= b;
  }
  return bits;
}
