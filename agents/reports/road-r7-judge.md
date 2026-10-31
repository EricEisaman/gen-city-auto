# Road (road-0) judge, round 7: 6.8/10 (r5 6.4, r6 6.6)
Scores: section 6.5, relief 7.0, material 6.0, colour 6.5, wear 6.5, distance 6.5, close-up 6.0, lighting 7.0, IQ 6.0.
Fixed: chrome pole bases in rain, nightrain picket fence, pole foot much better, navy red lane (now maroon), cabinet, backplate border
visible at 20 m, utility pole base guard.
"Wet night in context close to Ghostwire; daylight close-ups (hedge, bollard, push button) still PS3/early PS4."
Top fixes:
1 BROKEN (shared with rail): overhead/utility wires at far = 3-6 px solid black bands ("hoardings"), and they VANISH in shell (LOD1):
  round-8 rail change made all wires < 2 cm radius solid min-width lines. Width <= 1 px, alpha x (world/pixel width) below a pixel
  (coverage fade, TAA-stable); emit wires in LOD1/shell too; chain spans pole-to-pole along the approach (they stop at isolated pole
  pairs), drop wires to buildings in ctx.
2 Hedge = printed photo wall: 2 alpha leaf-card shells 3 and 6 cm out (~0.15 m world-planar tile), 5-10 cm tufts breaking the top edge,
  darker core (cavity ~0.4), hue ±8%/m, dead patches, leaf scale 2-3x smaller.
3 Patch rectangles = near-black flat boxes (top-day, top-rain): albedo ~0.85x base asphalt (not ~0.3x), fbm-jittered 4-6 cm sealant
  seam with roughness drop, slight rotation and size variety, wheel-path wear across them.
4 Golden blue metal: gutter grates saturated sky-blue at golden (ctx-pole-golden) -> dark iron albedo <= 0.2, metal 0.6, rough
  0.55-0.65, cavity occlusion between bars; blue pebble sparkle on near asphalt (ctx-eye-golden): tint by base albedo, cap by sun
  elevation, specular occlusion.
5 BROKEN-LOOKING: flat untextured MAGENTA plates near utility pole tops (curb-day, pole-day, mid-day) read as missing texture: real
  white/blue number plate with stencil, yellow/green ad wrap with text, transformer/insulator detail.
6 Grazing smear far carriageway still (eye-golden horizontal streaks, eye-rain foggy bright band): fwidth fade, mip bias at low NdotV,
  cap wet streak length with distance, check TAA clamp letting the bright crosswalk smear.
7 Furniture at 4 m: bollard 16-20 sides, domed/chamfered cap + reflective band, smooth shading; push-button face plate/lamp never visible
  (box seen side-on): turn ~30° toward the walkway; pole skirt lighter/whiter than shaft (match shaft paint, keep only grime/rust);
  rust mask still starts at a hard horizontal line at the skirt top (fbm edge); stickers 1.5-2x bigger with torn-paper alpha.
8 Box from above one flat grey, cracks dark painted veins: lane-centre oil bands per movement, lighter tyre-polish arcs along turn
  guides, 3-5 m ±8% mottle, sealed lighter-edged cracks; isolated night near carriageway almost unlit (eye-night, pole-night, low-night):
  stronger/wider pools overlapping the crosswalk; kerb face pure black in shadow by day (minimum ambient).
Too subtle: push-button face plate; stickers; signal visors thin at 20 m; guide sign no grime/rivets and glows like a screen at night
(light it with gantry downlights + retroreflective lettering).
