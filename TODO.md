[x] rain drops are going the wrong way and don't look much like rain but instead look like vertical rectangles
    -> fixed: drops moved upward (sign bug); now thin motion-blurred streaks of varying length, denser.

[x] water distortion only makes sense inside the car and should be limited to the windows.
    Currently it's a fullscreen effect that is always on
    -> lens drops are disabled; rain beads stay on the car glass only.

[x] the vehicles flicker often, almost but not quite like z-fighting. You can see this right
    at the start just a 5 or 10 seconds into the video. The camera pops outside the car
    as it pulls up to red light, the car in front of it is flickering like crazy.
    -> LOD selection now has hysteresis (vehicles near an LOD distance flipped every frame). Please re-check.
    -> follow-up (dashboard/doors flickering inside the car): it was SSAO, not shadows. Its sample
       radius never went below 1 m / 7 m, so at arm's length it sampled half the screen with a
       per-frame rotation that TAA couldn't hide. The radius now shrinks with view distance under
       12 m / 28 m; consecutive-frame diffs of the interior now match AO-off (only edge jitter left).
       This also calms AO on nearby cars, e.g. the car ahead at a red light.

[x] the settings should be in a popup behind a gear icon
[x] the camera should have a camera icon outside the settings the cycles through camera modes
    (can keep camera setting inside the settings too)
[x] the vehicle should have a icon outside the settings that cycles through vehicles.
    -> toolbar top-right: 📷 cycles director -> chase -> first -> hood -> orbit -> free, 🚗 next vehicle,
       ⚙ opens the settings (hidden by default). Camera select in settings includes "free".

[x] the sky looks really boring for some reason - colors too solid? no stars at night? not sure why.
    Ask the art director?
    -> added patchy high cirrus (sun forward-scattering, lit by city glow at night), a two-layer star
       field with a power-law magnitude spread and colour temperatures, fading near the hazy horizon.

[x] Car collisions are poor. Cars z-clip into hills - this happens in the current demo
    right at the start. The car is half under the ground.
    -> the driving surface used chain heights everywhere, but junctions are rendered as flat plates
       and roads use a smoothed grade. surfaceHeight() now tests junction polygons first and uses the
       mesh's grade blend; traffic snaps to it too. tools/drivecheck.ts measures it: samples off by
       more than 30 cm went from 4% to 0.05% (worst cases are where two roads overlap).

[x] Horizon colors do that match fog colors so when you can see the horizon, like from the helicopter,
    there is a sharp contrast between the horizon/sky-box and the buildings/ground
    -> one horizonColor() now drives the sky below the horizon, distant clouds (exponential haze),
       the overcast grey band and the edge of the world/outskirts, so they all meet seamlessly.
       The sea was black far out (screen-space reflections returned false hits at km range): SSR
       now stops at 1.2 km and far waves flatten so the sea mirrors the horizon.

[ ] The buildings need more details. They need stronger textures or something.
    -> in progress: facades now weather (rain streaks under sills, slab drips, patch repairs), shop
       shutters, blinds/curtains in windows. More geometry detail (balconies, AC units) still to do.

[x] the transit tracks sometimes collide with each other. Even if one is over the other
    it needs to be high enough to allow the train below to pass through with power cables.
    -> crossing elevated lines: the later one rises to clear the other by 8.5 m with a 3% approach grade.

[x] transit trains need windows and doors. Maybe the windows can use similar tech to building windows.
    -> the designer had modelled windows, doors, band and gangways, but in the game every vehicle was
       lit with inverted normals (the instance matrices are mirrored, flipping the winding, so the
       front-facing test turned normals inward). That made trains and cars dark, grainy (SSAO saw the
       body as occluded) and hid the window detail. Fixed in vehicle.wgsl; reflections below the
       horizon also see the sunlit street now instead of near-black.

[x] A production build should
    -> npm run build:prod: minified JS, WGSL stripped of comments/whitespace, gzip size table printed.

    1. strip whitespace from shader source
    2. terser the javascript
    3. print a total for the html/css/js gzipped

    A development build can do none of that.

[x] Cities usually have some major roads and highways
    -> it turned out no expressways were being generated at all (boulevard chains break at every
       junction, so none met the length test; the overpasses in shots were rail viaducts). Boulevards
       are now joined into long straight "strokes" through junctions, and the longest become elevated
       expressways (5 in Tokyo, 3-4 elsewhere), e.g. a ring around the centre. They end at crash walls
       on end piers (ramps down would cover the boulevard lanes), and carry far traffic light streams.

[x] When viewing from high up or when the view distance is far, consider showing
    headlight and brake lights as single sprites with no car, especially on highways?
    Same for street lights. I'm not sure if GTA5 does this but it worked well in older
    games.
    -> render/sprites.ts: every lane of every road and expressway carries a stream of head/tail light
       sprites beyond the 360 m simulated traffic radius (white toward the viewer, red away, ~1 car
       per 28 m), and every street lamp head gets a sodium/LED sprite past 180 m. Night and rain only.

[x] Tall buildings, antenna, need red airplane lights.
    -> blinking red obstruction lights on the corners of roofs over 60 m.

[x] Lit rooms on buildings are a little too random - I feel like in the real world,
    most buildings light up in sections, 3 floors are like, half a floor is lit.
    A hotel might have random rooms lit but probably fewer than 15%. Or at least
    that's my recollection. Not always though. I'm not actually sure. I just know
    something looks off.
    -> offices light in sections (3 floors x ~20 m: one tenant working late); homes room by room.

