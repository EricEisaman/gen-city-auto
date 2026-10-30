# Road (road-0, signalized crossroads) judge, round 0: 3.5/10
Scores: edge profile/elevation 2, relief 3, material 5, colour 4, wear 3, distance 4, close-up 5, lighting 5, IQ 5.
"Up close the asphalt aggregate and golden-hour light are good. At every other distance a geometry fault ruins the asset."
Top fixes:
1 BROKEN: junction box is a separate slab at a different height, floating over the crosswalks with a vertical skirt and cast shadow
  (mid-day, mid-golden, orbit-day; second one at upper junction mid-golden ~760,200); different asphalt tone; jagged polygon border
  (top-day). Stitch plate to approach heights at the stop line, same material + world UVs, clip to kerb returns.
2 No consistent kerb; trees and median rails planted in asphalt / on the double yellow (top, low-day, curb-day): raised median islands
  with kerb + planting strip wherever trees/rails go, never furniture on carriageway; kerb profile (face, chamfer, 300 mm gutter apron)
  on every carriageway edge incl. where pavers meet asphalt with only a paint line; tree-pit grates 1.2 m.
3 Rain = one flat mirror; markings vanish; puddle mask world-noise blobs also on lots/pavements: separate wetness (darken + rough) from
  puddles; puddles from road-space (gutter distance, wheel ruts, sag), 15-25% coverage; paint stays visible.
4 Paint pristine flat white: own roughness/spec, 2-3 mm edge, wheel-path x aggregate wear mask, edge wobble, bead retroreflection at night.
5 Manholes = black flat discs in a regular line; no drainage: patterned cast-iron lids (metal, rim, rust), jittered, patch halo;
  gutter grates every 10-20 m with recess.
6 No wear: crack network with tar sealant (~1-2%), common trench patches, oil drips before stop lines, stronger wheel-path polish.
7 Furniture primitive: signal heads = 3 lamp cells with visors, dark lenses (other lenses currently MISSING), backplate; pedestrian
  heads; blue guide sign per approach; rounded galvanised rails; bark on trunks.
8 Distance: LOD1 tree impostor is a different palm-like species (far vs shell); bake kerb/gutter value lines into far road;
  junction centre black hole at night (add junction luminaire).
Also: dark dashed line along the median rail in top view (z-fight/shadow line).
