# Road (road-0) judge, round 5: 6.4/10 (r0 3.5, r1 4.6, r2 5.4, r3 5.7, r4 5.9)
Scores: cross-section 6.0, furniture 6.0, material 6.0, colour 6.5, wear 6.0, distance 7.0, close-up 5.5, lighting 7.0, IQ 6.5.
"Fixed night box lighting, wet-road streaks, turn-guide arcs. ctx-mid-nightrain / ctx-orbit-nightrain best frames so far, close to
Ghostwire wet-neon. Daylight street-level: smeared, low-res surfaces (red-lane wear, hedges, cover tread, poles) = mid-budget look."
Top fixes:
1 Red-lane / wheel-path wear smears like MOTION BLUR (third round flagged; lane.png from eye-day, ctx-eye-day, eye-golden): stop
  sampling wear noise with lane-stretched UVs; isotropic world-XZ noise domain-warped across the lane ±0.2 m; hard smoothstep(t±0.03)
  edges; mask lerps red paint -> asphalt albedo/roughness (not darkening); fwidth fade.
2 Hedges low-res and stretched (second round; curb-day, ctx-curb-*): world-space planar projection ~0.25 m tile + 1.1 m octave instead
  of run-stretched UVs; cavity ~0.4; ±8% hue/segment, dead patches; alpha leaf-card fringe on top edge + outer face.
3 Poles/mast arms/gantries bare uniform grey extrusions at eye distance (pole.png): base flange ring 0.35 m + 4 bolt boxes, arm-joint
  collar, ID plate; bottom 0.6 m grime gradient, streaks under joints, roughness 0.35-0.7; signal backplates with white border.
4 Cover tread a blur; cover blows out to a cream plate at golden (eye-golden): procedural diamond lattice normal+AO with fwidth AA, dirt
  in cavities ~0.05, roughness 0.45-0.55, cast glyph; size/shape variety.
5 BOX GOES DARK IN NIGHTRAIN (top-nightrain, ctx-top-nightrain) though lit in top-night: cap wet diffuse darkening ~0.65, keep diffuse
  pool under lamps as well as streak; low-night stripes still ~0.85 near-emissive on near-black road: markings 0.6-0.65, rough 0.5 dry /
  0.2 wet; lift near-camera road floor a little (bounce from pools).
6 Grime decals artificial: box oil = fish/leaf smudges in random orientations -> align to lane direction, cluster behind stop lines;
  regular grid of hard dark squares (gum/pits) on red lane (kerbbase.png) -> jittered round dots of varied size; 10-15 cm damp band at
  kerb toe and planter base; drip streaks under guard-rail posts.
7 Far carriageway horizontal smear/ghosting at grazing angles (eye-golden left, ctx-eye-golden, low-golden): fwidth/LOD-bias clamp on
  the grazing noise octave; check road motion vectors / TAA neighbourhood clamp; less roughness noise at low NdotV.
8 Street edge lacks small fixtures: steel gutter grates every 12 m inset 1 cm, 3-5 bollards per corner radius, one controller cabinet per
  junction (0.6x0.4x1.2 m grey-green w/ stickers), push-button boxes on signal poles at 1.1 m; carry to LOD1 as boxes.
Broken: box dark in nightrain; cover cream plate at golden; faint planter-wall striation; shell-golden drops some long pole shadows.
Too subtle: tactile warning pads flat by eye distance; crosswalk crack still constant width (taper + chipping); box cracks uniform
alligator everywhere (concentrate in wheel paths and box edges); 2-3 stray straight dashes near arc ends.
