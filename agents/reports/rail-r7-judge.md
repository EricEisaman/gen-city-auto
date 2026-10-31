# Rail viaduct judge, round 7: 7.0/10 (r5 6.6, r6 6.8); station 7.0
Scores: silhouette 7.0, relief 7.5, material 7.0, colour 6.5, wear 7.0, distance 7.0, close-up 6.5, lighting 7.0, IQ 6.0.
Fixed: I-girder portal reads as steel, discrete dimmer coping fittings (no neon line), column-base sawtooth gone, ladders/cabinets/signal
bridges in frame, rain runoff streaks instead of rectangles.
"Under 7.5: big surfaces still clean uniform grey, concourse a flat box, procedural tells: dotted wires, canopy patchwork band,
octagonal clock, diagonal light tube."
Top fixes:
1 Concourse box flat and dead at night (station side-day/night): ground-floor glazing needs a lit-hall interior (cool white, gate
  silhouettes, ceiling light rows) that GLOWS at night (currently grey/unlit; only upper band glows); main name board 3x with one big
  glyph run (~1.2 m characters); fascia canopy with downlights over the doors; hanging route maps/fare boards.
2 Day/golden colour monotony (golden turns whole deck one cream): coping/parapet +15%, persistent soot band under the deck edge (LOD1
  too), columns cooler/greyer than deck, span plates/repainted beam every 4-6 spans; road girder paint value variation (chalked teal,
  darker lower flange, rust at bearings).
3 Under-deck and columns too clean: efflorescence + dark leak streaks from each expansion joint and drain outlet down crossbeam and column
  faces, water stains around soffit drain pipes, pigeon-net/bird-spike strips on crossbeam tops (geometry), darker AO in beam/column
  re-entrant corners.
4 Dotted wires in the sky at distance (side-day sd6 right x620-1000 y430-470): analytic sub-pixel coverage, ~1 px clamp + alpha fade,
  or TAA-stable blue noise; no per-pixel hash.
5 Canopy roofs from the train: near canopy a flat grey slab; along the canopy edge a band of random peach/grey/white rectangles
  (per-panel hue mosaic at grazing angle, st4): kill per-panel hue (value ±5% max), corrugation via geometry/POM, dark gutter box +
  fascia lip, grime toward the gutter.
6 Track bed: sleepers still identical light-grey bars at perfect spacing (ad3) despite round 5-7 work: per-sleeper value ±10% that
  READS, oil/brake-dust band, fastening rust, occasional replaced darker sleeper.
7 Station canopy night: one fluorescent tube runs diagonally along a brace (pn1, reads as a mistake); outer canopy edge = continuous bright
  white stripe ("Tron" again): tubes parallel to the track in discrete fittings, dim/break the outer strip.
8 Platform: clean uniform tiles (gum, scuffs along the yellow line, dirty corners at column feet); clock rim visible octagon (24+
  segments); platform-end vending machine faces away (blank blue slab) - turn it; timetable boards, bin trio, hanging platform-number sign.
Broken: dotted wire dither; canopy edge hue mosaic; diagonal tube; lower crossbeam formwork tone checkerboard (milder).
Subtle: outer cable tray still not seen from the ground in zooms.
