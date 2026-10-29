# Gen City Auto: art direction

Reviewed: `test/out/shots/*.png` (all 12), `src/shaders/{post,lighting,city-materials,surface,common,vehicle,ao,atmosphere}.wgsl`,
`src/world/sky.ts`, `src/render/renderer.ts` (frame setup), `src/city/gen-tile.ts` (`building`, `buildTile`),
`src/city/gen-base.ts` (`streetLights`, `streetLightSpots`).

## Diagnosis in one paragraph

The renderer has the right parts: deferred PBR, a Hillaire sky, cascaded shadows, SSAO, SSR and TAA. What makes it look dated is
**calibration and missing context, not missing features.** The auto exposure meters a frame that is mostly dark asphalt
(albedo 0.075), so it pushes up and blows out walls whose albedo is too high (0.78 to 0.82 linear). The result is the bleached,
low-contrast "white box city" in `day-chase.png`, `first-person.png` and `day-flyby.png`. Ambient is one hemisphere constant
that ignores the street canyon, so alleys get as much sky light as rooftops. Everything below the horizon reflects a flat grey
constant, so glass and car paint have nothing to reflect. Every wall is a perfectly flat quad with a flat normal. At night,
exposure lifts the frame back to mid-grey, street lights are nearly omnidirectional, so there are no pools of light, and neon
has no halo. The fix order is: calibrate first, then add context (canyon occlusion, reflections, contact shadows), then
geometry and detail.

---

## 1. Visual target

**Overall:** dense, layered, slightly humid Tokyo. Deep blacks, highlights that roll off (no flat clipped white walls), and
saturation saved for light sources (signs, signals, tail lights, sky), not spread over surfaces. Surfaces are mid-value and
slightly desaturated: grey concrete, beige and brown tile, dark glass. Colour comes from the light, not the paint.

| | Day (10:00 to 15:00) | Golden hour (sun 2° to 12°) | Night | Rain (day and night) |
|---|---|---|---|---|
| Palette | Neutral-warm sun (about 5500K), clean blue zenith, pale blue-grey horizon haze | Sun 2800K to 3500K amber; shadows cool blue-violet; sky orange at the horizon grading to teal | Ink blue-black sky with an orange-brown light-pollution dome; warm white LED pools (4000K); sodium as a sparse orange accent; neon magenta, cyan and green | Desaturated blue-grey; at night the colour comes entirely from reflections |
| Key-to-fill (sunlit to shadowed vertical wall) | 4:1 to 5:1 in the open; 8:1 in narrow streets | 6:1 to 10:1, sun side glowing, shade side cool | Pools 15:1 to 30:1 against the unlit sidewalk between lamps | 1.5:1 (overcast); at night the same as clear |
| Contrast and black level | Medium-high; shadows at 8 to 15% display value, never crushed | High; long shadows, rim light on cars | Very high; true blacks in alleys, sky at about 3% | Low on surfaces, high in reflections |
| Haze | Visible at 800 m and beyond; towers 2 km away lose about 40% contrast | Strong forward scatter toward the sun (Mie glow), warm | Light: the glow dome only, plus halos around lamps | Heavy: 300 to 600 m visibility, cool grey |
| Saturation (post) | 1.0 (none added) | 1.1 | 1.15 on light sources only (do it in AgX, see change 1) | 0.8 |
| Neon and signs | Read as painted panels with faint emission (about 0.3 of the night value); never glowing in sun | Signs begin to turn on; emission at 0.5 | The hero: hot near-white cores, saturated halos 2 to 6% of screen height, coloured spill on wet ground and adjacent walls | Halos double; every sign gets a vertical streak reflection in the road |

Reference stills to agree on: GTA V downtown at 11:00 (bright but not bleached; shadows read as blue), Spider-Man PS5 Midtown
golden hour (warm facades against cool shade, strong aerial perspective), Cyberpunk 2077 Kabuki at night in rain (wet,
anisotropic street reflections, neon bloom, near-black alleys).

---

## 2. Top 12 changes, ranked by visual impact per hour of work

### 1. Replace the exposure and tonemap pipeline (about 4 h, the biggest single win)

**Files:** `src/shaders/post.wgsl`, functions `exposure` and `fsTonemap`.

a) **Histogram metering instead of a log-average.** In `exposure`, build a 64-bin histogram of `log2(lum)` over the range
[-10, +6] (workgroup-shared `atomic<u32>` bins, then one thread reduces). Average only the bins between the 40th and 95th
percentile. This ignores dark asphalt and sky and sun hot spots, which currently drive the meter. Keep the centre weighting.

