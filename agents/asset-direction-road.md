# Asset direction: road (signalized crossroads, `road`)

Specimen: `junction #2761 (4 arms)`, neon seed 1. A 24 m arterial crossed by streets and avenues, with
sidewalks, curbs, white pedestrian guard fence, 9 m street lights, horizontal signals and avenue
trees. Renders: `test/out/lab/road-0-{eye,low,top,mid,far,shell,curb,orbit}-{day,golden,night,rain}.png`.
I made extra renders for this brief:
- `road-0-ctx-{eye,mid,top}-day.png`: `--ctx=1`, the junction among its buildings.
- Albedo-only `debug=1` top/mid, saved in the crop folder.

Crops are in `/private/tmp/claude-501/-Users-gregg-src-gen-city-auto/17c6b7f3-2e21-4356-b773-4c8329147e49/scratchpad/dir-road/`:

| Crop | Shows |
|---|---|
| `ctx-mid-plate-edge.png` | floating junction plate |
| `top-junction.png`, `eye-terrain-fill.png`, `dbg1-mid.png` | terrain asphalt showing through |
| `mid-plate.png` | raised slab at the next junction |
| `ctx-top-lanes.png` | tree and rail on the carriageway, black manhole dots, banding |
| `curb-curb.png` | 2 m asphalt |
| `eye-road.png` | pavers |
| `mid-night-junction.png` | dark junction |
| `eye-rain-mirror.png`, `mid-rain-sidewalk-camo.png` | rain |

**The developer is right, and the reason is simple.** Every square metre of carriageway is the same
material at the same age, with the same wear. The roads are laid by one shader with one noise field.
A real Tokyo arterial is a patchwork:
- resurfacing contracts of different ages, with straight saw-cut seams;
- utility trenches;
- a pale concrete gutter framing every road;
- coloured anti-skid, bike and school-zone paint;
- arrows and diamonds that tell you which way the lanes go;
- oil darkening in front of every stop line.

All of these are **0.3-20 m features**. They survive the mip chain and they read at 300 m. We have
none of them. What we do have (aggregate chips, hairline cracks, 9 m random patches) is too fine to read
or too random to mean anything.

On top of that there are four geometry bugs that the eye catches before any material:
- the junction plate floats;
- the terrain's raster "road" colour shows through at every corner;
- trees and guard rails stand in the traffic lanes;
- the junction is the darkest place at night.

Lessons carried over from the building loop:
1. **Subtle gets scored as missing.** Every macro change below has an sRGB contrast target that is
   checked on the PNG.
2. **The lighting is now decent.** GTAO and analytic AO are in, so do not touch the lighting except for
   the street-light distribution (S7).
3. **Budget.** I measured `generateLayout(PRESETS.river, 1)` + `buildBase()`:
   - 1088 km of curb, 746 km of road (by kind 0-3: 352 / 126 / 184 / 85 km), 5001 junctions,
     3850 of them signalized.
   - The base mesh is **3.96M vertices**: sidewalk 1.79M, curb faces 595k, road strips 230k,
     junction plates 41k.
   - The base mesh has no LOD and is resident city-wide. LOD1 tile props are also resident
     city-wide. LOD0 props only live near the camera.
   - **Rule:** base mesh and LOD1 must come out net ≤ 0 this round. The paydown is in G3. LOD0 props
     may spend.

---

## 1. Reference: a Tokyo arterial crossroads (e.g. Meiji-dori × Yasukuni-dori, Kasuga-dori × Hakusan-dori)

### 300 m (aerial / skyline)
- **Dark ribbons with bright edges.**
  - Carriageway asphalt at sRGB 70-125 in sun (albedo 0.06 fresh to 0.20 aged).
  - Each side is framed by a **0.35-0.5 m concrete L-gutter plus a 0.18 m curb top**, albedo 0.32-0.45.
    That pale double rule is what draws the road network from the air.
- **A patchwork of rectangles along the road.** Resurfacing sections are 40-150 m long and often
  one direction at a time, so a longitudinal seam runs on the centre line. The junction box is usually
  the newest, darkest asphalt. Value steps between sections are 20-40 sRGB levels: plainly visible
  from a helicopter.
- **Ladders and stripes.** These are the strongest marks:
  - zebra crossings (0.45 m bars, 0.45 m gaps, 4 m long) on every arm;
  - 0.45 m stop lines;
  - the yellow no-overtaking centre line (double on arterials);
  - white dashed lane lines, roughly 6 m on, 9 m off.
- **Spot colour, under 10 % of the road area.**
  - Brick-red anti-skid surfacing (≈ 0.36, 0.13, 0.09) on 20-40 m of some signalized approaches.
  - Blue bike-lane bands and arrows (≈ 0.08, 0.25, 0.6).
  - Green school-route belts (≈ 0.12, 0.38, 0.18) on small streets.
- **Green lines.** Clipped azalea / box hedges 0.6-0.8 m tall in a 1 m planting strip along the curb.
  Above them are zelkova or ginkgo street trees every 10-15 m.
- **Overhead blue guide signs** (案内標識, roughly 4.5 × 2.2 m, white text and arrow diagram) on
  F-type poles 50-100 m before major junctions. They are the largest man-made colour block in the
  street after shop signs.
- **Night:**
  - Junctions are the **brightest** spots. Dedicated junction luminaires sit on the signal poles.
  - Road lighting is a continuous band along the carriageway, not a string of disks. Luminaires throw
    wide along the road, with uniformity around 0.4.
  - Signal lamps are the saturated accents.

### 30 m (across the junction)
- Asphalt reads as tone zones:
  - wheel paths slightly darker and polished;
  - a darker oil/rubber band down the centre of each lane for 15-30 m behind each stop line;
  - a dusty lighter band in the 1 m next to the gutter;
  - patches with crisp straight seams, and house-connection trench cuts running from a longitudinal
    trench to the gutter.
- Markings:
  - Thermoplastic, slightly raised (2-3 mm).
  - Worn grey in the wheel paths, crisp elsewhere.
  - White lane arrows (5 m long) and ◇ diamond marks at 30 m and 50 m before each crossing.
  - Ghost scars of old lane lines.
- Iron:
  - Cast-iron manholes (0.6 m, brown-grey, polished, **lighter than fresh asphalt**, not black).
  - Square valve and NTT covers.
  - Catch-basin grates in the gutter every 15-20 m.
  - The odd yellow-outlined fire-hydrant cover.
