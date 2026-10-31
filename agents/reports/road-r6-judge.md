# Road (road-0) judge, round 6: 6.6/10 (r0 3.5 ... r4 5.9, r5 6.4)
Scores: section 6.5, furniture 6.5, material 6.0, colour 6.5, wear 6.5, distance 7.0, close-up 5.5, lighting 7.0, IQ 6.0.
Fixed: red-lane motion blur (now hard-edged peeled paint), box dark in nightrain, cover lattice + rust ring by day, furniture checklist
(flange, bolts, collars, backplate border, push button, cabinet, bollards), LOD1 == LOD0.
"New furniture correct as a checklist but primitive as models at 4 m (the new `pole` view). Wet nightrain ctx frames close to Ghostwire;
daylight close-ups still mid-budget."
Top fixes:
1 Pole foot low-poly + rust "sock" (pole-day/golden, pf2): 16-24-sided plinth with 2 cm top chamfer, 4-6 hex bolts (3 cm) evenly spaced,
  optional steel skirt; rust mask from flange up 0.05-0.4 m with irregular fbm top edge (not sawtooth band), vertical drip streaks
  ~0.02x0.4 m, damp/dirt gradient over bottom 0.15 m.
2 BROKEN: pole base becomes chrome mirror in rain (pole-rain, ctx-pole-rain, pole-nightrain): painted steel stays dielectric
  (metal <= 0.1), wet rough floor ~0.25, never boost metallic with wetness.
3 BROKEN: nightrain horizon "picket fence" of bright white vertical bars + mirrored copies along the far road edge/graded terrain
  (low-nightrain, pole-nightrain, ctx-low-nightrain; absent in low-night): guard-rail posts/delineators going near-emissive under wet
  spec/SSR, or SSR hits on terrain edge: clamp spec on thin posts, own roughness, fade SSR at screen edge/grazing, reject back-facing.
4 Furniture plain boxes: push button needs white face plate 0.18x0.25 m + round button + emissive wait lamp; cabinet door seams (1 cm
  inset, 3 sides), 6-slot louvre, stickers, bottom grime; utility pole step bolts from 2 m, blue/white number plate at 1.6 m, yellow-black
  base guard; ped signal hood visors.
5 Golden failures: cover still cream plate with specular disc (albedo <= 0.25 dark iron, rough 0.5-0.6, less tread spec); red lane goes
  NAVY with blue sparkle at golden in ctx-eye-golden (aggregate sparkle picking up sky: tint by paint albedo, cap under low sun).
6 Grazing smear on far carriageway still at golden (eg-far) and rain (eye-rain, ctx-eye-rain): fwidth fade of fine aggregate/wear
  octave, LOD bias at low NdotV, less anisotropic wet stretch at distance, check TAA clamp on road pixels.
7 Hedge face blobby broccoli: second alpha leaf-card shell 3-5 cm outside the face (~0.15 m world-planar tile), darker core (cavity
  0.4), ±8% hue per 1 m, dead patches.
8 Box + approach asphalt too uniform from above: darker lane-centre bands per approach, lighter wheel paths, tyre-polish arcs, 2-4 patch
  rectangles with seams, cracks in wheel paths; red-lane wear from above = regular horizontal tiling of dark dashes (tr.png): domain-
  warped jittered cells.
Too subtle: signal backplate border (1-2 px, invisible > 15 m), arm collars, pole stickers (tiny low-res), cabinet reads as a crate.
