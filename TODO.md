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

[x] guard posts at intersections float in the air
    -> street furniture was placed at road/junction height while the sidewalk follows the terrain.
       Bollards, signal poles, street lights, utility poles, trees, guardrails, bus stops, vending
       machines and bicycles now sit on the sidewalk surface and sink 0.3 m into it; corner bollards
       that landed in the carriageway are dropped.

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
    -> round 7: windows sit in 30-45 cm reveals that cast real sun shadows (lintel, sides, sill) and floor
       ledges shadow the wall below at every distance; glass is dark and reflective with per-pane tilt;
       AO is much stronger (new 35 cm crease scale); the tonemap stretches each frame to full contrast.
       Shopfronts have aluminium frames, garment racks and restaurant counters behind the glass; roofs
       carry AC banks, skylights, ducts and membrane/concrete panels. Please re-check.
    
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

[x] highway fence has no detail, looks PS1
    -> Shuto-style edge: concrete parapet with coping and drip groove, ribbed metal lower panels and
       pale translucent-looking upper panels inset between steel posts with mid and top rails,
       delineator lamps, expansion joints over piers, downpipes on piers.

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

[x] trains and probably vehicles need to look at at least 2 spots (front and back wheels) to decide their pitch.
    As it is, I think they just check their center point which means they snap when the road/track
    grade changes.
    -> train cars now sit on their two bogies (track sampled at ±6.9 m: heading, pitch and height
       from the line between them); traffic samples front/rear axle points along the lane path and
       eases pitch like a suspension. Worst per-frame pitch jump: trains 0.043 -> 0.003 rad,
       cars 0.68 -> 0.05 rad. Note: road chain 201 in the default city (bridge near x=1446, z=809)
       climbs ~6 m in ~8 m (~70% grade); that's a layout bug still to fix.

[x] Signs (low signs?) need more definition. Currently they are just colored text on a black background most
    of the time. Real signs can be different colors. Black on Yellow, white on red, red on black,
    red on yellow, red on white, black on white, red on blue, white on green, white on sky blue,
    white on dark blue, blue on yellow, yellow on white, lit white on non-lit white, etc..
    Further, some of them have  depth/relief or are neon-ish like red on transparent. 
    So maybe parallax or bump mapping would help the signs not look so
    boring. Maybe you can make a sign shader that takes color inputs so you cn re-use the same input
    texture in different colors. Or you could draw all the signs to a texture atlas.
    -> shop signs are now masks recoloured in the shader: 16 colourways (black on yellow, white on red,
       red on black, white on green, white on sky blue, blue on yellow, lit white on unlit white, red neon
       on dark, ...) picked per sign and per building, as light box / raised lit letters / neon with halo /
       painted board, with a raised-letter bevel.

[x] minor issue. When a ー is used in a vertical sign it should be a vertical dash like. For example
    the word "ラーメン", if written vertically, will have a vertical ー
    -> vertical signs turn ー, 〜, …, dashes and brackets a quarter turn and set small kana in the upper
       right of their cell.

[x] train goes through a building here
    -> lots were only checked by corners and centre, so a long lot's edge could cross the viaduct; footprints
       are now trimmed 7 m clear of rail lines after the building is designed (no change to random draws or
       building ids, so saved links still work), and a unit test checks it.

    freecam=393.64,55.99,-845.97,1.57,-0.22&city=neon&seed=1&time=13.55&timespeed=0&weather=sunny

[x] there is no end to this roof equipment
    -> the air-handler duct was an open-ended beam floating in mid air; it is now a capped run on two stands
       that drops into a curbed roof opening.

    freecam=394.97,50.59,-865.51,-0.36,-0.13&city=neon&seed=1&time=13.55&timespeed=0&weather=sunny

