# Asset direction: elevated rail viaduct (`rail`)

Renders reviewed: `test/out/lab/rail-0-{side,under,along,mid,far,shell,orbit}-{day,golden,night,rain}.png`,
`rail-station0-*-{day,night}.png`, and `rail-sheet.png` / `rail-station-sheet.png`.
Crops: `/private/tmp/claude-501/-Users-gregg-src-gen-city-auto/17c6b7f3-2e21-4356-b773-4c8329147e49/scratchpad/dir-rail/`
(`along-track.png`, `under-pier.png`, `far-deck.png`, `side-deck.png`, `station-canopy.png`,
`along-gantry.png`, `mid-golden.png`, `station-along-night.png`).

Developer: *"Something about them looks very PS2. Plain, flat, monochrome, or at least lacking in
details that are visible from a distance."* He is right. The viaduct is one grey extruded box with
thin sticks on it. From 300 m nothing tells you it is a **railway**, and it does not look **Japanese**
either. It is the expressway with a different top texture.

Measured budget (`node` on `generateLayout(PRESETS.river, 1)` + `buildBase`, with and without rail
elevateds): the river city has **19.0 km of rail viaduct, 1583 centreline points (12 m apart),
8 stations, and the rail emits 394,640 vertices** (about 250 per 12 m segment). The cluster pool is at
about 24.5M of 25.1M. **Hard cap for this round: rail net +100k vertices in river** (≤ 495k total).
Every geometry item below gives its cost. Where possible it pays for itself by deleting hidden faces.
The base mesh has **no LODs**: whatever is built is drawn at 300 m too. So geometry must be
large-scale relief, and shader detail must prefilter to its mean.

---

## 1. Reference: a Tokyo JR elevated (Yamanote / Chuo rapid / Sobu between Akihabara and Ochanomizu)

### 300 m (skyline / aerial read)
- A **continuous horizontal band in three values**:
  - a pale top line: soundwall panels or parapet coping, albedo ≈ 0.55-0.6;
  - a mid-grey fascia, 0.38-0.42;
  - a **hard dark shadow line** under the 0.8-1.2 m slab cantilever, luminance ≤ 0.15 in sun.

  That shadow line is what makes it read as a bridge, not a wall.
- **Vertical rhythm every 10-12 m**: rigid-frame bents (two square columns per frame) with dark bays
  between. Under them are shops, bike racks and fenced storage (*gado-shita*). In darker bays the
  void reads almost black.
- **Overhead line equipment against the sky**: a lattice gantry every 40-50 m, spanning both tracks,
  with a visibly sagging web of 4-8 wires between gantries (messenger, contact, feeders). This lacy
  silhouette is THE signature of Japanese urban rail. Read from distance it is a fine grey comb on
  top of the viaduct.
- **Colour blocks at road crossings**: steel plate-girder spans painted grey-blue, grey-green or
  rust brown, with a yellow/black clearance board. They break the grey every few hundred metres.
- At night: lit train windows, red and green signal points, and sodium/LED-lit underpasses and shops
  under the arches. The deck itself stays dark.

### 30 m (street level, across the road)
- Rail level is 8-10 m up. Deck slab 0.3-0.4 m; the edge fascia/cornice is about 0.8-1.0 m deep, with
  a **drip lip/coping** projecting 5-10 cm (thin shadow line).
- Longitudinal edge beams of about 1.2-1.5 m sit back 0.8-1.2 m from the fascia. Transverse beams at
  each bent have small haunches. Columns are 0.8-1.1 m square.
- Parapet 1.1-1.3 m above the deck. On many stretches a 1.5-2.0 m **soundwall** of ribbed pale
  panels sits on top, with H-posts every 2 m. Some stretches have translucent upper panels.
- Catenary masts are H-section steel (about 0.2 × 0.3 m), set on the parapet line. The
  gantry is a Warren truss with about 0.7 m between chords. Each track has a drop bracket with brown
  porcelain insulators. The contact wire is **staggered ±0.2 m** at each support. The messenger wire is
  about 1.0 m above it at supports and sags to about 0.5 m at mid-span, with droppers every 5-6 m.
- **Wear (the most visible thing)**: black-green rain streaks run down the fascia from every scupper
  and joint, 0.3-1 m wide and 2-6 m long. Efflorescence (white) bleeds at joints. Column bases are
  dirty to about 1 m. Columns next to roads have yellow/black hazard stripes to about 1.8 m and white
  column ID plates. Drain downpipes run down the columns. Cable troughs and conduits are clamped on.
- Palette: concrete warm grey (0.40, 0.39, 0.37) with roughness 0.85. Stains (0.13, 0.13, 0.11).
  Galvanised steel 0.5 with metal 0.6 and roughness 0.5. Painted steel girders (0.42, 0.48, 0.50) or
  (0.30, 0.40, 0.34).

### 2 m (on the deck / platform)
- Ballast: grey granite, 3-6 cm stones. It is **rust-brown within about 0.8 m of the rails** (brake and
  wheel dust) and has an oily dark strip down the track centre. The shoulders are lighter and fresher.
  Prestressed concrete sleepers are 2.0 m long, 0.24 m wide and 0.6 m apart, with dark fastening
  clips. They sit in the ballast with ballast heaped between them, not painted onto a plane.
- Rails: a **mirror-polished running band** on the railhead (about 3 cm wide, roughness ≈ 0.1) and
  rust-brown web and foot (0.25, 0.12, 0.05). On the deck edges: concrete cable troughs with lids,
  checker-plate walkway, signal heads, kilometre posts, and small grey equipment boxes.
- Stations: the platform is **about 1.1 m above the railhead**, with a dark recess under its edge.
  Along the edge are a white edge line, a 0.3 m yellow tactile strip, and numbered car-stop marks. The
  canopy is corrugated steel on a steel frame. Stair and escalator towers are clad in panels with
  glazing bands and the station-name board.

---

## 2. Gap list (what our renders lack)

### 300 m: `rail-0-far-day`, `rail-0-shell-day`, `rail-0-mid-day`, crop `far-deck.png`
- G300-1: The viaduct is a **single pale grey ribbon**. It has no shadow line (`deckBox` side faces
  are flush, 2.2 m, `gen-base.ts` deckBox) and no bent rhythm (piers only every 22 m, skipped over
  roads). Nothing is pale on top: the parapet is 1.08 m and the same material.
- G300-2: Catenary is nearly invisible: 0.24 m box masts and a 0.16 m beam every 45 m, one 1.5 cm
  contact wire. There is no wire web, so there is no "railway" read.
- G300-3: There is no colour anywhere: road crossings, columns and parapets all share `CM.concrete`.
- G300-4 (`rail-0-mid-golden`, `far-golden`, `shell-golden`, crop `mid-golden.png`): the viaduct
  blows to peach-white and is the brightest object in the frame. The concrete base albedo of
  0.5 × 1.03 is too high (same finding as the building r6 judge, fix 4).
- G300-5 (`mid-night`, `far-night`, `orbit-night`): the viaduct is an unlit black band. It has no
  under-deck light, no signals and no station glow outside stations.

### 30 m: `rail-0-side-day`, `rail-0-under-day`, crops `side-deck.png`, `under-pier.png`
- G30-1: The deck side is a flat 2.2 m panel with faint 10 m joints and soft low-contrast streaks
  (city-materials.wgsl M_CONCRETE, streak at most 22 %). The joints are on a world-space 10 m grid
  that does not line up with any structure.
- G30-2: Piers are a single 2.2 m square column with a cap. That is a **highway pier**, not a JR
  rigid frame. The underside has three identical girders (`deckBox` girder loop) shared with the
  expressway, so the two assets look like the same object.
- G30-3: The underside is clean. There are no downpipes, no hazard stripes, no ID plates, no ground
  splash band and no drip staining under joints.
- G30-4: The masts (`side-day`, x 20-160 and 795-845, y 200-290) are thin dark sticks with a single
  diagonal. They do not read as a lattice gantry.

### 2 m: `rail-0-along-day`, crop `along-track.png`, `along-gantry.png`
- G2-1: The **sleepers are painted white dashes** on a flat plane. They have no relief, no AO and
  sit at 0.5 albedo against 0.3 ballast, so they strobe into a dashed-line pattern down the track.
- G2-2: The ballast is one uniform field across the full 10.4 m deck. There is no ballast shoulder,
  rust band, oily centre, drain, cable trough or walkway.
- G2-3: The rails are 8 × 16 cm boxes of generic `CM.metal`. They have no polished head, so from the
  side or far they vanish. They are boxes (w ≠ h), so they get no min-width widening.
