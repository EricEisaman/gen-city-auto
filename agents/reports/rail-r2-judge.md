# Rail viaduct judge, round 2: 5.3/10 (r0 3.5, r1 4.8); station sub-score 4.5
Scores: silhouette 6, relief 6, material 5.5, colour 5.5, wear 5, distance 5.5, close-up 5.5, lighting 5, IQ 5.5.
"Clear step up: OHLE connects, fascia wear no longer one stencil, under-deck lights work, teal girders give a real Tokyo accent; up on the
deck by day it looks like a plausible Densha de Go! backdrop. Under 6: disappears at night at mid/far, soundwall glows like a flat card at
night, track and platform still clean CG, station underside/concourse placeholder."
LEAD NOTE: the judge reports as MISSING several things round 2 claims to have built: column chamfers ("no edge highlight even at 2x"),
downpipes, cable troughs, sloped ballast shoulder, per-sleeper tone ("still uniform pale grey"), tactile blocks, departure boards/vending,
second signal head lit ("still dark" on side gantry). FIRST verify each on main in the lab renders; if present but invisible, make it read.
Top fixes:
1 Night at mid/far: viaduct is a black void between street-lamp pools (far-night, mid-night, ctx-far-night). Distance-stable walkway lamp
  emissives (>= 2 px, also in LOD1), coping emissive strip on every span, signal flare sprites to ~500 m, under-deck fluorescents as emissive
  quads in LOD1 so the soffit glows from afar.
2 BUG: soundwall panels glow evenly pale blue at night with no source (along-night, ctx-along-night): dark tinted glass albedo ~0.05 +
  reflection, lit only by real lamps; per-panel tone, top-down grime, some opaque ribbed spans, mullion shadowing.
3 Station: soffit flat cloudy slab with no cap beams for ~30 m (station under-day) -> cap beams every bent, longitudinal ribs,
  fluorescent rows, ducts; concourse glass blown pure white at night, same diagonal reflection streak on every pane -> window/interior
  shader (ticket gates, lit ceiling ~3x not saturated), per-pane reflection; real entrance (glazed opening, stair/escalator, line-colour
  name sign, door canopy, bike parking); upper box louvres/fins/signage/rooftop AC. Station column splash band is LIGHTER than shaft
  (reads as salt) -> darker.
4 Wires bead and crawl; droppers not visible at zoom; second signal head dark -> every head lit by hash.
5 Track/platform CG-clean: per-sleeper tone/offset/yaw, sloped shoulder, oil band, rust on feet/clips; centre strip = cable trough with
  lids; platform tactile dot/bar pattern (normal-mapped), white edge + coping stone, paving joints, departure board + clock, benches and
  vending every 20 m, platform numbers.
6 Rain does almost nothing to the structure: pier/fascia streak roughness ~0.15 + darker, rail heads ~0.05 with sky reflection, ballast
  x0.6 rough 0.3, puddles on walkway/platform, coping drips, wet splash bands.
7 Story/colour: posters/graffiti on street-level piers, bridge number plates on every pier, yellow-black height-clearance signs on
  girders over roads, rust bleed, per-span girder paint variation, efflorescence at deck joints, fencing/shutters infilling some bays.
8 Fascia black at night (spill from cap lights doesn't reach outer face); visible 5-8 cm column chamfers, footing collar, downpipes.
Possible: soundwall stops while deck continues with low parapet in rail-0-mid-day left third - check it isn't a placement gap.