[x] something is strange about the train movement - about 12 seconds from when the city starts rendering,
    the camera cuts to follow a train. The train appears to jump backward 0.5m every few frames.
    -> the director's camera updated before the trains, so it aimed at last frame's position and the car
       sat v*dt ahead of the aim point (0.33 m at 60 fps, 0.67 m on a slow frame), snapping back after each
       uneven frame. Trains/helis now update before the camera; the car stays on the aim point. The train's
       own motion was always smooth. test/puppeteer/trainjitter.mjs traces it per frame.

[x] Why are the tops of these buildings flickering?

    Camera is free so the camera is not moving. Time is paused so the
    sun is not moving. So what makes the tops of the buildings flicker?
    -> the towers' LED crown line was a 12x24 cm box, about half a pixel tall at range. The TAA jitter
       moves the camera by sub-pixel amounts every frame even when it's still, so the line covered a pixel
       in some frames and missed it in others, and TAA kept discarding the history. Not new (it predates
       the recent perf work). It is now drawn like lamp tubes/wires: kept at least ~1 px wide with its
       light scaled by true coverage. Temporal flicker on the line 6.9 -> 2.4. The red corner lights
       still blink on purpose (aviation lights).

    freecam=0.00,100.00,0.00,0.00,-0.20&city=neon&seed=1&time=18.82&timespeed=0&weather=sunny

[x] startup time - can we compile pipelines using createXXXPipelineAsync,
    then go build the city, then later await on the pipelines so they can
    be compiled in parallel.
    -> every pipeline (renderer 35 + rain, sprites, vehicles) is now created async right after the device,
       and only awaited before the first frame; by then they've long finished. City workers start at
       ~0.2 s instead of 2.1 s. Sign atlas + detail texture painting (~1 s on the main thread) and the
       skyline moved into workers (identical bytes). The console prints a [startup] timeline;
       test/puppeteer/startup.mjs prints it too. Biggest remaining cost: all 6 city workers generate the
       same layout at once (~20 s each); having only one do it and share it is the next win.

[x] can we build any parts of the city on the GPU. You'd need to compile
    those pipelines first and await on them when you first need them.
    -> not without changing the generated city: WGSL has only 32-bit floats and the generator is 64-bit,
       so terrain/grading/layout on the GPU would shift heights and break saved links; clusterize is
       order-dependent and now only ~1 ms per LOD1 tile. Done instead, with identical output: clusterize
       2-5x faster (typed arrays), layout ~20% less CPU (rail lookup grid). Better load-time wins still
       open: build LOD1+LOD2 in one job (~4 s CPU), split buildBase over two workers (~2 s off the
       critical path). GPU facade instancing would mainly save memory and is a big redesign. Wasm: ~1.2-1.5x
       at best and its maths may not match V8's bit for bit, so not recommended.

[ ] Currently on Windows 11 the page just freezes for 15 seconds before
    any progress starts at all. What's it doing? How can we provide
    more feedback.
    -> very likely the 35 shader pipelines (D3D12 compiles WGSL -> HLSL -> FXC/DXC, slow with a cold
       cache), which were all awaited before the city even started, plus ~1 s of texture painting and two
       synchronous pipelines on the main thread. All now async or in workers, and the loading screen
       paints at ~0.1 s. Not tested on Windows: check the [startup] table in the DevTools console —
       "loading screen painted" should be ~100 ms; if "wait: pipelines + textures" is well above 0 ms,
       shader compiling is the bottleneck there (the screen then shows "Compiling shaders n/N" rather
       than freezing).

[ ] can we add a better progress. 
    It will probably take 30-60 seconds to
    start up on mobile. What can we do to entertain the user while that happens?
    -> new loading screen: the city's map draws itself live (terrain, streets, rail, blocks, buildings,
       then tiles lighting up as they finish), with city name/seed, phase labels and counts (shaders n/N,
       tiles n/N) and rotating control tips (touch tips on touch devices). The bar is weighted by real
       step times, keeps creeping between updates (runs on the compositor, so it moves even when the main
       thread is busy). Portrait layout stacks the map under the title.