- G2-4: The gantry is a plain box portal. The contact wire is one heavy black line per track
  (M_WIRE albedo 0.02, `along-day` y 190-300). There is no messenger, no stagger and no droppers.
- G2-5: The parapet is a plain 0.3 m wall, 1.08 m high, with no coping shadow and no soundwall.

### Station: `rail-station0-station-day`, `-side-day`, `-along-day`, `-along-night`, crop `station-canopy.png`
- GS-1 (**reads as a bug**): the station stair block is `packMat(CM.facade, 0x30000 | si)`, so it
  renders as a **4-storey apartment block with windows** punched through the viaduct.
- GS-2: The platform top is at deck level (y = 0), the same height as the ballast, so trains would
  sit 1 m above it. There is no platform face or under-edge shadow, and no edge or tactile markings
  (it uses `CM.sidewalk`).
- GS-3: The canopy is a flat pale slab with a teal band, and the fence is a teal paint strip
  (`CM.paint 0x60`). Both read as flat colour cards.

### Lab note (out of scope for both engineers, flag for the judge)
The default lab is sand desert: `skyVisibility`/`cityReflection` have no neighbours, and the far views
frame the asset at about 20 px tall. Score both `--ctx=0` and `--ctx=1`. Without a train on the
viaduct the judge has no scale cue. See G9 (optional).

---

## 3. Shared contract (agree first; both engineers code against it, neither edits cmesh.ts)

Engineer A owns `src/city/gen-base.ts` (and `src/game/trains.ts` line ~158, plus `src/city/lab.ts`
for the optional G9). Engineer B owns `src/shaders/city-materials.wgsl` and `src/render/detail-tex.ts`.
The constants below are duplicated in TS (gen-base.ts) and WGSL (city-materials.wgsl) with
identical values.

**UV convention on all rail-viaduct faces (except boxes, which keep cmesh metre UVs):**
- `uv.x = 12 × (segment index i + t)`, i.e. "bent units". Bents fall exactly on multiples of 12 and
  gantries on multiples of 48. Use `along` only for the segment start, never true metres. The shader
  can then put joints, scuppers and stains *on* the structure.
- Vertical faces: `uv.y` = metres **down from the top edge** of that face.
- `CM.rail` (track bed) faces: `uv.x` = **signed lateral offset from the deck centreline in metres**
  and `uv.y` = bent units (as today, plus the 12× rule). Sloped shoulder faces use the lateral offset
  of each vertex too.

**`packMat(CM.concrete, RC | flags)`**: concrete param is currently unused, so 0 keeps today's
generic look for the expressway and portals.

| const | value | faces |
|---|---|---|
| `RC_GENERIC` | 0 | unchanged (expressway, other) |
| `RC_FASCIA` | 1 | slab edge + parapet outer face (one continuous face) |
| `RC_BEAM` | 2 | edge/transverse beams, cantilever soffit, centre soffit |
| `RC_COLUMN` | 3 | columns (box UV: uv.y − 1 = metres above ground) |
| `RC_PARAPET` | 4 | parapet inner face + top |
| `RC_TROUGH` | 5 | cable trough lids/inner face, walkway |
| `RC_PLATFORM` | 6 | platform top (uv.x = metres from platform track edge, uv.y = along) |
| `RC_PLATFORM_FACE` | 7 | platform vertical face to the track |
| `RC_STATION` | 8 | stair/concourse tower walls |
| `RC_SOUNDWALL` | 9 | soundwall panels (inner + outer + top) |
| flag `RC_ROADSIDE` | 0x10 | column/beam adjacent to a road (hazard stripes, clearance mark) |
| flag `RC_GLAZED` | 0x20 | soundwall stretch with translucent upper panels |

`aux` high 16 bits = per-bent seed `(e index * 4099 + i) & 0xffff` on concrete faces. Concrete is not a
TUBE_MAT, so the bits are free.

**Other params**
- `packMat(CM.metal, RAIL_STEEL = 0x4000)`: railhead tube. `RAIL_WEB = 0x4001`: web/foot box.
- `packMat(CM.metal, GALV = 0x8000)`: gantry chords, diagonals, masts, brackets.
- `packMat(CM.paint, RAIL_GIRDER = 0x500 | seed8)`: steel plate girder over roads. Bit 0x80 of seed8
  marks the clearance-board face.
- `packMat(CM.paint, INSULATOR = 0xf9)`.
- `packMat(CM.wire, 1)` = contact wire (copper). `packMat(CM.wire, 2)` = messenger / feeder / dropper
  (steel). 0 = today's black utility wire.
- `packMat(CM.lamp, 3 | 4 | 5)` = rail signal aspect red / green / yellow, steady.

**Heights** (above deck top `hs[i]`): ballast top +0.15, sleeper top +0.20, railhead top
`RAIL_TOP = 0.37`, platform top +1.45, contact wire 5.4 + RAIL_TOP, messenger at support 6.4 +
RAIL_TOP. `trains.ts` line ~158 `q.p[1] + 0.25` becomes `q.p[1] + RAIL_TOP` (engineer A).

---

## 4. Ranked changes

Impact per hour, highest first within each list. A and B can work in parallel from hour 0. B can
test against today's geometry: roles default to generic and become visible as A lands faces.

### Engineer A: geometry (`gen-base.ts`)

**G1. RC rigid-frame structure for rail (new `railDeck()` replacing `deckBox` for rail only; 1 day).**
This is the biggest single fix: it gives the shadow line, the 12 m rhythm, and a different identity
from the expressway. Keep `deckBox` untouched for `expressway`.

Per segment i→j (all quads, no beams, so no hidden end caps):
- Fascia: outer face at ±5.2 from +1.2 (parapet top) down to −0.9. That is one quad per side,
  `RC_FASCIA`, 8 v.
- Coping/drip lip: `m.beam` at ±5.25, y +1.2, half 0.18 × 0.05, `RC_PARAPET`, with
  `hide = [0,-1,0]`. It casts the thin top shadow line. About 20 v per side.
- Parapet inner face at ±4.95 from 0 to +1.15, plus top, `RC_PARAPET`. 2 quads per side, 16 v.
- Cantilever soffit at y −0.9 from ±5.2 to ±4.4 (normal down, `RC_BEAM`), 8 v. Its shadow is the
  dark line.
- Edge beam: outer face at ±4.4 from −0.9 to −2.3, bottom at −2.3 from ±4.4 to ±3.4, inner face at
  ±3.4 from −2.3 to −0.4. `RC_BEAM`, 24 v.
- Centre soffit at −0.4 between ±3.4, `RC_BEAM`, 4 v. This gives the underside coffered depth.
- **Bent at every point i not over a road** (`!onRoad(q)`), via the existing
  `pier(e, q, top=hs[i]-0.4, 1.1, fallback)`, so the portal-over-lower-deck logic is kept. The
  fallback does three things:
  - Transverse beam `m.box(center y = hs-1.35, half [4.4, 0.95, 0.4], RC_BEAM, yaw, aux,
    skipBottom=false)`.
  - Two columns at lateral ±3.9: `m.box(half [0.5, h/2, 0.5])` from ground − 1 to hs − 2.3,
    `RC_COLUMN`. **Half ≥ 0.5** so `buildBase.record` still logs them as camera solids.
  - `RC_ROADSIDE` when `onRoad` is true within 6 m of the column.
- **Over roads** (a run of i with `onRoad`): the edge beams in those segments switch to a **steel
  plate girder**. Web quads from −0.9 to −2.6 at ±4.4 and ±3.4, `RAIL_GIRDER | seed` with
  `seed = hash(e, first i) & 0x7f`. Flanges are two `m.beam`s per girder (0.25 × 0.03 half,
  top and bottom) for crisp shadow lines. The two bents flanking the crossing get columns
  0.6 half-width, a full-width cap and lights (see G6). Set flag 0x80 on the road-facing web
  quad of the first segment so B paints the clearance board.
- Expansion joint: every 4th bent (uv.x ≡ 0 mod 48), add a 2 cm dark gap. Do it by ending and
  restarting the fascia quads 0.03 m apart (no extra verts).
- Cost per segment: about 108 v plus about 64 v per bent. Old cost: about 96 (deckBox) plus about 22
  (piers every 22 m). **Net ≈ +40 v/seg ≈ +63k**. Pay for it with G1b.
- **G1b savings**: rails `hide=[0,-1,0]` (−16 v/seg); the old 3-girder + diaphragm loop is gone
  for rail; the parapet `m.beam`s become quads (−60 v/seg). **Net G1 + G1b ≈ −5k.**

**G2. Track bed relief and rails (0.5 day).** Replace the single `CM.rail` top quad.
- Per track (centre ±2.1): ballast crown quad from c−1.5 to c+1.5 at +0.15. Shoulder slopes from
  c±1.5 at +0.15 down to c±2.1 at 0. 3 quads, 12 v per track.
