# Rail viaduct judge, round 4: 6.3/10 (r0 3.5, r1 4.8, r2 5.3, r3 5.8); station 5.9
Scores: silhouette 6.0, relief 7.0, material 6.0, colour 6.0, wear 6.5, distance 6.0, close-up 6.0, lighting 6.5, IQ 5.5.
"Up close and at night a solid background viaduct for Like a Dragon/Ghostwire; fascia finally reads as cast concrete. Mid-2010s from
mid/far in daylight and anywhere under the deck. Platform has the right parts but untextured blocks with placeholder text."
Confirmed: fascia formwork + scupper drips, night fascia bounce, continuous coping line (no beading), soundwall variety + taper, trough
with lids, ballast shoulder, droppers, LOD far==shell, station line band, concourse interior (no longer blown), tactile/paving/purlins.
Top fixes:
1 Wires bead and stair-step at MID distance (rail-0-mid-day md1z, ctx-mid): "barbed wire across the desert"; expand to max(world,
  1.0-1.3 px) and alpha x world/expanded; check the far LOD isn't using a beaded tube mesh; feeder + messenger too.
2 Underside flat (under-day/night, station under-night): soffit + column faces get formwork/drip/efflorescence (world-space, from
  transverse deck joints); geometry: cable tray along one girder, conduits down 1 in 3 columns, bearing plinths at column tops;
  under-night ground is one huge flat white pool -> lower intensity, tighter falloff, sequence of pools.
3 Mid/far day read = uniform grey ribbon: LOD1 ±6-8% per-span value jitter, wide dark shadow line under coping, drip darkening carried
  into low mip/LOD (periodic per-span albedo term), accents every few spans.
4 Ballast solid saturated orange, sleepers read painted: grey granite ballast, rust only ±0.25 m from each rail, oil centre; sleepers
  ~4 cm raised with contact shadow, ~0.6 m pitch, jitter, dark clip blobs.
5 Platform props placeholders: name board grey block glyphs and CLIPPED at top of platform view (hung too low? raise to ~2.6 m),
  real kana/kanji + adjacent-station arrow row; slatted bench; vending with lit window/product rows/coin slot; departure board as LED
  dot-matrix rows (orange/green), not a swirl; white platform edge line, floor car-position markers, clock, pillar number board
  (judge says clock, edge line, car markers ABSENT - they were claimed in round 3/4: verify placement/visibility).
6 Clearance boards: yellow board present but insert is a grey blur, not a numeral (boardz) - round 4 shader claims a "4.5m" digit
  that fades beyond ~4.5 cm/px: make it read at street distance (bigger glyph, no fade at that range).
7 Canopy roof top + station box roof flat untextured from train/aerial: corrugated ribs along slope, gutters, dirt streaks, vents/
  skylights.
8 Station box upper storey blank at night: clerestory band or lit ad strip, spill onto box and piers.
Missing (genuinely): cable trays/conduits under deck, bearing plinths. Optional: platform screen doors.