- Curb: 0.15-0.2 m exposed face, precast or granite in 1 m blocks, a light top edge, tyre scuffs.
- Signals:
  - Horizontal 3-lamp heads (≈ 1.2 × 0.4 m) with short visors on a cantilever arm.
  - A blue intersection-name plate on the arm.
  - Vertical 2-box pedestrian signals (red man / green man) at both ends of every crossing.
  - A grey controller cabinet on one pole, push-button boxes.
  - Round blue/red regulatory discs (0.6 m) on thin posts at the corners.
- Sidewalk:
  - Grey 300 mm concrete slabs or interlocking pavers in 2-3 restrained tones.
  - A **bright yellow tactile guide line** (0.3 m) running the length of the walk.
  - Yellow dot-block warning aprons at every crossing.
  - Tree pits with cast-iron grates.

### 2 m (pedestrian / driver)
- Dense-graded asphalt: dark grey binder with 5-13 mm chips, mostly the same grey. Occasional pale
  chips only where the binder has worn off. Texture is read through normal and roughness more than
  albedo.
- Fresh sections are near-black, satin (rough ≈ 0.7). Aged sections are mid-grey and open-textured
  (rough ≈ 0.9).
- Paint has glass-bead sparkle and a rounded edge, and aggregate pokes through where it is worn.
- Curb top: chamfered 2 cm, black rubber scuffs, grit in the gutter joint.
- Rain:
  - Arterials use drainage asphalt (排水性舗装): **no standing water**, dark, soft streaked reflections.
  - Older streets pool in the wheel ruts, along the gutter and in trench-patch dips.
  - Paint stays visible because it sits proud of the film.

---

## 2. Gap list

### Bugs (seen before any material)
1. **Floating junction plate.** `ctx-mid-plate-edge.png`, `mid-plate.png`, `mid-day` centre.
   - The plate is a flat fan at `j.h`, while the arms end at `chainAt(s0).h`. On a slope, the plate
     edges sit 0.3-1 m above the arm and show a dark cliff. At the next junction north it reads as a
     table top.
   - Code: `roads()` junction loop, gen-base.ts ~476-487.
2. **Terrain asphalt showing through.** `top-junction.png`, `eye-terrain-fill.png`, `dbg1-mid.png`.
   - `computeRoadGeom()` builds the outline from the arm-mouth corners only. Each corner between
     two arms is a straight chord, so the wedge between the chord and the block's rounded curb is
     not covered.
   - The terrain draws `land == 3` there as flat `0.07` with heightfield-cell jaggies: the darker,
     saw-edged blobs in every view, including the "shadow" on the road in `eye-day` (x 560-700,
     y 420-470).
3. **Props on the carriageway.** `ctx-top-lanes.png`, `low-day`, `curb-day`, `eye-day` left.
   - A tree stands on a double yellow centre line on a pale square.
   - A guard rail runs along a lane line.
   - Avenue trees, rails and lights are placed by a fixed offset from their own chain and never test
     what they land on. Where two chains run parallel and close, one chain's props land on the other
     chain's lanes.
4. **The junction is the darkest place at night.** `mid-night-junction.png`.
   - Lights are only placed between `s0 + 6` and `total − s1 − 6`. The 40 × 40 m box and all its
     crossings sit in a hole between pools.
5. **Periodic banding.** `ctx-top-lanes.png`, `top-day` right half: soft light/dark bands about 1.5 m
   apart across the lanes. This is either the `DETAIL_ASPHALT` repeat (1.1 m and 2.9 m layers)
   beating in the mips, or shadow aliasing. Find the source and kill it.

### 300 m (`far-*`, `shell-*`, `orbit-*`, `mid-*`)
- The roads are uniform mid-grey ribbons. Section-to-section value variation is 0. `drift` is ±12 %
  noise and averages away.
- There are no pale edge rules. The curb is a vertical face only, and the sidewalk starts at the curb
  line, so from above there is no light line between road and walk.
- No spot colour at all. The only colour is the yellow centre line.
- No hedge lines, no overhead signs. Trees are the only vertical read.
- Night (`far-night`): isolated round pools with black gaps, and the junctions are dark.

### 30 m (`mid-day`, `ctx-mid-day`, `top-day`, `orbit-day`)
- Manholes are **black discs** (albedo 0.09, metal 0.7) on a rigid 37 m grid at lane centres. From
  above they read as bullet holes (`ctx-top-lanes.png`).
- No arrows, no diamonds, no oil band at stop lines, no gutters, no grates, no trench patches.
  - The "utility patches" are random squares on a 9 m world grid, unrelated to lanes.
  - The comment "lane arrows approximated by a short bar" has no code behind it.
- Markings are binary `if` tests with no AA. They are crisp at 2 m and crawl at 30-80 m. Wear is
  noise, not tied to wheel paths.
- Signals are bare: no visors, no pedestrian signals, no name plate, no cabinet. No regulatory signs.
- The sidewalk is a beige carpet of randomly toned bricks (tone range 0.38-0.62 per brick). No tactile
  line, no tree pits, no planting strip (`eye-road.png`).

### 2 m (`curb-day`, `low-*`, `eye-*`)
- **Asphalt reads as terrazzo.** 18 % pale chips at 1.5-2× albedo give "popcorn" (`curb-curb.png`).
- The curb face has a dark joint every metre and nothing else. There is no top band, no chamfer, no
  scuffs.
- `low-golden` is the best shot in the set. Keep that asphalt sheen.

### Rain (`*-rain`)
- `eye-rain-mirror.png`: the whole carriageway is a flat mirror.
  - Puddle noise covers about half the road regardless of structure.
  - The edge line and lane lines vanish under it.
- `mid-rain-sidewalk-camo.png`: sidewalks and blocks get huge dark camouflage blobs. Real pavement
  darkens evenly and pools only at low spots.

### Lab note (for the judge, out of scope for both engineers)
In isolation (`--ctx=0`), every hidden building's block is drawn as a paved sidewalk plaza on sand.
That makes the mid/orbit views a beige desert. Judge `--ctx=0,1`, and add `nightrain` (the money shot
for Tokyo roads):
`node test/puppeteer/lab.mjs road --ctx=0,1 --times=day,golden,night,rain,nightrain`.

---

## 3. Shared contract (agree first; then A and B never touch the same file)

**Ownership**
- **Engineer A (geometry)** owns:
  - `src/city/gen-base.ts`: `roads()`, `blocks()`, `streetLightSpots()`, `streetLights()`;
  - `src/city/roadgeom.ts`;
  - `src/city/gen-tile.ts`: the props in `buildTile()`, `signal()`, `streetLight()`, `fillProps()`;
  - `src/city/cmesh.ts`, which only gains the two new ids below.