- Flat centre quad between tracks (−0.6..0.6, y 0) and outer flats to the trough, `CM.rail`. All
  carry the lateral uv.x.
- Cable troughs: inner face + lid at ±4.3..±4.95, height +0.30, `RC_TROUGH`. 2 quads per side.
- Rails: web/foot `m.beam(… 0.04 half-w, 0.06 half-h, RAIL_WEB, hide down)`. The **railhead is one
  continuous `m.tube` per rail** through all points at y RAIL_TOP − 0.02, r = 0.035, `RAIL_STEEL`.
  `RAIL_STEEL` is a TUBE_MAT (metal), so the vertex shader keeps it ≥ 0.7 px. That gives a bright
  line that survives to 300 m. Cost 4 v/pt per rail.
- Cost ≈ +24 + 16 + 16 − 4 ≈ **+52 v/seg ≈ +82k**. This is the biggest spend. If over budget, drop the
  outer shoulders on the outboard side of each track first (−8 v/seg).

**G3. Catenary: lattice gantries + compound wire web (0.5-1 day).** Gantries go on bents where
`uv.x ≡ 0 mod 48` (every 4th point), not every 45 m.
- Masts: `m.box(half [0.09, 3.9, 0.15], GALV)` at lateral ±4.8 on the coping, from deck +1.2 to
  +9.0. 2 × 20 v.
- Truss beam: top chord y +8.6 and bottom chord +7.9, each `m.tube` 2 points r 0.06 (8 v).
  Diagonals: **one** zig-zag `m.tube` alternating top and bottom chord every 0.8 m across the 9.6 m
  span (13 pts, 52 v), r 0.035, `GALV`.
- Per track: a drop bracket as one `m.tube` polyline from the bottom chord (c, 7.9) to (c, 6.9) and
  then horizontally to (c ± 0.5, 6.9), r 0.04, `GALV`. Add one insulator per track as a 2-pt
  `m.tube` r 0.07, 0.4 m long, `INSULATOR`. About 20 v per track.
- Wires, each a **single continuous tube for the whole line** (4 v per point):
  - Contact wire per track: points at every bent, lateral `c + (gantryIndex odd ? +0.2 : −0.2)` at
    gantries and linear between. Height 5.4 + RAIL_TOP. `CM.wire|1`, r 0.007.
  - Messenger per track: points at gantries (6.4 + RAIL_TOP) and 3 intermediate points with parabolic
    sag to 5.9 + RAIL_TOP at mid-span. `CM.wire|2`, r 0.008.
  - Droppers: every 12 m (at non-gantry bents), a 2-pt vertical tube from messenger to contact,
    r 0.004, `CM.wire|2`.
  - One feeder per side on mast tops (+9.0, sag 0.6 m, 3 intermediate points), r 0.012, `CM.wire|2`.
- Cost per 48 m ≈ 160 (gantry) + 160 (wires) ≈ **+75k net** after deleting the old masts, beam and
  per-segment contact beams. To trim, drop droppers to every other bent (−13k).
- Delete the old `if (along[i] - lastMast > 45)` block and the per-segment contact-wire `m.beam`.

**G4. Station fixes (0.5 day).**
- **Replace the `CM.facade` stair block** (GS-1) with a stair tower:
  - `m.box` same footprint, `RC_STATION`, height to deck + 4.5, plus a 0.3 m roof slab overhanging
    0.4 m.
  - A station-name board: `m.box([1.8, 0.4, 0.06], packMat(CM.sign, 64 + (si % 8)))` on the
    road-facing face at deck − 1.0.
  - A 2.4 m-wide dark entrance recess: a `m.box` 0.15 m proud on each side of the opening with
    `CM.frame`.
- Raise platforms to +1.45 (GS-2):
  - The platform top quad moves up and becomes `RC_PLATFORM` (uv.x = metres from the track edge).
  - Add a vertical `RC_PLATFORM_FACE` quad from +1.45 down to 0 at the track edge, recessed
    0.25 m under a 0.25 m nosing. That is 2 quads; the recess is the dark line under the edge.
  - Move posts, lamps, fence and canopy up by 1.45.
- Fence: replace `CM.paint 0x60` with the same `RC_SOUNDWALL | RC_GLAZED` face (1.2 m), so it
  shares B's panel shader.
- Suppress G1's soundwall (G5) and the outer shoulders for `si ± 7`.

**G5. Soundwall stretches (2 h).** On 120 m stretches with
`hash(e index, floor(uvx/120)) < 0.55` (an integer hash, **not** the layout RNG): add
a soundwall on top of the coping, ±5.1, from +1.25 to +2.75. Inner, outer and top quads,
`RC_SOUNDWALL` (`| RC_GLAZED` on half of those stretches). Posts are painted by B; no post geometry.
Cost 24 v per seg per side on 55 % of segments ≈ **+42k**. If the budget is tight, do it on the
outer side of curves only, or drop it (cheapest to cut).

**G6. Night presence (1 h).**
- At the two bents flanking every road crossing: one LED fixture under the transverse beam,
  `m.box([0.5, 0.06, 0.2], packMat(CM.lamp, 1))` with `lights.add(y − 0.4, 18, LED, LightKind.street)`.
- Every 4th remaining bent with ground clearance > 6 m, add one more. River ≈ 400 lights; check
  against `MAX_LIGHTS` 1024 culling in renderer.ts.
- Signals: every ~300 m per track (on a gantry where `uv.x ≡ 0 mod 288`), a signal head
  `m.box([0.15, 0.35, 0.1], CM.frame)` on the bracket with two lamp boxes
  `[0.06, 0.06, 0.02]`, `CM.lamp | 3/4/5`. The aspect comes from the seed: 70 % green, 20 % yellow,
  10 % red.
- Signals are emissive only, with no point light.

**G7. Under-deck furniture (2 h, cheap and visible at 30 m).** On every 2nd bent (alternate sides):
- A drain downpipe `m.cylinder` r 0.1, 6 sides, no cap, `packMat(CM.paint, 0x90)`, from hs − 2.3 to
  ground, hugging the column face. Copy the expressway code.
- A cable conduit: one `m.tube` along the outer edge-beam face at −1.2, r 0.06,
  `packMat(CM.paint, 0x90)`, continuous per line.

**G8. trains.ts (5 min).** Use `RAIL_TOP` for the car height (line ~158).

**G9 (optional, lab.ts).** Park one train (from the existing train variant) on track −2.1 at the
lab site for `side`, `along` and `station`. Use for judging only.

Budget tally (river): G1 −5k, G2 +82k, G3 +75k, G4 +3k, G5 +42k, G6 +2k, G7 +10k ≈ **+209k:
over the +100k cap.** Ship G1, G1b, G2, G3, G4, G6, G7 (≈ +167k) only if the pool owner confirms
headroom. Otherwise cut in this order:
1. G5 (soundwalls, −42k; the shader can still paint a pale coping band);
2. outer ballast shoulders (−13k);
3. droppers every 24 m (−13k);
4. feeders (−6k).

That lands at ≈ +93k. **Measure** with the script pattern: `buildBase({...L, elevated: all})` vs
`{...L, elevated: nonRail}`, compared on `mesh.vcount`.

### Engineer B: shader (`city-materials.wgsl`, `detail-tex.ts`)

All new features must fade to their mean once their scale is under about 3 px (use `foot`, as the
current concrete does). The base mesh has no LOD, so 300 m views are *these* shaders at a 0.3-1 m
footprint.

**S1. Rail concrete roles (`M_CONCRETE`, branch on `param & 0xf`; 1 day).** Keep role 0 exactly as
today (expressway).
- Base albedo for roles 1-5: `(0.40, 0.39, 0.37)`, **not 0.5**. This fixes golden-hour blowout
  (G300-4). Per-bent tone `mix(0.93, 1.05, hash(aux >> 16))` keyed on `floor(uv.x / 12)`.
- `RC_FASCIA`:
  - (a) A coping drip band: the top 0.25 m below the lip is ×0.7.
  - (b) **Scupper stains at uv.x ≡ 6 mod 12** (mid-span): width 0.5-1.0 m, length 2.0-3.5 m
    (both hashed per bent). Albedo × 0.45 toward `(0.13, 0.13, 0.11)`, with a soft top-weighted
    falloff and roughness 0.7. They are ≥ 0.5 m wide and > 50 % contrast, so they survive at
    300 m as 2-4 px dark ticks. This is the rhythm the far views lack.
  - (c) Joint lines at uv.x ≡ 0 mod 12: 2 cm, ×0.55, plus white efflorescence
    `(0.66, 0.65, 0.62)` 30 % bleeding 0.5-1.5 m below a joint on 40 % of joints.
  - (d) Fine formwork lines every 0.9 m in y and tie-hole dots on a 0.6 × 0.45 m grid, both only
    when foot < 0.02.