b) **Anchor exposure to a physical baseline.** Compute on the CPU (`renderer.ts`, next to `computeSky`) the exposure that
maps an 18% grey card lit by sun and sky to the key:
`E_base = key / (0.18 * (lum(sunColor) * max(sunDir.y, 0.15) / PI + lum(skyAmbient)))`, and pass it in `frame.exposure.y`
(currently unused). In the shader:
`tgt = clamp(key_hist / avg, E_base * 0.5, E_base * 2.0)`. That gives at most ±1 stop of auto adjustment, so
`first-person.png` (dark cabin, blown exterior) and the night shots can no longer drift. Keys: day 0.12, golden 0.11,
night 0.045 (currently 0.16 and 0.06, both too bright).

c) **Swap `acesFitted` for AgX** (the Wrensch approximation: inset matrix, `log2` encoding over [-12.47, +4.03] EV, 6th-order
sigmoid polynomial, outset matrix). ACES fitted pushes saturated neon toward flat clipped primaries and shifts blue toward
purple. AgX desaturates hot cores toward white, which is exactly the Cyberpunk neon look. Paste-ready constants:
- inset `mat3x3f(0.842479, 0.042328, 0.042376, 0.078434, 0.878469, 0.078434, 0.079224, 0.079166, 0.879143)`
- polynomial `15.5x⁶ − 40.14x⁵ + 31.96x⁴ − 6.868x³ + 0.4298x² + 0.1191x − 0.00232`
- outset `mat3x3f(1.196879, -0.052897, -0.052972, -0.098021, 1.151903, -0.098043, -0.099030, -0.098961, 1.151074)`

Then add a "punchy" look in AgX space: `pow(x, 1.12)` and saturation `mix(1.0, 1.15, night)`.

d) **Delete the current grade lines** (the cool-shadow `mix` and the pre-tonemap `sat` of 1.12 to 1.25) and replace them
with a per-time-of-day white balance plus split tone, applied before the tonemap:
`c *= mix(shadowTint, highlightTint, smoothstep(-6.0, 1.0, log2(lum)))`. Use:
- Day: shadow (0.97, 1.0, 1.04), highlight (1.02, 1.0, 0.97)
- Golden: shadow (0.88, 0.95, 1.12), highlight (1.10, 1.0, 0.85)
- Night: shadow (0.85, 0.98, 1.10), highlight (1.0, 1.0, 1.0)
- Rain: both (0.95, 1.0, 1.05), saturation 0.8

Drive the values from `frame.time.w`, sun elevation (add it to `frame.exposure.z`) and `frame.weather.y`.

e) Vignette: `mix(1.0, 0.72, smoothstep(0.35, 0.85, v))` becomes `mix(1.0, 0.86, smoothstep(0.45, 0.95, v))`. Apply grain
in linear space, scaled by `1 - m` so highlights stay clean, with amplitude 0.012.

### 2. Recalibrate albedos (about 1 h)

**File:** `src/shaders/city-materials.wgsl`.

- `wallPalette`: multiply every entry by 0.68. White becomes 0.56, off-white tile 0.53, charcoal 0.14. No wall above 0.6
  linear. This is the main cause of the bleached look.
- `interior`: drop the ceiling panel from `vec3f(6.0)` to 3.0 and the base room colour by 0.8, so lit offices don't out-glow
  signs.
- Road markings: in `roadMat`, change `vec3f(0.75)` to `vec3f(0.55)` and yellow to `(0.55, 0.36, 0.05)`. Paint should
  stay brighter than asphalt but must not clip. In `crosswalk` areas raise roughness to 0.7 and add
  `valueNoise(world.xz*1.5)` wear that exposes asphalt (alpha down to 0.3). The crosswalks in `dusk-train.png` and
  `night-side.png` are blinding.
- `sidewalkMat`: 0.5 to 0.62 becomes 0.30 to 0.40. Sidewalks currently out-shine the buildings (`day-chase.png`, right
  side).
- `M_ROOF`: base 0.42 becomes 0.26; membrane 0.5 becomes 0.34; vary hue per building (`mix(vec3(0.30,0.29,0.27),
  vec3(0.22,0.25,0.27), h)`). Roofs fill 60% of every aerial shot.