- **Engineer B (shader)** owns:
  - `src/shaders/city-materials.wgsl`: `roadMat`, `sidewalkMat`, `M_CURB`, `M_ASPHALT`, `M_SIGNAL`,
    `signMat`, and the new cases;
  - `src/render/detail-tex.ts`: `asphalt()`, `pavers()`;
  - `src/shaders/lighting.wgsl`: the street-light branch only.
- `surface.wgsl` `applyWetness()` is **not** edited. B drives it via its `flatness` argument.
- The rail round also edits gen-base.ts (viaduct functions) and city-materials.wgsl (concrete).
  - Do not touch `railViaduct`, `expressway`, `deckBox` or the `RC_*` branches.
  - Rail uses `CM.metal` 0x4000/0x4001/0x8000, `CM.paint` 0x500 | seed and 0xf9, and `CM.lamp` 3-5.
    Road takes none of those.

**Road strip (CM.road), unchanged except `aux`:**
- `uv.x` = signed lateral metres (+ = left of travel direction of the chain).
- `uv.y` = metres along from the start setback.
- `param` as today: kind 2 bits, signal-start 4, signal-end 8, len << 4.
- **New:** `aux = LANES | (chainSeed & 0xffffff) << 8`, with `chainSeed = hash2(ci, 0x5eed)`.
  - B reads `lanes = aux & 0xffu` and `seed = aux >> 8u`.
  - The seed drives resurfacing sections, trench patches and colour features per chain.

**Junction plate (CM.asphaltPlain):**
- `uv` = world xz as today.
- **New:** `param = (hash2(ji, 7) & 0xff) | (j.signal ? 0x100 : 0)`. B uses it for the plate's age and
  tint.

**Curb band strip (new, from G3).**
- Material: `packMat(CM.sidewalk, 1)`. Param 0 stays the interior plaza and behaves as today.
- `uv.x` = metres along the curb edge, continuous around the block.
- `uv.y` = metres from the curb's road edge (0 at the curb face top, growing inward).
- `aux` bits:
  - 0-1: kind of the adjacent road (`ROAD_WIDTH` kind);
  - 2: crossing apron (within 3 m of a crosswalk mouth on that curb);
  - 3: planting strip present (kind ≥ 2, not an apron, not a bus stop);
  - 4: tree pit within this vertex's 9 m segment;
  - 8-15: band width in 2 cm units.

**New material ids** (cmesh.ts `CM` and WGSL `M_*`, identical values):
- `roadSign: 27`. `param & 0xff` = sign kind:
  - 0 speed 40, 1 speed 50, 2 no parking, 3 designated direction (straight/left), 4 pedestrian
    crossing, 5 no entry;
  - 16-23 overhead guide-sign variants;
  - 24-31 intersection-name plates;
  - `param & 0x100` = back face (plain grey 0.45, metal 0.6).
  - `uv` = 0..1 over the face.
- `hedge: 28`. Param 0 = clipped hedge (box UVs in metres). Param 1 = cast-iron tree grate (uv 0..1
  over a 1.2 m square).

**`M_SIGNAL`:** `lamp == 3` = pedestrian lamp. `param & 0x800` = upper (red man) vs lower (green
man). It uses the same `group` and `phase` as the vehicle head it serves, so pedestrian green runs with
vehicle red on the crossing road.

**Street-light direction (for S7):** in `streetLights()`, the street-light `kind` becomes
`0.05 + 0.4 * fract(roadAngle / π)` (road axis, undirected).
- `kind < 0.5` still means street light.
- `kind == 0` (legacy, or junction lights) means a round pool.
- A must check that the float survives the light upload in `renderer.ts` unquantized (`kind` already
  carries a fraction for headlights, so it should).

**Round 3 additions (shader side landed; each is opt-in, old geometry renders as before):**
- **Directed road luminaires (forward throw).** `kind = -(0.05 + 0.9 * fract(armAngle / 2π))`, with
  `armAngle = atan2(dir[1], dir[0])` and `dir` the arm direction from the pole over the road (the
  same `dir` `streetLight()` uses).
  - The shader throws the pool 0.35 pole heights forward onto the carriageway and cuts it off behind
    the pole (house side), which keeps sidewalks and lots from being evenly lit.
  - Negative kinds still pass `kind < 0.5` (street light) in `city.ts` and `lighting.wgsl`.
  - The undirected `0.05 + 0.4 * ...` form keeps working.
  - Junction luminaires may use it too, with `dir` pointing down the approach. That lights the
    driver's own approach to the stop line, which is unlit in `curb-night` today.
- **Junction plate centre.** The plate's `aux = (round(cx * 4) + 32768) | (round(cz * 4) + 32768) << 16`
  (quarter metres, 16 bits each; 0 = unknown).
  - With it, oil drips and rubber haze gather round the centre, where right-turners wait.
  - Without it, the plate is still uniformly worn.
- **Road poles.** Use `packMat(CM.metal, 0x10)` for galvanised street-light columns and
  `packMat(CM.paint, 0x93)` for grey signal and sign columns.
  - Use cylinder uv: x = metres around, y = metres up from the sunk foot (`SINK = 0.3`).
  - The shader adds vertical streaks (rough 0.35-0.5), the bottom 0.5 m of splash dirt, and torn
    sticker scraps at 1.1-1.9 m.
  - Bare `CM.metal` uprights only get the streaks.

Until B lands each piece, the new ids render as default grey and `aux` high bits are ignored, so A's
work can merge first. B can test against today's geometry: the band and new ids just appear later.

---

## 4. Ranked changes

Ranked by impact per hour. The numbers are global ranks; each engineer works their list top-down.

| Rank | Item | Owner | Time |
|---|---|---|---|
| 1 | G1 junction plate | A | 3 h |
| 2 | S1 resurfacing patchwork | B | 1 day |
| 3 | S2 gutter and edge rule | B | 0.5 day |
| 4 | G2 prop landing | A | 2-3 h |
| 5 | S3 colour and directional markings | B | 1 day |
| 6 | G3 curb band (and vertex paydown) | A | 1 day |
| 7 | S5 rain | B | 0.5 day |
| 8 | S6 band shading | B | 0.5-1 day |
| 9 | G4 junction lighting | A | 2 h |
| 10 | S7 light distribution | B | 2-3 h |
| 11 | G5 planting strip | A | 0.5 day |
| 12 | S4 traffic wear and ironwork | B | 0.5 day |
| 13 | G6 signs | A | 0.5-1 day |
| 14 | G7 signal and pedestrian signal fidelity | A | 0.5 day |
| 15 | S8 asphalt micro and banding | B | 2 h |

### Engineer A: geometry