- `RC_BEAM`:
  - Soffits (n.y < −0.5): ×0.55 plus damp mottling.
  - Vertical faces: drip streaks hanging from the bottom edge of the cantilever soffit (same
    function as fascia, uv.y down).
- `RC_COLUMN` (uv.y − 1 = height above ground):
  - A splash/grime band from 0 to 1.2 m: ×0.72, warm `(0.30, 0.27, 0.23)`, with a ragged top edge
    (valueNoise).
  - `RC_ROADSIDE`: 45° yellow `(0.85, 0.62, 0.05)` / black hazard stripes, 0.2 m pitch, from 0.2 to
    1.8 m, chipped at the edges.
  - On every column, a white ID plate 0.3 × 0.2 m at 2.2 m, on the face where `n·(road)` is
    largest; approximate with "the face whose uv.x span is 1.0". Draw a dark blob glyph on it.
  - Stains from the beam above: dark at the top 0.5 m, fading down.
- `RC_PARAPET`: the inner face gets brake-dust rust tint `(0.36, 0.27, 0.21)` × 40 % on the lower
  0.6 m. The top face gets moss/dirt spots.
- `RC_TROUGH`: lids are 1.0 m precast pieces with dark 1 cm gaps; one lid in 15 is a different tone.
- Rain (`applyWetness`): porosity 0.6 for all; stains get wetter (darker) first.

**S2. Track bed (`M_RAIL`; 0.5 day).** Zone by `uv.x` (lateral, metres). For each track
c = ±2.1, `tx = uv.x − c`.
- Ballast base: `(0.30, 0.29, 0.28)` × detail. Rust tint `(0.33, 0.24, 0.17)` weighted by
  `smoothstep(0.9, 0.3, abs(abs(tx) − 0.53))`. Oily centre `(0.15, 0.135, 0.12)` for |tx| < 0.3, 60 %.
  The shoulder (|tx| > 1.5) is lighter `(0.40, 0.39, 0.37)`.
- **Sleepers**: 2.0 m × 0.24 m every 0.6 m (|tx| < 1.0), albedo `(0.44, 0.43, 0.41)`, **not 0.5**.
  Give them relief:
  - normal tilt in a 3 cm bevel at all 4 edges;
  - ballast **AO 0.55** (`s.ao`) in a 6 cm band next to each sleeper edge, with stones heaped
    partly over the sleeper ends (ballast mask from `d.a` > 0.6 wins within 8 cm of the ends).
  - Fastening clips: dark (0.06) 6 × 10 cm blobs at tx = ±0.53 ± 0.08.
- **Prefilter**: when foot > 0.05, return the sleeper/ballast area-weighted mean
  (0.4 × sleeper + 0.6 × ballast) with no stripes. That kills the `along-day` strobe.
- Centre zone |uv.x| < 0.6: concrete drain channel, 0.3 m dark slot at x = 0.
- `detail-tex.ts ballast()`: make the stones more angular and higher contrast. Raise `L.bump`
  from 0.25 to 0.45, and seed 20 % of stones darker (0.25) and 10 % rust-tinted, so the 2 m read is
  stones, not noise.

**S3. Rail steel and catenary materials (2 h).**
- `M_METAL` param `RAIL_STEEL`: head (n.y > 0.6) albedo `(0.62, 0.62, 0.60)`, metal 1, roughness
  0.12, with a 3 cm running band at roughness 0.07. Sides are rust brown `(0.26, 0.13, 0.06)`,
  roughness 0.8, metal 0. Wet: head roughness 0.05.
- `RAIL_WEB`: rust brown, roughness 0.85, darker oily foot.
- `GALV`: albedo 0.52, metal 0.6, roughness 0.5, plus spangle valueNoise ±6 %, rust bloom at chord
  joints (y within 0.1 of chord heights) at 20 %, and dark streaks down masts.
- `M_WIRE`:
  - param 1 (contact): aged copper `(0.30, 0.20, 0.14)`, metal 0.9, roughness 0.35, so the sun
    gives a glint line at golden hour.
  - param 2 (steel): `(0.22, 0.22, 0.22)`, metal 0.8, roughness 0.45.
  - param 0 stays.
- `INSULATOR` (paint 0xf9): brown glazed porcelain `(0.32, 0.14, 0.07)`, roughness 0.15, with ribs
  along the u of the tube every 6 cm.

**S4. Steel girder spans (`M_PAINT` `RAIL_GIRDER = 0x500`; 3 h).**
- Palette by seed: grey-blue `(0.42, 0.48, 0.50)`, JR grey-green `(0.30, 0.40, 0.34)` or rust
  brown `(0.24, 0.12, 0.07)`.
- Reuse `paintedSteel` wear and rust streaks (add a palette argument).
- Vertical stiffeners every 1.5 m: a 4 cm highlight line plus a 4 cm shadow line, and a normal
  tilt. Rivet rows 8 cm from the flanges: dots every 0.15 m, only when foot < 0.01.
- Flag 0x80 on the web: a centred clearance board 2.4 × 0.5 m at 0.3 m above the bottom flange.
  Yellow `(0.9, 0.7, 0.05)` with a black border and a white panel blob for the text.

**S5. Soundwall (`RC_SOUNDWALL`; 2 h).**
- Panels `(0.60, 0.61, 0.58)`, with horizontal ribs every 0.12 m (normal sine, fading by foot).
- H-posts every 2 m (uv.x): 0.15 m dark steel `(0.25)` with normal edges.
- Dirt gradient: ×(0.75 → 1.0) from the bottom 0.4 m up. Rust streaks below the post tops.
- `RC_GLAZED`: the upper 0.6 m is translucent-looking, `(0.42, 0.48, 0.5)` at roughness 0.15 (lets
  the sky/env reflect), with a grimy bottom edge.
- At 300 m this is the pale top band in G300-1. Ensure mean albedo ≥ 0.52.

**S6. Platform and station (`RC_PLATFORM`, `RC_PLATFORM_FACE`, `RC_STATION`; 2 h).**
- Platform base `(0.47, 0.46, 0.44)`.
- White edge line from 0.02 to 0.12 m from the edge.
- Yellow tactile strip `(0.85, 0.66, 0.06)` from 0.80 to 1.10 m, with a dot/bar bump normal and
  roughness 0.6.
- A worn darker centre walking band. Car-stop marks: white triangle plus numeral blob every 20 m.
- Platform face: dark `(0.12)` with grime. Its recess is mostly done by geometry.
- `RC_STATION`: precast panels 1.2 × 3 m with joints, a 0.8 m glazing band (reuse `opening()`-style
  dark glass with sky reflection) at 2.5 m above each landing, and the bottom 1 m in dark granite.
- Night: the glazing band glows at ×6 with a warm-white interior, and stair lights.

**S7. Rail signal lamps (`M_LAMP` 3/4/5; 30 min).** Steady emissive. Red `(1, 0.05, 0.02)`, green
`(0.1, 1, 0.6)`, yellow `(1, 0.7, 0.05)`, × mix(4, 30, night). Add a small front-facing hood
falloff using n.

---

## 5. 300 m acceptance (judge on `rail-0-far-*`, `shell-*`, `mid-*`, crops)
1. The deck side shows **3 value bands** in day: soundwall/coping ≥ 0.5 tonemapped luminance ratio
   vs fascia ≥ 1.3, and the cantilever shadow line ≤ 0.5 × fascia, at least 2 px tall in
   `mid-day`.
2. **Bent rhythm**: columns or stains every 12 m visible as alternating light/dark in `far-day` along
   the visible length.
3. **Wire web**: gantries visible as lattice in `along`/`side`, and a grey comb on top in `mid`.
4. **Colour**: at least one non-grey span (girder) in `mid` or `far` when a road crossing is in
   frame, and hazard yellow at column bases in `side`/`under`.
5. **Golden**: the viaduct is no longer the brightest object in `mid-golden` (mean deck-side
   luminance < the sand around it).
6. **Night**: under-deck pools of light at road crossings and red/green signal points in `mid-night`.
7. **No strobe**: sleepers in `along-day` beyond 30 m resolve to a smooth tone (no dashes); rails
   remain two bright continuous lines to the horizon.
8. Station: no apartment windows; the platform stands visibly above the rails with a dark under-edge
   line.

## 6. Don'ts
- Don't put sleepers (or any per-0.6 m item) in geometry: river would need about 64k sleepers and
  over 1M verts. Shader only.
