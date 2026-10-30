# Building (midrise0) judge, round 6: isolated 5.5, in-context 5.8, "fair" 5.5 (r4 6.0, r5 6.0)
Note: new judge instance; scores are noisy +-0.3. Round 6 was systemic (GTAO + analytic AO, lab ctx=1, min-width tubes,
metre UVs, one opening() model). Lowest criterion is now CLOSE-UP QUALITY 4.8.
Scores (isolated): silhouette 6.5, relief 6.0, material 5.5, colour 6.5, wear 5.5, distance 6.0, close-up 4.8, lighting 6.0, IQ 6.0.
Top fixes:
1 Brick front blurry/blocky at street distance (sd_brick, fd_tl): procedural running-bond brick in metre UVs, per-brick albedo/rough
  hash, mortar mask driving recessed normal + AO, optional 4-8 step POM, high-freq detail normal under 15 m.
2 Party wall reads as flat slab at mid/far: ghost roofline darker/dirtier below + 2-3 cm geometry step, slab edges as 3-5 cm ledges,
  1-2 vertical pipe runs, bracketed AC cluster. (Exists but only legible in service-day.)
3 Night: ZEN billboard flat self-lit (add 3-4 gooseneck floodlamps on top edge, top-down falloff gradient, spill onto wall);
  small tower windows uniform pale-blue cards (use interior mapping path, 40-60% lit, warm/cool, curtains); rear/party nearly black.
4 Golden hour blows the pale painted concrete to peach-white (rear/service/aerial-golden): concrete albedo 0.35-0.5, stronger grime/AO,
  check tonemap shoulder.
5 Rain streaks on party wall look like plastic sheeting (uniform over whole wall): confine to drip paths below ledges/copings/sills/
  fixtures, porosity darkening, base puddle darkening; fixtures (white meter boxes) must get wet too.
6 Sign/print crispness: ZEN print and スナック/CAFE/不動産 glyphs soft at street range (SDF/MSDF or fix mip selection: signMat picks one
  mip from the max derivative); props still boxy (vending front panel product grid, coin slot, emissive strip; bevels); visible blade-sign
  mounting arms + conduit.
7 Glass: same sky smear on every pane, blind-slat moire (prefilter by derivatives), dithered dark ghost reflection on a 3rd-floor pane
  (facade-day x500-600 y250-480, looks like noisy SSR of the lamp pole: fall back to probe when confidence low).
8 LOD1 storefront: awning/fascia/vending vanish in shell; keep awning + fascia boxes in LOD1.
Broken/suspect: dithered ghost reflection; blind moire; スナック may read as …メック from below (check glyph UVs); duplicate ZEN billboard
on a neighbour (ad repetition).