#### G1. Junction plate that meets its arms and fills its corners (rank 1, 3 h). Bugs 1 and 2.
**Files:** `roadgeom.ts` `computeRoadGeom()`, `gen-base.ts` `roads()` junction loop.

- **Heights.**
  - Each outline vertex takes the height of the arm end it belongs to,
    `chainAt(c, arc, end ? total − s1 : s0).h + 0.02`, exactly as `roads()` computes `hs` at the strip
    end. Store `h` per outline point in `JunctionGeom`.
  - The centre vertex stays at `j.h + 0.02`.
  - Subdivide the fan into 2 rings (centre, mid-ring at 50 %, outline) so the plate is a smooth
    warped surface rather than a folded fan: +1 vertex per outline point.
- **Corner fillets.** Between arm A's left edge and arm B's right edge, replace the straight chord
  with an arc tangent to both kerb lines.
  - Radius `R = clamp(min(A.setback, B.setback) − 0.5, 3, 12)`.
  - Use 4 segments per corner.
  - The block curb polygon (`L.blocks[].curb`) must meet this arc. Check `top-day`. If the curb uses
    a different corner construction, sample the block's curb vertices that fall within 2 m of the
    wedge and use them as the fillet points instead, so road and curb share an edge exactly.
  - Fillet heights interpolate linearly between the two arm-end heights.
- **Terrain.** After this, no `land == 3` texel may be visible inside the curb lines. If one still
  is, extend the outline 0.3 m under the curb (the curb face hides the overlap).
- **Param** per §3 contract.
- **Cost:** about +24 vertices per junction, ≈ +120k in river. This is paid back by G3.
- **Accept:**
  - `ctx-mid-day` and `mid-day`: no dark step at any plate edge.
  - `top-day`: no saw-edged dark wedge at any corner. The plate and arms differ only by the S1
    "junction age".

#### G2. Props land on sidewalk, never on carriageway (rank 4, 2-3 h). Bug 3.
**File:** `gen-tile.ts` `buildTile()`: avenue trees (~6704), guard rails (~6841), bus stops, utility
poles, signals; `gen-base.ts` `streetLightSpots()`.

- Add one helper, `onCarriageway(ctx, x, z)`. It returns true if the point is within
  `ROAD_WIDTH/2 + 0.25` of any chain other than the prop's own chain, using `ctx.tileChains` of that
  tile and its 8 neighbours with `closestOnPolyline`, or is inside any junction outline.
- Every street prop placed by offset must also pass the existing `onSidewalk()` (block curb
  containment, ~6915). If either test fails, skip it, and for guard rails break the run
  (`prev = null`).
- Find out why parallel chains overlap here (`ctx-top-lanes.png` has two double-yellow centre lines
  ~16 m apart with props between). If the layout makes divided roads as two chains whose strips
  overlap, log the count in river; that is a layout bug to raise, not to fix this round.
- **Cost:** 0 vertices (fewer, in fact).
- **Accept:** no trunk, rail post or pole base on asphalt in any `road-0-*` or `ctx` view.

#### G3. Curb band strip + vertex paydown (rank 6, 1 day). The base for S6; pays for the round.
**File:** `gen-base.ts` `blocks()`.

- **Band.**
  - Inset each non-park block's curb polygon by `bw = min(SIDEWALK[kind] , 2.5)` m. `kind` is the
    adjacent road: nearest chain to the edge midpoint. Use the 3 m-inset fallback if the lookup
    fails. Use the existing `inset()` from gen-tile, or move it to geometry utils.
  - Emit the ring between the curb polygon and the inset polygon as a strip:
    - 2 vertices per curb sample point;
    - 9 m sampling, as the curb faces use now;
    - material, uv and aux exactly per the contract.
  - Triangulate the **inset** polygon for the interior plaza (param 0).
  - If `inset()` fails, or the inset area is < 30 % of the block, fall back to today's path with the
    band uv for the whole block: `uv.y` = distance to the nearest curb edge per vertex. Coarse but
    harmless.
- **Curb height follows the road, not the terrain.**
  - For each band outer vertex, take the road surface height `hr` at the nearest chain point
    (`chainAt` at the projection), or the junction plate height inside a junction.
  - Set the band outer vertex to `hr + 0.15`.
  - The curb face runs from `hr − 0.05` to `hr + 0.15` (today it is terrain −0.3 to +0.16, which is
    why the road can float over or sink under the walk).
  - The band inner ring stays on `terrain + 0.16`. The band absorbs the difference (clamp to ±0.6 m;
    beyond that keep today's terrain heights).
- **Paydown, and how to measure it.**
  - Count base vertices with a scratch script that runs `generateLayout(PRESETS.river, 1)` +
    `buildBase()` under `node --experimental-strip-types`. Write it to the scratchpad, not the repo;
    mine was 15 lines.
  - Today: sidewalk 1,792,288, curb 595,060, road 230,306, junction 41,165.
  - (a) Interior plaza subdivision: `subdivide(tris, 9)` → `subdivide(tris, 14)`. The band now
    carries the terrain-following edge where it shows. The interior is mostly under buildings.
    Expect about −0.9M.
  - (b) Curb faces: today each 9 m piece is a separate `m.quad` (4 unique vertices). Emit each edge
    as a shared-vertex strip (2 vertices per sample). Expect −290k.
  - (c) The band adds about +2 vertices per 9 m sample (≈ +250k).
  - **Net target: base mesh ≤ 3.2M (−750k).** That frees room for this round and the next.
- **Accept:**
  - `top-day`: the curb top and gutter read as a continuous pale rule (needs S2 and S6).
  - Curb exposed height is 0.15 ± 0.05 m at 10 random river samples (log it).
  - The vertex counts above are logged in the PR.

#### G4. Junction lighting (rank 9, 2 h). Bug 4.
**Files:** `gen-base.ts` `streetLights()` and `streetLightSpots()`; `gen-tile.ts` `signal()`.

- At every signalized junction, each signal pole also carries a luminaire (shared pole, 共架):
  - a second arm at 9.5 m reaching 2.5 m over the road along the same `armDir`;
  - a flat LED head, box half-extents (0.35, 0.06, 0.15), `CM.lamp` 1;
  - LOD0 only, the same as signals. That is about 50 vertices per arm.
- Add the light in `streetLights()` (base light list, not LOD-gated):
  - kind exactly `0` (round pool);
  - radius 24, `LED` colour, 1.3× the arterial street-light intensity, so the box is the brightest
    place on the road.
  - Expose the pole positions from one function used by both files: `junctionLightSpots(L, geom, hf, cb)`.
- Street lights: also pass the road angle per the contract (for S7).
- **Accept:** `mid-night`: mean sRGB inside the junction box ≥ the mean of the lit arm 30 m out. No
  crossing stripe is in darkness.

#### G5. Planting strip: hedges and tree pits (rank 11, 0.5 day)
**File:** `gen-tile.ts` `buildTile()`, the avenue tree loop and the guard-rail loop.

- **Where:** on kind ≥ 2 chains, both sides, from `s0 + 8` to `total − s1 − 8`. Leave gaps:
  - 3 m around each bus stop;
  - a 2 m gap every 35-50 m (hash), for driveways and access;
  - none within 8 m of a junction mouth (aprons).
- **Shape:** one shared-vertex strip per run, not boxes.
  - Profile: 4 points (road-side bottom, road-side top, back top, back bottom).
  - Centre at `ROAD_WIDTH/2 + 0.75`, width 0.9 m, height 0.7 m.
  - Samples every 6.5 m with ±0.05 m height jitter so the top undulates.
  - End caps as quads.
  - Material `packMat(CM.hedge, 0)`. UVs: x = metres along, y = metres up the profile.
- **LOD0 only.** At LOD1 the hedge exists only as S6's green planting-strip paint on the band (aux
  bit 3). From above, the 0.9 m green top and the painted strip match within 10 sRGB. That makes this
  0 vertices city-wide at LOD1.
