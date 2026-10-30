# Road (road-0) judge, round 1: 4.6/10 (r0 3.5)
Scores: cross-section 4.5, furniture/relief 4, material 6, colour 6, wear 3.5, distance 5, close-up 6, lighting 6, IQ 6.
"Round 0 blocker gone (plate continuous, 3-cell signals, rain keeps paint, rusty manholes, grates). Wet night is a real highlight
(ctx-low-nightrain, ctx-mid-nightrain close to Like a Dragon); golden asphalt sparkle excellent. At street level in day light still a
clean CAD drawing: pristine paint, no crack/stain/oil, hedges flat green boxes, guide sign blank grey slab, square trunks, night pools
huge overexposed blobs, day rain one uniform film."
NOTE (lead): round-1 shaders DID add patchwork, oil bands, wheel-path wear, paint wear, but the judge sees none of it at street level
in daylight => TOO SUBTLE. Every change this round must be obvious in an A/B crop at eye-day/low-day.
Layout quirks (not asset): overlapping arterial+avenue chains (flush concrete strip between, stepped crosswalks, corners with no sidewalk);
lot ramp rises above eye height beyond the sidewalk in isolated eye/low views.
Top fixes:
1 Wear layer: sealed crack network (Voronoi, 1-2%, glossy black tar), oil/rubber darkening at stop lines and in wheel paths on GREY
  asphalt (exists only on red lanes visibly), paint worn through in wheel paths with edge wobble, 2-4 more trench patches per approach.
2 Hedges: concrete planter kerb 15-20 cm + lumpy leaf mass (alpha leaf-card shells or displaced hull), AO darker at base, lighter tips;
  trunks 8-sided tapered with bark normal; 1.2 m tree-pit grate.
3 Night pools: tight elliptical pools ~1.5x pole height, inverse-square windowed, lower intensity (asphalt mid-grey under lamp),
  warm/cool mix; eye-level crosswalk currently lit evenly like overcast day; paint retroreflection toward camera.
4 Sign faces: guide sign blank grey -> blue field, white border, destination rows (kanji+romaji), arrows, route shields; pedestrian
  heads need walking/standing pictograms (now salmon squares); car signal hood visors + louvred backs.
5 Day rain: puddles in gutters/ruts/sags 15-25% with roughness ~0.02 and real reflections; elsewhere roughness ~0.25; remove world-noise
  blotches at junction centre (look like dirt).
6 LOD1: signals/rails/hedges/poles vanish in shell; tree impostors = dark low-poly diamonds of different shape/colour; keep 1-2 box
  proxies for poles/arms, hedges as green box, impostor from LOD0 canopy colour/silhouette; dark kerb/gutter line in far road.
7 Kerb on every carriageway edge incl. medians/islands (median is flush concrete with a regular dark dot grid that reads as a pattern);
  arterial outer edges have no kerb; gutter apron grime.
8 Paint material: roughness 0.45 vs asphalt 0.85, micro edge bump, wheel-path holes, dirty white ~0.75 albedo (not 0.9).
Broken: jagged unmarked asphalt aprons at the site edge beyond the last crosswalks (chain-end stubs); dark skirt wedge where road sits
above terrain; trench patch only visible in some lighting (normal-only; give albedo/roughness difference).
