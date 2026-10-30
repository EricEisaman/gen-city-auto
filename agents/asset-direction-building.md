# Asset direction: building (midrise first, generalises to all kinds)

Specimen: `building #46441 midrise 17 m` (5 floors x 3.3 m, ~18 x 16 m,
charcoal "nichokake" tile, office windows). Renders:
`test/out/lab/building-midrise0-{street,facade,mid,far,shell,aerial,rear,orbit}-{day,golden,night,rain}.png`.

The developer's verdict ("PS2: plain, flat, monochrome, nothing that reads from
a distance") is correct, and the cause is clear from the renders. Up close the
tile, reveal parallax and interiors are good. But the building is one
extruded box with **one material, one window, one colour, repeated on all four
sides and every floor**. At 30 m and beyond, every bit of detail sits at a
frequency that the mip chain averages away. Nothing at 1-10 m scale breaks the
value field: no zones, no relief, no silhouette. The work is mostly about
**macro structure**, not more micro detail.

---

## 1. Reference: a contemporary Tokyo midrise (5-9 floors, 1985-2015)

Think of a Kanda or Shibuya-side-street office/zakkyo building, or a 7-floor
"mansion" in Nakano.

### At 2 m (pedestrian)
- **Base (0-4.5 m)**: the ground floor is taller than the upper floors
  (4.0-4.8 m vs 3.0-3.4 m) and built differently. Options: flamed or polished
  granite cladding in 900 x 600 mm slabs (albedo 0.10-0.20, rough 0.3-0.5,
  2 mm dark joints); a recessed glass lobby with an aluminium door, a
  stainless nameplate, a mailbox bank, and a 1.2-1.8 m deep concrete or steel
  entrance canopy with downlights; or a shopfront. The base is darker and
  glossier than the body above it.
- **Body**: 45 x 95 mm or 45 x 45 mm porcelain mosaic tile, or 240 x 60 mm
  nichokake tile, with ±8-12 % tile-to-tile tone variation (kiln batches).
  Grout recessed 2-3 mm. Alternatives are spray-textured render (lysine) or
  ALC panels with 600 mm joints.
- **Windows**: anodised aluminium sash, silver (albedo 0.55, metal) or
  bronze/stainless (0.25), with 40-60 mm visible frame. They are never black.
  Glass is set 100-200 mm back on small buildings and 300+ mm on precast. Many
  windows have a white lace curtain or vertical blinds, some are open, and
  bathroom windows have frosted wired glass (a white diamond mesh).
- **Clutter**: AC condensers (800 x 550 x 290 mm, warm white 0.65) on wall
  brackets or balcony floors, each with a 50 mm white insulated pipe running
  to a hole. Vertical PVC drainpipes (100 mm, grey 0.5). Gas meters. Steel
  stair railings painted dark green or brown.

### At 30 m (across the street)
- **Tripartite zoning is the dominant read**: dark or glossy base, light body,
  and a solid parapet or crown band 0.8-1.5 m tall, often a different tile
  tone or capped with aluminium coping (a bright 50-100 mm line against the
  sky).
- **Vertical accent**: a stair or elevator core expressed on the street face
  (a 2.4-3.5 m wide strip of glass block, louvres or a different tile) running
  full height and ending in a penthouse. Corners are usually a solid pier of
  0.6-1.2 m, so **windows never wrap or get cut at a corner**.
- **Window rhythm**: 3-5 bays per front with equal end piers. Windows are
  about 35-50 % of the wall, so the facade reads as alternating light and dark
  bands.
- **Faces differ**: the front is designed. Side walls on a lot line are blank
  painted concrete or ALC (light grey 0.45-0.55) with a few small windows, rust
  and rain streaks, and drainpipes. The rear has a steel fire stair, AC units
  and pipes.
- **Weathering**: dark rain-wash streaks hang 1-4 m below the coping, the sill
  ends and the ledge ends. A grime gradient covers the bottom 1 m. One face is
  sun-bleached.
- **Signage** (when tenants exist): a vertical tenant-sign stack beside the
  core and the building name on the penthouse or canopy.

### At 300 m (skyline)
What survives is the silhouette (penthouse, elevated water tank on a steel
stand, green mesh roof fence, antenna or billboard frame), the 3-zone value
stripe (dark base / light body / bright coping line), the overall colour (most
midrises are LIGHT: white, beige or pale grey, albedo 0.35-0.6, with a few
dark-brick and charcoal ones), the window rows as a faint horizontal
striation, and at night the pattern of lit windows. Lit windows are a sparse,
irregular mosaic of warm (2700 K) and cool (5000 K) rectangles at varied
brightness, plus always-on cool stairwell lights stacked in one column.

---

## 2. Gap list (what our renders lack)

