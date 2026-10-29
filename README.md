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
`shot=<director shot>`, `spawn=x,z`, `debug=1..8` (G-buffer and lighting views).

## Development

```sh
npm install
npm run dev          # esbuild watch + express on http://localhost:8080
npm run build        # one-off build into dist/
npm test             # typecheck, unit tests, puppeteer smoke test
npm run test:shots   # screenshot matrix in test/out/shots (for the AAA judge)
npm run test:perf    # frame-time measurements
node test/puppeteer/turntable.mjs <design>   # vehicle turntable screenshots
node tools/map.ts neon 1 test/out/map.png    # 2D map of a city layout
```

Every WebGPU object is labelled. Uncaptured errors, device loss and WGSL
compilation messages are printed to the console and collected in
`window.__errors` for the tests.

`PLAN.md` describes the architecture. `agents/` holds the briefs for the
vehicle designer and the vehicle and AAA judge agents used during development.
GitHub Actions builds and deploys the site to GitHub Pages on every push to
`main`.
