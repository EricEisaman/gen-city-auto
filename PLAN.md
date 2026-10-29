# Gen City Auto — Implementation Plan

This plan turns [DESIGN.md](DESIGN.md) into a sequence of buildable milestones. Every
milestone ends in something that runs in the browser, passes the puppeteer harness, and
is reviewed by the AAA judge agent before moving on.

---

## 1. Ground rules

- **No runtime libraries.** Only browser APIs (WebGPU, DOM, Web Workers). Math, NURBS,
  noise, RNG, city generation, physics and rendering are all written in this repo.
  Dev dependencies (TypeScript, esbuild, gts, express, puppeteer) are fine.
- **Deterministic.** Every generator takes a seed and uses our own PRNG (e.g. PCG32 /
  xoshiro128**). Same seed + same city type = same city, on every machine.
- **Render at CSS resolution.** `canvas.width = canvas.clientWidth`, no
  `devicePixelRatio` scaling. Internal render targets may be scaled *down* for dynamic
  resolution, never up.
- **Every WebGPU object gets a `label`.** Buffers, textures, views, samplers, bind group
  layouts, bind groups, pipeline layouts, shader modules, pipelines, encoders, passes,
  query sets. Labels follow `system/purpose[/detail]`, e.g. `city/tile(3,-2)/clusterBuffer`,
  `post/bloom/downsample[2]`.