| # | Gap | Evidence |
|---|-----|----------|
| G1 | **No zoning.** Same tile and same window from the ground floor to the roof. The ground floor is just floor 1 again: no lobby, canopy, plinth or door. | `street-day`, `facade-day`, `rear-golden` |
| G2 | **All four sides identical.** The rear and sides have the same windows as the front, so it reads as a "cube with a texture". | `orbit-day`, `rear-day`, `aerial-day` |
| G3 | **Windows cut by corners.** The window grid's `u` runs continuously around the footprint (`walls()`), so bays straddle corners and half-windows appear at the edges. Classic procedural tell. | `facade-day` (left and right edge windows clipped), `street-day` corner |
| G4 | **Black window frames** (`vec3f(0.08)`, 0.07 m frame) on a dark wall. They read as cartoon outlines up close and as a grey smear at distance. | `facade-day`, `street-day` |
| G5 | **No macro value structure.** Charcoal wall (palette 10 x 0.68 = albedo 0.136) with dark windows, so the window/wall contrast is about 1.3:1. At 300 m the building is a near-black cube. Streak noise is 3 cycles/m, so it averages to nothing past 20 m. | `mid-day`, `far-day`, `shell-day` (crops: a black block with a faint grid) |
| G6 | **Silhouette is a box** plus one 3.2 m stair cube. No parapet coping line, water tank stand, fence or penthouse sign. LOD1 is the same. | `orbit-day`, `rear-golden`, `shell-*` |
| G7 | **Facade clutter is noise, not structure.** AC boxes are placed at random `t`, at random floors, floating on the wall with no pipes, not aligned to windows. They read as white specks. | `street-day` left face |
| G8 | **Night is flat.** Most windows are lit, and lit ones clip to near-white with no colour temperature spread. There are no stairwell or entrance lights and no curtain silhouettes. The facade itself is pitch black. | `street-night`, `facade-night`, `shell-night` |
| G9 | **Rain doesn't touch the facade.** `facadeMat` never calls `applyWetness`, so rain renders as dim day: no darkened tile, no gloss, no run-off. | `street-rain`, `facade-rain` |
| G10 | **Ledges wrap all four sides at every floor**, identically, in cream concrete. They are fine as one accent but look applied when they repeat everywhere. | `street-day` |

---

## 3. Ranked changes (impact per hour)

All facade logic stays in `facadeMat`, so it runs at LOD0 and LOD1 alike.
That is how detail reaches 300 m. Every new shader pattern must fade to its
mean by pixel footprint (`foot = max(length(dWorldX), length(dWorldY))`, as
`M_CONCRETE` does) so it never aliases.

### R1. Per-edge facade role + corner-safe bay grid  (geometry plumbing + shader) — HIGHEST
**Files**: `src/city/gen-tile.ts` `walls()`, `building()`, `facadeParam()`;
`src/shaders/city-materials.wgsl` `facadeStyle()`, `facadeMat()`.

1. **Edge role in param bits 21-22** (free; packMat's param is 24 bits):
   `0 = front` (`i === b.front`), `1 = street side` (`b.frontage[i]`),
   `2 = party wall` (no frontage, not opposite the front),
   `3 = rear` (no frontage and `dot(n_i, n_front) < -0.7`).
   For `b.front < 0`, treat the longest edge as the front. Give `walls()` an
   optional `roles?: number[]` argument and OR `role << 21` into
   `mat >> 8`'s param for each edge's quad.
2. **Corner-safe grid**: make `u` restart at 0 on every edge and stretch it so
   an integer number of bays fits. Port `facadeStyle`'s bay to TS (the WGSL
   `hashu` is the Wang hash: `(v^61)^(v>>>16); v=imul(v,9); v^=v>>>4;
   v=imul(v,0x27d4eb2d); v^=v>>>15`). Then
   `bay = 1.5 + 1.7*hashuf(hashu(imul(style,747796405)+1)^0x1234)`, followed by
   `count = max(1, round((len - 1.2) / bay))` and `scale = count*bay/(len-1.2)`.
   Split each edge into three quads: a 0.6 m **corner pier** at each end and
   the window field between them. The piers are flagged with param bit 23
   (`solid`: wall material, no windows). The field gets `u` from 0 to
   `(len-1.2)*scale`, so it holds exactly `count` whole bays. The shader needs
   only one change: `if (solid) { skip the window branch }`. Geometry cost is
   +2 quads per edge. Windows are then never cut, and the corners read as
   piers.
3. **Shader per role** (in `facadeStyle`, take `role`):
   - front: as now (the designed face).
   - street side: same family, `winW *= 0.8`.
   - party wall (2): **no windows on 70 %** (hash), otherwise one column of
     0.6 x 0.9 m windows in every 3rd bay. Material is painted render or ALC:
     DETAIL_CONCRETE at tile 2.4 m, albedo `mix(0.42,0.55,h)` warm grey, ALC
     joints every 0.6 m horizontally (dark line, 0.008 m, fade by foot), rust
     streaks under any fixtures, and stronger rain-wash (R3) at 1.5x.
   - rear (3): render material, windows `winW 0.45, winH 0.45`, and 35 % frosted
     (`albedo 0.7`, emissive = interior average x0.6, with a 25 mm diamond wire
     mesh fading by foot).

This one change kills "cube with a texture" from every angle, and it holds at
LOD1 because it is all shader-side plus a few quads.

### R2. Tripartite zoning: base, body, crown  (shader + small geometry) — HIGH
**Files**: `facadeMat()`; `building()` (midrise/pencil/apartment path, lines
~779-817).

- **Base zone** = `floorIdx == 0` on front and street-side roles. Non-shop:
  granite cladding (`albedo = mix(vec3(0.11,0.105,0.10), vec3(0.20,0.19,0.18), h)`,
  rough 0.35, joints 0.9 x 0.6 m at 0.004 m, `metal 0`) with a **lobby bay**.
  Use the bay nearest the edge centre (or the bay under the core, see R5)
  for a full-height glazed door (`winW 0.85, sill 0, winH 0.85`), with an
  aluminium frame (R4 colour) and a bright interior at night
  (`vec3(1.0,0.92,0.8)*1.5` emissive). All other base bays get large fixed
  glass `winW 0.8, winH 0.7` with dark lobby interiors. Shops keep their
  current shopfront code.