- Asphalt (0.075) is correct. Keep it.

### 3. Night: real light pools, darker base, stronger neon halo (about 3 h)

**Files:** `src/shaders/lighting.wgsl` `main` (point-light loop), `src/city/gen-base.ts` `streetLights`,
`src/world/sky.ts` `computeSky`, `src/shaders/post.wgsl` `bloomUp` and `fsTonemap`.

- **Street light cone.** Replace `lc *= mix(0.15, 1.0, smoothstep(-0.2, 0.3, l.y))` with
  `lc *= mix(0.03, 1.0, smoothstep(0.45, 0.85, l.y))`, a downward cone of about 60° half angle. Raise the street-light
  multiplier from `60` to `140` (keep 60 for other kinds). In `streetLights` reduce the radius from 24/17 to 20/14. The
  sidewalk between lamps should fall to near black. That is the pooled look of `night-chase.png` done right.
- **Light colour.** In `gen-base.ts` set `LED = [1.0, 0.88, 0.72]` (4000K, currently a cold 0.85/0.92/1.0, which reads as
  moonlight). Make sodium 1 in 6 (`hash2 % 6`), and use it on all `kind >= 3` arterials and expressways, so sodium reads as
  a deliberate accent.
- **City glow.** In `computeSky`, change `glow` to `[0.035, 0.022, 0.014]` and change the `skyAmbient` term
  `cityGlow * 0.5` to `cityGlow * 0.25`. Ambient at night must be about 1/30 of a lamp pool.
- **Neon emission.** In `signMat`, `mix(0.5, 3.0, night)` becomes `mix(0.25, 8.0, night)`. Make the sign face emission
  `c * c * 1.5` (squared, which saturates the colours and makes white glyph cores hotter than the panel). For `M_LED`, 12
  becomes 20.
- **Bloom.** In `bloomUp`, weight the larger mips more: pass the mip index and use `base + c * mix(0.85, 1.3, mip / 5.0)`.
  In `fsTonemap`, change `mix(c, bloom, 0.06 + rain * 0.05)` to
  `mix(c, bloom, mix(0.03, 0.10, night) + rain * 0.06)`. Day bloom becomes nearly invisible and night neon gets wide halos.

### 4. Ambient from the sky LUT plus street-canyon sky visibility (about 6 h)

**Files:** `src/world/sky.ts`, `src/render/renderer.ts`, `src/shaders/lighting.wgsl` `main`, plus a new CPU rasteriser.

Currently `skyAmbient` is a hand-tuned constant (`clear = [0.32, 0.48, 0.85]`), and it lights a ground-floor alley exactly
like a rooftop. This is why the city reads flat and evenly lit.

a) **Irradiance from the real sky.** After the `skyViewLut` pass, add a 1-workgroup compute pass that integrates the sky-view
LUT (32×16 samples) into L1 spherical harmonics (4 coefficients × RGB, cosine-convolved) and writes them to a small storage
buffer. Use those coefficients in `lighting.wgsl` in place of `frame.skyAmbient` for the up-hemisphere term. Golden hour
then gets an orange horizon fill and a blue zenith fill automatically, which fixes the grey `golden-aerial.png`.

b) **Canyon visibility.** At city build time, rasterise building footprints (max roof height) into a 2048² `r16float`
height texture covering the 6144 m world (3 m per texel). Use the existing footprints in `L.buildings`, filled in a worker.
In `lighting.wgsl`, for each pixel within 1.5 km, march 8 azimuths × 6 steps (2, 4, 8, 16, 32, 64 m), keep the maximum
horizon sine `sinH` per azimuth, and compute `skyVis = 1 - mean(sinH²)`. For walls, only count azimuths with
`dot(dir, n.xz) > -0.2`. Then:
- multiply the sky-hemisphere ambient by `skyVis`,
- multiply the env reflection fallback by `mix(0.35, 1.0, skyVis)`.

Leave ground bounce untouched. Expect ground-floor streets to darken by 40 to 60% in ambient while sunlit facades stay put.
That is the key-to-fill ratio from the target table, and it is what makes GTA's streets look deep.

### 5. Vehicles sit on the road: contact occlusion and paint (about 4 h)

**Files:** `src/shaders/lighting.wgsl` `main`, `src/render/vehicles.ts` (upload), `src/shaders/vehicle.wgsl`
`vehicleSurf` and `fsGlass`.