- **Errors are loud.** `device.addEventListener('uncapturederror', …)` logs
  `[WebGPU] <type>: <message>` to the console (the message includes the offending
  object's label); `device.lost` is logged too; `getCompilationInfo()` is printed for
  every shader module. A `?debug` flag wraps each frame's subsystems in
  `pushErrorScope/popErrorScope` so failures are attributed to a subsystem.

---

## 2. Tooling and project skeleton (Milestone 0)

```
gen-city-auto/
  package.json            "type": "module"
  tsconfig.json           strict, target ES2022+, lib dom + @webgpu/types
  .eslintrc / .prettierrc gts defaults
  build.mjs               esbuild script (bundle, sourcemaps, .wgsl as text loader)
  server.mjs              express dev server (static dist/, optional watch rebuild)
  index.html
  src/
    main.ts               boot, device creation, error hooks, main loop
    gpu/                  device, resource helpers, labels, pipeline cache, profiler
    math/                 vec/mat/quat, AABB, frustum, PRNG, noise, splines
    nurbs/                NURBS curves/surfaces API (see §5)
    city/                 terrain, water, roads, blocks, lots, buildings, props
    vehicles/             vehicle designs, tessellation, physics, AI
    render/               passes: gbuffer, lighting, sky, clouds, shadows, post…
    shaders/              *.wgsl, shared include chunks
    world/                streaming, tiles, time of day, weather
    camera/               chase, first person, free fly, auto director
    input/                keyboard, mouse, gamepad
    ui/                   HUD, menus (city type / seed / time / weather / camera)
    workers/              city generation & tessellation workers
  test/
    unit/                 node:test tests for math, NURBS, city gen
    puppeteer/            smoke, screenshot, perf scripts
  agents/                 briefs + rubrics for the vehicle-design and judge agents
  .github/workflows/pages.yml
```

Tasks:

1. `npm init`; dev deps: `typescript` (latest), `esbuild`, `gts`, `@webgpu/types`,
   `express`, `puppeteer`. Run `npx gts init` and adapt. TypeScript is pinned to the
  newest 6.0.x because gts's typescript-eslint does not yet accept TypeScript 7.
2. `build.mjs`: bundles `src/main.ts` and worker entry points to `dist/`, `.wgsl` loaded
   as text, `--watch` mode, minify for production.
3. `server.mjs`: express serving `dist/` on a configurable port.
4. Scripts: `build`, `dev`, `lint`, `fix`, `typecheck`, `test:unit`, `test:smoke`,
   `test:shots`, `test:perf`.
5. `.github/workflows/pages.yml`: on push to `main` → `npm ci`, `npm run lint`,
   `npm run typecheck`, `npm run test:unit`, `npm run build`, then
   `actions/upload-pages-artifact` + `actions/deploy-pages`.
6. Boot code: request adapter (`powerPreference: 'high-performance'`), request device
   asking for useful optional features when present (`timestamp-query`,
   `indirect-first-instance`, `shader-f16`, `float32-filterable`,
   `rg11b10ufloat-renderable`) and raised limits we need (storage buffer size, bind
   groups, etc.), with fallbacks when absent. Clear screen + labelled resources +
   error hooks.
7. Puppeteer smoke test passes (see §11).

**Done when:** the GitHub Pages URL shows a cleared canvas, and `npm run test:smoke`
reports zero WebGPU errors.

---

## 3. Rendering architecture

A GPU-driven deferred renderer, modelled on what Spider-Man, GTA V and Cyberpunk do for
dense cities.

### 3.1 Frame graph

A small hand-written frame graph: each pass declares the textures/buffers it reads and
writes; the graph allocates transient targets, orders passes and labels everything.
Passes per frame:

| # | Pass | Notes |
|---|------|-------|
| 1 | Streaming uploads | `queue.writeBuffer` into ring/staging buffers; budgeted per frame |
| 2 | GPU culling (compute) | instance + cluster frustum culling, Hi-Z occlusion from last frame, LOD selection, writes indirect args |
| 3 | Shadow cascades | 3–4 cascaded shadow maps, cached/scrolled for far cascades, sun or moon |
| 4 | Depth prepass + G-buffer | albedo, octahedral normal, roughness/metal/AO, emissive, motion vectors |
| 5 | Hi-Z build (compute) | depth pyramid for next frame's occlusion culling and SSR |
| 6 | SSAO / GTAO (half res) | |
| 7 | Clustered lighting (compute) | light assignment to a froxel grid; thousands of street lights, signs, car lights |
| 8 | Deferred lighting | sun/moon + clustered point/spot lights + IBL from sky probe |
| 9 | Screen-space reflections | Hi-Z traced, strength driven by wetness; fallback to sky/probe |
| 10 | Sky, aerial perspective, volumetric clouds | see §7 |
| 11 | Forward transparents | glass, rain streaks, particles, lens drops |
| 12 | TAA | jittered projection, reprojection with motion vectors, neighbourhood clamp |
| 13 | Post | bloom (dual filter), auto exposure (histogram compute), tonemap (ACES/AgX), color grade per time/weather, vignette, film grain, lens flare at night |
| 14 | HUD | DOM overlay, not GPU |

### 3.2 Geometry pipeline (Nanite-inspired, but practical in WebGPU)

WebGPU has no multi-draw-indirect or mesh shaders, so:

- **Meshlets/clusters.** All static geometry (buildings, props, terrain) is split into
  clusters of ≤128 triangles with bounding sphere + normal cone, stored in big shared
  storage buffers (one vertex pool, one index pool, one cluster table).
- **Cluster LOD hierarchy.** Clusters are grouped and simplified (our own edge-collapse
  simplifier, run in workers) into a DAG with monotonic error bounds, like Nanite. The
  culling compute shader picks the cut where projected error < ~1 pixel.
- **Single indirect draw per material class.** Culling compacts visible clusters into a
  list; the vertex shader does vertex pulling: `instance_index` → cluster,
  `vertex_index` → triangle corner. One `drawIndirect` per pipeline (opaque, alpha-test,
  emissive-sign), so draw call count is a handful regardless of city size.
- **Two-pass occlusion culling.** Draw last frame's visible set, build Hi-Z, test the rest,
  draw newly visible ones (as in Nanite / Assassin's Creed Unity).
- **HLOD / impostors for distance.** Beyond ~1.5 km, a city tile collapses to one merged
  low-poly proxy; beyond ~5 km, a skyline proxy with baked window-light emissive. This is
  how the city reads as "enormous" without drawing it all.
- **Instancing for repeated things.** Trees, street lights, traffic lights, benches,
  signs and vehicles use instance buffers + culling compute + `drawIndexedIndirect` per
  mesh/LOD.
- **Fallback path.** If the cluster pipeline is too slow on a GPU, a classic per-tile
  `drawIndexed` path exists behind a flag so the game always runs.

### 3.3 Materials and the "AAA look"

- PBR metal/rough everywhere; materials are mostly procedural in shader (triplanar
  concrete, brick, glass curtain wall, asphalt, painted lines) driven by small parameter
  structs, plus a handful of generated textures (noise atlases, decal atlas, sign/ad
  atlas) created at startup with compute shaders.
- **Interior mapping** for building windows (Spider-Man's technique): a fake room
  raymarched in the fragment shader, with procedurally chosen room types, furniture
  silhouettes and per-room on/off lighting that follows time of day.
- **Emissive signage** with bloom; ads/billboards generated into an atlas (procedural
  shapes, gradient logos, fake text made from glyph noise), some animated.
- **Wetness** (§8) modifies albedo darkening, roughness, normals (ripples) and
  puddle masks on roads/sidewalks/roofs.
- Decals: road markings, cracks, manhole covers, crosswalks — projected via a decal pass
  into the G-buffer.

### 3.4 Performance budget and practices

- Target 60 fps at 1080p CSS resolution on a mid-range discrete GPU, 30+ on integrated.
- Dynamic resolution on internal targets based on GPU timestamp queries (when
  available); TAA upsamples back to canvas size.
- Bind group frequency split: `@group(0)` frame, `@group(1)` pass, `@group(2)`
  material, `@group(3)` draw. Pipelines created up front with `createRenderPipelineAsync`
  and cached; no pipeline creation during gameplay.
- Avoid per-frame allocation (JS and GPU). Persistent, ring-buffered uniforms.
- Render bundles for static sub-passes where it helps.
- In-page profiler overlay (`?stats`): CPU frame time, GPU pass timings, visible
  clusters, triangles, draws, lights, streaming queue length.

---

## 4. City generation

All generation runs in Web Workers, tile by tile, from `(cityType, seed)`.

**First target: Tokyo ("Neon Sprawl").** Tokyo is the preset built and polished first;
the others reuse its pipeline with different parameters. Requirements that drive the
Tokyo preset:

- **Not flat.** Most of the city sits on rolling hills and plateaus cut by river
  valleys (like Tokyo's Yamanote upland vs. the Shitamachi lowlands); only the bayside
  lowland and reclaimed land is flat. Roads follow the terrain with gentle grades,
  buildings get stepped foundations/retaining walls on slopes, and some streets climb
  stairs-steep hills.
- **Trains on bridges crossing over traffic.** Elevated rail viaducts (concrete
  pillars, girders, catenary masts) run through the city, crossing over streets and
  rivers; commuter trains (NURBS-modelled cars) run on them continuously. Elevated
  expressways (Shuto-style) on piers weave between buildings.
- **Business signs everywhere.** Vertical and horizontal shop signs with Japanese text
  (kanji/katakana rendered into a sign atlas with the browser's Canvas 2D text APIs at
  startup), lit box signs, neon, rooftop billboards, video screens; dense at street
  level in commercial districts and near stations.
- **Modern buildings.** Glass curtain-wall towers, mixed-use mid-rises with podiums,
  slim pencil buildings, stepped setbacks, rooftop equipment, LED crowns at night.

### 4.1 Pipeline

1. **Macro layout** — heightfield (multi-octave noise + ridge noise, shaped by city
   type), coastline and rivers (flow accumulation + carved channels), sea level, islands.
2. **Districts** — Voronoi/region growing over the land: downtown core, financial
   high-rise, residential, industrial/port, parks, waterfront promenade. District drives
   density, height, building style and road style.
3. **Road network** — tensor-field street generation (Chen et al., *Interactive
   Procedural Street Modeling*): grid tensors in planned districts, radial around plazas,
   tensors following coastlines and terrain contours elsewhere. Hierarchy: highways →
   arterials → local streets. Produces a planar graph.
4. **Bridges and elevated roads** — where highways/arterials cross water or steep
   valleys, generate suspension, cable-stayed, arch and truss bridges (procedural
   towers, cables, decks) and elevated expressways (Chongqing / Tokyo style), with
   on/off ramps.
5. **Road meshing** — lanes, lane markings, sidewalks, curbs, intersections with proper
   corner fillets, crosswalks; stored as a lane graph for driving AI.
6. **Blocks and lots** — faces of the road graph minus sidewalk; lots by recursive
   OBB subdivision with street-frontage constraints.
7. **Buildings** — split/shape grammar per style: podium + tower, setbacks
   (NYC zoning feel), stepped Asian towers, slab apartments, brownstones, warehouses,
   landmark supertalls. Facade grammar picks window grids, mullions, balconies, AC units,
   rooftop water towers, antennas, helipads, roof gardens, neon signs.
8. **Props** — street lights along roads, traffic lights at intersections (with real
   phase timing), signs, bus stops, benches, hydrants, trash cans, trees (L-system or
   space-colonisation, a few dozen species instanced), parks (paths, lawns, ponds,
   trees), billboards on roofs and highways, piers, cranes in ports.
9. **Clustering** — geometry → clusters + LOD DAG + tile HLOD proxy (§3.2).

### 4.2 City types (presets)

Each preset is a parameter set over the same pipeline:

| Preset | Character |
|---|---|
| **Metro Island** (NYC-like) | Long island, strong grid downtown, organic older south tip, many bridges, waterfront piers, central park |
| **Neon Sprawl** (Tokyo-like) | Flat, dense, organic streets, elevated expressways, rail lines, huge sign density |
| **Harbour Peaks** (Hong Kong-like) | Steep island + mainland across a harbour, towers climbing hills, skyline across water |
| **River Mountain** (Chongqing-like) | Two rivers meeting, very hilly, multi-level roads, many large bridges, towers on cliffs |
| **Random** | Mixed parameters from the seed |

UI lets the user choose preset + seed and "Generate new city"; the world is torn down and
regenerated without reloading the page.

### 4.3 Scale and streaming

- World targeted at ~20 × 20 km, divided into 256 m tiles.
- Tile states: *not generated → generating (worker) → resident (full clusters) →
  proxy only*. A priority queue orders work by distance and view direction, with a
  look-ahead along vehicle velocity (important for helicopter speed).
- Macro data (terrain, water, road graph, districts, skyline proxies) is generated once
  for the whole world at startup (a few seconds, with a progress bar); tile detail is
  generated lazily.
- GPU memory is managed with pooled allocators in the shared vertex/index/cluster
  buffers; evicted tiles return space.

---

## 5. NURBS API and vehicles

### 5.1 NURBS library (`src/nurbs/`)

Written first, unit-tested, and documented so that a separate agent can design vehicles
with it without reading the renderer.

- Core: knot vectors, Cox–de Boor basis + derivatives, rational curves and surfaces,
  evaluation of point/normal/derivatives, knot insertion, degree elevation.
- Construction: `curve(points, degree, weights?)`, `interpolate(points)`,
  `circleArc`, `loft(curves)`, `sweep(profile, rail)`, `revolve(profile, axis, angle)`,
  `extrude`, `ruled`, `bilinear`, `coons`, `mirror(surface, plane)`, `offset` (approx).
- Trimming: simple parametric-space trim loops (for wheel arches, windows, doors).
- Tessellation: adaptive by curvature and target screen error, producing multiple LODs,
  watertight across shared edges; outputs positions, normals, UVs, and a material ID per
  patch. Runs in workers and is cached per design.
- Assembly: a `VehicleDesign` is a tree of named parts (body panels, glass, lights,
  wheels, interior: seats, dash, steering wheel, gauges, mirrors), each a NURBS surface
  set + material + optional animation pivot (wheels, steering wheel, rotor blades,
  doors).
- Serialisable to JSON so designs can be generated, saved, compared and judged.

### 5.2 Vehicle catalogue

Procedural families, each a parametric generator built on the NURBS API, varied by seed:
sedans, hatchbacks, sports cars, SUVs, pickups, taxis, police cars, vans, box trucks,
semi trucks + trailers, city buses, articulated buses, and helicopters (news, police,
private). Every design includes an **interior** good enough for first-person
(dashboard, gauges with emissive at night, seats, steering wheel/yoke, A-pillars, mirrors).

### 5.3 Rendering lots of vehicles

- Tessellate each design at 4 LODs + a far impostor (octahedral impostor captured at
  load). A few dozen designs × colour/livery variations covers the traffic population.
- All traffic is GPU-instanced: per-instance transform, colour, livery, light state
  (brake, indicator, headlights). Culling + LOD selection in compute.
- Car paint shader: clearcoat layer, metallic flake, dirt, wetness beads in rain.
- Headlights/taillights register as clustered lights only for the nearest N vehicles;
  further ones are emissive sprites (with bloom), which is how night traffic glows.

### 5.4 Vehicle simulation

- Player car: raycast-wheel model (suspension springs, tyre slip curves, weight
  transfer, simple drivetrain), collisions against road surfaces, curbs, building
  footprints (2D OBBs + heights), and other cars (sphere/OBB).
- Helicopter: arcade flight model (collective, cyclic, yaw, auto-hover assist), collide
  with building AABBs and terrain.
- Traffic: lane-graph following, IDM car-following, obeys traffic light phases, simple
  lane changes, spawns/despawns in a ring around the camera. Buses follow routes and
  stop at bus stops. Some ambient helicopters fly patterns.
- **Autopilot** for the player vehicle: the same traffic AI drives it whenever the user
  is idle for a few seconds (car picks random scenic routes biased to bridges and
  waterfronts; helicopter flies tours between landmarks). Any input takes over instantly.

---

## 6. Cameras

- Modes: **chase** (spring-damped, look-ahead, collision-avoiding), **first person**
  (inside the interior, head-bob/ look with mouse), **hood**, **free fly** (detached),
  **cinematic/auto director**. Cycle with `C`.
- **Auto director** (active when the user isn't driving): a shot library — trailing
  chase, low bumper cam, fly-by from a roadside point, telephoto from a rooftop,
  helicopter orbit, bridge establishing shot, interior over-the-shoulder. It picks shots
  by context (on a bridge → wide establishing; at night downtown → low neon fly-by), holds
  each for 4–10 s, enforces the 180° rule and avoids occluded shots (raycast checks), cuts
  or blends, and prefers golden-hour / skyline compositions.
- Camera jitter for TAA, motion blur from camera + object motion vectors (optional).

---

## 7. Sky, time of day, clouds

- **Atmosphere** — Hillaire 2020 (*A Scalable and Production Ready Sky and Atmosphere
  Rendering Technique*): transmittance LUT, multi-scattering LUT, sky-view LUT, aerial
  perspective froxel volume. Rayleigh + Mie + ozone. Recomputed when sun moves.
- **Sun, moon, stars** — sun disk with limb darkening, moon with phases, starfield +
  Milky Way band at night; moon as the night directional light.
- **Volumetric clouds** — raymarched low-res (¼ res) with temporal reprojection
  (Horizon Zero Dawn / Nubis approach): 3D noise textures generated by compute at
  startup, weather map controlling coverage/type, lit by atmosphere, cast shadows onto the
  city via a cloud shadow map. Cirrus layer as a 2D texture.
- **Sky probe** — sky + clouds rendered to a cubemap periodically, prefiltered for IBL
  and reflections.
- **Day/night look** — exposure adaptation, street lights switch on at dusk with
  staggered timing, building window occupancy follows a daily schedule, signs and
  billboards emit at night, sodium vs LED street lights per district, car lights on at
  dusk or in rain.
- Time controls: slider, speed multiplier, pause, presets (dawn, noon, golden hour,
  dusk, midnight).

---

## 8. Weather

- States: **sunny, cloudy, rainy, stormy**, blended smoothly over time (and a "cycle"
  mode that drifts between them).
- Weather drives: cloud coverage/density/darkness, atmosphere haze, sun intensity,
  fog, wind (trees sway, rain angle), and **surface wetness** which ramps up during rain
  and dries out afterwards.
- **Wet surfaces** — darker albedo, lower roughness, puddle mask from noise + a
  terrain/road-curvature term, rain ripples (animated normal), SSR + probe reflections so
  neon and headlights streak across wet streets. Raindrop streaks on vehicle glass and
  splashes from tyres.
- **Rain** — GPU particle rain in a camera-relative volume, depth-tested against a
  top-down occlusion map so it doesn't fall indoors/under bridges; splash particles.
- **Storm** — heavier rain, darker sky, lightning (flash lighting + bolt geometry inside
  clouds), wind gusts.

---

## 9. UI and input

- Keyboard/mouse and Gamepad API. WASD/arrows drive, mouse look, `C` camera, `V` switch
  vehicle (car ↔ helicopter, or enter nearest vehicle), `T` time, `Y` weather, `N` new
  city, `Esc` menu.
- Menu: city type, seed, generate; time of day; weather; camera mode; quality preset;
  stats overlay. Minimal, clean DOM HUD (speedometer, minimap rendered from the road
  graph, current district name).
- URL parameters for everything (`?city=harbour&seed=42&time=19.5&weather=rain&cam=chase`)
  so tests and the judge get reproducible views.

---

## 10. Multi-agent workflow

Three agent roles beyond the main implementer, each with a brief stored in `agents/`.

1. **Vehicle Designer agent** — receives the NURBS API docs (`src/nurbs/README.md`), the
   `VehicleDesign` schema, and a vehicle turntable page (`vehicles.html?design=…`). It
   writes vehicle generators/designs, renders them via puppeteer turntable screenshots,
   and iterates. It never touches the renderer.
2. **Vehicle Judge agent** — scores turntable shots of each design (proportions,
   silhouette readability, surface quality, recognisable type, interior plausibility)
   on a 1–10 rubric with concrete fix requests; designs below 7 go back to the designer.
3. **AAA Judge agent** (sole duty: compare against AAA games) — after every milestone, and
   whenever rendering changes, it receives a fixed screenshot set (§11) and scores each
   against a rubric derived from GTA V / Spider-Man PS5 / Cyberpunk: lighting & GI
   feel, material quality, density & detail, scale/skyline, atmosphere & sky, night
   lighting, wet-weather look, vehicle quality, motion/AA quality, and performance
   (fps from the perf run). It returns ranked, actionable issues. A milestone is not done
   until its target areas score ≥ 7 or remaining gaps are explicitly accepted.

The judges get the screenshots and rubric, not the implementer's opinion, so their read
isn't anchored.

---

## 11. Testing

- **Unit tests** (`node --test`): PRNG determinism, math, NURBS evaluation against known
  values (circle exactness, derivatives, knot insertion invariance), tessellation
  watertightness, road graph planarity, lot subdivision validity, seed determinism of
  city generation.
- **Puppeteer harness** (`test/puppeteer/`), launched with default puppeteer arguments,
  against the express server:
  - `smoke` — load the page, wait for `window.__ready`, run N frames, fail on any
    `[WebGPU]` uncaptured error, `pageerror`, shader compilation error, or device loss.
  - `shots` — a fixed matrix of `{city type} × {time: noon, golden hour, night} ×
    {weather: sunny, rain, storm} × {camera: chase, first person, aerial}` via URL params,
    saving PNGs to `test/out/` for the judges.
  - `perf` — fixed flythrough route; reports average/p95 frame time, GPU pass timings,
    and visible-geometry stats from `window.__stats`.
  - Harness robustness: headless Chrome's compositor can stall; the harness checks that
    `requestAnimationFrame` is ticking and relaunches the browser if not (pattern from
    `../webgpu-puppeteer/koi-shot.js`).
- The page exposes `window.__ready`, `window.__stats`, and `window.__errors` for tests.

---

## 12. Milestones

Each milestone: implement → unit + smoke tests green → screenshot set → AAA judge review
→ fix top issues → commit.

| # | Milestone | Deliverable |
|---|-----------|-------------|
| M0 | Skeleton | Build, lint, express server, Pages deploy, labelled device + error hooks, smoke test |
| M1 | Core renderer | Math lib, camera, frame graph, G-buffer + deferred sun lighting, CSM shadows, TAA, tonemap; free-fly over test geometry |
| M2 | Sky & time of day | Atmosphere LUTs, sun/moon/stars, sky probe IBL, time controls |
| M3 | City macro | Hilly terrain, water, coastline, districts, roads, road meshes, Tokyo preset first |
| M4 | Buildings | Lots, building + facade grammars, interior-mapped windows, day/night window lights |
| M5 | Scale | Clusters, cluster LOD DAG, GPU culling + Hi-Z occlusion, tile streaming in workers, HLOD/skyline proxies, profiler overlay; hit perf budget on full-size city |
| M6 | NURBS + vehicles | NURBS library + tests + docs; vehicle designer/judge agent loop; vehicle turntable page; instanced vehicle rendering with LODs/impostors |
| M7 | Driving | Car + helicopter physics, chase/first-person/hood cameras, interiors, input |
| M8 | Streets alive | Props, trees, parks, traffic lights, Japanese business signs/ads/billboards atlas, elevated rail viaducts with running trains over traffic, bridges & elevated roads, traffic AI, buses, ambient helicopters |
| M9 | Night & lights | Clustered lighting, street lights, vehicle lights, emissive signs, bloom, auto exposure |
| M10 | Clouds & weather | Volumetric clouds + shadows, weather states, wetness, SSR, rain/splashes, lightning |
| M11 | Autopilot & director | Player-vehicle autopilot, auto director shot library |
| M12 | All city types | Metro Island, Neon Sprawl, Harbour Peaks, River Mountain, Random; regenerate in-page |
| M13 | Polish | Colour grading per time/weather, lens effects, quality presets, dynamic resolution, final AAA judge pass over the full shot matrix |

M1–M2 and M6 (NURBS library + vehicle design loop) are independent and can proceed in
parallel once M0 lands.

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| No mesh shaders / multi-draw-indirect in WebGPU | Vertex-pulling cluster rendering with one indirect draw per pipeline; classic per-tile fallback |
| Generation time for an "enormous" city | Global macro data once, tile detail lazily in a worker pool, HLOD proxies give the full skyline immediately |
| GPU memory | Pooled shared buffers, tile eviction, compact vertex formats (quantised positions, octahedral normals, f16 where supported) |
| Volumetric clouds + SSR cost | Low-res + temporal reprojection, quality presets, dynamic resolution |
| Optional features missing (timestamp-query, f16) | Feature-detect and fall back; never require them |
| Headless puppeteer flakiness | Ready/ticking checks and automatic relaunch in the harness |
| "AAA look" is subjective | Independent AAA judge agent with a fixed rubric and reproducible URL-parameterised shots every milestone |