- **Raise the ground floor**: in `layout.ts` the midrise floorH is uniform 3.3.
  Do not change the layout. Instead, in the shader, shift floors so floor 0 is
  4.2 m: `let g = 4.2; ly/floorIdx` are computed on `uv.y - (g - floorH)` for
  `uv.y >= g`. Mirror this in the `band()` ledge loop (`base + g + (f-1)*floorH`).
  The building gets 0.9 m taller per the shader: use `mainTop` as is and let
  the top floor shrink. The crown band (below) absorbs it.
- **Crown**: emit a solid crown band with geometry, at all LODs. Raise the
  existing cornice into a **0.9-1.2 m parapet face** flush with the wall
  (`walls(m, fp, mainTop, mainTop + 1.0, base, crownMat, aux)`, where
  crownMat = wallMat with bit 23 `solid` set and a crown tone flag; reuse
  `podium` bit 20 semantics if bits run out). Add an **aluminium coping cap**:
  `band(m, fp, mainTop + 1.0, 0.08, 0.06, packMat(CM.metal))`. This bright
  line against the sky is the single best distance cue. Crown tone: body tile
  x `mix(0.75, 1.25, h)` (sometimes lighter, sometimes darker; never equal).
- **Ledges**: keep only every 3rd floor's deep band (office) or none
  (residential, 40 %). Keep the cream concrete only when the body is dark,
  otherwise use body-tone tile (`wallMat` + `solid`). This stops G10.

### R3. Macro value field: palette weighting, frames, large-scale weathering (shader) — HIGH
**File**: `city-materials.wgsl` `wallPaletteRaw`, `facadeStyle`, `facadeMat`.

- **Palette distribution**: Tokyo midrises are mostly light. Re-weight the
  12 entries so that `≈60 %` land on off-white, white, beige or light grey
  (raw 0.7-0.82), `25 %` on mid (0.5-0.62), and `15 %` on dark
  (brown tile, charcoal). Keep the `*0.68` scale. Add a **hue jitter** per
  building: `wall *= 1.0 + vec3(0.04,0.0,-0.04)*(h-0.5)*2` so neighbours never
  match. For dark buildings (`luminance(wall) < 0.2`), force a light crown
  and coping (R2) and light sash frames (R4) so the value structure survives.
- **Window/wall contrast at distance**: when `foot > 0.08` (window detail
  sub-pixel), blend the window cell toward its *average* radiance, not toward
  the wall. That keeps a striped facade at 300 m. Target daytime average
  window luminance ≈ 0.35-0.5x a light wall, giving clear dark bands.
- **Large-scale weathering** (all fade-safe, 1-10 m wavelengths):
  - *Coping wash*: below the crown, `streak = smoothstep(0.45,0.85,
    valueNoise(vec2(uv.x*0.9, 7.0))) * smoothstep(5.0, 0.0, distFromTop)`,
    darken `*0.75` (tile) or `*0.65` (render). This needs the wall top: pass
    the height in the cap-to-base distance by setting the crown quad's
    `uv.y` normally and storing `mainTop - base` for walls in `aux`'s high
    byte (aux is the hash seed; masking 8 bits off it is fine). Use 0.25 m
    units, so max 63 m. For towers that exceed this, clamp (they use
    `curtainWall` mostly).
  - *Ledge and sill ends*: the existing per-window drip, but with column width
    1/0.7 m and length 1.5 m, so it reads at 30 m.
  - *Base grime*: `mix(0.72, 1.0, smoothstep(0.0, 1.2, uv.y))` (currently
    0.7 over 3 m: too soft to notice, too long to be grime).
  - *Per-face sun bleach*: `wall *= mix(0.93, 1.07, hashuf(aux ^ role ^ edgeIdx))`.
    Each face gets its own tone, so corners read in flat light.
  - *Tile batch patches*: `floor(uv / vec2(1.92, 1.38))` cells (2x2 tiles of the
    0.96 detail) times `0.94 + 0.12*hash`, kept until foot ≈ 0.5 m. This gives
    the "speckled mosaic" texture you see at 30-80 m in real tiled facades.
- **Sash frames (G4)**: replace `vec3f(0.08,0.08,0.09)` with a per-building
  sash: silver `vec3(0.55,0.56,0.57)` (55 %), bronze `vec3(0.18,0.14,0.10)`
  (30 %), white `vec3(0.75)` (15 %), `metal 0.8, rough 0.3`. Frame width
  `0.07 → 0.045`, and add a meeting rail (vertical mullion at the window
  centre for `roomSize.x > 1.2`, 0.04 m). Sliding sashes are the Japanese
  default.

### R4. Night: sparse, varied, tone-mapped windows plus stair and entrance light (shader) — HIGH, cheap
**File**: `interior()`, `facadeMat()` window and base branches.

- **Lit fraction** at 22:00: residential `mix(0.03, 0.30, night)` per room
  (now 0.34). Office: `sectionLit < mix(0.08, 0.30, night)`, rooms in a lit
  section `0.75`.
- **Brightness spread**: `light *= mix(0.35, 1.3, r2*r2)`. Cap so the brightest
  lit window, after exposure, sits at about 85 % white, never clipped: scale
  the `warm` emissive term by `0.55` and check `street-night`.
- **Colour temperature per room**: residential picks from
  `2700K (1.0,0.70,0.42)`, `3500K (1.0,0.82,0.60)`, `5000K (0.92,0.96,1.0)` at
  weights 0.5/0.3/0.2. Offices pick per section 4000-6500 K (existing).
- **Curtains**: when lit and `cover > 0`, the curtain becomes a translucent
  warm glow (`inside*0.6 + vec3(1.0,0.85,0.65)*0.25`) with 0.12 m fold
  stripes, not a flat tone. Add a 15 % chance of a person silhouette against
  a lit curtain.
