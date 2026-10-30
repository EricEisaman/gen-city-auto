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
