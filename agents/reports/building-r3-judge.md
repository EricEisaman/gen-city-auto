# Building (midrise0) judge, round 3: 5.5/10 (r0 4.0, r1 5.0, r2 5.3)
Scores: silhouette 5, relief 6, material 5.5, colour 6, wear 5.5, distance 6.5, close-up 5, lighting 6, IQ 7.
"Night shots get close to Yakuza-street mood from a distance. By day it still reads as a clean grey box with stickers on it: flat glass,
flat paint, a bare roof and an empty-looking shopfront. Roughly a 2018 open-world background building."

KEY META-PROBLEM (from the lead): the judge keeps asking for things that already exist (sill streaks, rain rivulets, roof tank,
night window variety). They exist but are TOO SUBTLE TO SEE. Every change this round must be visible in an A/B crop at the named view.

Top fixes:
1 Daytime glass is opaque navy (street-day/facade-day upper floors, mid-day black strips): Fresnel sky/env reflection, per-pane normal
  jitter so reflections break per pane, blind height/tint per pane; at mid/far window bands should read sky-tinted, not black.
  (A previous attempt raised F0 and made in-game windows pale grey: solve it with Fresnel/env, check the game shot.)
2 Street facade showroom-clean: soot drip under every ledge/sill, ground-up dirt over first 1.2 m, rust tails under sign brackets,
  15-25% value contrast so it reads at mid.
3 Party-wall flashing bands are pure black hard stripes: bitumen albedo 0.08-0.12, thin line at roofline only, noise-broken drip
  edge, ghost region a cleaner warmer inverse patch, jitter/dropout on bolt grid.
4 Roof bare (aerial): tank on steel stand, condenser rows with conduit, parapet railing, visible steel frame behind roof sign.
  NOTE lead: aerial preset is ~150 m away so the building is tiny; reframe it.
5 Shopfront interior is a flat card of pastel stripes: parallax interior with 2-3 shelf rows of depth, poster decals on glass,
  door with push bar; konbini brightest light on the block at night with a cold white pool on the pavement.
6 Rain does almost nothing (only darker): glossy walls with sky/neon reflections, water sheets under ledges, visible rivulets on glass,
  wet patches on ledge tops, sign-colour bounce on wet wall near signs.
7 Value monotony: golden hour reads as one beige; all frames/mullions/canopy trim same blue-grey. Front glazed tile w/ grout and
  sparkle, side/rear painted render with flaking near base, anodised metal frames (metallic 1, rough 0.3), canopy fascia band +
  soffit with downlight cans.
8 Flat side wall (small frosted windows look like stickers) and uniform rear grid: shutter boxes above some windows, deeper sills,
  frosted vs clear with curtains, rear balcony slabs with railings, drainpipes w/ elbows; rear-night uniform cold white -> vary.
Broken/minor: shell drops green/pink blade signs by day; streetlight pole at canopy edge (clearance check);
ZEN billboard blurry low-res; exposed party wall pitch black at night (faint ambient).