- **Tree pits:** under each avenue tree (and only if `onSidewalk`), a 1.2 × 1.2 m quad at
  `sidewalkY + 0.012`, `packMat(CM.hedge, 1)`, LOD0. Set band aux bit 4 for that segment from G3 (the
  shader darkens the soil ring around it).
- The pedestrian guard fence stays at `+0.35`, in front of the hedge.
- **Cost:** LOD0 only, about 8 vertices per 6.5 m per side (+4 per tree).
- **Accept:** `eye-day`, `ctx-eye-day`: a continuous dark-green hedge line behind the white fence on
  the arterial. `mid-day`: green rules along both sides of the arterial.

#### G6. Signs: overhead guide signs, name plates, regulatory discs (rank 13, 0.5-1 day)
**File:** `gen-tile.ts` (new `guideSign()`, `roadSign()`, called from `buildTile()`).

- **Overhead guide sign (案内標識).**
  - On each kind 3 approach to a signalized junction, and on 50 % (hash) of kind 2 approaches.
  - Place it 60-90 m before the stop line on the incoming (left, Tokyo) side, and only if that arm
    is ≥ 70 m long.
  - F-type pole: column radius 0.18 m, 7.6 m high, `CM.paint` 0x90 grey.
  - Horizontal arm at 7.2 m reaching `ROAD_WIDTH/2 − 0.5` over the incoming lanes.
  - Panel 4.4 × 2.2 m × 0.08 m, bottom at 5.0 m, facing oncoming traffic:
    `packMat(CM.roadSign, 16 + hash % 8)` front, `| 0x100` back.
  - LOD0 ≈ 150 vertices.
  - **LOD1 keeps the panel and column** (≈ 50 vertices). This is the one road prop that must read
    at 300 m. River has ≈ 85 km of kind 3 roads, so expect a few hundred signs, ≤ 25k vertices at
    LOD1. Log the count.
- **Intersection-name plate.** On each signal arm, 1.0 × 0.28 m, 0.3 m above the head,
  `packMat(CM.roadSign, 24 + ji % 8)`. LOD0.
- **Regulatory discs.**
  - 1-2 per junction corner (hash).
  - Disc radius 0.3 m (cylinder, 12 segments, 0.02 m thick) at 2.3-2.8 m on a 0.03 m post.
  - Kinds from the contract list: speed 40/50 on approaches to kind ≥ 2, no-parking on kind ≤ 1,
    pedestrian-crossing square (0.6 m box) at crossings.
  - LOD0 only, must pass G2's landing test.
- **Accept:** `far-day`: at least one blue guide sign visible as a ≥ 6 px blue block. `eye-day`: one
  ahead over the arterial.

#### G7. Signal and pedestrian-signal fidelity (rank 14, 0.5 day)
**File:** `gen-tile.ts` `signal()` and its call (~6730).

- **Vehicle head.**
  - Half-extents (0.85, 0.22, 0.14) → (0.62, 0.2, 0.12).
  - Lamps 0.17 → 0.15, spaced 0.4.
  - Add a visor over each lamp: box (0.17, 0.015, 0.1) at lamp top + 0.15, projecting 0.1 toward
    the face.
  - Add a 0.03 m dark backing frame around the head (`CM.paint` 0x91).
- **Pedestrian signals.** At both ends of every crossing:
  - The end at the signal pole: on the pole at 2.4-3.2 m.
  - The far corner: a new 3.4 m pole of radius 0.07.
  - Each head is a box (0.22, 0.4, 0.12) facing across the crossing, with two lamp faces of
    0.34 × 0.34 m (`M_SIGNAL` lamp 3, `0x800` on the upper one) and a short top visor.
  - A push-button box (0.08, 0.12, 0.06) at 1.2 m.
- **Controller cabinet:** one per junction, on the first pole, box (0.3, 0.45, 0.2) at 2.6 m, grey.
- **Cost:** LOD0 only, about +450 vertices per signalized junction.
- **Accept:** `low-day`, `eye-day`: pedestrian signals visible at the crossing ahead. `mid-night`:
  red/green men visible at ≥ 4 px.

### Engineer B: shader

All new features use the coverage-conserving `paintLine()`, or an equivalent analytic filter on
`foot`. Nothing may crawl at 30-80 m.

**Macro features (≥ 0.3 m) must keep their full contrast at 300 m.** Only fine lines may fade.

Measure every acceptance target in sRGB on the PNG, e.g. with `sips` crop + a small python BMP mean;
python3 has no PIL here.

#### S1. Resurfacing patchwork: kill the monochrome (rank 2, 1 day)
**File:** `city-materials.wgsl` `roadMat()`, `M_ASPHALT` case.

- **Age field `age ∈ [0,1]`** per chain section:
  - Section index `k = floor((along + 37 * h(seed)) / 70)`.
  - Shift each boundary by `25 * (h(seed, k) − 0.5)` m.
  - `age = h(seed, k, 3)`.
- **Directional split:** in 35 % of sections (hash), the half with `x < 0` gets its own age,
  `h(seed, k, 5)`, which makes a longitudinal seam on the centre line.
- **Mouth sections:** the first and last 25 m of a signalized arm (bits 4/8, `along < 25` /
  `fromEnd < 25`) take the junction's age. The junction plate's age is
  `0.08 + 0.2 * h(param & 0xff)`, so junction boxes and their mouths are the freshest, darkest
  asphalt.
