# Building (midrise0) judge, round 5: 6.0/10 (r0 4.0, r1 5.0, r2 5.3, r3 5.5, r4 6.0) - plateau
Scores: silhouette 6.5, relief 6.0, material 5.5, colour 6.5, wear 6.0, distance 5.0, close-up 5.0, lighting 6.0, IQ 6.0.
"Ground floor and signage are AAA-adjacent. Above the canopy: smeary brick, flush side windows, empty balconies and a big pale party
wall still give a last-gen read. Distance read is the weakest category."
Top fixes:
1 BROKEN: shell-night upper windows ~2x brighter with saturated cyan blocks vs far-night (LOD pop at night). Lock lit state/intensity
  across LODs; carry vending/konbini emissive into the shell. (Round 5 added zakkyo sign lights at LOD1 + a shader approximation of
  shell neon; likely the double-up.)
2 Brick spandrels blurry/stretched, grime blotches repeat per bay (facade-day): procedural world-space brick with per-brick tint and
  roughness, mortar recess normal/AO, detail normal; grime from world-space noise + sill drip mask, not per-bay UVs.
3 Flush tower/side punched windows = pale flat grey quads with hairline sill ("most PS2 element"): 12-15 cm inset, frame extrusion,
  drip sill, lintel; interior-mapped dark glass (not opaque pale grey); frosted for stair core.
4 BROKEN: one cyan sign light floods the whole upper brick facade mint-green (facade-night): ~3 m hard radius, inverse-square,
  sign's own colour, cap intensity so albedo shows.
5 Party wall: ghost/flashing/stair scar exist but low contrast on a huge beige slab; pure black at night. Real 3-5 cm ghost profile
  geometry with dark bitumen stripe, patch panels with different albedo at 2-5 cm offset, 1-2 wall/security lamps.
6 Rear balconies empty: floor-standing AC units with pipe, laundry poles with cloth/futons, plants, white partition boards w/ evac sign,
  curtain colours readable at mid.
7 Roof membrane still reads as cloudy noise with no seams from aerial; coping flat slate band: visible seams + edge flashing,
  dirt toward drains, conduit along parapet, metal coping lap joints.
8 Thin-line aliasing: railings, power lines, terrace rails stair-step and break up; will shimmer. Min ~1 px width + coverage fade,
  or alpha-to-coverage with TAA, or textured card past a distance.
Present but subtle (checked): party-wall ghost/flashing/rust stubs, roof ponding, sill streaks, rain rivulets on glass (good), blinds/decals.
