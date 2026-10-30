# Road (road-0) judge, round 2: 5.4/10 (r0 3.5, r1 4.6)
Scores: cross-section 5, furniture 4.5, material 6, colour 6.5, wear 5, distance 6.5, close-up 6, lighting 6.5, IQ 6.5.
"A credible mid-tier street; wet night near AAA. Daylight street level still too clean and CAD-like; the empty junction box is the
single biggest giveaway."
Gains: real blue guide sign (kanji/romaji/km), walking pictogram, crosswalk wear visible, red-lane wheel paths, crack network from top,
trench patch with tar edge, day-rain puddles with mirror reflections, tighter night pools at mid, LOD1 == LOD0 (no pop).
Top fixes:
1 Junction box = blank flat dark slab, different-looking material, seam at crosswalk edges: curved dashed turn guides (導流線) from
  left-turn lanes, right-turn waiting box outline, lane-edge dashes across the box; same asphalt stack (cracks, patchwork, oil) at
  1.5-2x wear, radial rubber/oil toward stop lines and centre, 2-3 patches + manholes; matching UVs/world noise (no seam).
2 Cracks read from the air, invisible at street level; from above a uniform crazed-mud net over every lane: density ~1/3, bias to
  longitudinal (wheel paths, lane joints) + transverse every 5-10 m, alligator only in wheel paths/bus stops; tar 3-6 cm, albedo ~0.04,
  roughness ~0.25 (specular at grazing); screen-space width floor (fwidth) so it survives eye-level anisotropy; sealed cracks stay as
  glossy dark lines under rain.
3 Poles/signal heads bare CAD extrusions: 8-12 sided poles, base flange ~0.4 m with bolts, footing collar, handhole, banding, sticker
  scraps at hand height; metal rough 0.35-0.5 with vertical streaks + bottom 0.5 m dirt; ground AO under pole base.
4 Crosswalk wear = a few big grey cow-print lobes, same on every stripe: wheel-track mask x 2-5 cm noise, aggregate speckle, chipped
  edges; paint albedo ~0.72, rough ~0.45, 1-2 mm edge bevel; tyre-black smudges at stop lines.
5 Hedges rounded green boxes, black at night: ±10-15 cm low-freq displacement, leaf-card fringe on top/sides, vertical AO, translucency
  wrap so lights reach them, per-segment hue jitter.
6 Night pools in top-night are big soft overlapping discs, sidewalks almost evenly lit: hotspot + fast falloff, forward throw onto the
  carriageway (Type II/III), mid-grey asphalt between poles, ~30% lower peak, per-street colour temperature. curb-night: camera's own
  approach is unlit while far crosswalk is bright.
7 Sterile street edge: gutter apron 20-40 cm darker with sediment/leaf litter/water staining (also puddle mask), chipped kerb top with
  tyre scuffs, per-paver ±8% albedo/height jitter, a few replaced pavers, walking wear band, gum spots, stains under rails/poles/
  planters; tactile blocks as real raised domes/bars (parallax or geometry).
8 Trees: uniform yellow-olive card noise with see-through holes -> 4-6 lobes around branch ends, crown interior AO ~0.5x, greener,
  per-tree hue; keep trees >= 3 m from lamp heads (lamp head inside canopy at eye-day ~x840 y165).
Broken: junction box seam; lamp head in canopy; hedges black at night; curb-night near approach unlit; cracks vanish under rain.
Lab: the `curb` camera sits on the flush overlap strip and never frames a kerb: reframe to a real kerb.