- **Material by age:**
  - base albedo `mix(0.06, 0.19, smoothstep(0.15, 0.85, age))`, neutral with a 2 % warm tint;
  - `rough = mix(0.72, 0.92, age)`;
  - aggregate influence (the `dd` terms) `mix(0.35, 1.0, age)`, so fresh asphalt is smooth and
    binder-rich;
  - **remove** `drift`, or cut it to `0.95 + 0.1 * drift`. Value now comes from structure, not noise.
- **Seams:**
  - transverse and longitudinal section edges get a 2.5 cm sealed seam, `paintLine(d, 0.025, foot)`,
    albedo 0.04, rough 0.35;
  - plus a 0.15 m overband of tar sealant at 40 % opacity on 50 % of seams.
- **Trench patches**, replacing the 9 m world-grid squares:
  - 55 % of chains get one longitudinal trench at lateral offset `±(w/2 − 1.1)`, 0.8 m wide,
    spanning `along ∈ [a0, a0 + 25..90]`.
  - From it, service cuts 0.6 m wide run to the gutter every 7-12 m (hash).
  - Patch age = host age ± 0.45, flipped so the step is visible either way. Same seams.
- **Accept** (`ctx-mid-day`, `top-day`, `orbit-day`):
  - adjacent sections differ by ≥ 25 sRGB in mean (e.g. 80 vs 115 in sun);
  - the junction box is ≥ 15 sRGB darker than the arm 40 m out;
  - in `far-day`, the arterial shows ≥ 3 distinct tone blocks.

#### S2. Gutter and edge rule (rank 3, 0.5 day)
**File:** `roadMat()`. It works on the road strip's `uv.x`.

- **Kinds 2-3: concrete L-gutter.**
  - Zone: `ax > w/2 − 0.4`.
  - `DETAIL_CONCRETE`, albedo 0.34 (sRGB ≈ 150 in sun against asphalt ≈ 95-115), rough 0.85.
  - Transverse joints every 2.0 m: 1 cm, ×0.7.
  - Grime ramp toward the curb: `×mix(1.0, 0.72, smoothstep(w/2 − 0.15, w/2, ax))`.
  - Grit specks: hash, 3 %, ×0.5.
- **Kinds 0-1: side-ditch covers.**
  - Zone: `ax > w/2 − 0.5`.
  - Precast covers 0.5 m long with dark joints, albedo 0.38.
  - Every 4th cover is a steel grating: bars 2 cm every 3 cm across, metal 0.6, albedo 0.16, slots
    0.03.
- **Catch basins** (kinds 2-3), every 15-20 m (hash per side):
  - grate 0.4 (lateral) × 0.75 (along) m reaching `ax > w/2 − 0.45`;
  - a dark wet halo, ×0.8 within 0.4 m.
- **Edge line:** moves to `ax ∈ [w/2 − 0.6, w/2 − 0.45]` (15 cm) and applies to kind 0 too.
- **Accept:**
  - `top-day`: every road edge carries a pale rule ≥ 35 sRGB brighter than the adjacent asphalt;
  - `far-day`: the arterial has visible light edges (1 px rule after coverage);
  - `curb-day`: gutter joints and a grate in frame.

#### S3. Colour and directional markings (rank 5, 1 day)
**File:** `roadMat()`. Rewrite the marking block as a sum of coverage terms:
`cov = max(...)` of `paintLine`/SDF terms, with the colour chosen by the dominant term.

- **AA:** every existing mark (edge, centre, lane, crosswalk, stop line) becomes `paintLine` on its
  centre distance, or a box SDF filtered by `foot`. No binary `if`s remain.
- **Stop line:** `fromEnd ∈ [6.0, 6.45]` on the incoming half. Crosswalk unchanged (0.45 / 0.45,
  `along 0.6-4.5`).
- **Lane arrows:** in each incoming lane (lanes ≥ 2 per direction), centred at `fromEnd = 14`
  and `32` m.
  - 5 m long; shaft 0.15 m wide; head 0.9 m wide, 1.5 m long.
  - Leftmost lane: straight + left. Rightmost: straight + right. Middle: straight. Kind 1: one
    straight arrow per direction.
- **◇ diamonds:** on kinds ≥ 1 with a signalized end, in each incoming lane at `fromEnd = 36` and
  `56` m. Outline 0.2 m wide, 1.5 m across × 3.0 m along.
- **Anti-skid red:**
  - On 35 % (hash) of signalized approaches of kind ≥ 2, the incoming lanes over
    `fromEnd ∈ [7, 7 + 20..35]`.
  - Albedo (0.36, 0.13, 0.09), wear-desaturated toward the host by up to 35 % in wheel paths.
  - rough 0.93; detail normal ×1.6 (calcined bauxite grit).
  - Markings paint over it.
- **Blue bike marks:**
  - On kind ≥ 2, in the leftmost lane of each direction at `ax = w/2 − 1.1`.
  - Every 10 m: a 0.75 × 1.6 m blue (0.08, 0.25, 0.6) arrow plus a white bike glyph (two 0.25 m
    circles and a bar).
  - On 25 % of kind 3 chains, a continuous 1.0 m blue lane band with a white 0.15 m bounding line.
- **Green belt:** on 50 % of kind 0-1 chains, the band between the edge line and the gutter is green
  (0.12, 0.38, 0.18), rough 0.75, with the same wear.
- **Fire-hydrant frame:** every ~110 m (hash) near the gutter, a 0.6 m square yellow
  (0.75, 0.52, 0.06) outline, 0.1 m wide.
- **Paint response:**
  - white 0.80, yellow (0.75, 0.52, 0.06);
  - rough 0.5 new, 0.65 worn;
  - a raised edge: tilt the normal outward by 0.35 where `0 < cov < 1` at under 15 m;
  - glass-bead sparkle: 2 % of 3 mm cells at rough 0.15, under 10 m.
- **Wear:**
  - Paint coverage `×mix(1.0, 0.45, track)` in the wheel paths. Crosswalk bars show two worn
    tracks per lane.
  - Sections with `age > 0.6` lose another 25 %.
  - Fresh sections are crisp.
- **Ghost lines:** in 30 % of sections, the old lane line sits 0.6-0.9 m off the current one: a 0.15 m
  dashed scar, ×0.85, rough −0.05.
- **Accept:**
  - `mid-day`: arrows and diamonds are legible in the approach lanes;
  - `far-day`: at least one red approach and one blue band are visible;
  - no marking crawls in a 2-frame A/B of `mid-day`.

