# Road (road-0) judge, round 4: 5.9/10 (r0 3.5, r1 4.6, r2 5.4, r3 5.7)
Scores: cross-section 5.5, furniture 5.5, material 5.5, colour 6.5, wear 5.5, distance 6.5, close-up 5.5, lighting 6.0, IQ 6.5.
"Real step up at the sidewalk; with buildings a credible mid-budget Tokyo street; ctx-low-nightrain and ctx-mid-night best frames yet,
close to Like a Dragon mood."
Top fixes:
1 Turn guides read as scattered straight white ticks / confetti across the box (top-day, mid-day): a few clean quarter-circle dashed arcs,
  one per turning movement, dashes laid by arc length as curved/subdivided quads along the tangent, 4-6 arcs per box max.
2 Junction box is the DARKEST place at night (ctx-top-night, top-night, mid-night, ctx-mid-night) - third round running: aim corner
  pole heads inward to box centre, forward-throw onto carriageway, 1-2 extra luminaires on signal mast arms; box luminance ~ sidewalk.
3 Wet carriageway has no streetlight streaks (eye-nightrain, curb-nightrain, low-nightrain isolated): only sidewalk/puddles reflect;
  wet asphalt rough ~0.08-0.15 in the wet mask, wet darkening ~0.6, make sure local-light specular is evaluated on road materials;
  far road shows smeary horizontal ghosting.
4 Red lanes still salmon plastic; wheel-path wear smears like motion blur; grazing aggregate = oversized gravel noise: red ~(0.32,0.15,
  0.12) linear, -30% sat; wheel-path mask from lane-warped noise ±0.2 m with crisp broken edges; aggregate normal half amplitude, ~2x
  frequency, fwidth fade.
5 Hedges = bubble wrap: second larger warp octave, leaf cards with own UVs (not stretched), void darkening ~0.4, darker base, dead/brown
  patches, ±8% hue per segment.
6 BUG: utility covers float ~5 cm proud with visible sides; untextured cream plate in golden: sink flush (<= 3 mm lip), metal (0.8 / 0.5),
  tread normal, rust/dirt ring, stencil glyph, 2-3 sizes incl. round. (Material contract: WALK_COVER_MAT, CM.hedge 1 borrowed; add param.)
7 Cracks/patches drawn on: crosswalk crack constant width, blue-black (sky spec), no paint erosion; patches flat dark rectangles with
  perfect edges: taper, albedo ~0.05 rough 0.9, erode paint, patch edges ±5 cm noisy + seal band + different roughness.
8 LOD1 trees -> spindly palm-like twigs in shell-day vs full crowns in far-day (pop); signal/lamp heads vanish at LOD1: impostor crowns
  from LOD0 colour/mass, keep heads as boxes; poles/rails still bare (bottom 0.5 m grime, streaks, rail end caps/bolted bases).
Broken: planter-wall shadow striation (shadow of alpha cards: normal-offset bias / filtered); isolated low-night stripes near-emissive
white on black road (paint ~0.85 -> ~0.65; road under-lit).
Too subtle: tactile domes beyond ~1 m; gum/stains too sparse; no kerb-back dirt band, no drips under railings; signal/pole details read
as bare grey extrusions at eye distance (poles need material variation).