[x] cars make very janky turns. turning at very discrete angles around
    corners. Can we make them make smoother turns. Maybe, like the trains,
    they need to pick a front and back target? Or maybe there is some
    other solution.
    -> three causes: the front axle point jumped onto the junction curve when a turn began (and the rear
       one back onto the lane when it ended), corner curves were followed as 24 straight pieces, and
       road centrelines had sharp bends that cars took in one frame. Now the turn is planned when a car
       enters a lane so the axles sample one continuous route (lane -> true Bezier corner -> next lane),
       centreline corners are rounded (<=1.5 m), and cars ease to a curvature-based speed instead of
       snapping to 0.55x. Applies to all traffic and the autopilot. Max per-frame yaw 4.77 -> 1.3 deg,
       yaw-rate jumps 287 -> 55 deg/s (test/puppeteer/carturns.mjs).

[x] Are any parts of rendering CPU heavy? Can they be moved to the GPU
    or to Wasm?
    -> yes: first-person was CPU-bound (~8 ms CPU vs 7.4 ms GPU at 720p). Traffic's O(n^2) "car ahead"
       scan and building vehicle part matrices were ~5 ms of that. Fixed with a neighbour grid (same
       results) and allocation-free instance matrices: traffic 2.4 -> 1.6 ms, vehicle instances
       2.4 -> 1.2 ms; all six test views are now GPU-bound. Next: expand vehicle parts on the GPU (~1.2 ms),
       allocation-free chainAt (~0.3 ms), renderer bind-group cache (~0.25 ms). Traffic in Wasm/GPU isn't
       worth it. test/puppeteer/cpuprof.mjs profiles it.

[x] bridges in Hong Kong are kind of a mess
    -> every avenue/boulevard ran straight on across the harbour, so ~20 long bridges crossed each other
       at mid-water junctions. Now only the shortest crossings at least 700 m apart that don't meet another
       bridge are kept (river crossings under 200 m untouched); no random draws, blocks unchanged.
       Harbour 1: ~20 bridges -> 3. A few short bay bridges hugging the shore remain.

    city=harbour&seed=1&freecam=2.50,371.03,179.50,-2.13,-0.53&time=15.10&timespeed=0&weather=sunny

[x] trains in Hong Kong can be way too high and dead end
    -> the rail profile held a 3% grade off hilltops and lifted crossing lines for a km or more (decks
       100-136 m up); lines cut at the harbour ran off the end of the deck, and loops crossing a river were
       split into two dead ends (all cities). Decks now rise at most 25 m above clearance and rail tunnels
       through hills (portals at the mouths); open lines end at a terminus with an end wall and buffer
       stops, trains reverse there; river-crossing loops stay loops. Rail max height 100-136 -> 28-36 m.
       Still open: expressways reach 60-80 m where the boulevards under them climb ~50% grades (same
       steep-road bug as neon chain 201); portals in flat ground have no ramps/cut.

    city=harbour&seed=1&freecam=14.58,120.29,260.55,1.02,-0.40&time=16.16&timespeed=0&weather=sunny

[x] a building in Chongqing has a broken shape
    -> its lot outline crossed itself (~0.6% of lots come out pinched or folded when blocks are split),
       and shrinking it for the tower body twisted the box past the podium. Self-crossing plans now keep
       their largest simple loop (after the building's random draws, so others don't change), and tower
       insets that fold are retried smaller. River 1: 526 such plans -> 0 in Chrome. Still open: house
       roofs on irregular lots can overhang 25-40 m. Note: Node and Chrome generate slightly different
       cities (Math.cos/exp/atan2 differ in the last bit), so saved links follow the browser.

    city=river&seed=1&freecam=-1830.71,189.75,-152.37,-0.41,0.08&time=18.79&timespeed=0&weather=sunny

