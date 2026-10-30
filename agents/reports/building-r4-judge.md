# Building (midrise0) judge, round 4: 6.0/10 (r0 4.0, r1 5.0, r2 5.3, r3 5.5)
Scores: silhouette 6.5, relief 6, material 6, colour 6.5, wear 6.5, distance 6.5, close-up 5, lighting 6.5, IQ 7.
"Above the ground floor this now reads as a believable Tokyo zakkyo biru... no longer looks PS2 from mid range. The weak point is now the
ground floor: shop interiors, street props and the empty pavement look like placeholders, right where a player looks first.
From mid range up it is credible; at street level it falls to about 5."
Top fixes:
1 Shop interiors placeholder: konbini shelves = saturated pastel rainbow barcode noise, no product shapes (kon-z); boutique = opaque
  grey-white panels with nothing behind (btq-z). Need: curated product look (muted colours, bottle/box shapes, dark shelf edges, value
  contrast, no per-cell random hue), magazine rack at glass, fridge wall at back, ceiling strips; boutique: clothing rails, warm spots,
  mannequin, normal glass reflection instead of grey diffuse.
2 Street props crude, pavement empty: plant = few-poly diamond (pot with lip + crossed leaf cards), bin/recycling = flat boxes,
  vending machine unbevelled with no drink rows. Kit per shop type: A-board, bicycle, banner flag (nobori), noren, crates, umbrella stand.
3 No AC units on balconies/street facade, no meters, no cable runs (rear downpipes exist): 1-2 ACs per balcony bay, bracketed ACs
  beside street-side windows, PVC pipe runs, meter box at grade, laundry poles on 30% of rear balconies, cable bundles pole->facade.
4 Window rows have no sills/drip edges on the street face (sf-z): 6-8 cm sill/coping strip under each window row, soffit lip;
  reveal corner AO; dirt wash below sills.
5 Roof under-detailed (aerial): membrane one flat colour (seams every 1 m, ponding stains near drains, darker parapet edges),
  tank plain white box (panel lines, bolts, rust), add pipe runs, TV antenna, satellite dish.
6 Party wall texture only, lights as one plane at golden: geometry stubs where old floor slabs met, protruding flashing strip on old
  roofline, cut pipe/cable stubs, capped pipe, painted-over doorway recess; normal bump for tie holes.
7 Rain: concrete/brick still only darker and matte (service-rain, street-rain): roughness x0.5 on vertical surfaces with streak mask
  from sills/parapets; neon bounce must produce SPECULAR coloured highlights on wet brick.
8 Narrow palette: per-building trim colour (cream, teal, rust-red frames; painted fascia), tiled ground-floor cladding colour per shop,
  more window decals (stickers, half-drawn curtains).
Broken: sign reads "landry" (typo or overflow); far-night vs shell-night neon wash mismatch (bake approx bounce into shell).
