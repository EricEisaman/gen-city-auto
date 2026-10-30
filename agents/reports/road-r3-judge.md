# Road (road-0) judge, round 3: 5.7/10 (r0 3.5, r1 4.6, r2 5.4)
Scores: cross-section 5.5, furniture 5, material 5.5, colour 6, wear 5.5, distance 6.5, close-up 5.5, lighting 6.5, IQ 6.5.
"Holds up from the air and in the wet; box no longer blank; kerb reads as stone. At eye level in daylight still a clean CAD plaza:
pristine pavers, plastic red lane, hedges and trees procedural not planted. ctx-mid-day / ctx-orbit-golden look like a competent
mid-budget Tokyo game; isolated street-level shots do not."
LEAD NOTE: round 3 tree crowns (4-5 lobes on bark limbs) read as PALM TREES at eye/mid (city-wide regression) - must fix.
Top fixes:
1 Sidewalk = sterile paver carpet: per-paver hash albedo ±10%, rough ±0.1, 1-2 mm bevel, 2% replaced pavers; darker walking band;
  dirt within 30 cm of kerb back and under furniture; gum spots, drip stains under railings/planters; small square utility covers
  (NTT/water/gas) every 10-20 m as geometry.
2 Junction box = procedural texture showcase: cracks a dense even polygon net -> ~60% fewer, masked to wheel paths; oil blots are round
  ink blots -> elongated smears along lane tangents; a hard dark rotated SQUARE in the box centre reads as a hole/broken decal (remove or
  fix); turn guides are straight L-brackets -> quarter-circle dashed arcs (Bezier dash quads). Hard dark seam/step along the crosswalk
  band at the box edge (z-topbox left; partly overlap quirk).
3 Red lanes plastic and noisy in rain: desaturate ~25%, darken ~15%, wheel paths worn to grey asphalt (push harder), aggregate
  normal/albedo noise; rain wet/puddle mask low-passed to 0.5-3 m patches (now per-texel speckle on red).
4 Hedges read as faceted voronoi/reptile-skin cells: smooth low-freq displacement + ~5 cm two-octave leaf-cluster normal/albedo,
  darker bottom (AO ~0.5), alpha leaf cards on top edge and planter rim, per-segment hue.
5 Trees: sparse, see-through, yellow-olive, palms on a Tokyo street; flat yellow-olive discs inside a crown in z-eyesign (lamp heads or
  giant cards?). Dense zelkova/ginkgo/plane crowns, ~2x cards, crown interior AO, greener per-tree hue, no palms in road planting.
6 Poles/signals still bare extrusions at eye distance: grime streaks + bottom 0.5 m dirt + roughness variation; backplate + visors that
  read; ribbed back on the second gantry sign (blank grey slab in eye-day left); 1-2 regulatory plates per signal pole.
7 Night: top-night still big soft discs flooding sidewalks: asymmetric forward-throw lobe toward the road, back-throw -60%, peak -25%,
  4000-5000 K on arterials, warmer on avenues (shop spill carries sidewalks in ctx).
8 Eye-level crack/paint: cracks constant-width black pen lines drawn over paint -> width noise along length, fade at ends, albedo ~0.06,
  erode paint ±2 cm where a crack crosses it; wet crosswalk stripes sparkle with white noise (clamp spec on chip mask / fwidth AA).
Too subtle: tactile domes/bars (only nearest metre: raise height/normal, darker groove AO); pole foot collar; kerb scuff is a hard
rectangle (soft irregular mask).