[x] When I run on my iPhone it gets almost all the way through initialization
    and then runs out of memory from WebGPU. Are there any things we can compress?
    For example, we could make vertex values quantized to 16bits with an offset and
    multiplier per channel for models? Maybe there are some other buffers that can
    use a smaller storage for? Maybe you have some ideas... Looking for solutions
    that do not change the city. Also, how many workers are you spawning at init
    time, maybe we need to limit it to navigator.hardwareConcurrency

    Also, can workers use smaller chunks? Are they transferring their data via
    transferring ownership of typedarrays?
    -> (needs an iPhone test) city vertices packed 32 -> ~20 bytes (vpack.ts: positions on a fixed
       1/4096-1/1024 m grid relative to the cluster, 0.12-0.5 mm max error, no cracks; mat/aux in a
       per-cluster palette; normal/uv unchanged), so the pool is 512 MB instead of 768. Buffers are freed
       as soon as they're copied (most of the old peak was dead ArrayBuffers not yet GC'd), GPU uploads go
       in 8 MB pieces (one big writeBuffer kept its size again as staging memory). Workers: city used
       cores-1 clamped 2-6, vehicles up to 9; now from caps.ts (?cores=N, ?lowmem=1), max 3 city / 2
       vehicle workers on phones, and only 3 city workers (2 on phones) stay after load. Transfers were
       already zero-copy for all big data except the base lights (fixed); the ~32 MB layout object is
       still copied to each worker (SharedArrayBuffer needs COOP/COEP headers). Phones also get the low
       preset, a smaller LOD0 ring and a 384 MB pool. Neon 1: GPU 1192 -> 898 MB, page peak 4.6 -> 2.9 GB,
       low-memory mode 633 MB GPU / 1.4 GB page. City unchanged (worker output hashes match, also with
       2 and 4 cores). Memory report: node test/puppeteer/mem.mjs "city=neon&seed=1".

[x] This intersection makes no sense. The road needs top being a hill before it reaches the intersection.
    -> roads took their height from the ground under them (smoothed only along their own length) and
       junctions the raw ground height, with no grade limit: 50-80% climbs, warped junctions, parallel
       roads 11 m apart vertically. All road heights are now solved together (max grade lane 15% ..
       boulevard 8%, junction arms ~flat, close neighbours tied, decks keep clearance) and the ground is
       cut/filled to 0.7 banks within 120 m of roads. Every road in every preset <= 15% (harbour was up to
       244%); near-vertical ground by roads 11k -> 1k cells. Roads, junctions, blocks and lots unchanged
       (no random draws touched), but hilly harbour/river ground moves by up to tens of metres, so some
       saved views there frame differently. Still open: tunnel portals in flat ground have no ramps.

    city=harbour&seed=1&freecam=2252.81,102.45,2269.14,-0.75,-0.18,0.67&time=16.95&timespeed=0&weather=sunny

    Other harbour issues

    city=harbour&seed=1&freecam=2058.36,149.16,2273.68,2.44,-0.21,0.67&time=16.95&timespeed=0&weather=sunny
    city=harbour&seed=1&freecam=1675.83,107.27,2276.71,-2.63,0.09,0.67&time=16.95&timespeed=0&weather=sunny

[x] River Mountain. What happened here?
    -> this link has the same coordinates as the harbour one above; in river it's a rooftop over level
       ground with nothing wrong. River's steep roads elsewhere are fixed by the grading above. Send the
       river link again if it was something else.

    city=river&seed=1&freecam=2252.81%2C102.45%2C2269.14%2C-0.75%2C-0.18%2C0.67&time=16.95&timespeed=0&weather=sunny

[x] When I switch from rain/storm to cloudy/sunny, it takes way too long for the road to stop being wet.
    It should take no more than 3 hours.
    -> drying ran on real time (~250 s from soaked), so with the clock sped up it took many in-game hours.
       It now follows the clock: soaked to dry in 2.5 game hours once the rain stops (T's +1 hour counts),
       never slower than the old 250 s, so roads still dry with the clock paused.