- **Stair column**: in the core column (R5), or failing that the bay nearest
  one corner on side or rear faces, each floor has a small 0.9 x 1.2 m window
  that is **always lit** at night, cool `vec3(0.85,0.95,1.0)*0.9`. This stack
  of identical lights is the classic Tokyo night read at 300 m.
- **Entrance**: the lobby bay (R2) is lit `vec3(1.0,0.9,0.75)*1.6`, plus one
  `lights.add(..., 8, [1.0,0.85,0.65], LightKind.sign)` in `building()` at
  the canopy, so the sidewalk gets a pool.
- **Facade at night**: the wall shouldn't be black. Add a faint window-spill
  term on the wall for 0.4 m around lit windows. This needs the lit state, so
  compute `lit` for the cell's own window in `facadeMat` and add
  `wall * warm * 0.04 * smoothstep(0.4, 0.0, distToWindow)` to emissive.

### R5. Silhouette and relief that survive LOD1  (geometry) — MEDIUM-HIGH
**File**: `building()` roof clutter (~1326-1502) and massing (~779-817).

- **Expressed core**: on the front (or a street side, 50/50), place a
  2.4-3.2 m wide core strip at one end of the edge, `walls()` over it pushed out
  0.25 m with its own material (glass block = `CM.glass` param flag, or
  vertical louvres = `fins()` at spacing 0.15, depth 0.12, `CM.metal`),
  rising 2.6 m above `mainTop` as the **penthouse** (replace the current
  centred 3.2 m stair cube with this, so it is at the facade edge as in real
  buildings). Building-name sign on the penthouse front: `signPanel` 2.0 x 0.5 m
  flush, `SIGN.horizontal`. Emit the core at both LODs (LOD1: one box).
- **Elevated water tank** (55 % of midrise and apartment over 12 m): FRP panel
  tank `box 2.4 x 1.8 x 2.0 m`, albedo 0.75 off-white (`CM.paint 0xd1`, with
  a 1 m panel grid in the shader if cheap), on a 1.5 m steel stand of 4 legs
  plus X braces (`CM.paint 0x90`), with a cage ladder. LOD1: tank box plus one
  stand box. Replace the cylinder tank used now. Square FRP tanks are what
  Tokyo roofs have.
- **Roof fence**: 30 % get a 1.8 m green mesh fence (`CM.paint`, a dark green
  ≈ `(0.15,0.25,0.18)`) set 0.5 m in from the parapet. Use a two-sided quad
  with an alpha-like shader mesh pattern if available, otherwise posts every
  2 m plus top and bottom rails. This replaces the 2.0 m single-rail "safety
  rail", which is invisible.
- **Antenna mast** (25 %): 4-6 m pole with 2-3 crossbars on the penthouse.
- **Balconies for residential midrise** (`office == false`): reuse the
  apartment balcony code on the front only, with 1.1 m solid upstand panels in
  body tone or frosted glass (`CM.glass 4`). Put an AC unit on 50 % of the
  balconies. This gives deep horizontal shadow bands that read at 300 m. LOD1:
  one `band()` per floor, 1.0 m deep, 1.1 m tall.
- **Entrance canopy**: a 1.5 m deep x 4 m wide x 0.25 m slab at
  `base + 3.6`, over the lobby bay. LOD0 only, but it casts a shadow shape on
  the base.

### R6. Facade wetness in rain  (shader) — MEDIUM, very cheap
**File**: `facadeMat()`.

Call `applyWetness(&s, world, 0.0, porous)` on wall returns, with porous
`0.35` for tile and `0.8` for render or granite, so walls darken by 0.75-0.55
and gloss up. Then add rain-only run-off: scale the R3 coping and sill
streaks by `1 + 1.5*frame.weather.z`, and set `rough = 0.15` inside the
streaks (wet trails shine). Window glass: add a droplet normal (`hash22` cells
of 0.03 m, fade by foot) times `frame.weather.y`. Ledges and coping are
up-facing, so `applyWetness` makes them glossy, which gives bright rim lines
in overcast light.

### R7. Clutter as structure: AC units, pipes, side and rear service  (geometry) — MEDIUM
**File**: `building()` "Facade clutter" (~1251-1324).

- Place AC units **per window**, not at random `t`: for side and rear roles,
  for 40 % of windows put the unit centred under the sill (`y = floorY +
  sill - 0.35`), 0.25 m off the wall on two bracket beams. Add a 0.05 m white
  pipe beam from the unit side to the wall and up 0.4 m. Compute the window
  bay with the same TS bay function as R1 so the units line up.
- Use AC colour `vec3(0.68,0.67,0.63)` (current `0xe0` → paint 0.62, fine)
  with a dark fan grille disc on the front: a `CM.frame` square 0.4 m inset
  0.01 m. Fan grilles at window spacing read at 30 m as a regular dot row.
- **Drainpipes**: 2 per party or rear wall, at 0.3 m from a corner, full
  height, `cylinder r 0.05`, `CM.paint 0x90`, with offset elbows at the crown.
  This adds vertical lines on blank walls.
- **Exterior stair**: 25 % → 60 % for midrise when the rear or party wall is at
  least 6 m. Put it on the rear role edge, not `(b.front + 1)`. Add stringer
  side panels (0.25 m deep beams), not only slabs.