- **Contact occlusion.** Add a storage buffer at binding 15 with up to 256 vehicle entries `{pos, yaw, halfExtents}`. Cull it
  per tile exactly like the light list (second shared array, cap 32). For ground pixels (`cls == CLASS_GROUND` or
  `n.y > 0.7`), convert to vehicle-local `q` and compute:
  `occ = (1 - smoothstep(0.6, 1.0, length(q.xz / (half.xz + 0.4)))) * clamp(1.0 - q.y / 1.0, 0.0, 1.0) * 0.8`.
  Add four wheel blobs: `0.9 * exp(-d²/0.08)` at `(±half.x*0.85, ±half.z*0.68)`. Apply `ao *= 1 - occ` and multiply the
  specular env (SSR result included) by `1 - occ`. Wet roads then stop reflecting sky under the car. This fixes the floating
  cars in `storm-orbit.png` and `first-person.png`.
- **Paint.** Mat 0 and 1: base `rough` 0.4 becomes 0.32 when metallic (`color.a > 0.5`), with flake: perturb the normal by
  `(hash33(floor(local*2500)) - 0.5) * 0.06` (add a `hash33` returning vec3 to `common.wgsl`) on the base layer only. Solid paints: base rough 0.55, and let the clear coat
  carry the gloss. The coat specular `* 0.25` becomes `* 1.0`; the sun glint on a car roof should bloom.
- **Glass.** `fsGlass` uses `skyAmbient * 1.3` as its reflection. Use the sky-view LUT (bind it) or the probe from
  change 8, and lower base alpha from 0.14 to 0.35 with the cabin darkened. AAA car glass is a dark mirror, not a tinted
  window.

### 6. Procedural micro-normals on every large surface (about 3 h)

**Files:** `src/shaders/city-materials.wgsl` (`roadMat`, `sidewalkMat`, `facadeMat`, `M_CONCRETE`, `M_ROOF`),
`src/shaders/common.wgsl` (new helper).

Every surface except curtain-wall panes writes the flat geometric normal. Add
`fn bumpNormal(n, T, B, h0, hx, hy, scale) -> vec3f` using finite differences of a height function (three evaluations, or
analytic `valueNoise` derivatives to save cost). Apply:
- Asphalt: aggregate `valueNoise(world.xz*40)*0.25 + valueNoise(world.xz*6)*0.5`, strength 0.15. Patches get a raised
  0.5 cm rim. Cracks: `abs(valueNoise(world.xz*0.7) - 0.5) < 0.01` as a groove.
- Wall tiles: grout grooves from the existing `tileLine` with strength 0.4. Floor slab line (`ly < 0.18`): a real 90° bevel
  normal on the top 3 cm.
- Sidewalk: per-paver tilt `(hash22(cell) - 0.5) * 0.04` plus grout grooves.
- Fade all bumps with `1 / (1 + dist/60)` to avoid shimmer. TAA will resolve the rest.

This breaks up the specular highlight and the wet-road reflections (currently mirror-flat in `rain-day-chase.png`) and kills
the "plastic" look in close shots.

### 7. Window reveals with true parallax, and facade ledges (about 4 h)

**Files:** `src/shaders/city-materials.wgsl` `facadeMat`, `src/city/gen-tile.ts` `building` and `walls`.

- **Parallax reveal (shader).** The glass sits at depth `d = 0.22` m behind the wall plane. Compute the tangent-space view
  `vT = vec2(dot(V,T), V.y) / max(-dot(V,n), 0.05)`. The window hole as seen from the camera is the window rect, but the
  glass is hit at `(lx, ly) + vT * d`. If that hit point lies outside the rect, the pixel sees a reveal side or sill. Shade
  it with the wall albedo × 0.8, set `s.normal` to the side's normal (±T, or up for the sill), and let the deferred sun and
  shadow light it. That replaces the hand-rolled `inShadow` reveal hack with real light. Glass inside gets
  `interior(...)` at the offset coordinates.
- **Geometry (LOD 0 and 1).** In `building` for midrise and pencil kinds, add a horizontal ledge `m.beam` every floor at
  slab height: depth 0.18 m, thickness 0.12 m, `concrete` mat. Every third floor on offices, depth 0.35. For `tower` and
  `glass`, add vertical fins every 2 bays: 0.12 × 0.45 m, `M_METAL`, running podTop→bodyTop. On podiums, add a 1.2 m deep
  canopy over the shopfront row. Cornice at the roofline: 0.4 m deep. This doubles silhouette complexity from street level
  for little geometry. Ledges cast real CSM shadow lines across facades, which is the strongest "this is not a box" cue.

