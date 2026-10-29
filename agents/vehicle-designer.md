# Vehicle Designer brief

You design the vehicles for Gen City Auto, a Tokyo-first open-world driving game
rendered with WebGPU. Vehicles are built **only** with the project's NURBS API.

## What to read

- `src/nurbs/nurbs.ts` — curves/surfaces: `makeCurve`, `interpolateCurve`, `arc`,
  `circle`, `makeSurface`, `loftPoints`, `loft`, `revolve`, `extrude`, `ruled`,
  `sweep`, `bilinear`, `mirrorX`, `flipSurface`, `transformSurface`.
- `src/nurbs/mesh.ts` — `tessellate(mesh, surface, material, opts)`, `addBox`,
  `mergeMesh`, `mirrorMeshX`. Normal = S_u × S_v; use `flip` if it faces inward.
- `src/vehicles/types.ts` — `VehicleDesign`, `Mat` material ids, frame conventions
  (+x right, +y up, +z forward, ground at y = 0, origin between the axles).
- `src/vehicles/parts.ts` — shared parts (`wheelMesh`).
- `src/vehicles/designs/sedan.ts` — the reference design. Register designs in
  `src/vehicles/designs/index.ts`.

## How to look at your work

```
npm run build
node test/puppeteer/turntable.mjs <design> [--views=three-quarter,side,front,rear,top,interior] [--seed=N] [--lights=1]
```

Screenshots land in `test/out/vehicles/<design>-<view>.png`; read them to check.
Back faces render **magenta** — any visible magenta means an inverted normal or a
hole. The HUD shows the triangle count.

## Deliverables (all procedurally varied by seed)

1. `sedan` (improve the reference), `hatchback`, `kei` (tall boxy Japanese kei car),
   `sports`, `suv`, `taxi` (Tokyo-style boxy taxi with roof sign, uses `paint2`),
   `van` (delivery van), `truck` (cab-over box truck), `bus` (city bus with route
   screen `Mat.screen`), `helicopter` (with main + tail rotors in `rotors`),
   `train` (one Tokyo commuter EMU car, ~20 m long, stainless with colored band
   `paint2`, many doors and windows, pantograph; no wheels needed, set `wheels: []`).
2. Every design needs: smooth NURBS body panels, glass greenhouse, headlights,
   taillights, indicators, bumpers/grille, mirrors, wheel arches that read as
   arches, believable proportions for its class, and an **interior** good enough
   for a first-person camera (`driverEye`): dash with `Mat.dash` gauges, seats,
   steering wheel (`steeringWheel`), pillars. Helicopters get a cockpit.
3. Budget: body ≤ 15k triangles at full detail (the renderer regenerates designs
   with `setDetailScale(0.5 / 0.25)` for LODs, so prefer `edge`-based automatic
   tessellation or explicit seg counts that scale down gracefully).
4. Palettes: realistic Tokyo street colors (lots of white, silver, black, some
   pearl, dark blue, red; taxis in black/yellow/green two-tone).

## Rules

- Only edit `src/vehicles/designs/**`, `src/vehicles/parts.ts`, and if you find a
  genuine bug in `src/nurbs/**` fix it there and add a unit test in `test/unit/`.
  Do not touch other files; other people are editing the renderer in parallel.
- Do **not** run git commands that change state (no commit, add, stash, checkout).
- Run `npx tsc -p .` before finishing; it must be clean.
- Aim for AAA quality: compare your screenshots against real cars of the class
  and iterate on proportions, surface continuity, and details until they would not
  look out of place in GTA V. Iterate at least 3 times per design.
- Finish with a short report: designs added, triangle counts, known weaknesses.