#### S5. Rain with structure, and drainage asphalt (rank 7, 0.5 day)
**Files:** `roadMat()` and `sidewalkMat()`. Pass a structured `flatness` into `applyWetness()`; do
not edit surface.wgsl.

- **Road water mask** `wm`:
  - gutter zone `ax > w/2 − 0.6`: 1.0;
  - wheel paths: `0.8 * track` in sections with `age > 0.5`;
  - trench patches and their seams: 0.7;
  - within 0.6 m of catch basins: 1.0;
  - crown, `ax < 1.0`: 0.1;
  - else 0.3.
  - Then `flatness = wm * (1 − cov_paint)`. Paint stands proud, so markings never drown.
- **Drainage asphalt** (排水性舗装) on all kind 3 chains and on 50 % of kind 2 chains (seed):
  - flatness ×0.08 (no standing water);
  - after `applyWetness`, `rough = max(rough, 0.32)` outside the gutter, and albedo ×0.8;
  - result: dark, satin, softly streaked reflections, never a mirror.
- **Junction plate:** flatness 0.25, plus 1.0 within 2 m of the outline corners. Use the distance to
  the nearest curb from G1's fillet if exposed, otherwise skip.
- **Markings when wet:** albedo ≥ 0.6 for white, rough ≥ 0.15.
- **Sidewalk:** the band (param 1) uses `flatness = 0.15 + 0.6 * smoothstep(0.5, 0.0, uv.y)` (water
  at the curb edge). Interior: 0.15. That kills the camouflage blobs.
- **Accept:**
  - `eye-rain`: ≤ 35 % of carriageway pixels are mirror-like, and the edge line and lane lines are
    continuous;
  - `low-rain`: crosswalk bars and arrows read;
  - `mid-rain`: sidewalks are evenly dark;
  - add `nightrain`: the signal and street-light reflections stretch on the arterial but break up on
    the aggregate.

#### S6. Curb, band and sidewalk shading (rank 8, 0.5-1 day; needs G3 for the band)
**Files:** `sidewalkMat()` (gains `uv`, `param`, `aux`), `M_CURB`, new `M_HEDGE`; `detail-tex.ts`
`pavers()`.

- **Curb top** (band, `uv.y < 0.18`):
  - precast/granite, albedo 0.46 (sRGB ≈ 180 in sun), rough 0.7, `DETAIL_CONCRETE`;
  - chamfer normal tilted 45° toward the road for `uv.y < 0.025`;
  - joints every 1.0 m in `uv.x` (5 mm, ×0.6);
  - black tyre scuffs: 15 % of blocks get a 0.3-0.8 m streak ×0.6 on the outer 5 cm.
- **Curb face (`M_CURB`):**
  - replace the world `(x+z)` joint with joints keyed to the face's own `uv.x` (metres along) at
    1.0 m;
  - grime ×0.7 on the bottom 5 cm;
  - same albedo as the top, so the curb reads as one block.
- **Tactile paving** (kinds ≥ 1):
  - guide line centred at `uv.y = clamp(0.5 * bandWidth, 0.8, 1.6)`, 0.3 m wide;
  - yellow (0.78, 0.6, 0.08), rough 0.6;
  - 4 raised bars per 0.3 m tile along `uv.x`, by normal;
  - crossing aprons (aux bit 2): dot-block field, 0.6 m deep from the curb top inward, 5 × 5 dots
    per 0.3 m tile.
- **Planting strip** (aux bit 3), `uv.y ∈ [0.25, 1.25]`:
  - distance-blended soil/mulch (0.12, 0.09, 0.07) near the camera → hedge top green (0.08, 0.15,
    0.05) beyond 60 m, matching the LOD1 view of G5;
  - 0.1 m pale edging curbs at both edges.
- **Tree pit ring** (aux bit 4): darker soil ×0.7 within 0.2 m around the 1.2 m grate square. The
  grate itself is `M_HEDGE` param 1: radial slots in 3 rings, cast iron (0.2, 0.18, 0.16), metal 0.5,
  rough 0.55, slot interior 0.03.
- **Hedge (`M_HEDGE` param 0):**
  - leaf-scale noise at 0.04 m and 0.25 m: albedo (0.06-0.11, 0.12-0.2, 0.04-0.06), a brighter top
    (new growth ×1.25);
  - normal bulge: tilt toward the outward face within 0.12 m of the top edges, so the box reads
    rounded;
  - `cls = CLASS_FOLIAGE`, rough 0.8; `ao` = `mix(0.45, 1.0, uv.y / 0.7)` on the sides.
- **Pavers (`detail-tex.ts` `pavers()`):**
  - tones `0.38-0.62` → `0.45-0.55` (the beige carpet becomes a laid surface);
  - add a second pattern: in the band outside the tactile line, a 300 mm square concrete slab
    (`sidewalkMat` picks it by `uv.y`);
  - the 60 m zone palette: drop the pink-beige (0.46, 0.4, 0.34) to 20 % frequency. Tokyo walks are
    mostly neutral grey, 0.40-0.44.
- **Accept:**
  - `eye-day` / `ctx-eye-day`: a yellow tactile line runs the length of the walk, a pale curb top
    edges the road, and tree grates sit under the trees;
  - `top-day`: road edge (gutter + curb top) is a pale double rule;
  - the sidewalk reads grey-neutral with restrained tone variation (16 px block sd ≤ 10 sRGB at 8 m,
    against 14.8 today).

#### S7. Street-light distribution (rank 10, 2-3 h; needs G4's angle)
**File:** `lighting.wgsl`, the `L.kind < 0.5` branch (~780).

- If `L.kind > 0.01`:
  - `axis = (L.kind − 0.05) / 0.4 * π`, `ax = vec3(cos(axis), 0, sin(axis))`;
  - before the downward cone test, squash the along-road component:
    `lq = normalize(vec3(l.x, l.y, l.z) − ax * dot(l, ax) * 0.55)`;
  - use `smoothstep(0.25, 0.8, lq.y)` instead of `(0.45, 0.85)`.
- The result is an elongated pool, about 2.2 : 1 along the road, which joins neighbours at the 30 m
  spacing.
- Round pools stay for `kind == 0`: junction lights and legacy.
- **Accept:** `mid-night`, `far-night`: the arterial reads as a continuous lit band (minimum/mean
  luminance along its centre line ≥ 0.35), not beads.

#### S4. Traffic wear and ironwork (rank 12, 0.5 day)
**File:** `roadMat()`.

- **Stop-line oil band:** incoming lanes, `fromEnd ∈ [6.5, 30]`, at the lane centre:
  - 0.7 m wide, soft edges;
  - albedo ×`mix(0.68, 1.0, (fromEnd − 6.5) / 23.5)`, rough −0.12.