### 8. One dynamic reflection probe for glass, paint and wet ground (about 1.5 days)

**Files:** `src/render/renderer.ts` (new pass), new `src/shaders/probe.wgsl`, `src/shaders/lighting.wgsl`
(`main` env block), `src/shaders/vehicle.wgsl` `fsGlass`.

- A cubemap, 256² `rgba16float`, 9 mips, centred 2 m above the player vehicle (or the free camera). Re-render **one face per
  frame** (full refresh at 10 Hz). Use the existing cluster culling with a 7th cull view (`writeCullView`) at 2× the LOD
  bias.
- The forward shader for the probe is simple: `albedo * (sunColor * nl * shadow(cascade 3) + skyAmbient) + emissive`, then
  fog. Skip SSR and AO. Sky pixels come from `skyPixel`.
- Prefilter only the updated face: GGX importance sampling, 32 samples per texel per mip, mip `m` = roughness `m / 8`.
- In `lighting.wgsl`, replace the below-horizon hack
  (`mix(groundAmbient*0.5 + cityGlow, env, smoothstep(-0.05, 0.15, refl.y))`) with
  `textureSampleLevel(probe, refl, rough * 8)` for pixels within 150 m of the probe, blending to the current path beyond.
  Use box parallax correction against a 120 × 60 × 120 m proxy box centred on the probe. SSR still overrides where it hits.
