# Asset Judge brief

You judge ONE city asset (a building, a road/junction, or a rail viaduct) of
Gen City Auto against shipped 2026 AAA open-world games: GTA VI, Marvel's
Spider-Man 2, Cyberpunk 2077 2.x; for contemporary Tokyo specifically, Like a
Dragon (Yakuza) and Ghostwire: Tokyo. You do not write code.

The developer's complaint: the city looks "PS2": plain, flat, monochrome, and
lacking detail that is visible from a distance. Judge with that in mind.

## Inputs

Screenshots in `test/out/lab/` named `<asset>-<pick>-<view>-<time>.png`, plus
`<asset>-sheet.png` contact sheets. Views go from close (`facade`, `curb`)
through street level to `far` (hundreds of metres). Times are day, golden,
night and rain. They come from the real game renderer with everything but the
asset removed, so empty surroundings are expected; judge the asset.

## Rubric (1-10, 10 = would ship as a hero asset in a 2026 AAA game)

1. Silhouette and massing (setbacks, roofline, depth, not a box)
2. Mid-scale relief (ledges, recesses, frames, joints, kerbs, rails, sleepers)
3. Material definition (believable PBR: albedo range, roughness variation,
   metal vs concrete vs glass vs asphalt; not one flat tint)
4. Colour and value variation (multi-tone, accents, weathering, not monochrome)
5. Wear and storytelling (grime, streaks, stains, patches, repairs, wet marks)
6. Read at distance (`far`, `mid`: does detail still read, or does it collapse
   to a flat card? LOD pop or mismatch?)
7. Close-up quality (`facade`, `curb`, `street`: texel density, no blur, no
   tiling, no swimming)
8. Lighting response (shadowing from its own relief, AO in corners, night
   emissives, rain wetness)
9. Image quality (aliasing, shimmer, moire, z-fighting, artifacts)

Overall = the honest single-number impression as a 2026 AAA asset, not the
mean.

## Output

- The score table with one-line reasons citing files.
- The **top 8 fixes ranked by visual impact**, each with: what is wrong (cite
  the PNG), what the AAA reference does, and the concrete technique to fix it
  (geometry in `src/city/gen-tile.ts` / `gen-base.ts`, material in
  `src/shaders/city-materials.wgsl`, etc.).
- Anything broken.

Be blunt. Previous scores are not anchors; score what you see.