[x] Can we add a free camera mode where the user can fly the camera. ASWD moves the camera
    left/right/forward/back, mouse aims. Need mobile controls too. This will make it easier
    to inspect the city. Further, add a button in settings that puts a URL in the clipboard
    that contains the camera's current position, orientation, time-of-day and other things
    so that I can give you that URL to highlight certain places.
    -> free camera: WASD/arrows move, Space/E up, Shift/Q down, right Shift = 4x, mouse drag looks,
       wheel changes speed. Touch: left half of the screen is a move stick, right half looks.
       The car keeps driving on autopilot. "Copy link to this view" in settings (or L) copies a URL
       with freecam=x,y,z,yaw,pitch, time, timespeed=0, weather, city and seed; opening it starts in free camera.

[x] Add size=<width>x<height> url param that lets me set the size of the canvas to a fixed
    number of CSS pixels. i can use this to make videos of a specific size.
    -> added: ?size=1280x720

[x] the height of the camera when inside a vehicle, or a least the default car, seems
    10-20 cm too low.
    -> first-person eye raised 15 cm.

[x] traffic jams are common. All the cars get stuck.
    -> junction deadlock breaker (creep after 4 s stopped), cars stuck > 40 s despawn.

[x] trains station platforms are missing bottoms
    -> platforms were a top and an outer lip only; they now have a slab underside and inner face.

    freecam=12.79,24.31,-453.23,-2.69,0.55&city=neon&seed=1&time=7.02&timespeed=0&weather=sunny

[x] These train tracks are impossible. They are stacked on top of each other
    Further a tree is poking through the tracks.
    -> that was the Yamanote-style loop folding back over itself (its spline through the hubs
       self-intersected at a shallow angle). The loop now drops the hub causing a fold. Crossing
       clearance now uses deck overlap instead of centreline intersections (shallow crossings overlap
       for 100+ m), also covers a line against itself, and an upper pier that would land on a lower
       deck becomes a portal frame straddling it. Trees are not planted where they'd reach a deck.
       Checked 20 city/seed combos: no rail decks clash.

    freecam=133.83,34.41,-585.14,-2.41,0.09&city=neon&seed=1&time=22.05&timespeed=0&weather=sunny

[ ] guard posts at intersections float in the air

    freecam=461.06,26.74,118.35,-1.13,-0.07&city=neon&seed=1&time=13.99&timespeed=0&weather=sunny

[x] Car lights on highways/streets at night are going too fast, unrealistic speeds
    -> each light looped along its own ~12 m road segment and jumped back, so streams looked frantic.
       Lights now flow continuously along whole lanes: 30-45 km/h in town, ~70 km/h on expressways,
       with per-lane speed variation and random gaps.

[ ] buildings still look very flat - like maybe they need parallax mapping or normal mapping
    in their textures or some. Same with almost everything. 
    -> in progress: tiled facades now use a normal-mapped Japanese facade-tile layer (half-bond,
       recessed grout, glazed faces with per-tile tone and gloss); rendered/concrete walls use the
       concrete layer. Windows already had a 22 cm parallax reveal.
    
[x] Roads look flat, dull, splotchy, gray.
    Nothing like an actual road. Sidewalk, train tracks, they all look worse than PS2 era.
    -> new mipmapped, anisotropically filtered detail textures (render/detail-tex.ts, generated at
       startup): asphalt aggregate with light quartz chips (two scales, rotated, so no tiling),
       interlocking sidewalk pavers in a few colours, concrete with pores, ballast stones, each with
       a normal map and cavity. Roads also get sealed tar cracks, crisp utility-cut patches and worn
       thermoplastic markings; tracks get concrete sleepers with rusty fastenings; curbs, piers and
       roofs use the concrete/ballast layers.

    freecam=527.15,27.42,-25.98,-0.14,-0.35&city=neon&seed=1&time=18.49&timespeed=0&weather=sunny

[x] Bookshelf window textures are not raymarched and so look flat and PS1 era.
    -> convenience-store shelves are now traced as three rows of gondolas behind the glass
       (product faces, shelf lips, visible shelf tops and aisles), so they shift with parallax.

    freecam=512.36,25.62,116.49,-2.47,-0.06&city=neon&seed=1&time=17.03&timespeed=0&weather=sunny

[ ] highway fence has no detail, looks PS1

    freecam=540.09,44.72,50.72,1.46,-0.16&city=neon&seed=1&time=17.46&timespeed=0&weather=sunny

[x] bloom is way too strong and area too big.
    -> the six bloom levels were summed at equal weight and never normalised, so at night ~60% of
       every pixel was blurred glow. Coarse levels now fall off (0.6 per level), the sum is
       normalised and mixed at 5% (day) to 12% (night).

    freecam=528.02,33.99,-29.18,-1.83,0.03&city=neon&seed=1&time=19.46&timespeed=0&weather=sunny

[x] Many city blocks are a small and single building. That is extremely rare in the real world
    -> lots are now cut across the street frontage like Tokyo plots: 5.5-11 m wide downtown,
       9-20 m in the suburbs, ~22-25 m deep (deep lots become back-to-back plots), every lot keeps
       street frontage, some get narrow gaps to their neighbours, and old 2-4 storey buildings
       mix in among mid-rises. A few big core lots stay whole for towers.

    freecam=27.56,363.59,-39.04,-0.30,-1.50&city=neon&seed=1&time=18.43&timespeed=0&weather=sunny