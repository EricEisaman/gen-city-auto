# Rail viaduct judge, round 6: 6.8/10 (r0 3.5 ... r4 6.3, r5 6.6); station 6.9
Scores: silhouette 6.5, relief 7.5, material 6.5, colour 6.5, wear 7.0, distance 6.5, close-up 6.5, lighting 7.0, IQ 6.0.
Fixed: mid catenary dashing, per-span tone + repaired span at mid, platform stains, station under-night pools, vending rows/header.
"Under 7.5 because of procedural tells a AAA viewer spots at once."
Top fixes:
1 BROKEN-LOOKING: portal (gantry) beam has dense vertical streaks along its length = wood planks / broken UVs (ad1 crop of along-day,
  worse at night): likely a world-space vertical drip on a 0.4 m-tall beam; gate drips to faces > ~1 m tall or rotate along the beam;
  galvanised low-freq mottle (~0.5 m fbm), rough 0.4-0.6; ideally I-section / truss geometry so it reads as steel.
2 Coping light line = uniform full-brightness neon stripe for km at night ("Tron, not Tokyo"): remove, or discrete fittings every
  10-25 m with per-fitting on/off hash (~10% dead), warm/cool mix, 3-5x dimmer; let under-deck pools + train carry night.
3 Canopy roof tops still flat near-white from the train (st1/st6): ribs every 0.4-0.6 m down slope (normal/geometry), albedo ~0.45,
  grime streaks toward gutter, gutter box + darker fascia lip, roughness variation for a sky highlight.
4 Column-base splash band = hard sawtooth/triangle wave ~1.2 m up (su1): smoothstep ~0.2 m, 2-3 octave fbm height, drip fingers above,
  darker toward ground, AO in bottom 0.3 m.
5 Contact wire close up (10-30 m) = noisy speckled rope (ad3): analytic coverage, no hash dither at near range (or TAA-stable blue noise).
6 Far day still ~85% one warm grey: coping +15%, fascia lower third -25% soot line, persistent dark band under deck edge in LOD1; accent
  every 4-6 spans (JR blue/white span plate, repainted span, cabinet cluster); portal masts darker than concrete.
7 Rain wetness in per-formwork-panel rectangles with hard borders (sr1 of side-rain): continuous world-space field, runoff curtains from
  the deck edge, wetter under coping/column tops, dark trail under each scupper.
8 Silhouette: no ladders / stair towers / cabinet clusters / OHLE switch boxes found in side-day or mid-day (round 6 placed them at
  1-in-10 bents etc: make them land in frame / more frequent / bigger); cable tray still not visible from the ground in under-day (u1);
  sleepers little per-sleeper variation (ad2).
Smaller: concourse box needs backlit ad panels, big lit station-name band, IC gate glow; clock rim aliased (st3).
Broken: fascia grime stops at a hard vertical seam between spans (sd4, side-day x~750) - blend across or put the seam on the joint plate;
station along-day: cantilever registration arms appear to hang from the canopy with no mast (st6).