- **Gutter dust:** `ax ∈ [w/2 − 1.2, w/2 − 0.4]`, albedo ×1.12, rough +0.04, plus 2 % dark debris
  specks under 20 m.
- **Wheel paths:** keep today's `track`. In `age > 0.5` sections, ×0.85 and rough −0.15. In fresh
  sections, ×0.95 only.
- **Manholes**, replacing the black grid discs:
  - Radius 0.3 m. Place in the wheel paths or at a lane line ±0.4 m, one per lane per 25-60 m
    (hash on seed, lane, `floor(along / 25)`).
  - Cast iron (0.24, 0.21, 0.18), metal 0.55, rough 0.38 (polished).
  - Raised pattern via normal: concentric rings plus a hash-chosen grid or radial.
  - 3 cm dark frame gap; a 0.15 m darker cracked asphalt ring around it.
- **Square covers:**
  - valve covers 0.25 m every ~30 m near the gutter;
  - NTT/utility covers 0.6 × 0.9 m on 20 % of trench patches.
- **Junction plate (`M_ASPHALT`):**
  - overall rough −0.08 (polished by turning traffic);
  - plus 4-6 faint tyre-scuff arcs, radius 8-14 m, centred on hashed world points on a 40 m grid,
    ×0.85, 0.25 m wide. The plate only knows world xz, so the arcs are not tied to corners.
- **Accept:** `ctx-top-lanes` equivalent: no black dots; manholes are lighter than fresh asphalt.
  `low-day`: oil band visible behind the stop line.

#### S8. Asphalt micro and banding (rank 15, 2 h)
**Files:** `detail-tex.ts` `asphalt()`; `roadMat()`.

- In `asphalt()`:
  - pale-chip fraction `0.18` → `0.07`;
  - pale tone `0.75-1` → `0.6-0.78`;
  - matrix chips `0.4-0.6` → `0.44-0.56`;
  - `bump` 0.35 → 0.5;
  - add 1500 small dark pits (r 0.8-1.6 px, `L.a` 0.15).
- In `roadMat()`, re-pick the two detail scales so they are not near-harmonic (1.1 / 2.9 → 1.3 /
  3.7, rotation 0.8/0.6 → 0.6/0.8 at 37°).
- Fade `dd.b` contrast to its mean by `smoothstep(0.004, 0.02, foot)`: per-chip albedo is
  meaningless past 20 m and the beating is what produces bug 5. Confirm it disappears; if it doesn't,
  it is shadow-side and goes to the lighting owner.
- **Accept:** `curb-day` reads as asphalt (chips by relief, not by speckle). No banding in `top-day`.

---

## 5. Holding up at 300 m and LOD1

- Base mesh (road strips, junction plates, band, curbs) has no LOD. So S1, S2, S3-colour and S6
  curb/planting are what `far-*` and `shell-*` show. All of them are ≥ 0.3 m features: no fade on them
  except the 2.5 cm seams.
- LOD1 additions are G6 guide-sign panel + column only. Hedges are paint at LOD1, signals and
  pedestrian signals are LOD0 only, and junction luminaires are LOD0 geometry but base-list lights.
- `shell-day` vs `far-day`: road values within ±5 sRGB in 8 × 8 blocks over the road area, since it is
  the same mesh and shader. The only allowed difference is the absent hedge height and signals.
- **Budget check** (both engineers, in the PR): base-mesh vertex count in river (target ≤ 3.2M, from
  3.96M), and LOD1 road-prop delta (target ≤ +25k).

---

## 6. Don'ts

- **No more noise octaves on asphalt.** Value must come from things with edges and reasons
  (sections, trenches, gutters, oil at stop lines), not from `valueNoise` at three scales. Every
  darkening must be explainable as age, tyres, oil, water or a repair.
- **No ±5 % tweaks.** If an effect is not ≥ 15-25 sRGB at the distance it is meant for, the judge
  will score it as missing.
- **No black manholes, no black seams wider than 3 cm, no pure-white (> 0.85) paint.** Real paint is
  dirty off-white. Real iron is lighter than fresh asphalt.
- **No colour everywhere.** Red, blue and green surfacing together stay under 10 % of the carriageway
  area. Tokyo is a grey city with coloured punctuation.
- **No mirror roads in rain.** Water lives in gutters, ruts and dips. Arterials drain.
- **No props by offset alone.** Everything tests what it lands on (G2).
- **No per-brick random tone carpets.** Pavers are laid in restrained tones with designed bands.
- **No new geometry for detail the shader can draw** (gutters, grates, arrows, tactile paving,
  manholes). Geometry is for silhouette and height: curb, hedge, signs, signals.
- **No box-per-segment props at LOD1.** Strips with shared vertices, or paint.
- **Don't touch GTAO or analytic AO, or the sun/sky balance.** `low-golden` proves the road already
  responds to light well.

---

## 7. Who does what

| | Engineer A: geometry | Engineer B: shader |
|---|---|---|
| Files | `gen-base.ts` (`roads`, `blocks`, `streetLight*`), `roadgeom.ts`, `gen-tile.ts` (props, `signal`, `streetLight`), `cmesh.ts` (ids 27/28) | `city-materials.wgsl` (`roadMat`, `sidewalkMat`, `M_CURB`, `M_ASPHALT`, `M_SIGNAL`, `M_ROADSIGN`, `M_HEDGE`), `detail-tex.ts`, `lighting.wgsl` (street-light branch) |
| Order | G1 → G2 → G3 → G4 → G5 → G6 → G7 | S1 → S2 → S3 → S5 → S6 → S7 → S4 → S8 |
| Gives B | road `aux` seed, junction `param`, band uv/aux, new ids, light angle | n/a |
| Can test without the other | yes: new ids are grey, `aux` bits ignored | yes: S1-S5 work on today's road strips; S6 waits for G3 |

Run for the judge after both merge:
`node test/puppeteer/lab.mjs road --ctx=0,1 --times=day,golden,night,rain,nightrain`.
Give the judge this file and ask for scores per view, with A/B crops of the same views against the
current set (keep a copy of `test/out/lab/road-0-*` before re-rendering).

### Projected effect
- G1 + G2 remove three "broken" reads (+0.4).
- S1 + S2 are the real anti-monochrome jump: patchwork plus edge rules at every distance (+0.6-0.8
  on material, colour and distance).
- S3 gives colour and meaning (+0.3-0.4).
- G3 + S6 add the curb/sidewalk close-up and the budget (+0.3).
- S5 + S7 + G4 are rain and night (+0.4).
- G5-G7 are street furniture density at 30 m (+0.3).
