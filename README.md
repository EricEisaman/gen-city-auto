# Gen City Auto

A procedurally generated metropolis you can drive and fly around, rendered
with WebGPU and no libraries. Inspired by GTA V and Marvel's Spider-Man.

- **Cities:** Tokyo-like *Neon Sprawl* (the primary target), plus *Metro
  Island* (New York), *Harbour Peaks* (Hong Kong) and *River Mountain*
  (Chongqing). Every city comes from a seed and has hilly terrain, rivers,
  waterfronts and bridges. Elevated rail viaducts carry trains over the
  traffic, expressways run on piers, and the streets are dense with Japanese
  business signs and modern towers.
- **Vehicles:** cars, taxis, vans, trucks, buses, trains and helicopters are
  modelled with a NURBS library (`src/nurbs`), tessellated at three LODs in a
  worker and drawn instanced. Pedestrians use the same library.
- **Rendering:** GPU-driven deferred renderer:
  - city geometry is split into 128-triangle clusters, culled on the GPU
    (frustum + Hi-Z occlusion + per-tile LOD) and drawn with one indirect draw
    using vertex pulling (Nanite-style);
  - cascaded shadows and tiled lighting with up to 1024 lights;
  - Hillaire 2020 atmosphere (Rayleigh/Mie scattering, aerial perspective) and
    volumetric clouds;
  - SSAO, screen-space reflections on wet streets, TAA, bloom, auto exposure
    and ACES tonemapping;
  - interior-mapped windows, and rain with puddles and lens drops.
- **Simulation:** left-hand traffic with signals and IDM car following, trains
  that stop at stations, and pedestrians. Your vehicle drives itself whenever
  you let go of the controls, while an auto director cuts between cinematic
  shots.

## Controls

| Key | Action |
|---|---|
| WASD / arrows | drive or fly (taking control disables the autopilot) |
| Space / Shift | handbrake; climb / descend in the helicopter |
| Q / E | helicopter yaw |
| C | cycle camera (chase, first person, hood, orbit) |
| K | toggle the auto director |
| V / B | car ↔ helicopter / next vehicle |
| T / Y | +1 hour / next weather |
| N | generate a new random city |
| M / H / F | menu / help / stats |

URL parameters: `city=neon|metro|harbour|river`, `seed`, `time` (hours),
`timespeed` (hours per second), `weather=sunny|cloudy|rain|storm`,
`vehicle=<design>|heli`, `cam=chase|first|hood|orbit`, `director=0`,
`shot=<director shot>`, `spawn=x,z`, `freecam=x,y,z,yaw,pitch`, `quality=low`,
`debug=1..8` (G-buffer and lighting views), `diag=1` (on-screen diagnostics
for devices without a console: main-thread stalls, GPU queue latency, errors,
the adapter and the startup timeline, with a Copy button), `lowmem=0|1`.

Graphics settings live in the menu (M, under GRAPHICS) and persist in
localStorage. URL parameters override them for that page load without being
saved: `scale=25..100|auto|dynamic` (render scale: the internal resolution
in % of the display, upsampled by TAA; `auto` = 75% at 1440p and up, 85% at
1080p, native below; `dynamic` steers it to hold `fps=30|45|60|90|120`),
`gfx=low|medium|high|ultra` (quality preset), `clouds=0..4`,
`shadows=0|1024|1536|2048|3072`, `readout=1` (FPS / GPU ms readout),
`traffic=<cars>`, `lod2=<metres>`.

Asset lab (one asset alone in the full renderer, for art review):
`lab=building|road|rail`, `pick=<n>` (0 = most typical building / most
central signalized junction / first straight viaduct section),
`kind=tower|glass|midrise|pencil|house|apartment|station` (buildings),
`station=1` (rail: a station), `ctx=1` (keep the buildings around; for a
building, its streets and the neighbours within 120 m, minus any that stand
between a preset camera and it),
`view=<preset>`: building
`street|facade|mid|far|shell|shell2|far-iso|aerial|rear|service|orbit` (`mid` 70 m,
`far` 180 m at a long lens, `far-iso` the old 350 m silhouette view),
road `eye|low|top|mid|far|shell|shell2|curb|orbit`, rail
`side|under|along|mid|far|shell|shell2|station|orbit`. `shell` is `far` with every
tile forced to LOD1, `shell2` to LOD2 (the shell past 1.5 km). Traffic, pedestrians, trains and the director are off;
`time`, `weather`, `ui=0` and `freecam` still apply.

## Development

```sh
npm install
npm run dev          # esbuild watch + express on http://localhost:8080
npm run build        # one-off build into dist/
npm test             # typecheck, unit tests, puppeteer smoke test
npm run test:shots   # screenshot matrix in test/out/shots (for the AAA judge)
npm run test:perf    # frame-time measurements
node test/puppeteer/turntable.mjs <design>   # vehicle turntable screenshots
npm run lab -- building --kind=midrise --times=day,night   # asset lab shots
#   test/puppeteer/lab.mjs <building|road|rail> [--pick=0] [--kind=..]
#   [--station=1] [--ctx=0|1|0,1] [--views=a,b] [--times=day,golden,night,rain]
#   [--size=1280x720] -> test/out/lab/*.png and <asset>[-ctx]-sheet.png
#   (--ctx=1 shots are named <asset>-<kind><pick>-ctx-<view>-<time>.png)
node tools/map.ts neon 1 test/out/map.png    # 2D map of a city layout
```

Every WebGPU object is labelled. Uncaptured errors, device loss and WGSL
compilation messages are printed to the console and collected in
`window.__errors` for the tests.

`PLAN.md` describes the architecture. `agents/` holds the briefs for the
vehicle designer and the vehicle and AAA judge agents used during development.
GitHub Actions builds and deploys the site to GitHub Pages on every push to
`main`.