- Payoff: curtain walls reflect the buildings opposite (Spider-Man's signature look), car clear coats reflect street and
  neon, and wet roads reflect signs outside the screen, where SSR currently fails at the frame edges.

### 9. Wet streets: anisotropic streaks and stronger puddles (about 2 h)

**Files:** `src/shaders/lighting.wgsl` `ssr` and the point-light loop, `src/shaders/surface.wgsl` `applyWetness`.

- In `ssr`, for `CLASS_GROUND` when `frame.weather.z > 0.3`, replace the isotropic jitter `vec3f(j.x, 0, j.y) * rough * 0.6`
  with jitter in a view-aligned frame: `side = normalize(cross(n, v))`, `fwd = cross(side, n)`,
  `r += side * j.x * rough * 0.15 + fwd * j.y * rough * 1.4`. Reflections then stretch into vertical streaks toward the
  camera (the Tokyo-in-the-rain image).
- For point lights on wet ground, use the same idea: evaluate the GGX lobe with an anisotropic alpha
  `(ax, ay) = (rough*0.4, rough*2.5)` along `(side, fwd)`. Signal lights and tail lights become long red, amber and green
  streaks.
- `applyWetness`: lower the puddle threshold so coverage reaches 35% at `wet = 1` (`0.62 - wet*0.25` becomes
  `0.58 - wet*0.3`). Puddle albedo factor 0.6 becomes 0.35. Raise the edge `smoothstep` width from 0.06 to 0.12 so puddle
  borders get a damp gradient instead of a hard cut.

### 10. Street clutter density (about 1 day)

**File:** `src/city/gen-tile.ts` `buildTile` (props pass), new prop helpers next to `utilityPole` and `streetLight`.

Streets in `day-chase.png` and `golden-telephoto.png` are clean corridors. Tokyo is visually noisy at 0 to 4 m height. Add
at LOD 0, per chain, deterministic from `hash2(ci, …)`:
- pedestrian guardrails along `kind >= 2` curbs (white, 0.8 m, posts every 2 m, gaps at crossings)
- bollards at corners (5 per corner)
- bicycles parked against shopfronts (clusters of 3 to 8, 2 boxes plus 2 torus wheels at LOD 0)
- vending-machine clusters of 2 to 3 (already exists, but raise density 3×)
- blue overhead direction signs on gantries at arterial junctions (with `signAtlas` entries)
- traffic cones and construction barriers (1 in 12 blocks)
- bus stops with a lit panel (`M_SCREEN`) every 300 m on arterials
- planter boxes, manhole decals (`roadMat`: a 0.6 m disc every 25 m in the lane centre with a 0.6 metal and a bump pattern)

Target: at least one object every 4 m of sidewalk.

### 11. Roofs for aerial shots (about 4 h)

**File:** `src/city/gen-tile.ts` `building` (roof clutter section).

`golden-aerial.png` and `day-flyby.png` are 60% bare grey roof. Increase `units` from `rng.int(1, 4)` to `rng.int(4, 12)`
AC condensers, arranged in grid rows (`rng.chance(0.6)`: 2 × N array with 1.2 m pitch). Add:
- a stairwell or elevator box (3 × 3 × 3 m, facade material) on every roof over 15 m
- perimeter safety rails on 50% of roofs
- pipe runs (`m.beam` 0.15 m) between units
- a solar array (dark blue `M_GLASS`, rough 0.2) on 20% of low roofs
- a rooftop garden (`CM.grass` cap plus 2 to 5 trees) on 10%
- a helipad H decal on towers over 120 m (currently a disc)

With change 2's darker albedo this alone fixes most of the "SimCity" read from above.

### 12. Cinematic motion blur and depth of field (about 1.5 days)

**Files:** `src/shaders/post.wgsl` (new `motionBlur` and `dof` compute entries between `taa` and `bloomDown`),
`src/render/renderer.ts`, `src/game/camera.ts` (focus distance per shot).

- **Motion blur** (McGuire 2012): 20×20-pixel tile max velocity, then 3×3 neighbour max, then a gather of 12 samples per pixel
  along the dominant velocity with depth-compare weights. Shutter 0.5 (180°). Clamp to 32 px. Uses the existing `taaMotion`.
  Enable for the `chase`, `bumper` and `flyby` shots. A chase shot at 90 km/h with a frozen background is the most "game
  from 2008" cue in the set.
- **DOF**: half-resolution gather. CoC from depth with focus = distance to the target vehicle, aperture f/2.8-equivalent on
  `telephoto`, `side` and `bumper` shots and off for `aerial`. Use 16 to 24-tap golden-angle disc with near/far split and a
  premultiplied CoC alpha. Max CoC 12 px at 720p. `golden-telephoto.png` should have the car sharp and the street 200 m back
  softly melted into haze.

---

## 3. Things to stop doing

1. **Metering on the average of the whole frame.** Dark asphalt dominates the log-average and drives every day shot into
   over-exposure (`day-chase.png`, `first-person.png`). See change 1.
2. **Near-white wall albedo** (0.78 to 0.82 linear). Nothing in a city is that bright. It clips under any sun and kills
   facade detail.
3. **Pre-tonemap global saturation boost** (`sat = 1.12..1.25`). It oversaturates surfaces (the purple-grey sidewalks of
   `dusk-train.png`) and still does nothing for neon. Saturation belongs in the lights, not the grade.
4. **Treating ACES fitted as neutral.** It skews neon blue to purple and clips saturated highlights flat.
5. **A single constant ambient for the whole city.** An alley and a rooftop must not receive the same sky light.
6. **Reflecting a grey constant below the horizon** (`groundAmbient * 0.5 + cityGlow`). Glass and car paint look like
   matte plastic as a result.
7. **Omnidirectional street lights.** The `mix(0.15, …)` floor lights walls and sidewalks evenly, so night has no pools and
   no darkness between them.
8. **Cold blue-white LED colour (0.85, 0.92, 1.0) for all street lights.** It reads as moonlight. Use warm white.
9. **Neon at daytime brightness × 6.** Signs at 3.0 emissive barely beat lit windows. Neon must be the brightest thing in a
   night frame after headlights.
10. **Perfectly flat normals on every surface.** Facades are lit like paper.
11. **Faked window shadow** (`inShadow` reveal band with `ao = 0.35`). It fights the real sun direction. Replace it with
    real parallax (change 7).
12. **Uniform featureless lawns** with blotchy low-frequency noise (`golden-aerial.png`, `day-flyby.png`). Large flat
    grass is a giveaway. Break it up with paths, trees and darker, higher-frequency colour (`terrain.wgsl`: add
    `valueNoise(xz*3)` at 20% and scale grass albedo by 0.8).
13. **Strong vignette (to 0.72) and lens raindrops on every camera** (`lensDrops` runs whenever rain > 0.05). Drops only
    belong on the `bumper` and `first` cameras. Also, the huge soft white blob at the bottom centre of
    `night-rain-bumper.png` (the bumper's own headlight pool on wet asphalt) is unshaped. With change 3's cone and change
    9's streaks it should become a defined beam footprint, not a fog patch.
14. **Crosswalks and lane markings at 0.75 albedo with roughness 0.6.** They are the brightest objects in every
    street-level shot and pull the eye away from the car.