### R8. Ground-floor street life without signage density  (geometry) — LOW-MEDIUM
Even at low `b.density`, a midrise front gets: 1 vertical name or tenant
sign at the core edge (`blade`, span 3-4 floors), a mailbox, an intercom
plate, and 2 bicycles or a vending machine 40 % of the time (reuse
`fillProps` vending). The lab specimen has none of this, so the lab is
showing the worst case. Fix it at the generator, not by raising density.

### LOD1 checklist (the `shell-*` views must look like `far-*`)
Must be present at LOD1: crown parapet and coping band (R2), core and
penthouse box (R5), tank and stand boxes (R5), per-floor balcony bands
(R5, residential). Shader-side zoning, roles, weathering and night (R1-R4,
R6) apply automatically. Today's LOD1 crop is a black grid cube. After these
changes it should read as a dark base, a light striped body, a bright coping
line, a tank silhouette, and a column of stair lights at night.

### Generalisation
- **pencil**: R1-R4, R6 and R7 apply as is. Narrow fronts (count = 1-2 bays)
  benefit most from corner-safe bays. Always give pencils the core strip,
  since it is their whole facade.
- **apartment**: roles are the big win. Corridor side = rear role with
  open-gallery geometry (1.2 m slab plus a 1.1 m upstand per floor, doors every
  bay); balcony side = front.
- **tower / glass podium**: R2 base and crown on the podium (`podium` bit),
  R4 night spread in `curtainWall`, R5 crown already exists. Add the coping.
- **house**: R3 palette and sash colour, R6 wetness. Houses skip roles.

---

## 4. Don'ts

- **No black outlines.** Frames, ledge undersides and seams must never be
  below albedo 0.12 unless they are actual voids. Black frames on every
  window is the strongest "PS2" signal in the current renders.
- **No identical faces.** Never the same window program on all four sides or
  all floors. Any building must show at least 3 distinct facade programs
  (base, body, crown) and 2 face roles.
- **No cut windows** at corners, setbacks or wall ends.
- **No high-frequency-only detail.** Anything under 0.3 m must fade by
  `foot`, and it must be backed by a 1-10 m pattern that carries the same
  idea at distance (tile → batch patches, sill drips → wash streaks).
- **Don't darken everything for grit.** Tokyo is pale and clean-ish. Weathering
  is local (under copings and sills, bottom 1 m), not a global multiply. Keep
  most walls at 0.35-0.6 albedo.
- **No randomly scattered boxes.** Every prop attaches to something (window,
  bracket, pipe, roof grid) and aligns to the bay grid.
- **No uniformly lit, clipped night windows.** Brightness and colour must vary,
  and most rooms must be dark.
- **No cylinder water tanks on low roofs** and no centred stair cube.
  Penthouses sit at an edge over the core.
- **Don't add bloom or post effects to fake richness.** The fixes are
  structural.

---

## Round 6: from 6 to 8

Scores so far: 4.0, 5.0, 5.3, 5.5, 6.0, 6.0. The judge's lists have turned
into inventory ("add laundry poles, add a lamp"). The inventory is now
basically complete: canopy, konbini, vending, signs, fire stair, tank,
railings, balconies, party-wall ghost, vinyl, rain. Another round of props
will not move the score, because **every new prop is rendered with the
same flat image formation**. What separates this 6 from an 8 is not
content. It is how light, edges and materials behave across *all* content
at once:

- **Nothing is grounded.** Canopies, ledges, sills, signs and the wall foot
  get no occlusion. I measured this with `debug=8` (AO view), using
  `node test/puppeteer/lab.mjs building --kind=midrise --views=street,facade,rear --times=day --debug=8`.
  AO under the 1.5 m konbini canopy, at the foot of the 17 m wall, under
  the floor ledges and on open wall all tonemap to 148-158/255. That means
  AO is about 0.95-1.0 everywhere. Under the canopy it should be about 0.4.
  The pavement at the wall foot is 191 vs 195 in the open: no darkening
  at all. This is the single biggest "CG / last-gen" tell in
  `street-day`, `facade-day`, `rear-day` and `service-day`. It is also why
  the judge keeps calling detail "too subtle": in shade, lighting is ambient
  only, and ambient without occlusion erases relief.
- **Edges are last-gen.** Wires and rails break into dashes (`service-day`
  pole wires, `street-day` roof rail, `aerial-day` railings). Every beam and
  corner is a razor 90-degree edge with no highlight line. Ledge beams map
  the tile texture stretched (cmesh `beam()` writes v = 0..1 per face
  regardless of thickness, so a 0.18 m ledge face squeezes a 0.96 m tile
  into it: the smeared brick on the ledges in `facade-day`).
- **Materials respond to light like a texture, not a surface.** In shade
  (the whole front in day views), tile relief and cavity do nothing, because
  they only modulate albedo and ambient is nearly isotropic. Five or six
  overlapping low-frequency noises (0.7 m mottling, 2.4 m patches, wash,
  fringe, efflorescence, face tone) average into grey mud. That is the
  "smeary brick" in r5.
- **Night breaks across LOD.** I confirmed this with `far-night` vs
  `shell-night` crops. The shell has a cyan/pink wash over the upper floors
  and top floor that LOD0 does not have. That is the `shellLod` neon block
  in `facadeMat()` (city-materials.wgsl ~1619-1630), stacked on the zakkyo
  sign lights that `building()` now emits at LOD1 too.
- **The lab undersells it** (see S2): 4 of 9 views are a 40-150 px building
  in sand dunes, with no neighbours for the skyline-based sky occlusion,
  city reflection and canyon bounce to work with.

### Verdict on the candidate list

