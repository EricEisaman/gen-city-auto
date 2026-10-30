# Building (midrise0) judge, round 2: 5.3/10 (r0 4.0, r1 5.0)
Scores: silhouette 5, relief 5, material 5, colour 6, wear 5.5, distance 6, close-up 5, lighting 6, IQ 6.
"The front at street level is close to a 7. Every other view (rear, fire stair, exposed party wall) pulls the overall back toward PS2."
Top fixes:
1 Fire stair = extruded solid slabs, opaque plates, untextured flat orange-brown: open steel stair, C-channel stringers, individual
  treads with gaps (or alpha strip), landing plates w/ thickness, thin round handrails + balusters/mesh, corner posts;
  painted-steel material with chipped paint (metal 0.3-0.5 where chipped), rust at bolts/landings + downward streaks.
2 Exposed party wall = largest surface at mid/far, reads as a blank cream slab: albedo ~0.35-0.45, much stronger ghost-neighbour
  outline incl. diagonal stair scar and interior tile/wallpaper remnants, black coping streaks; geometry: 1-2 pipes, corrugated sheet
  patch on some seeds, chance of framed billboard/painted ad.
3 BUG: party-wall repair patches + meter box render near-white/glowing at golden (street-golden), brighter than lit wall.
4 Shopfront story: yakitori sign over a bookshop interior (key sign text to the same shop type as the interior); shutter boxes,
  noren, A-board, plastic-food display case, crates; parallax shop interior with back wall, counter, ceiling light.
5 Upper glass = 4 identical dark-grey bands that collapse to stripes at mid/far: per-floor tenant cut-vinyl lettering on glass
  (カラオケ, 歯科, 麻雀, phone numbers) that glows at night; per-bay blinds variety; per-pane reflection tint jitter. Reads from blocks away.
6 Break the box: rear AC brackets per floor with copper pipe runs, window grilles on some rear windows, roof perimeter railing,
  exposed steel lattice behind/under the rooftop sign, corner vertical projecting sign. Must show at mid and in LOD1.
7 Rear windows read keystoned (jamb wedge wider at top, rear-day): fix reveal geometry or add reveal contact AO; recess glass ~10 cm
  in a frame with profile, head drip line, grime under sills.
8 Rain/distance: far-rain/mid-rain lose all contrast and emissive read: wet flow-streak roughness on facades; signs and some windows
  on in overcast/rain like dusk; emissive carries through fog.
Broken: glowing patch decals; floating dark cube on upper party wall (street-day x~305,y~180); keystoned rear windows;
sign/interior mismatch; possible floor-count mismatch front (5 levels) vs rear (4 rows + door) - verify;
LOD1 night storefront = one flat white band vs discrete lit bays at LOD0.
