# Rail viaduct (rail-0, rail-station0) judge, round 0: 3.5/10
Scores: silhouette 4, relief 3.5, material 3.5, colour 3, wear 2.5, distance 5, close-up 4, lighting 4, IQ 5.
"Structure underneath is reasonable (hammerhead piers, beams, seams, AO, LOD1 matches). Everything a player reads it by is missing:
one grey tone, sleepers painted stripes on a flat plane, overhead wiring invisible, no light at night, no wear. PS2 concrete ribbon."
Top fixes:
1 Overhead wiring invisible: contact wire is a 15 mm half-width beam at 5.4 m (gen-base.ts railViaduct ~851), sub-pixel. Add per-track
  messenger (~6.4 m, parabolic sag), contact wire 5.1-5.4 m zig-zag +-0.2 m, droppers every ~6 m, registration arms + brown insulator
  stacks on gantries, 1-2 feeders on mast tops; min screen-width tubes (as round 6 buildings) with coverage. Also: two heavy sagging
  wires outside the tracks at post height in along-* - unknown source, check.
2 Track: sleepers are shader stripes (M_RAIL loop city-materials ~3158), rails bare 4x8 cm boxes, ballast flat wall to wall. Real
  sleepers (~0.2 m, every 0.62 m) or Tokyo slab track (raised panels, central gutter); fastening clips; rail profile or shiny head face;
  profiled ballast shoulder; cable troughs with lids at parapet bases; walkway + handrail; rust rail sides, polished heads, oil/brake dust.
3 Monochrome grey: per-span concrete tone, galvanised/rust-oxide gantries, yellow-black chevrons on pier bases, km posts/signage plates,
  wayside signal posts with emissive heads.
4 Soundwalls: H-posts every 2 m with infill panels (translucent polycarbonate / ribbed metal), cantilevered cable rack outside. Fixes
  "flat ribbon at distance".
5 Wear: black drip streaks below deck-edge drains (~18 m) and parapet joints, efflorescence at cold joints, rust bleed, pier splash band,
  black downpipes on every pier (m.tube), graffiti/posters underneath.
6 Night/rain: viaduct pitch black at night (signal aspects, gantry lamps, fluorescent strips under the deck); rain only darkens (rail heads
  rough ~0.1 wet, bed pooling, pier streaks).
7 Station: corrugated canopy roof strong moire (band-limit by fwidth); canopy one flat slab on one row of posts -> butterfly/gable on
  T-frames, fascia, light boxes; yellow tactile strip, white edge line, JR-style name signs, stair enclosures, concourse box w/ gates.
  Station building is a generic apartment block whose red sign clips the canopy underside.
8 Piers: single square hammerheads with no footing, every span identical -> two-column RC rigid-frame bents, chamfers, footings,
  bearing pads; steel plate-girder span over roads (onRoad exists); infill walls/shutters between bents.
Broken: no contact wire visible; canopy moire; station building clips canopy; wires break into dashes; street utility wires end in
mid-air at the viaduct fascia (side-deck ~x495).
