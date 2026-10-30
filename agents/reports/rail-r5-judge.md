# Rail viaduct judge, round 5: 6.6/10 (r0 3.5, r1 4.8, r2 5.3, r3 5.8, r4 6.3); station 6.6 (r4 5.9)
Scores: silhouette 6.0, relief 7.5, material 6.5, colour 6.5, wear 7.0, distance 6.0, close-up 6.5, lighting 7.0, IQ 5.5.
"Close up and at street level now a believable Like a Dragon / Ghostwire background viaduct; underside no longer flat; track bed right;
platform almost real. From mid/far in daylight still a long grey ribbon with dotted-line wires - what holds it below 7."
LEAD NOTE: zoomed 2x on rail-0-mid-day the wires are continuous lines; remaining "beads" are droppers/insulators/hardware. Consider
fading droppers and fine hardware with distance (they read as dots at mid/far), rather than more wire AA work.
Confirmed fixed: underside formwork/tie holes/plinths/conduits/dim pools; granite ballast + rust near rails; raised sleepers; readable
4.5m clearance; real kanji name boards; clocks, car markers, tactile, slatted benches, vending rows, LED departure board; lit clerestory;
corrugated canopy underside with lights.
Top fixes:
1 Catenary still reads dashed at mid/far (m1, f1; ~6 parallel dashed lines incl. feeders): fade droppers/hardware at range, keep
  continuous lines; or cross-fade wires to zero ~250 m and let portals carry the read.
2 Daylight mid/far uniform grey ribbon (~90% one value): ±8-10% per-span albedo + hue keyed on span index surviving LOD1,
  low-frequency drip curtains that survive low mips, an accent every 4-6 spans (repaint patch, lighter repaired span, span plate).
3 Station canopy ROOF TOP flat untextured slab from the train (station0-along-day, c1): round-5 skylights/vents not visible from this
  view; standing-seam/corrugated ribs down the slope (geometry or normal), gutter lip, metal roughness variation, downslope streaks.
4 Silhouette repeats for km: expansion-joint finger plates + coping step every 3-4 spans; mast variety (heavy headspan portal vs
  cantilever); OHLE switch/isolator boxes; maintenance ladder/stair down a column every ~10 spans; a signal gantry bridge; equipment
  cabinets on the parapet walkway breaking the coping line.
5 Platform floor stains = hard-edged cartoon blobs (p4): fbm-thresholded soft low-contrast gum dots, worn centre polish lane,
  tile-edge grout darkening, dirt under benches.
6 Vending + departure board low-res/blocky at 10-20 m (p1, p3): white frame, product rows with dark gaps, logo header, coin/IC panel;
  procedural dot-matrix (step on fract(uv*N)) so the LED rows stay crisp. (Vending front quad now flagged 0x300 for the shader.)
7 Sleepers one off-white tone -> concrete grey 0.45-0.55, ±10% per sleeper, darker rail-seat pad, chipped corners; teal girder
  uniform -> rust bleed from bolts/bottom flange, chalky fade on sun side, bottom-flange grime.
8 Soffit field between girders smooth/low-detail (efflorescence at transverse joints, damp patches under scuppers); station under-night
  ground near black while columns are lit (ground term?); cable tray claimed in r5 NOT findable in under-day - make it visible from
  the ground.
Broken: lab framing: a tree blocks rail-station0-side-night camera.
Pending shader asks from r5 geometry: darken RC_RECESS faces ~0.6x, SKYLIGHT polycarbonate look, brighter thin clerestory ribbon,
stronger platform white edge line, vending window only on VENDING_FRONT (param & 0x300) == 0x300.