- Don't paint white stripes on a plane. If a feature has no relief, it needs AO/normal or it reads
  as decal (G2-1).
- Don't make concrete albedo > 0.45, or golden hour blows out. Don't stack more low-frequency
  noises on the concrete (the r5 "grey mud" lesson). Use structure-aligned stains in uv bent units
  instead of world-space grids.
- Don't reuse the expressway look (round or square single pier, 3 girders, flush box) for rail: they
  must read as two different structures from 300 m.
- Don't draw black-ink wires (albedo 0.02). Wires are metal and catch light. Don't make wires boxes
  (`beam` with w ≠ h): use `tube` so min-width applies.
- Don't use subtle effects: anything under 25 % contrast or under 0.4 m scale is invisible at 300 m
  and gets scored as missing.
- Don't touch the layout RNG or `railLines`/`elevateProfile`. All new variety comes from integer
  hashes of (line index, point index).
- Don't add emissive washes or anything that depends on distance/LOD (the building `shellLod` bug).
  Emissive is a function of param, aux, uv and time only.
- Don't add props on the deck that need per-metre geometry (fences with balusters, sleeper clips,
  dropper clamps). Paint them.
- Don't use `CM.facade` for anything on the viaduct.

---

## 7. Round 2 geometry additions (for the shader engineer)

New params and faces (gen-base.ts railViaduct); none needs a shader change to look sane,
but these are the hooks:
- `packMat(CM.concrete, RC_STATION | RC_GLAZED)` (= 0x28): **glazed concourse curtain wall**
  under the station deck (box, metre UVs per face: uv.y = metres above the box bottom, which is
  0.3 m below ground). Wants: mullions every 1.5 m, transoms at 2.4 m, dark glass with sky
  reflection, warm emissive interior at night, bottom 0.3 m granite. Today it falls back to the
  RC_STATION panel look. The solid band above it is plain `RC_STATION`.
- `packMat(CM.screen, DEPARTURE | si)` (`DEPARTURE = 0x100`): station departure boards, uv 0..1
  over each face. Wants amber/white timetable rows on black; today renders as an ad screen.
- `packMat(CM.lamp, 1)` is now also used for: the light-box strip on the station canopy fascia
  (vertical face toward the track + a down-facing strip), the LED strip under the coping lip
  (`y 1.10`, down-facing, ~30 % of 120 m stretches per side), the fluorescent fitting under the
  centre soffit of every bay (down-facing quad), the walkway lamp heads (short tubes) and the
  under-canopy fluorescent line. M_LAMP lights only n.y < -0.5 faces strongly; a vertical
  light-box face only gets the x4 night term - consider a brighter side term for lamp param 1
  on vertical faces if the fascia strip reads too dim.
- Signal heads: both lamps are now `CM.lamp` 3/4/5 (G over Y, Y over Y or R over R).
- `RC_PLATFORM_FACE` also on the stair-well walls (down to the slab soffit); `RC_PLATFORM` on the
  stair treads/risers (uv: risers 0..0.265 m tall, treads 0..0.32 deep, 2.2 m wide).
- `RC_TROUGH` also on the outer cable trough hung on the s = -1 fascia (y -0.06..0.30,
  lateral 5.2..5.5) and on the gully boxes at downpipe feet.