| Candidate | Verdict |
|---|---|
| Light transport (AO, contact shadows, bounce) | **Agree, #1.** Measured as absent. Moves every daytime view. |
| Lab context penalty | **Agree, #2 by impact per hour.** Glass reflects empty sky. `skyVisibility()` and `cityReflection()` find no neighbours. Far/shell frame the asset at ~40 px. The judge's distance score (5.0) is partly an artefact of this. |
| Thin-geometry AA | **Agree, #3**, together with chamfered edges (edge quality as one system). |
| Material texel quality (procedural brick) | **Partly disagree.** The detail texture is 512 px per 0.96 m (1.9 mm/texel) with full mips and 8x aniso, so resolution is not the bottleneck. The problems are response (cavity not used as occlusion, no per-tile hash beyond tilt), contrast (grout/tile tones too close), UVs (beams) and noise stacking (mud). Fix those (#4). Do not write a procedural brick generator. |
| Real window depth everywhere | **Partly agree.** The main window grid already has a good 0.30 m shader reveal (city-materials.wgsl ~1992-2045). The windows that read flush take *other code paths with no reveal*: the stair/core glass-block bay (`stairBay`, ~1963), party-wall and side small windows, and frosted rear panes. Fix: one opening function for all of them (shader), plus real reveal geometry only on LOD0 punched windows (#5). |
| Value structure / colour grade | **Not the lever.** The albedo pass (`debug=1`) shows sane zoning: party wall ~0.55, tile ~0.45, dark glazed base. Relative values will fall into place once occlusion exists. The very saturated navy zenith in day shots (sky RGB about 20,50,140) makes every grey look dead. That is a global atmosphere/grade issue for another owner, not a building task. |
| LOD-consistent emissives | **Agree, but it is a bug fix, not a system.** Do it first (S0) because the judge flags it as BROKEN every round. |

### Moratorium

No new prop types this round. Every hour goes into S0-S5. The judge must
compare A/B crops of the *same* views.

---

### S0. Night LOD parity (shader + geometry, 2-3 h): do first

- **Shader (B)**: delete the `shellLod` neon wash in `facadeMat()`
  (city-materials.wgsl ~1619-1630). Emissive must be a function of
  `(param, aux, uv, time)` only, never of `shellLod`. Grep for any other
  `shellLod` branch that changes emissive and remove it the same way.
- **Geometry (A)**: in `building()` (gen-tile.ts), `lights.add(...)` must
  run on exactly the same decisions at LOD0 and LOD1. Gate the sign light
  loops (~2546, 2984, 3529, 3774, 3818, 3945, 4210) on the LOD0 placement
  decision, not on whether the LOD1 sign geometry exists. If the LOD1 shell
  needs the bounce colour, it gets it from the same point lights, not from a
  second approximation.
- **Acceptance**: mean luminance of `far-night` vs `shell-night`, in 8x8
  blocks over the building's bounding box, within ±10 %. No block shifts
  hue by more than about 15 degrees.

### S1. Occlusion that actually occludes (shader/render, engineer B, 1.5-2 days): biggest lever

**Files**: `src/shaders/ao.wgsl` `main`, `src/shaders/lighting.wgsl`
`main`/`skyVisibility()`/`bilateralAo()`,
`src/shaders/city-materials.wgsl` `facadeMatBase()`.

1. **Replace the SSAO kernel with GTAO** (Jimenez 2016, horizon-based,
   cosine-weighted). Run it at half resolution, as now.
   - Use 2 slice directions per pixel × 2 sides × 6 steps. Rotate slices
     per pixel with the existing 4x4 interleave plus `frame.time.z` jitter,
     resolved by the existing bilateral 4x4 and TAA.
   - Use a world radius of 1.5 m, clamped to [6 px, 64 px] on screen. Add a
     falloff `w = saturate((R² - d²) / (0.4 R²))` so distant geometry fades
     out of the horizon search rather than being rejected outright. Today's
     `smoothstep(R*1.5, R*0.5, diff)` throws away exactly the occluders that
     matter (canopy, ledge).
   - Keep one extra short slice at 0.35 m for creases if it is cheap.
     Otherwise one GTAO radius covers it.
   - Integrate the visibility per slice analytically (the standard GTAO arc
     integral against the projected normal). Do not count hits.
   - Before replacing it, put one log/debug line in the current kernel to
     find which test makes it return ~1. My suspects are the `occ / total`
     normalisation across 3 scales and the range smoothstep.
2. **Multi-bounce** (Jimenez): in lighting `main`, after `bilateralAo`:
   `ao = max(ao, ((ao*a + b)*ao + c)*ao)` with `a = 2.0404*alb - 0.3324`,
   `b = -4.7951*alb + 0.6417`, `c = 2.7552*alb + 0.6903` (per channel,
   `alb = albedo`). This keeps pale Tokyo walls from going grey-dirty in
   corners.
3. **Specular occlusion**: replace `specOcc = ao*ao` with Lagarde's
   `so = saturate(pow(nv + ao, exp2(-16*rough - 1)) - 1 + ao)`. Glass
   inside reveals and wet ledges under canopies stop glowing with sky.
4. **Sun**: drop the `mix(1.0, ao, 0.25)` on direct light, since AO on
   direct light reads as dirt. Add a **screen-space contact shadow** for the
   sun instead:
   - March 12 steps over 0.6 m (scaled ×dist/30, max 2 m) toward `sunDir`
     in the depth buffer, with a thickness of 0.15 m.
   - Multiply into `sh` only where the shadow cascade texel is larger than
     5 cm.
   - This catches sign brackets, AC units, sills, mailboxes, vending and
     the plant, which the cascades smear today.
5. **Wall-foot sky term** in `skyVisibility()`: the march starts at
   `dist = 2.0`, so occluders closer than 2 m are never seen. Pavement
   within 2 m of a 17 m wall reports a full sky. Start at 0.5 m with 8
   doubling steps (0.5 → 64 m), and sample the skyline texel *edges*: take
   the max of the texel and its neighbour toward `dir`, since texels are
   several metres. Target: ground 0.5 m from a tall wall has `skyVis` ≤
   0.6, and the wall's own bottom metre ≤ 0.65.
6. **Analytic facade AO** (works at LOD1, where the geometry is gone). In
   `facadeMatBase()`, multiply into `s.ao` (not albedo):
   - under every slab/ledge: `mix(0.55, 1.0, smoothstep(0.0, 0.5, slabBelow))`
     wherever a ledge or band projects (both LODs, since LOD1 has no ledge
     geometry);
   - wall foot: `mix(0.7, 1.0, smoothstep(0.0, 0.9, uv.y))`;
   - the base zone under the canopy line (`fz.zone == FZ_BASE`, top 0.8 m
     of the ground floor): `mix(0.5, 1.0, smoothstep(0.0, 0.8, floorTop - ly))`;
   - **tile cavity**: `s.ao *= mix(0.55, 1.0, wd.a)` and remove the same
     factor from albedo (`mix(0.6, 1.0, wd.a)` in the `wall =` line), so
     grout darkens ambient and specular, not the diffuse sun term. This is
     what makes tile read in shade.
   GTAO and the analytic term are multiplied; clamp the product at ≥ 0.3.
7. **Acceptance** (`debug=8`, `street-day`/`facade-day`/`rear-day`):
   under the canopy ≤ 0.45; wall 0-0.3 m below a ledge ≤ 0.7; reveal
   corners ≤ 0.5; pavement within 0.5 m of the wall foot ≤ 0.7; open wall
   and open pavement ≥ 0.95. No halo wider than 0.5 m around the building
   silhouette against sky (the current rear-day balconies show soft blurry
   halos: tighten the bilateral depth weight).

Expected: canopy, sills, ledges, signs, AC units and the building's
contact with the street all "land". This is +0.5 to +0.8 on lighting,
relief, close-up and wear simultaneously.

### S2. Judge it in context (tooling, engineer A, 2-3 h)

**File**: `src/city/lab.ts` (building branch, ~355/414 and the views at
~546-580).

- Let `ctx=1` work for buildings: `buildings: spec.ctx ? keepBuildings(...) : []`
  already exists for road/rail. For a building lab, keep every building
  whose footprint centroid is within 120 m of the subject, and hide only
  the ones that occlude the `street`/`facade` cameras. A building in the same
  block between the camera and the subject must go.
- New presets so distance is judged at the size a player sees it:
  - `far`: 180 m, fov 0.55. The subject should be ≥ 150 px tall at
    1280×720, not 40.
  - `mid`: 70 m, fov 0.8.
  - Keep the old isolated `far` as `far-iso` for silhouette checks.
- Run the judge on `--ctx=1`. Keep isolated shots for the rear, party-wall
  and roof checks only.
- Why this is not cheating: the lab shows `cityReflection()`,
  `skyVisibility()` and canyon `bounce` running against nothing. The glass
  reflects open sky over a desert, the walls see a full sky hemisphere, and
  the night building glows alone in black dunes. The asset will never be
  seen like that. I estimate this costs 0.5-0.8 of the overall score across
  `mid`, `far`, `shell`, `aerial` and `orbit`.

### S3. Edge quality: thin geometry and chamfers (A: geometry + vertex shader, 1-1.5 days)

**Files**: `src/shaders/city.wgsl` `vs`/`fs`, `src/city/cmesh.ts`
`tube()`/`beam()`, `src/city/gen-tile.ts` `band()`/`coping()`/`walls()`/`guardRail()`.

1. **Minimum pixel width for tubes** (wires, rails, posts, pipes, aerials):
   - `tube()` writes its radius into `aux` for `CM.wire`, `CM.frame`,
     `CM.paint` and `CM.metal` tubes, as `round(r * 2000)` (0.5 mm units, 16
     bits). Leave the hash seed in the upper 16 bits.
   - In `vs`, compute the world size of one pixel:
     `px = 2 * clipW / (proj[1][1] * resolution.y)`.
   - If `r < 0.7 * px`, push the vertex out along its radial normal by
     `0.7*px - r` and pass `cov = r / (0.7*px)` to the fragment.
   - In `fs`, apply a hashed coverage test with the same `leafDither()`
     band used for leaves: `if (cov < 1 && cov <= hash(pos.xy, frame)) discard;`.
     TAA resolves it into a continuous, correctly thin, non-crawling line.
   - Fade to nothing past `cov < 0.08`, and let the cluster cull drop the
     cluster past that distance.
   - Shadows keep the true radius.
   - Acceptance: the `service-day` pole wires are continuous lines and the
     `aerial-day` railing does not break into dashes.
2. **Chamfered beams and corners** (the 1-px highlight line that every AAA
   building edge has):
   - `beam()` gets an optional `chamfer` (default 0). For ledges, bands,
     coping and sills, use 0.02 m: 8 faces, where the 4 bevel strips carry
     normals at 45°. That is +16 tris per beam and the only geometry cost here.
   - The building's own vertical corners: in `walls()`/`facadeEdges`, cut
     each corner with a 0.03 m bevel quad (normal = bisector), in the
     corner-pier material. +2 tris per corner.
   - LOD1 skips the chamfer.
3. **Beam UVs in metres**: in `beam()`, set v = `sy*hgt`-based metres
   (0..2·hgt, and 0..2·w for the r faces) instead of 0..1. Tile and concrete
   on ledges then keep their real scale, which removes the smeared ledge
   tile in `facade-day`. Do the same for any `quad()` with `[0,0]..[1,1]`
   UVs that uses a tiled material (`guardRail` posts are fine).

### S4. Material discipline: response over noise (shader, engineer B, 1 day)

**Files**: `city-materials.wgsl` `facadeMatBase()`, `paintedRender()`,
`partyWall()`; `src/render/detail-tex.ts` `tile()`, `concrete()`.

- **Cut the noise stack.** In `facadeMatBase()`:
  - remove `(0.88 + 0.12*valueNoise(uv*0.7))`;
  - remove the 2.4 m `patchC` multiplier on tiled walls (keep it on render
    at 0.5);
  - halve the efflorescence.
  What remains is one per-face tone (`faceH`), the batch patches (tile), and
  the *structural* grime that is tied to geometry (sill ends, slab wash,
  soot fringe, ground grime, rust tails). Rule: every darkening must be
  explainable by water or dirt from a named edge.
- **Per-tile response, hashed in world space.** The `th` hash (already
  computed for tilt) also drives albedo `*= 0.88 + 0.24*th.y` and roughness,
  faded by `fT`. This breaks the 0.96 m texture repeat (4 × 14 fixed tones)
  that shows as a grid at 10-30 m.
- **Contrast in the texture.** In `detail-tex.ts` `tile()`:
  - tones `rng.range(0.4, 0.6)` → `rng.range(0.34, 0.66)`;
  - grout albedo `0.22` → `0.30` (lighter cement grout, but with cavity 0
    so S1's cavity-AO darkens it in shade);
  - groove depth: face rise `4 + ...` → `6 + ...`.
  The joint then shows in shade through AO and in sun through the normal,
  rather than as a painted dark line that turns to mud in the mips.
- **Wet = response, not tint.** Leave rain alone this round except to check
  that S1's specular occlusion does not kill the wet-ledge glints under
  the canopy (`street-rain`).
- **Acceptance**: `facade-day` spandrels read as crisp tile with a visible
  grout grid at 8 m and as an even, slightly speckled field at 30 m (`mid`).
  `street-day` side wall render shows streaks from sills and ledges, not
  blotches.

### S5. One opening model; real reveals on LOD0 (B: shader 0.5 day; A: geometry 1 day)

- **Shader (B)**: factor the reveal block (city-materials.wgsl ~1992-2045:
  reveal parallax, jamb/head/sill choice, contact AO, `castVis` sun, bounce
  emissive) into `fn opening(lx, ly, wx0, wx1, sill, wy1, D, ...) -> OpeningHit`.
  Call it from every path that draws a window:
  - the `stairBay` glass block (D = 0.15);
  - the party-wall and side small windows in `partyWall()`/`facadeRole()`
    (D = 0.12);
  - the frosted rear panes (D = 0.15, already inside the main branch but
    check that `role == 3` widths get the reveal);
  - the shop/lobby glazing (D = 0.08).
  After this no opening on the building is flush. That was the r5 judge's
  "most PS2 element" (`street-day` left face, x 380-560).
- **Geometry (A), LOD0 only, punched-window families** (not ribbon or
  curtain), front and street-side roles:
  - in `building()`, after the bay grid is known (`facadeBay`/`facadeWindows`),
    emit per window 4 reveal quads (jambs, head, sill) of depth D and a
    0.06 m projecting precast sill beam (chamfered, S3) under the opening;
  - leave the wall quad unbroken behind them: the shader already paints
    the glass recessed, so the geometry only needs to supply the silhouette,
    shadow-map and GTAO response at grazing angles. That costs about 10
    quads per window, ≈ 2 k tris for this specimen;
  - LOD1 keeps the shader-only reveal.
  - Acceptance: `street-day` grazing view along the front shows reveal
    edges in silhouette, and `golden` shows sun shadows of the jambs that
    match the shader's `castVis` within 2 px.

---

### Who does what (two engineers in parallel, no shared files)

| | Engineer A: geometry and tooling | Engineer B: shading and lighting |
|---|---|---|
| Files | `gen-tile.ts`, `cmesh.ts`, `lab.ts`, `city.wgsl` (vs/fs coverage) | `ao.wgsl`, `lighting.wgsl`, `city-materials.wgsl`, `detail-tex.ts` |
| Order | S2 lab context (first, so B's work is judged in context) → S0 light parity → S3 tubes, chamfers, beam UVs → S5 reveal geometry | S0 remove `shellLod` wash → S1 GTAO, multi-bounce, spec occlusion, contact shadow, wall-foot sky, analytic AO → S4 material → S5 `opening()` |
| Interface | `aux` low 16 bits = tube radius (0.5 mm) for tube mats; `beam` chamfer flag needs no shader change | S1's analytic AO must not double-count where A's reveal and sill geometry exists. Key it on `shellLod` *only for AO*, never for emissive |

Run order for the judge: both merge, then run the lab with `--ctx=1`
**and** without it, all 4 times. Give the judge this section, and ask for
scores per view, not per prop.

### Projected effect

S0 removes a "BROKEN" (+0.2). S1 is the round's real jump (+0.6-0.8:
relief, lighting, close-up, wear). S2 gives an honest distance and colour
read (+0.4-0.6 on distance, mid and far). S3 is IQ and close-up (+0.3).
S4 is material (+0.3). S5 is relief and close-up (+0.2-0.3). Total is about
7.6-8.2, if the next judge round compares the same views in context.
