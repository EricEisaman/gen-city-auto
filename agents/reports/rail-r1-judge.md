# Rail viaduct judge, round 1: 4.8/10 (r0 3.5)
Scores: silhouette 5.5, relief 5.5, material 5, colour 4.5, wear 3.5, distance 5.5, close-up 5.5, lighting 4.5, IQ 5.5; station sub-score 4.
"No longer reads as a PS2 ribbon at street level. Under 5 because: concrete one clean grey everywhere, wear is a stencilled repeat,
deck dark at night, rain only darkens, OHLE doesn't connect, station is a plain box tower with a floating plank roof; in ctx-along it
reads as the cleanest, newest object in a grimy city."
Lab framing: ctx-side (faces a building wall), ctx-orbit (inside/against a wall), ctx-far/ctx-shell (viaduct hidden), ctx-mid (sliver)
are unusable; only ctx-along and ctx-under work. Fix rail ctx presets.
Top fixes:
1 Concrete monotone + stencilled wear: per-span/per-pier hash +-10% albedo + hue; streaks under every drain fanning/fading over 1.5-4 m
  with fbm edges, width/offset jitter (not identical rectangles); efflorescence at joints; pier splash band ~1.2 m; rust bleed from
  bearings/bolts; streaks inside parapet and down soundwall posts; posters/graffiti at street level.
2 OHLE doesn't connect + wires alias: registration arm tips must sit exactly on the contact wire (±0.2 m stagger computed per gantry);
  insulators at boom and arm hinge; wires beaded/stair-stepped close up: min ~1 px width with coverage (building round 6 approach),
  remove twisted-strand normal noise.
3 Night deck dark: every signal head emissive (hash aspect) with bloom-sized flare to read at mid/far; walkway lamps on soundwall posts
  every 30-40 m (emissive + cheap lights); emissive strip under coping on some spans; under-deck fluorescents every bay, cool tint.
  Side-night: one signal head lit, one dark (reads as broken).
4 Station placeholder: concourse = unbroken grey box with one door and a tiny pink sign; canopy a high flat plank on nothing, partial
  coverage. Canopy down to ~3.2 m on T-frames at lamp-post positions, fascia + light-box strip + name boards (4-6 m line-colour bands),
  stair openings with handrails, glazed concourse between bents (window shader + emissive interior), benches/vending/departure boards.
5 Piers/bents boxes: 5-8 cm chamfer, 0.3 m plinth/footing collar, haunched cap, elastomeric bearing blocks under girder ends,
  downpipe with brackets on each pier into a ground drain box, optional chain-link/shutter infill.
6 Rain: wet rail head rough ~0.05 with sky reflection (currently dull), ballast albedo x0.6 rough 0.3 in gaps, pier/fascia run-off
  streak gloss, puddles on walkway lids and between tracks.
7 Soundwall/parapet panels flat cream cards: 5-10 cm thickness + coping cap, normal-mapped ribs, per-panel tone jitter, top-down grime,
  some translucent spans, outside cable trough + brackets, placards and km posts.
8 Track polish: sleepers uniform clean white at exact spacing -> grey-brown with oily centres, per-sleeper hash tone, tiny rotation/offset;
  oil/brake-dust band down the centre, rust near rail feet; sloped ballast shoulder; rail joint plates; tactile dots on station strip.
Broken: registration arms float beside contact wires; street utility wires end mid-air at the fascia (rail-0-side-day ~x250-300 y330);
beaded wires; unlit second signal head; floating station canopy; possible building clipping against soundwall in ctx-along-day.