- `RC_PARAPET` also on the soundwall coping cap (4.99..5.21, y 2.74..2.87).
- `RC_COLUMN` columns are now chamfered prisms (u around the perimeter, 2(hw-0.07) per face,
  so the shader's "face whose uv.x span is 1.0" test for the ID plate sees 0.86/1.06); roadside
  columns have an 8 cm plinth to 0.3 m.
- Lab: `LabInfo.train` parks one train at the site; trains in the lab are drawn but never move.

### Round 3 geometry additions (for the shader engineer)

- **Column arris (needs shader):** the chamfer is now CH = 0.10 m, but the bevel still shares
  the face vertices (flat bevel normals would cost +116k in river). On `RC_COLUMN` faces the bevel
  is the u span `[k*2hw + 2(hw-CH), (k+1)*2hw]` of face k, i.e. `fract(u / (2hw)) > 1 - CH/hw`;
  hw = 0.5, or 0.6 when the new flag **`RC_WIDE = 0x40`** is set (flank columns, 1.2 m of u per
  face). The interpolated normal already turns through the diagonal there; please paint a worn,
  ~20 % paler arris band (and/or snap the normal to the diagonal) over that span so the corners
  read as a line at 30-60 m. Roadside columns' footing collar is now 10 cm proud to 0.45 m.
- `CM.ledLine` param 0 (white, every face x20 at night) on the walkway lantern diffusers
  (0.6 x 0.16 x 0.22 m box on a post above the soundwall cap, 3.44 m above the deck).
- `CM.lamp` 1 also on: the coping light line (a vertical, outward-facing 10 cm strip on every
  non-station span, 5 mm proud of the coping lip outer face, y 1.14..1.24); the fascia up-light
  fittings (box under the coping, outer face, every 4th bay alternating sides, with a point light);
  the under-soffit fluorescent fittings (now 7 cm tubes 12 cm below the centre soffit); the
  under-platform fluorescent rows; the concourse canopy underside; the back-lit platform clock
  faces. A vertical lamp-1 face only gets the x4 night term: if the coping line reads too dim at
  the far view, a brighter side term for lamp 1 would help it.
- Signal heads carry lit lenses on both faces (the back face is the opposite direction's aspect);
  lens boxes are 0.30 m and stand 9 cm proud so their sides glow from across the line.
- `RC_TROUGH` also on the centre cable trough between the tracks (lid top 'h' at y 0.22,
  |lateral| <= 0.32, uv.x along in bent units; sides 'v'). The centre `CM.rail` flat is now only
  0.32..0.6 each side. Off the platforms the outer ballast shoulder drops to y -0.10 at 4.0 into
  a concrete cess (`RC_PARAPET`, 'h', 4.0..4.3).
- Platform coping stones: `RC_PLATFORM` 'plat' strip 0.0..0.4 m from the edge, 3 cm proud (y
  1.48), so the white edge line now sits on a raised precast edge; the paving starts at 0.4.
- `RC_BEAM | RC_ROADSIDE` quads along the bottom 0.45 m of both outer girder webs over roads
  (1.5 cm proud), uv.y mapped to 1.1..1.38 so the existing hazard band fills them.
- Pier number plates: `CM.sign` 56..63 (the JR board look) 0.4 x 0.26 m quads, uv 0..1, on the
  street face of every column taller than 3.5 m, 2.6 m up.
- Gado-shita infill (~1 bay in 4 off roads): corrugated `CM.paint 0xf8` or `RC_STATION` side
  walls, a roller shutter (0xf8 with uv u = height, so the ribs run horizontally), a shutter box
  and a 4:1 atlas sign (`CM.sign` 32..47). Logged as camera solids.
- Downpipes: `CM.paint` PAINT_STEEL | 3 (dark green) tubes, r 0.11, on the outer column face.
- Station: cap beams (`RC_BEAM`) under the platform slab at every station bent; two 0.45 m
  longitudinal ribs per side; ducts `CM.paint 0x90` (r 0.16) and `0x301` (r 0.08); concourse
  vestibule `RC_STATION | RC_GLAZED` box 1.5 m proud with `CM.frame` door frame, canopy with a
  line-colour band (`CM.paint 0x0c`), fins and a louvre band on the upper band, AC units
  (`CM.paint 0xd0`), a bike rack; stair towers get rooftop plant and fins. Platform: benches and
  vending every bay in a 4-bay rhythm, platform number plates (`CM.roadSign` 24+, both faces),
  departure boards lowered 0.35 m on rods with a clock beside them.

### Round 4 geometry additions (for the shader engineer)

- **Thin lines (city.wgsl vs/fs, cmesh tube contract):** the beading / stair-stepping was TAA, not
  the widening: hashed coverage only survives where the 3x3 variance clip keeps history, and a
  sparse dither (a wire at 10-40 % coverage) has frames with no covered neighbour, so the history
  is wiped and the line comes out as dots. Now overhead-line wires (`CM.wire` params != 0) widen to
  `MIN_LINE_PX` 0.85 (~1.2 px across the diamond) with a coverage floor of 0.5 (0.3 past 260-520 m),
  and `CM.lamp` joined `TUBE_MATS`: **lamp tubes are drawn as solid min-width lines** (no dither;
  VOut.cov < 0 carries the true coverage and fs scales `s.emissive` by it). Street wires (param 0)
  and frame/paint/metal tubes keep the old 0.7 px hashed path.
- **Coping light line** is now a lamp tube, **`CM.lamp` 7** (r 4.5 cm at lateral 5.455, y 1.155,
  continuous over each non-station run, both sides), replacing the lamp-1 strip. With the solid
  min-width path it no longer needs lamp 7's x8 distance boost to stay continuous: at far-night it
  now reads as a bright, slightly blooming tube; please drop the boost to ~x2-3 for param 7.
- **Soffit fittings** (the 1.2 m tube under the centre soffit, every bay) are **`CM.lamp` 6** (was
  1): distance-boosted, solid min-width, so they read as a row of lit bars from afar.
- **Coping lip** is 19 cm deep (y 1.25..1.06, was ..1.13): deeper shadow line. The RC_FASCIA face
  top is now 1.06 (uv.y still metres down from it). The lamp-1 LED strip under the lip is at 1.03.
- **Scuppers:** a dark green spout (`CM.paint` 0x303, r 7.5 cm) through each non-station fascia,
  both sides, from (5.12, y 0.97) to (5.68, y 0.84), at exactly `u = scupperU(seed, i)` (gen-base.ts):
  `12i + 6 + (hashuf(hashu(seed * 0x9e3779b1 ^ (i + 65536)) ^ 0x22) - 0.5) * 1.8` - the x0 of the
  scupper streak in `deckStains()`. If you move/re-anchor that streak keep x0, or tell me; the
  streak should start right under the spout (uv.y ~0.1-0.2 from the fascia top) with a hard top.
- **Cable troughs (off platforms):** two precast troughs per side: signal 4.3..4.6 (lid
  `RC_TROUGH` 'h' at y 0.295, a 5 cm `RC_PARAPET` 'h' rim at 4.3..4.35 y 0.32), a step face
  (`RC_TROUGH` 'v') up to the power trough 4.6..4.9 (lid y 0.355), its outer face down to a 5 cm
  dark gap (4.9..4.95, y 0.2, `RC_PARAPET` 'h') against the parapet. Centre trough: 5 cm
  `RC_PARAPET` rims at |lateral| 0.27..0.32, y 0.24, lid 0.22. **Shader ask:** lids still read as
  pale paving - darker/greener lid tone than the rims, 1 m lid joints that survive to ~30 m
  (prefiltered), some lids rocked (+-tone), a cable glimpse at 1 in 40 joints.
- **Ballast shoulder (off platforms):** crown 0.9..3.3 at y 0.15, then one 'bed' slope to
  (4.05, -0.17) (n ~ (0.39, 0.92)), cess `RC_PARAPET` 'h' 4.05..4.3 at -0.17. `uv.x` is the signed
  lateral, so `abs(uv.x) > 3.3` is the slope: paler fresh stone with a darker toe would sell it.
- **Soundwall panel mix:** `RC_SOUNDWALL` params carry **`(param >> 7) & 3` (RC_PANELS_SHIFT = 7)**
  per 120 m stretch: 0 all ribbed grey; 1 ribbed + ~1 in 4 clear polycarbonate; 2 ribbed + ~1 in 6
  replaced panel in a fresher/other tone; 3 all three. Pick each ~2 m panel by
  `hash(floor(uv.x / 2), aux seed)`; +-8 % tint, grime at the foot. (Glazed bit 0x20 unchanged.)
- **Soundwall ends:** galvanised H end post (0.26 x 1.88 m, 25 cm above the cap) and a 6 m raking
  taper (both panel faces, wall mat, uv.x continues the run's bent units, uv.y from the panel top)
  with a sloped `RC_PARAPET` cap down to the parapet. Next to a platform: post + end face only.
- **Clearance boards:** every girder span's outer web now has 0x80 set (board on every span), plus
  a proud plate (`CM.paint RAIL_GIRDER | 0x80 | seed`, 3 cm proud of the web at lateral 4.43, in
  front of the hazard band, y -1.8..-2.3, uv = (12i + 4.8..7.2, 0.9..1.4)) with `CM.frame` edges.
  **Shader ask:** a real black numeral (e.g. "4.5m" via rdDigit) in the white panel instead of the
  noise glyphs.
- **Station:** line-colour band (`CM.paint 0x0c`, 0.45 m, 2 cm proud) along both platform outer
  fascias (y 0.5..0.95); canopy purlins (galv-less `CM.metal` tubes r 6 cm, ~2.5 m apart, 4.1..9.7)
  each with a 1.2 m `CM.lamp` 8 tube fitting (5.4..6.6); yellow car-position plates (`CM.paint`
  0x92, 0.28 x 0.24 m, facing along) under the canopy fascia every 24 m.
- **Lab:** new `platform` view for station sites (on the +1 platform at eye height looking toward
  the stair head: canopy soffit, departure board, clock, benches, vending).

### Round 5 geometry additions (for the shader engineer)

- **Wires (city.wgsl):** the round-4 code still gave overhead-line wires a 50 % *hashed* coverage
  floor whenever they were thinner than the min width, i.e. at every range past ~10 m: that was the
  mid-range "barbed wire" (120-300 m in `mid` / `far`). Overhead-line wires (`CM.wire` params != 0)
  now go down the lamp path: a SOLID min-width line (`MIN_LINE_PX` 0.7, ~1 px across the diamond),
  `VOut.cov` = -true coverage, out to `LINE_FADE` = 700 m, then a 30 % dither. Lamp tubes are also
  0.7 px now (was 0.85; their light is still scaled by the true coverage). No material change needed;
  if the wires read too dark/heavy against sky, a coverage-driven lift is possible in `fs` (ask me).
- **`RC_FASCIA | RC_RECESS` (`RC_RECESS = 0x40`, gen-base.ts):** the top 0.36 m of the fascia (y 1.06
  .. 0.70) is now set back 8 cm (5.12 lateral) under the coping lip, then a 45-degree weathering fillet
  (plain `RC_FASCIA`, normal out+up) steps back out to the 5.2 face at y 0.62. All three faces keep the
  fascia's uv.y (metres down from 1.06), so formwork rows, scupper streaks and stains run straight
  across. The lip soffit now spans 5.43 .. 5.12. **Shader ask:** darken the `RC_RECESS` face (~0.6x,
  grime / damp, still formwork) so the band under the coping reads as a dark line at mid/far range in
  flat or back light too (it is only in the lip's shadow when the sun is on that side). Role is still
  `param & 0xf == RC_FASCIA`, so nothing breaks if ignored.
- **Expansion-joint cover plates:** `CM.paint 0x304` (PAINT_STEEL seed 4, dark rust-brown, chipped)
  boxes 0.4 m wide x 1.96 m (y -0.92 .. 1.04, lateral 5.10..5.25) over the fascia at every 4th bent
  (`i % 4 == 2`, halfway between gantries), both sides, off stations: a dark tick every 48 m.
- **Underside:** cable tray along the +1 side (`galv` metal: bottom 'h' 2.8..3.38 at y -1.25 against
  the edge beam / girder inner face, a 15 cm 'v' lip at 2.8); grey conduits (`CM.paint 0x90`, r 4 cm)
  up the inner face of ~1 in 3 non-flank columns (on the +1 side with a junction box at 1.6 m and a
  bend into the tray); **bearing plinths** at every main column head taller than 3 m (column stops
  0.3 m lower; an `RC_BEAM` block 8 cm proud all round, 0.3 m, closed soffit). Under-deck lights: the soffit fluorescent light is
  radius 9 at half colour (was 11, full); the bent LEDs are now `LightKind.station` radius 11 at 0.8
  (were street kind, radius 18 - the junction-luminaire path washed the whole underside white).
- **Station canopy roof:** `CM.paint SKYLIGHT` (**0xd2**, new; pale-grey fallback) 0.8 m x bay
  skylight strip boxes down the middle of the roof (lateral 7.0, 4 cm proud); ridge ventilators
  (`CM.paint 0x90`, 0.44 x 0.36 x 0.6 m with a cap) every 2nd bay near the high edge; an eaves
  gutter tube (`CM.paint 0x90`, r 7.5 cm) along the low track-side edge. **Shader ask:** SKYLIGHT
  as milky polycarbonate (pale, glossy, faint 0.1 m ribs along u, a soft glow at night).
- **Concourse upper storey (night band):** a 1 m clerestory ribbon on both long faces (quad,
  `RC_STATION | RC_GLAZED`, uv.x metres along, **uv.y 1.2 .. 2.2** so it is all glass between kick
  plate and transom) centred in the upper band (lateral 9.87, behind the fins), a `CM.ledLine 0`
  cornice line over it, and when the band is > 3 m a row of back-lit 4:1 ad boxes (`CM.sign 32..43`
  on a `CM.frame` box, uv 0..1, 3 x 0.76 m, 0.33 m proud) above it, clear of the name board. The
  glazed hall emissive is room-level and faint on this thin ribbon at night: a brighter emissive for
  glazed faces whose uv.y starts at 1.2 (or any brighter term) would help it.
- **Platform:** perpendicular mid-platform name board raised to 2.6 m clear (on two rods); the
  track-facing boards 13 cm higher (bottom ~2.16 m); two double-faced hanging clocks per platform
  (lateral 8.3, 2.45 m: `CM.lamp 1` 10-gon face uv 0..1 around the centre, `CM.paint 0x91` rim
  tube and hands at 10:08); green (`CM.paint 0x0c`) 0.45 m car-position floor squares every 6 m at
  1.25..1.7 m from the edge (4 mm proud); slatted benches (4 seat + 3 back slats, steel end frames);
  vending machines' display window recessed 6 cm (a proud lower body 0..0.7 m and header 1.5..1.8 m,
  same `CM.vending` param, uv.y from their own bottoms so no drink rows on them). The shader's
  white edge line (x 0.04..0.16 on the coping) is there but low-contrast against the pale coping
  (0.8 vs 0.5) - a brighter / wider line would make the judge see it.
- **Lab:** the `platform` view now stands at -8 m (was +4) looking at +40 m, so the hanging board is
  whole, ~14 m ahead, with a clock beside it.
- **Round 5 follow-ups (after shader round 5):**
  - `DEPARTURE` is now **0x10000** (bit 16; ad screens carry at most a 16-bit seed), and the
    `screenMat` selector is `(param >> 16u) == 1u`, so no ad can render as a departure board.
  - **`RC_CLERESTORY` = 0x80** on the concourse clerestory ribbon (`RC_STATION | RC_GLAZED |
    RC_CLERESTORY`). Its emissive is the delimited "Clerestory band" block in the glazed branch of
    `railConcrete` (city-materials.wgsl): a warm band between the mullions, x0.15 by day, x1.4 at
    night. The shader engineer can retune it.
  - Name boards are 0.64 m tall (0.72 m for the concourse one) and 4.8 m wide (2 x the 2.4 m unit)
    or 2.4 m (the perpendicular board) / 7.2 m (concourse) / 4.8 m (stair tower), so the 0.6 m atlas
    cell fits inside the frame and the 2.4 m unit repeats with no clipped remainder. The
    perpendicular board is still 2.6 m clear.
  - **`VENDING_FRONT` = 0x300** (`CM.vending`, `| body 0..2`; 0x300 % 3 == 0, so `param % 3` still
    picks the body colour): the platform machines' display front is its own quad 3 mm proud of the
    box's +x face with the same box UVs (u 0..0.9, v 0..1.8). **Shader ask:** draw the window and
    header only where `(param & 0x300) == 0x300` (or on the street machine's mesh); the box's other
    faces then stay plain body.

### Round 6 geometry additions (for the shader engineer)

- **Fine OHLE hardware fade (city.wgsl vs, cmesh.ts `FINE_TUBE` = aux bit 31 on a tube):** droppers,
  drop poles, registration / messenger arms, insulators, disconnector rods and jumpers, ladder rungs and
  stand-offs, tray drop rods fade out (hashed coverage) between `FINE_NEAR` 45 m and `FINE_FAR` 100 m.
  Contact, messenger and feeder wires stay solid min-width lines. Only **one feeder** now (on the -1
  masts, 9.0 m): five overhead lines instead of six. No material change needed.
- **Gantry variety** (per gantry hash, not the layout RNG): ~58 % light Warren truss portal (as before);
  ~25 % **cantilever pairs** (horizontal galv arm at 7.9 m from each mast to lateral 1.3 plus a raking
  tie; no beam over the centre); ~17 % **heavy portals**: galvanised H masts (two 0.3 m flanges + web,
  `GALV` boxes) to 9.6 m with a cap plate and a **0.8 m deep box girder** (`GALV` box, 7.9..8.7);
  every signal location (`i % 24 == 0`) is a **signal bridge**: the heavy portal plus a 1.1 m grated
  walkway (`GALV` box at 8.74) with handrails at 9.3 / 9.85 and a ladder up the -1 mast. The big
  `GALV` boxes are flat metal faces 10 m long: a little streaking / bolt-row rhythm along u (box UVs,
  metres) would help, they read as one flat bar now.
- **Disconnectors** on ~1 gantry in 3: `CM.paint 0x90` box (0.44 x 0.68 x 0.56 m) high on a mast's
  outer face at 7.05 m, a handle box at 1.85 m, a FINE operating rod and an insulator + jumper.
- **Expansion joints** (`i % 4 == 2`, same as the round-5 cover plates): a **coping step** - an
  `RC_PARAPET` box 0.6 m along, y 1.04..1.50 (25 cm proud of the coping top), lateral 4.95..5.49
  (5.18.. on soundwall stretches), box UVs (metres) - and a galv **finger plate** quad across the
  walkway troughs (lateral 4.31..4.93, y 0.365, uv metres).
- **Accent spans: `RC_ACCENT_SHIFT` = 9, `(param >> 9) & 3`** on one span in ~5 (hashed position per
  run of five, hashed kind): set on that span's `RC_FASCIA` faces (recess band, fillet, face; with
  `RC_RECESS` where applicable) and on the `RC_PARAPET` coping lip outer face. **Shader ask (#2):**
  1 = repaired span (fresh, paler patch-repair mortar, crisp ends at the bents), 2 = protective
  coating (warm grey-beige, flatter, cleaner), 3 = old span (darker, heavier soot / run-off);
  roughly +-10-15 % value so a 12 m span reads as lighter / darker at the far view. Ignored = today.
- **Span number plates:** `CM.sign 56..63` (the pier-plate JR board look, uv 0..1) 1.2 x 0.5 m on the
  fascia (lateral 5.215, y -0.2..-0.7, 28 % into the span), both sides, one span in five.
- **Lineside cabinets:** `CM.paint 0xd0` location cases (0.56 x 1.6 x 1.1 m with a rain-hood box, a
  second 1.2 m case beside about half) on the walkway troughs (lateral 4.34..4.9) in ~1 span in 5,
  off soundwall stretches; they stand ~0.7 m over the coping in profile.
- **Maintenance ladders:** every 10th bent (alternating sides, off soundwalls and stations): a caged
  galv ladder at lateral 5.75 from 2.3 m above ground to 1.05 m over the coping, stiles bent over
  into the walkway (lateral 5.15), hoops every 1.8 m, stand-offs to the column / edge beam / fascia.
- **Cable tray moved** to where it can be seen from the ground: lateral 2.7..3.3, bottom at y -2.95
  (under the transverse beam haunches; it was at -1.25, hidden between beams), 20 cm lips both sides
  (galv), a dark cable bundle top (`CM.paint 0x301`, 'h', y -2.8), drop rods every 4th bay. Only on
  non-station, non-girder spans. The +1 conduits now bend into it at y -2.85.
- **Station canopy roof top:** standing seams every ~0.9 m down the slope (`CM.paint 0xf8` 5 cm
  tents, normals 45 degrees along, uv = the roof's: u along from the segment start, v 0..5.8 up the
  slope), the skylight is now a **raised ridge rooflight** (`SKYLIGHT` prism 0.84 m wide, 0.24 m
  tall; slopes uv u along 0..len-0.6, v 0..0.48; triangular ends), a capped ventilator in **every**
  bay (`CM.paint 0x90`, 0.6 x 0.5 x 0.9 m, cap 0.8 x 1.1 m) and a 6 cm gutter lip (`0x90`, both
  faces) on the low track-side edge; the round eaves gutter now hangs just under that edge (3.93,
  CY + 0.07) instead of on the roof. The train eye is only ~0.2 m over the low edge, so the raised
  rooflights / vents are what shows; SKYLIGHT still wants its milky polycarbonate look, and the
  roof top's grazing view would gain from a stronger rib / sheet-lap contrast that survives
  foreshortening (the 0.9 m laps are ~1 px tall there).
- **Station under-deck pools:** where a station's under-deck fitting is too high for its light to
  reach the ground, a second `LightKind.station` light (radius 8, 0.4x colour) 5.2 m above the
  ground under it throws a pool (lighting.wgsl's high-fitting cone).
- **`CANOPY_FASCIA` = `CM.paint 0xd7`** (new) on all station canopy fascia faces (track-side
  0.45 m fascia, both faces, and the 0.3 m back fascia; uv.x metres along, uv.y metres down from the
  roof edge), replacing the shared 0xd0. Pale-grey fallback until the shader panels it (this is the
  big flat slab seen from the train in `station0-along-day`).
- **Vending flags:** platform machines' proud lower-door box is `CM.vending VENDING_DOOR (0x100) |
  body`, the header box `VENDING_HEADER (0x200) | body` (box UVs; uv.y from each box's bottom).
- **Lab:** rail sites hide the park / lawn blocks the `side` preset's sight line crosses in the 30 m
  in front of the eye (their trees go with them): a park crown filled `rail-station0-side-*`. The
  station0 site stands in a big park, so its views (ctx and not) now show bare ground around it.

### Round 7 geometry additions (for the shader engineer)

- **Heavy portal / signal-bridge beam is now a rolled I girder** (was one `GALV` box 10.1 x 0.8 x
  0.34 m): top and bottom flanges `GALV` boxes 0.4 m wide x 4 cm (y 7.90..7.94, 8.66..8.70), a 2 cm
  web (`GALV` box, y 7.94..8.66, recessed 19 cm behind the flange edges) and 9 web stiffeners each
  side (16 mm plates, two faces each, every ~1.24 m, `GALV` quads, uv 0..0.18 x 0..0.72 m). No
  `GALV` face on a portal beam is now taller than 0.72 m, so a drip / streak gate on face height
  (> ~1 m) keeps them off the beam; the flange edges are 4 cm (box UVs, metres).
- **`MAST_PAINT` = `CM.paint 0x307`** (`PAINT_STEEL | 7`: dark green paint, chipped; seed 5 grey read as concrete) on every OHLE
  mast (light box masts, heavy H masts and cap plates): darker than the concrete. Beams, cantilever
  arms, droppers and hardware stay `GALV`. Also used on the soundwall access doors. Retune it in `paintedSteel` (seed & 3 == 3) if it reads too rusty.
- **Coping light line removed.** Instead: one 1.2 m `CM.lamp 7` fitting (0.5 m ones were sub-pixel at the far view) (a lamp tube, r 4.5 cm, at
  lateral 5.455, y 1.155) in **every span per side** (~12 m; at every 2nd span the far-night deck line vanished), at
  a hashed spot 20-80 % into the span; ~10 % of them are dead (the same tube in `CM.paint 0x90`).
  **Shader ask:** for lamp 7 (only the coping fittings use it), 3-5x dimmer than today's `14 *
  min(boost, 2.5)` and a per-fitting warm / cool mix, e.g. `hash21(floor(world.xz / 2.0))` < 0.35 →
  warm (1.0, 0.8, 0.55), else the cool LED (each fitting is 1.2 m long, so a 2 m cell is ~one
  fitting). The lamp-1 down-facing LED strip under the lip on ~30 % of 120 m stretches is unchanged.
- **Accent spans are now joint-bounded blocks of four** (bents 4b+2 .. 4b+6, between the cover
  plates at `i % 4 == 2`; ~30 % of blocks, kind hashed per block, none touching a station), so every
  accent edge sits on a plate and the shader's hard breaks only happen at joints.
- **I-girder stiffener quads:** uv.y = metres up from the stiffener foot (0 at y 7.94, 0.72 at
  8.66), like the box faces, so the face-height drip gate sees 0.72 m.
- **Fascia grime seam (judge "Broken"):** the per-span seed (aux >> 16) changes at every bent, i.e.
  at **u = 12 i exactly** (every multiple of 12 in bent units) on every `RC_FASCIA` / `RC_RECESS` /
  fillet face and the coping lip outer face. Only `i % 4 == 2` (u = 48k + 24) carries an expansion-
  joint cover plate. **Shader ask:** either blend the span-seeded grime / stain terms across
  `|u - 12 round(u / 12)| < ~0.6 m` (lerp toward the neighbour span's seed, i.e. aux >> 16 +- 1 is
  not available, so fade the span-specific terms to a shared world-space field near the seam), or
  draw a 2-3 cm dark sealant joint line at `fract(u / 12) == 0` (prefiltered) so the change sits on
  a joint, as it does on a real simply-supported viaduct.
- **Galvanised cable tray on the +1 outer fascia** (non-station spans, `edgesOf`, so it runs
  continuously): soffit `GALV` 'h' lateral 5.25..5.6 at y -0.05 (n down), outer face 'v' at 5.6
  from y 0.35 down to -0.05 (uv.y metres down from 0.35), a 4 cm return lip on top (5.56..5.6,
  y 0.35 / 0.31), and the dark cable bundle `CM.paint 0x301` 'h' at y 0.22. A galv bracket quad
  under it every 4th bay (`i % 4 == 2`). Its soffit throws the shadow line on the fascia below it.
  (The -1 side keeps the concrete `RC_TROUGH` trough at the same height.)
- **Span plates** are 1.8 x 0.7 m (was 1.2 x 0.5; y -0.15..-0.85 at lateral 5.215, 28 % into
  the span, one span in five, both sides) and alternate per run of five between the white board
  (`CM.sign 56..63`) and a JR-blue plate (`CM.roadSign 24..31`, uv 0..1).
- **Cabinet clusters** (`CM.paint 0xd0` location cases, 1.2 m along x 0.6 m x 1.4 m tall, a
  rain-hood box on each, a shorter 1.0 m third case on ~35 %): one span in four (hashed position in
  each run of four, hashed side) on every non-station stretch. Off soundwalls: on an `RC_PARAPET`
  plinth on the walkway troughs (lateral 4.34..4.94, base y 0.56, top ~2.0: 0.75 m over the coping).
  On soundwall stretches: outside the wall on a bracketed `GALV` grated platform (lateral
  5.44..6.28, y 1.19..1.25, 3.5 m along) with two raking `GALV` struts from the fascia (y -0.6) and
  a handrail (lateral 6.25, y 2.3): a box on the deck edge seen from the street.
- **Ladders** now on one bent in six (alternating sides, 12 columns apart on a side; piers under
  26 m only: most of the river line is 30-90 m up, where a caged ladder is absurd) and **on
  soundwall stretches too**. Each has a railed `GALV` grated rest platform (lateral 4.42..6.55,
  1.6 m along, 6 cm, handrail 1.1 m, toe board) at the bearing level (y deck - 2.45) with the
  ladder through a hatch in it; on soundwall stretches it tops out at a railed landing outside the
  wall at coping level (lateral 5.45..6.55) with an access door in the wall (`MAST_PAINT` quad,
  0.84 x 1.4 m, uv metres, 7 mm proud of the outer panel face at 5.167).
- **Station mid-bay portals:** inside a station (both neighbouring segments station) every
  `i % 4 == 2` point now also has a light Warren-truss portal (masts at +-4.8 on the platforms,
  `MAST_PAINT`), with drop poles, registration arms (stagger 0 there) and a messenger arm at the
  sagged messenger height (MW - 0.5). The along view at a station no longer sees wires and
  droppers 24 m from any support (judge st6 "arms hanging from the canopy").
- **Canopy roof top:** the round-6 standing seams stay (I tried steep 7 cm ribs every 0.6 m: from
  the grazing along view their eye-facing flanks merge into one evenly lit plane, flatter than the
  45-degree seams, so the roof's read is the shader's tone / grime / roughness). **Box gutter** along the low (track-side) edge, in front of the fascia top:
  a 0.25 m face toward the track (lateral 3.8, y CY+0.21..CY-0.04, `CM.paint 0x90`, uv.y metres down),
  its soffit (3.8..4.0) and a near-black wet channel (`CM.paint 0x301`, up-facing, y CY+0.13)
  seen from the train eye; the round eaves-gutter tube is gone. **Shader ask (roof):** albedo
  ~0.45 instead of near-white, grime streaks down the slope toward the gutter (v -> 0), a
  per-sheet (1 m along u) roughness / tone variation so the sky highlight breaks up.
- **Concourse:** a lit station-name band behind the concourse name board on both long faces
  (`CM.lamp 1` diffuser box 7.8 x 1.0 m at lateral 9.88; lamp 8 side faces were too dim, plus `CM.ledLine 0` edge lines top and
  bottom); **back-lit portrait ad panels** (`CM.screen`, seed (si*13 + ...) & 0xff, uv 0..1,
  1.2 x 1.8 m on a `CM.frame` box at lateral 9.85, 0.45..2.25 m up) two each side of the entrances
  (not over the bike rack); an **IC gate line** under each entrance canopy: five `CM.paint 0xd0` gate
  cabinets (1.1 m deep x 0.18 x 1.0 m, lateral 11.5..12.6) with a blue `CM.ledLine 1` IC reader
  slab on top and a small white `CM.ledLine 0` indicator on the street end, and a
  `LightKind.station` light (radius 6, LED) 2.4 m over them. No shader change needed.
- Vertex cost (river, rail-only): round 6 1,040,922 → round 7 see the commit message.
