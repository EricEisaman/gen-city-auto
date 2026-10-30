// Procedural materials for city geometry (see src/city/cmesh.ts for ids).

@group(2) @binding(0) var signAtlas: texture_2d<f32>;
@group(2) @binding(1) var linearSampler: sampler;
@group(2) @binding(2) var leafTex: texture_2d<f32>;
// Tileable detail layers (src/render/detail-tex.ts): RG normal, B albedo
// multiplier around 0.5, A cavity.
@group(2) @binding(3) var detailTex: texture_2d_array<f32>;
@group(2) @binding(4) var detailSampler: sampler;
const DETAIL_ASPHALT = 0;
const DETAIL_PAVERS = 1;
const DETAIL_CONCRETE = 2;
const DETAIL_TILE = 3;
const DETAIL_BALLAST = 4;

// Screen derivatives captured in uniform control flow (fs entry), so
// materials can filter textures from inside their switch.
var<private> dWorldX: vec3f;
var<private> dWorldY: vec3f;
var<private> dUvX: vec2f;
var<private> dUvY: vec2f;

fn detailAt(p: vec2f, dx: vec2f, dy: vec2f, tile: f32, layer: i32) -> vec4f {
  return textureSampleGrad(detailTex, detailSampler, p / tile, layer, dx / tile, dy / tile);
}

fn detailXZ(world: vec3f, tile: f32, layer: i32) -> vec4f {
  return detailAt(world.xz, dWorldX.xz, dWorldY.xz, tile, layer);
}

fn detailUV(uv: vec2f, tile: f32, layer: i32) -> vec4f {
  return detailAt(uv, dUvX, dUvY, tile, layer);
}

// World-space detail projected along the dominant axis of n; returns the
// sample and writes the matching tangent frame.
fn detailTri(world: vec3f, n: vec3f, tile: f32, layer: i32, t: ptr<function, vec3f>, b: ptr<function, vec3f>) -> vec4f {
  let a = abs(n);
  if (a.y > 0.7) {
    *t = vec3f(1.0, 0.0, 0.0);
    *b = vec3f(0.0, 0.0, 1.0);
    return detailAt(world.xz, dWorldX.xz, dWorldY.xz, tile, layer);
  }
  if (a.x > a.z) {
    *t = vec3f(0.0, 0.0, 1.0);
    *b = vec3f(0.0, 1.0, 0.0);
    return detailAt(world.zy, dWorldX.zy, dWorldY.zy, tile, layer);
  }
  *t = vec3f(1.0, 0.0, 0.0);
  *b = vec3f(0.0, 1.0, 0.0);
  return detailAt(world.xy, dWorldX.xy, dWorldY.xy, tile, layer);
}

fn detailNormal(n: vec3f, t: vec3f, b: vec3f, d: vec4f, strength: f32) -> vec3f {
  let xy = (d.xy * 2.0 - 1.0) * strength;
  return normalize(n + t * xy.x + b * xy.y);
}

const M_ROAD = 0u;
const M_SIDEWALK = 1u;
const M_CURB = 2u;
const M_FACADE = 3u;
const M_ROOF = 4u;
const M_GLASS = 5u;
const M_METAL = 6u;
const M_SIGN = 7u;
const M_FOLIAGE = 8u;
const M_BARK = 9u;
const M_GRASS = 10u;
const M_LAMP = 11u;
const M_CONCRETE = 12u;
const M_RAIL = 13u;
const M_SIGNAL = 14u;
const M_FRAME = 15u;
const M_PAINT = 16u;
const M_SCREEN = 18u;
const M_TILE = 19u;
const M_WIRE = 20u;
const M_VENDING = 21u;
const M_LED = 22u;
const M_ASPHALT = 24u;
const M_LEAVES = 25u;
const M_CARPARK = 26u;

fn nightLight() -> f32 {
  return smoothstep(0.15, 0.7, frame.time.w);
}

fn wallPalette(i: u32) -> vec3f {
  return wallPaletteRaw(i) * 0.68;
}

fn wallPaletteRaw(i: u32) -> vec3f {
  switch (i % 12u) {
    case 0u: { return vec3f(0.78, 0.76, 0.72); }  // off-white tile
    case 1u: { return vec3f(0.62, 0.6, 0.57); }   // light concrete
    case 2u: { return vec3f(0.45, 0.33, 0.25); }  // brown tile
    case 3u: { return vec3f(0.3, 0.3, 0.32); }    // dark grey
    case 4u: { return vec3f(0.7, 0.66, 0.56); }   // beige
    case 5u: { return vec3f(0.55, 0.58, 0.6); }   // blue grey
    case 6u: { return vec3f(0.82, 0.8, 0.78); }   // white
    case 7u: { return vec3f(0.5, 0.42, 0.35); }   // taupe
    case 8u: { return vec3f(0.38, 0.4, 0.38); }   // green grey
    case 9u: { return vec3f(0.66, 0.52, 0.42); }  // terracotta-ish
    case 10u: { return vec3f(0.2, 0.2, 0.22); }   // charcoal
    default: { return vec3f(0.72, 0.7, 0.66); }
  }
}

fn paintColor(p: u32) -> vec3f {
  if (p == 0x90u) { return vec3f(0.45, 0.46, 0.45); }
  if (p == 0x91u) { return vec3f(0.06, 0.06, 0.06); }
  if (p == 0x92u) { return vec3f(0.8, 0.55, 0.04); }
  if (p == 0x80u) { return vec3f(0.5, 0.5, 0.5); }
  if (p >= 0xd0u && p < 0xf0u) { return vec3f(0.62, 0.62, 0.6); }
  let h = hashu(p * 2654435761u);
  let hue = hashuf(h);
  let sat = mix(0.15, 0.6, hashuf(h ^ 1u));
  let val = mix(0.25, 0.8, hashuf(h ^ 2u));
  let k = vec3f(5.0, 3.0, 1.0);
  let rgb = clamp(abs(fract(vec3f(hue) + k / 6.0) * 6.0 - 3.0) - 1.0, vec3f(0), vec3f(1));
  return val * mix(vec3f(1.0), rgb, sat);
}

// Fake room behind a window (interior mapping). Returns radiance.
fn interior(local: vec2f, size: vec2f, depth: f32, N: vec3f, T: vec3f, V: vec3f, seed: u32, office: bool, section: u32) -> vec3f {
  let rd = vec3f(dot(V, T), V.y, -dot(V, N));
  let ro = vec3f(local, 0.0);
  let inv = 1.0 / select(rd, vec3f(1e-4), abs(rd) < vec3f(1e-4));
  let tx = select(-ro.x * inv.x, (size.x - ro.x) * inv.x, rd.x > 0.0);
  let ty = select(-ro.y * inv.y, (size.y - ro.y) * inv.y, rd.y > 0.0);
  let tz = (depth - ro.z) * inv.z;
  let t = min(min(tx, ty), tz);
  let hit = ro + rd * t;
  let r0 = hashuf(seed);
  let r1 = hashuf(seed ^ 0x9e37u);
  let r2 = hashuf(seed ^ 0x5bd1u);
  let wallC = mix(vec3f(0.75, 0.72, 0.66), vec3f(0.55, 0.6, 0.62), r1);
  var c: vec3f;
  if (t == tz) {
    c = wallC * 0.9;
    // Posters / shelves on the back wall.
    if (abs(hit.x - size.x * 0.5) < size.x * 0.25 && hit.y > 1.0 && hit.y < 2.0) { c = mix(c, vec3f(r2, 0.4, 1.0 - r2) * 0.6, 0.6); }
  } else if (t == ty) {
    if (rd.y < 0.0) {
      c = select(vec3f(0.35, 0.25, 0.18), vec3f(0.4, 0.42, 0.45), office);
    } else {
      c = vec3f(0.62);
      // Ceiling light panels.
      if (office && fract(hit.z * 0.4) < 0.25 && abs(hit.x - size.x * 0.5) < 0.4) { c = vec3f(1.3); }
    }
  } else {
    c = wallC * 0.75;
  }
  // Furniture silhouette at mid depth.
  let zF = depth * mix(0.35, 0.7, r2);
  let tF = (zF - ro.z) * inv.z;
  if (tF > 0.0 && tF < t) {
    let pF = ro + rd * tF;
    let deskH = select(0.9, 0.75, office);
    if (pF.y < deskH && abs(pF.x - size.x * (0.3 + 0.4 * r0)) < size.x * 0.3) { c = select(vec3f(0.2, 0.14, 0.1), vec3f(0.25), office); }
    // A person, occasionally.
    if (r1 > 0.85 && abs(pF.x - size.x * 0.6) < 0.22 && pF.y < 1.65 - abs(pF.x - size.x * 0.6) * 0.6) { c = vec3f(0.12, 0.1, 0.1); }
  }
  // Rooms darken away from the window; at grazing angles the room collapses
  // to its average colour instead of slivers of ceiling and wall.
  c *= mix(1.0, 0.35, clamp(hit.z / depth, 0.0, 1.0));
  let avg = wallC * 0.62;
  c = mix(c, avg, smoothstep(0.4, 0.12, abs(rd.z)));
  // Blinds (offices) and curtains (homes) at the glass, lit from behind.
  let blindDrop = select(0.0, size.y * mix(0.15, 0.85, r1), hashuf(seed ^ 0x77u) < select(0.35, 0.55, office) && size.x < 3.5);
  var screen = local.y > size.y - blindDrop;
  if (!office && size.x < 3.5) {
    let cw = size.x * mix(0.1, 0.3, r2);
    screen = screen || local.x < cw || local.x > size.x - cw;
  }
  if (screen) {
    let slat = select(1.0, 0.85 + 0.15 * step(0.5, fract(local.y * 12.0)), office);
    c = select(vec3f(0.78, 0.62, 0.48), vec3f(0.8, 0.8, 0.78), office) * slat * 0.45;
  }
  // Lighting: lit rooms glow at night, everything gets some daylight.
  let night = nightLight();
  // Offices light up in sections (a few floors x part of a facade: one
  // tenant working late); homes are lit room by room in the evening.
  var lit: bool;
  if (office) {
    let sectionLit = hashuf(section ^ 0xbeefu) < mix(0.1, 0.45, night);
    lit = hashuf(seed ^ 0x1234567u) < select(0.04, 0.88, sectionLit);
  } else {
    lit = hashuf(seed ^ 0x1234567u) < mix(0.03, 0.34, night);
  }
  // Office colour temperature varies by tenant (3500-6500 K).
  let cool = mix(vec3f(1.0, 0.86, 0.66), vec3f(0.88, 0.95, 1.0), hashuf(section ^ 0x51u));
  let warm = select(vec3f(1.0, 0.72, 0.42), cool, office && r0 > 0.25);
  // Daylight in a room is dim and neutral: seen from the street a room is
  // 5-10x darker than the facade, so the glass reflection dominates.
  var light = vec3f(luminance(frame.skyAmbient.rgb)) * vec3f(1.0, 0.95, 0.88) * 0.14;
  // Dark offices still show their ceiling grid under corridor and exit
  // lighting, so towers don't read as black slabs at night.
  if (office) { light += vec3f(0.75, 0.85, 1.0) * 0.05 * night; }
  if (lit) {
    let flicker = 1.0;
    light += warm * mix(0.6, 1.2, r2) * flicker * mix(0.12, 1.0, night);
  }
  return c * light;
}

// Tangent-space light offset for facade self-shadowing: how far (in facade
// uv metres) a ray toward the light moves per metre of depth out of the wall.
// Uses the moon when the sun is down, like the shadow map. w > 0 when the
// wall faces the light (otherwise N.L already shadows it).
fn facadeLight(n: vec3f, T: vec3f) -> vec3f {
  let L = select(frame.moonDir.xyz, frame.sunDir.xyz, frame.sunDir.y > -0.02);
  let nl = dot(L, n);
  return vec3f(vec2f(dot(L, T), L.y) / max(nl, 0.08), nl);
}

// Soft-edged inside test for a cast-shadow footprint (penumbra a few cm).
fn castVis(inside: f32) -> f32 {
  return smoothstep(-0.015, 0.02, inside);
}

struct FacadeStyle {
  floorH: f32,
  bay: f32,
  winW: f32,
  winH: f32,
  wall: vec3f,
  strip: bool,
  /** 0 tile, 1 ribbon, 2 piers, 3 metal panel, 4 fair-face concrete. */
  family: u32,
};

fn facadeStyle(style: u32, kind: u32, podium: bool) -> FacadeStyle {
  let h = hashu(style * 747796405u + 1u);
  var s: FacadeStyle;
  s.floorH = select(3.3, 3.9, kind <= 1u);
  if (kind == 4u) { s.floorH = 2.9; }
  if (podium) { s.floorH = 4.6; }
  s.bay = mix(1.5, 3.2, hashuf(h ^ 0x1234u));
  if (kind == 4u) { s.bay = mix(2.2, 3.4, hashuf(h ^ 0x1234u)); }
  s.winW = mix(0.42, 0.8, hashuf(h ^ 0x22u));
  s.winH = mix(0.42, 0.66, hashuf(h ^ 0x33u));
  s.strip = hashuf(h ^ 0x44u) < select(0.28, 0.6, kind == 0u);
  if (s.strip) { s.winW = 1.0; }
  s.wall = wallPalette(hashu(h ^ 0x55u));
  let fam = hashuf(h ^ 0x66u);
  s.family = select(select(select(select(0u, 1u, fam < 0.62), 2u, fam < 0.44), 3u, fam < 0.28), 4u, fam < 0.12);
  if (s.strip) { s.family = 1u; }
  if (s.family == 2u) { s.winW = 0.62; s.winH = 0.72; }
  if (s.family == 3u) { s.wall = mix(vec3f(0.42, 0.44, 0.47), vec3f(0.25, 0.26, 0.28), hashuf(h ^ 0x77u)); s.winW = min(s.winW, 0.5); }
  if (s.family == 4u) { s.wall = vec3f(0.36, 0.355, 0.34) * mix(0.85, 1.1, hashuf(h ^ 0x88u)); }
  if (podium) { s.wall = mix(s.wall, vec3f(0.35, 0.33, 0.3), 0.5); }
  return s;
}

fn facadeMat(world: vec3f, n: vec3f, uv: vec2f, param: u32, aux: u32) -> Surf {
  var s = defaultSurf(n);
  let style = param & 0xffffu;
  let kind = (param >> 16u) & 7u;
  let shop = ((param >> 19u) & 1u) == 1u;
  let podium = ((param >> 20u) & 1u) == 1u;
  let st = facadeStyle(style, kind, podium);
  let V = normalize(world - frame.camPos.xyz);
  let T = vec3f(-n.z, 0.0, n.x);
  let sl = facadeLight(n, T);
  let sunLit = sl.z > 0.0;
  let sT = sl.xy;
  // Below the street-level ground floor (downhill sides) the window grid
  // simply continues with lower floors.
  let floorIdx = floor(uv.y / st.floorH);
  let ly = uv.y - floorIdx * st.floorH;
  let bayIdx = floor(uv.x / st.bay);
  let lx = uv.x - bayIdx * st.bay;
  let cellSeed = hashu(aux ^ hashu((u32(bayIdx + 1000.0) * 73856093u) ^ (u32(floorIdx + 1000.0) * 19349663u)));
  // Wall: glazed tile (tile and ribbon styles) or concrete render, with
  // grime streaks.
  let tiled = st.family <= 1u;
  let wd = select(detailUV(uv, 2.4, DETAIL_CONCRETE), detailUV(uv, 0.96, DETAIL_TILE), tiled);
  let streak = valueNoise(vec2f(uv.x * 3.0, uv.y * 0.15)) * 0.25;
  var wall = st.wall * (0.88 + 0.12 * valueNoise(uv * 0.7)) * (1.0 - streak * 0.5) * mix(1.0, wd.b * 2.0, select(0.6, 1.0, tiled)) * mix(0.6, 1.0, wd.a);
  // Street grime: darker, rain-splashed base of the wall.
  wall *= mix(0.7, 1.0, smoothstep(0.0, 3.0, uv.y));
  // Weathering. Rain washes dirt off window sills into streaks below each
  // window; slab edges drip too. Patch repairs vary the tone in panels.
  {
    let wx0e = (1.0 - st.winW) * 0.5 * st.bay;
    let sillE = (1.0 - st.winH) * st.floorH * 0.55;
    let below = sillE - ly;
    let inSpan = lx > wx0e - 0.05 && lx < st.bay - wx0e + 0.05;
    let drip = valueNoise(vec2f(uv.x * 9.0, floorIdx * 3.1)) * valueNoise(vec2f(uv.x * 23.0, uv.y * 0.4));
    let dirtAmt = mix(0.15, 0.55, hashuf(aux ^ 0x5151u));
    if (below > 0.0 && inSpan) {
      wall *= 1.0 - dirtAmt * drip * smoothstep(1.4, 0.0, below);
    }
    let slabDrip = valueNoise(vec2f(uv.x * 14.0, floorIdx * 7.7));
    wall *= 1.0 - dirtAmt * 0.6 * slabDrip * smoothstep(0.9, 0.18, ly) * step(0.18, ly);
    let patchC = floor(uv / vec2f(2.4, st.floorH));
    wall *= 0.95 + 0.1 * hash21(patchC + f32(aux & 255u));
  }
  s.albedo = wall;
  s.rough = 0.75;
  if (st.family == 3u) {
    // Aluminium cladding panels with dark seams.
    let pu = fract(uv.x / 1.2);
    let pv = fract(uv.y / (st.floorH * 0.5));
    let seam = min(min(pu, 1.0 - pu) * 1.2, min(pv, 1.0 - pv) * st.floorH * 0.5) < 0.012;
    s.albedo = select(wall, wall * 0.35, seam);
    s.metal = 0.75;
    s.rough = 0.38 + 0.1 * hash21(floor(uv / vec2f(1.2, st.floorH * 0.5)));
  } else if (st.family == 4u) {
    // Fair-face concrete: formwork panel lines and tie holes.
    let fu = fract(uv.x / 1.8);
    let fv = fract(uv.y / 0.9);
    let joint = min(fu, 1.0 - fu) * 1.8 < 0.01 || min(fv, 1.0 - fv) * 0.9 < 0.008;
    let tie = length((fract(uv / vec2f(0.6, 0.45)) - 0.5) * vec2f(0.6, 0.45)) < 0.015;
    s.albedo = wall * (0.9 + 0.12 * valueNoise(uv * 3.0)) * select(1.0, 0.75, joint || tie);
    s.rough = 0.85;
  } else if (st.family == 2u) {
    // Deep vertical piers between the windows (shaded by normal tilt).
    let lxp = uv.x - floor(uv.x / st.bay) * st.bay;
    let pierW = (1.0 - st.winW) * 0.5 * st.bay;
    if (lxp < pierW * 0.3 || lxp > st.bay - pierW * 0.3) {
      s.normal = normalize(n + T * select(-0.6, 0.6, lxp < pierW));
    }
  }
  // Tile relief and the floor-slab bevel.
  if (st.family != 3u) {
    s.normal = detailNormal(s.normal, T, vec3f(0.0, 1.0, 0.0), wd, select(0.5, 1.0, tiled));
    if (tiled) { s.rough = mix(0.35, 0.8, 1.0 - wd.a); }
    let lyw = uv.y - floor(uv.y / st.floorH) * st.floorH;
    if (lyw < 0.21 && lyw > 0.18) { s.normal = normalize(s.normal + vec3f(0.0, 0.9, 0.0)); }
  }
  // Floor slab line.
  if (ly < 0.18) { s.albedo = wall * 0.8; }
  // Shadow cast by the floor ledge above (projecting P metres, underside at
  // the next floor line). Works at every LOD, ledge geometry or not.
  if (sunLit) {
    let P = select(0.18, 0.40, st.family == 4u || podium);
    let sy = P * min(sT.y, 6.0);
    s.sunVis = smoothstep(sy - 0.04, sy + 0.04, st.floorH - ly);
  }

  // Ground floor shopfront.
  if (shop && abs(floorIdx) < 0.5) {
    let shutter = hashuf(cellSeed ^ 77u) < 0.12;
    let fr = min(lx, st.bay - lx);
    if (ly > 0.15 && ly < st.floorH * 0.78 && fr > 0.08) {
      if (shutter) {
        // Painted, slightly grimy corrugated steel shutter.
        s.albedo = vec3f(0.36, 0.37, 0.38) * (0.75 + 0.25 * step(0.5, fract(ly * 12.0))) * mix(1.0, 0.7, smoothstep(1.2, 0.2, ly));
        s.metal = 0.25;
        s.rough = 0.65;
        return s;
      }
      // Shop type per pair of bays: convenience store, restaurant (noren),
      // boutique, or dark office lobby.
      let shopSeed = hashu(aux ^ u32(floor(bayIdx / 2.0) + 3000.0));
      let shopType = shopSeed % 4u;
      let night = nightLight();
      let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(V, n)), 5.0);
      var inside = interior(vec2f(lx, ly), vec2f(st.bay, st.floorH), 6.0, n, T, V, cellSeed, false, 0u);
      var glow = vec3f(1.0, 0.85, 0.6) * 0.2;
      // Aluminium shopfront frame: mullions every ~1.8 m and a transom.
      let mw = st.bay / max(1.0, round(st.bay / 1.8));
      let mx = lx - floor(lx / mw) * mw;
      let tr = st.floorH * 0.62;
      if (min(mx, mw - mx) < 0.035 || abs(ly - tr) < 0.03 || ly < 0.22) {
        s.albedo = vec3f(0.5, 0.51, 0.52);
        s.metal = 0.8;
        s.rough = 0.35;
        return s;
      }
      let ndvP = max(-dot(V, n), 0.05);
      let vP = vec2f(dot(V, T), V.y) / ndvP;
      if (shopType == 2u) {
        // Boutique: garments on two rails behind the glass (parallax planes),
        // lit by warm track lights.
        for (var r = 0; r < 2; r++) {
          let depth = 1.2 + f32(r) * 1.6;
          let q = vec2f(lx, ly) + vP * depth;
          let gw = 0.09;
          let gid = floor(q.x / gw);
          let gh = hash21(vec2f(gid, f32(r) * 17.0 + f32(shopSeed % 53u)));
          let bottom = mix(0.45, 0.9, gh);
          if (q.y > bottom && q.y < 1.75 && fract(q.x / 0.9 + f32(r) * 0.37) < 0.7 && fract(q.x / gw) > 0.12) {
            let cf = smoothstep(0.015, 0.06, max(length(dWorldX), length(dWorldY)));
            let cloth = mix(mix(vec3f(0.08), 0.35 + 0.35 * cos(6.2831 * (gh * 0.7 + vec3f(0.0, 0.25, 0.55) + f32(shopSeed % 7u) * 0.1)), 0.8), vec3f(0.3, 0.28, 0.27), cf);
            inside = cloth * (1.0 - 0.3 * f32(r)) * mix(0.35, 1.0, smoothstep(bottom, bottom + 0.6, q.y)) * mix(0.45, 1.1, night);
            break;
          }
          if (abs(q.y - 1.78) < 0.02) { inside = vec3f(0.5); break; }
        }
        glow = vec3f(1.0, 0.8, 0.55) * 0.35;
      }
      if (shopType == 0u) {
        // Konbini: bright cool interior, colored band across the top.
        // Gondola shelves stocked with packaging, traced as parallax planes
        // facing the street at three depths behind the glass.
        var shelf = vec3f(0.0);
        var hitShelf = false;
        let ndvS = max(-dot(V, n), 0.05);
        let vS = vec2f(dot(V, T), V.y) / ndvS;
        for (var r = 0; r < 3; r++) {
          let depth = 1.0 + f32(r) * 1.7;
          let q = vec2f(lx, ly) + vS * depth;
          let qTop = vec2f(lx, ly) + vS * (depth + 0.45);
          if (q.y > 0.15 && q.y < 1.65) {
            // Front face: product rows every 0.38 m with white shelf lips.
            let row = floor((q.y - 0.15) / 0.38);
            let fy = fract((q.y - 0.15) / 0.38);
            let pw = mix(0.08, 0.16, hash21(vec2f(row, f32(r) + f32(shopSeed % 31u))));
            let pid = floor(q.x / pw);
            let ph = hash21(vec2f(pid, row * 7.0 + f32(r) * 13.0 + f32(shopSeed % 97u)));
            // Products shrink below a pixel at a distance: fade to the
            // average shelf tone instead of shimmering pastel stripes.
            let pf = smoothstep(0.015, 0.06, max(length(dWorldX), length(dWorldY)));
            let pack = mix(mix(vec3f(0.85, 0.82, 0.75), 0.5 + 0.5 * cos(6.2831 * (ph + vec3f(0.0, 0.33, 0.67))), 0.75), vec3f(0.5, 0.48, 0.45), pf);
            let gapX = fract(q.x / pw) < 0.08;
            let fill = fy > 0.1 && fy < 0.1 + mix(0.55, 0.85, ph) && !gapX;
            shelf = select(vec3f(0.12), pack, fill);
            if (fy < 0.1) { shelf = vec3f(0.92); }
            // Darker toward the aisle ends.
            shelf *= 1.0 - 0.25 * f32(r);
            hitShelf = true;
            break;
          }
          if (q.y >= 1.65 && qTop.y < 1.65) {
            shelf = vec3f(0.6) * (1.0 - 0.25 * f32(r));
            hitShelf = true;
            break;
          }
        }
        if (!hitShelf) { shelf = inside * 2.0; }
        inside = inside * 0.3 + shelf * vec3f(1.05, 1.1, 1.15) * mix(0.2, 0.85, night);
        if (ly > st.floorH * 0.66) {
          let bandC = array<vec3f, 3>(vec3f(0.1, 0.5, 0.25), vec3f(0.9, 0.3, 0.05), vec3f(0.1, 0.3, 0.8))[shopSeed % 3u];
          s.albedo = bandC;
          s.rough = 0.3;
          s.emissive = bandC * mix(0.8, 4.0, night);
          return s;
        }
      } else if (shopType == 1u) {
        // Restaurant: warm light, a wooden counter with diners' backs, pendant
        // lamps, and a noren curtain over the top of the door.
        inside *= 1.4;
        glow = vec3f(1.0, 0.6, 0.3) * 0.5;
        let qc = vec2f(lx, ly) + vP * 2.2;
        if (qc.y < 1.0) {
          inside = vec3f(0.32, 0.18, 0.09) * (0.8 + 0.2 * step(0.5, fract(qc.x * 3.0))) * mix(0.5, 1.4, night);
          if (qc.y > 0.95) { inside = vec3f(0.55, 0.38, 0.22) * mix(0.6, 1.6, night); }
        }
        let qd = vec2f(lx, ly) + vP * 1.4;
        let sx = fract(qd.x / 0.75) - 0.5;
        if (hash21(vec2f(floor(qd.x / 0.75), f32(shopSeed % 41u))) > 0.45 && qd.y < 1.35 - abs(sx) * 0.5 && abs(sx) < 0.17 && qd.y > 0.45) {
          inside = vec3f(0.06, 0.05, 0.05);
        }
        let ql = vec2f(lx, ly) + vP * 1.8;
        let lp = vec2f(fract(ql.x / 1.2) - 0.5, ql.y - 2.15);
        if (length(lp * vec2f(1.0, 1.6)) < 0.14) { inside = vec3f(1.0, 0.7, 0.4) * mix(1.5, 5.0, night); }
        if (ly > st.floorH * 0.5 && ly < st.floorH * 0.7 && fract(lx * 2.2) > 0.06) {
          let norenC = array<vec3f, 3>(vec3f(0.08, 0.1, 0.25), vec3f(0.5, 0.08, 0.06), vec3f(0.85, 0.8, 0.7))[shopSeed % 3u];
          s.albedo = norenC;
          s.rough = 0.9;
          s.emissive = norenC * 0.4 * night;
          return s;
        }
      } else if (shopType == 3u) {
        inside *= 0.3;
        glow = vec3f(0.0);
      }
      s.albedo = vec3f(0.02);
      s.rough = 0.04;
      s.emissive = inside * 1.2 * (1.0 - fres) + glow * mix(0.3, 1.0, night);
      s.cls = CLASS_GLASS;
      return s;
    }
    s.albedo = vec3f(0.12);
    s.metal = 0.5;
    return s;
  }

  // Windows.
  let wx0 = (1.0 - st.winW) * 0.5 * st.bay;
  let wx1 = st.bay - wx0;
  let sill = (1.0 - st.winH) * st.floorH * 0.55;
  let wy1 = sill + st.winH * st.floorH;
  if (lx >= wx0 && lx <= wx1 && ly >= sill && ly <= wy1) {
    // Window reveal parallax: the glass sits D behind the wall plane (deeper
    // between piers).
    let D = select(0.30, 0.45, st.family == 2u);
    let ndv = max(-dot(V, n), 0.05);
    let vT = vec2f(dot(V, T), V.y) / ndv;
    let g = vec2f(lx, ly) + vT * D;
    if (g.x < wx0 || g.x > wx1 || g.y < sill || g.y > wy1) {
      s.albedo = wall * 0.8;
      s.rough = 0.8;
      s.ao = 0.55;
      if (g.y < sill) { s.normal = vec3f(0.0, 1.0, 0.0); }
      else if (g.y > wy1) { s.normal = vec3f(0.0, -1.0, 0.0); }
      else if (g.x < wx0) { s.normal = T; }
      else { s.normal = -T; }
      if (sunLit) {
        // Depth z where the view ray meets the reveal, then march to the
        // light: lit only if the ray leaves through the opening. The face's
        // own edge is N.L's job, so only the opposite edges cast.
        let tx = select((wx0 - lx) / min(vT.x, -1e-4), (wx1 - lx) / max(vT.x, 1e-4), vT.x > 0.0);
        let ty = select((sill - ly) / min(vT.y, -1e-4), (wy1 - ly) / max(vT.y, 1e-4), vT.y > 0.0);
        let z = clamp(min(tx, ty), 0.0, D);
        let e = vec2f(lx, ly) + vT * z + sT * z;
        var ix = min(e.x - wx0, wx1 - e.x);
        var iy = min(e.y - sill, wy1 - e.y);
        if (tx < ty) { ix = select(e.x - wx0, wx1 - e.x, vT.x < 0.0); }
        else { iy = select(e.y - sill, wy1 - e.y, vT.y < 0.0); }
        s.sunVis = min(s.sunVis, castVis(min(ix, iy)));
      }
      return s;
    }
    let lxg = g.x;
    let lyg = g.y;
    // Lintel and side-reveal shadows on the recessed glass and frame.
    if (sunLit) {
      let e = g + sT * D;
      s.sunVis = min(s.sunVis, castVis(min(min(e.x - wx0, wx1 - e.x), min(e.y - sill, wy1 - e.y))));
    }
    let fx = min(lxg - wx0, wx1 - lxg);
    let fy = min(lyg - sill, wy1 - lyg);
    let mull = st.strip && abs(fract(uv.x / 1.6) - 0.5) > 0.47;
    if (fx < 0.07 || fy < 0.07 || mull) {
      s.albedo = vec3f(0.08, 0.08, 0.09);
      s.metal = 0.7;
      s.rough = 0.35;
      return s;
    }
    // Each pane sits slightly out of plane, so neighbours reflect different
    // sky and city. Glass gets no wall tile relief.
    let wob = (hash22(vec2f(bayIdx, floorIdx) + f32(aux & 1023u)) - 0.5) * 0.035;
    s.normal = normalize(n + T * wob.x + vec3f(0.0, wob.y, 0.0));
    let office = kind <= 2u && !(kind == 2u && hashuf(style) < 0.4);
    let roomSize = vec2f(wx1 - wx0, wy1 - sill);
    let section = hashu(aux ^ (u32(floor(floorIdx / 3.0) + 500.0) * 7919u) ^ (u32(floor(uv.x / 18.0)) * 104729u));
    var inside = interior(vec2f(lxg - wx0, lyg - sill), roomSize, mix(3.5, 7.0, hashuf(cellSeed)), n, T, V, cellSeed, office, section);
    // Curtains / blinds.
    let blinds = hashuf(cellSeed ^ 0xabcu);
    let cover = select(0.0, mix(0.2, 1.0, hashuf(cellSeed ^ 0xdefu)), blinds < 0.35);
    if ((lyg - sill) / roomSize.y > 1.0 - cover) {
      let lit = luminance(inside) > 0.4;
      inside = vec3f(0.8, 0.75, 0.65) * select(frame.skyAmbient.rgb * 0.3, vec3f(1.2, 0.95, 0.7), lit) * (0.85 + 0.15 * step(0.5, fract(lyg * 30.0)));
    }
    let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(V, n)), 5.0);
    s.albedo = vec3f(0.03, 0.035, 0.04);
    s.rough = 0.05;
    s.emissive = inside * (1.0 - fres);
    s.ao = mix(0.55, 1.0, smoothstep(0.0, 0.15, min(fx, fy)));
    s.cls = CLASS_GLASS;
    return s;
  }
  // Window sill shadow / AC units under some windows.
  if (ly < sill && ly > sill - 0.1 && lx > wx0 && lx < wx1) { s.albedo = wall * 0.6; }
  // Deep piers shadow the recessed spandrels between them.
  if (st.family == 2u && sunLit && lx > wx0 && lx < wx1) {
    let ex = lx + sT.x * 0.45;
    s.sunVis = min(s.sunVis, castVis(min(ex - wx0, wx1 - ex)));
  }
  return s;
}

fn curtainWall(world: vec3f, n: vec3f, uv: vec2f, param: u32, aux: u32) -> Surf {
  var s = defaultSurf(n);
  let style = param & 0xffffu;
  let h = hashu(style * 2246822519u + 7u);
  let tints = array<vec3f, 5>(vec3f(0.25, 0.42, 0.45), vec3f(0.5, 0.55, 0.6), vec3f(0.42, 0.33, 0.22), vec3f(0.16, 0.24, 0.4), vec3f(0.3, 0.45, 0.35));
  let tint = tints[hashu(h) % 5u];
  let floorH = 3.9;
  let bay = mix(1.2, 1.8, hashuf(h ^ 3u));
  let V = normalize(world - frame.camPos.xyz);
  let T = vec3f(-n.z, 0.0, n.x);
  let floorIdx = floor(uv.y / floorH);
  let ly = uv.y - floorIdx * floorH;
  let bayIdx = floor(uv.x / bay);
  let lx = uv.x - bayIdx * bay;
  let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(V, n)), 5.0);
  // Mullions, a slim transom at each slab and one at the spandrel head.
  if (lx < 0.06 || lx > bay - 0.06 || ly < 0.05 || abs(ly - 0.95) < 0.025) {
    s.albedo = vec3f(0.45, 0.47, 0.5);
    s.metal = 0.9;
    s.rough = 0.3;
    return s;
  }
  // Mullions and transoms project Dm: thin shadows on the glass beside each
  // mullion and under each transom.
  let sl = facadeLight(n, T);
  if (sl.z > 0.0) {
    let Dm = 0.12;
    let ex = lx + sl.x * Dm;
    let ix = min(ex - 0.06, bay - 0.06 - ex);
    let transom = select(floorH, 0.925, ly < 0.95);
    let iy = transom - (ly + min(sl.y, 6.0) * Dm);
    s.sunVis = castVis(min(ix, iy));
  }
  // Each pane is slightly misaligned for realistic broken reflections.
  let wob = (hashuf(hashu(u32(bayIdx + 5000.0)) ^ u32(floorIdx)) - 0.5) * 0.04;
  s.normal = normalize(n + T * wob + vec3f(0.0, wob * 0.5, 0.0));
  if (ly < 0.95) {
    s.albedo = tint * 0.25;
    s.rough = 0.08;
    s.metal = 0.0;
    s.cls = CLASS_GLASS;
    return s;
  }
  let seed = hashu(aux ^ hashu((u32(bayIdx + 1000.0) * 73856093u) ^ (u32(floorIdx + 1000.0) * 19349663u)));
  // Offices: rooms span four bays.
  let roomW = bay * 4.0;
  let rx = uv.x - floor(uv.x / roomW) * roomW;
  let roomSeed = hashu(aux ^ hashu((u32(floor(uv.x / roomW) + 2000.0) * 83492791u) ^ (u32(floorIdx) * 2971215073u)));
  let section = hashu(aux ^ (u32(floor(floorIdx / 3.0) + 500.0) * 7919u) ^ (u32(floor(uv.x / 24.0)) * 104729u));
  let inside = interior(vec2f(rx, ly - 0.95), vec2f(roomW, floorH - 0.95), 9.0, n, T, V, roomSeed, true, section);
  s.albedo = tint * 0.18;
  s.rough = 0.04;
  s.emissive = inside * (1.0 - fres) * 0.8 * (1.0 - 0.6 * tint.b);
  s.cls = CLASS_GLASS;
  _ = seed;
  return s;
}

fn roadMat(world: vec3f, n: vec3f, uv: vec2f, param: u32, lanes: u32) -> Surf {
  var s = defaultSurf(n);
  // Aggregate texture at two scales (the second rotated) so it never tiles
  // visibly; large-scale tone drift stays subtle.
  let d1 = detailXZ(world, 1.1, DETAIL_ASPHALT);
  let rot = mat2x2f(0.8, -0.6, 0.6, 0.8);
  let d2 = detailAt(rot * world.xz, rot * dWorldX.xz, rot * dWorldY.xz, 2.9, DETAIL_ASPHALT);
  let dd = mix(d1, d2, 0.4);
  let drift = valueNoise(world.xz * 0.05) * 0.6 + valueNoise(world.xz * 0.4) * 0.4;
  s.albedo = vec3f(0.14, 0.137, 0.133) * (0.88 + 0.24 * drift) * (dd.b * 2.0) * mix(0.55, 1.0, dd.a);
  s.rough = 0.86 + (1.0 - dd.a) * 0.1 - (dd.b - 0.5) * 0.15;
  s.cls = CLASS_GROUND;
  let foot = max(length(dWorldX), length(dWorldY));
  // Utility-cut patches: newer, darker asphalt with a crisp seam.
  let pc = floor(world.xz / 9.0);
  let ph = hash21(pc);
  let pf = fract(world.xz / 9.0);
  let pLo = vec2f(0.15);
  let pHi = vec2f(0.15 + ph * 0.7);
  if (ph > 0.8 && all(pf > pLo) && all(pf < pHi)) {
    let e = min(min(pf.x - pLo.x, pHi.x - pf.x), min(pf.y - pLo.y, pHi.y - pf.y)) * 9.0;
    // The dark seam fades out once it is thinner than a pixel.
    let seam = (1.0 - step(0.05, e)) * clamp(0.05 / max(foot, 1e-4), 0.0, 1.0);
    s.albedo *= mix(0.78, 0.45, seam);
    s.rough -= 0.06;
  }
  // Sealed cracks: thin glossy tar lines.
  // The line keeps its width in noise units; once a pixel covers more than
  // that, it widens to the pixel but fades so coverage is conserved (never
  // a thick black web in the distance).
  // Domain-warped so the line wanders jaggedly like a real crack.
  let cw = vec2f(valueNoise(world.xz * 2.3), valueNoise(world.xz * 2.3 + 17.0)) - 0.5;
  let crack = abs(valueNoise(world.xz * 0.45 + 3.0 + cw * 0.35) - 0.5);
  let crackW = 0.006;
  let fw = max(crackW, foot * 0.45);
  let tar = (1.0 - smoothstep(fw * 0.5, fw * 1.5, crack)) * (crackW / fw)
    * smoothstep(0.55, 0.7, valueNoise(world.xz * 0.09));
  s.albedo = mix(s.albedo, vec3f(0.03), tar * 0.8);
  s.rough = mix(s.rough, 0.4, tar);
  let oil = smoothstep(0.78, 0.92, valueNoise(world.xz * 0.6)) * valueNoise(world.xz * 3.0);
  s.albedo *= 1.0 - oil * 0.3;
  s.rough -= oil * 0.25;
  let kind = param & 3u;
  let crossStart = (param & 4u) != 0u;
  let crossEnd = (param & 8u) != 0u;
  let len = f32(param >> 4u);
  let widths = array<f32, 4>(7.0, 10.0, 16.0, 24.0);
  let w = widths[kind];
  let x = uv.x;
  let ax = abs(x);
  let along = uv.y;
  var mark = 0.0;
  var yellow = false;
  // Edge lines.
  if (kind >= 1u && ax > w * 0.5 - 0.45 && ax < w * 0.5 - 0.3) { mark = 1.0; }
  // Center line.
  if (kind == 1u && ax < 0.075 && fract(along / 10.0) < 0.5) { mark = 1.0; }
  if (kind >= 2u && ax > 0.08 && ax < 0.23) { mark = 1.0; yellow = true; }
  // Lane dividers.
  if (kind >= 2u) {
    let perDir = f32(lanes) * 0.5;
    let laneW = (w * 0.5 - 0.5) / perDir;
    for (var k = 1.0; k < perDir; k += 1.0) {
      if (abs(ax - laneW * k) < 0.075 && fract(along / 12.0) < 0.42) { mark = 1.0; }
    }
  }
  // Crosswalks and stop lines near junctions.
  let fromEnd = len - along;
  if ((crossStart && along < 4.5 && along > 0.6) || (crossEnd && fromEnd < 4.5 && fromEnd > 0.6)) {
    if (fract(x / 0.9) < 0.5 && ax < w * 0.5 - 0.2) { mark = 1.0; yellow = false; }
  }
  if ((crossStart && along > 5.2 && along < 5.6 && x > 0.0) || (crossEnd && fromEnd > 5.2 && fromEnd < 5.6 && x < 0.0)) { mark = 1.0; yellow = false; }
  // Lane arrows approximated by a short bar before the stop line.
  if (mark > 0.0) {
    // Thermoplastic paint: bright, worn through where tyres run and where
    // the aggregate pokes through.
    let wear = smoothstep(0.25, 0.75, valueNoise(world.xz * 3.0)) * 0.5 + (1.0 - dd.a) * 0.6;
    let c = select(vec3f(0.78, 0.78, 0.76), vec3f(0.7, 0.48, 0.08), yellow);
    s.albedo = mix(c, s.albedo, clamp(wear * 0.55, 0.0, 0.8));
    s.rough = 0.62;
  }
  // Manhole covers along the lane centers.
  if (kind >= 1u) {
    let laneW2 = 3.3;
    let lc = (fract(ax / laneW2) - 0.5) * laneW2;
    let mh = vec2f(lc, fract(along / 37.0) * 37.0 - 18.5);
    if (length(mh) < 0.32) {
      s.albedo = vec3f(0.09, 0.09, 0.09) * (0.8 + 0.4 * step(0.5, fract((mh.x + mh.y) * 9.0)));
      s.metal = 0.7;
      s.rough = 0.45;
    }
  }
  // Tyre tracks: slightly polished, darker wheel paths.
  if (kind >= 1u) {
    let laneCenter = fract(ax / 3.3) - 0.5;
    let track = exp(-pow((abs(laneCenter) - 0.27) * 9.0, 2.0));
    s.rough -= 0.1 * track;
    s.albedo *= 1.0 - 0.18 * track;
  }
  s.normal = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), dd, 1.0);
  applyWetness(&s, world, 1.0, 0.6);
  return s;
}

fn sidewalkMat(world: vec3f, n: vec3f) -> Surf {
  var s = defaultSurf(n);
  let d = detailXZ(world, 1.2, DETAIL_PAVERS);
  // Each stretch of sidewalk gets one of a few paver colours.
  let zone = hash21(floor(world.xz / 60.0));
  let base = select(select(vec3f(0.42, 0.41, 0.39), vec3f(0.46, 0.4, 0.34), zone < 0.55), vec3f(0.36, 0.3, 0.28), zone < 0.2);
  s.albedo = base * (d.b * 2.0) * mix(0.45, 1.0, d.a) * (0.9 + 0.2 * valueNoise(world.xz * 0.3));
  // Foot-traffic grime.
  s.albedo *= 1.0 - 0.15 * smoothstep(0.5, 0.8, valueNoise(world.xz * 0.15 + 9.0));
  s.rough = 0.8 + (1.0 - d.a) * 0.15;
  s.cls = CLASS_GROUND;
  s.normal = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), d, 1.0);
  applyWetness(&s, world, n.y, 0.7);
  return s;
}

// Coverage of a painted line of width w at distance d from its centre, for a
// pixel footprint `foot`: antialiased up close, fading (coverage conserved)
// once the line is thinner than a pixel.
fn paintLine(d: f32, w: f32, foot: f32) -> f32 {
  let fw = max(w, foot);
  return (1.0 - smoothstep(fw * 0.5 - foot * 0.5, fw * 0.5 + foot * 0.5, d)) * (w / fw);
}

// Flat roofs, in the roof's own frame (uv from cap(): metres along the
// footprint axes). Membrane sheets 1 x 10 m with lap seams, pressed-concrete
// panels with sealed joints, or ballast; plus drains every ~18 m ringed by
// dirt stains. This gives a 100 m roof a readable scale from the air.
fn roofMat(world: vec3f, n: vec3f, uv: vec2f, param: u32) -> Surf {
  var s = defaultSurf(n);
  let h = hashu(param * 31u + 5u);
  let g = hashuf(h) < 0.12;
  let membrane = hashuf(h ^ 3u) < 0.4;
  let panels = !membrane && hashuf(h ^ 77u) < 0.5;
  let foot = max(max(length(dUvX), length(dUvY)), 1e-4);
  // Fine pattern fades to its mean once a pixel covers more than ~1 m.
  let fine = 1.0 - smoothstep(0.6, 1.6, foot);
  let gravel = 0.85 + 0.15 * hash21(floor(world.xz * 20.0));
  let stain = 1.0 - 0.3 * smoothstep(0.55, 0.8, fbm2(world.xz * 0.15));
  var base = select(mix(vec3f(0.30, 0.29, 0.27), vec3f(0.22, 0.25, 0.27), hashuf(h ^ 21u)), vec3f(0.16, 0.25, 0.1), g);
  var pattern = gravel * (0.85 + 0.3 * valueNoise(uv * 0.25));
  if (membrane) {
    // Light grey sheet, the green urethane coat common on Tokyo roofs, or a
    // darker aged membrane.
    let k = hashuf(h ^ 41u);
    base = select(select(vec3f(0.34, 0.35, 0.34), vec3f(0.2, 0.27, 0.22), k < 0.45), vec3f(0.24, 0.24, 0.25), k > 0.8);
    let col = floor(uv.x);
    let sheet = vec2f(col, floor(uv.y / 10.0 + hash21(vec2f(col, 3.1))));
    let lap = abs(fract(uv.x + 0.5) - 0.5);
    let end = abs(fract(uv.y / 10.0 + hash21(vec2f(col, 3.1)) + 0.5) - 0.5) * 10.0;
    pattern = mix(1.0, 0.92 + 0.16 * hash21(sheet), fine);
    pattern *= 1.0 - 0.25 * max(paintLine(lap, 0.02, foot), paintLine(end, 0.02, foot));
  } else if (panels && !g) {
    // Pressed concrete in 3 m panels with dark sealant joints.
    let cell = floor(uv / 3.0);
    let j = abs(fract(uv / 3.0 + 0.5) - 0.5) * 3.0;
    pattern = mix(1.0, 0.93 + 0.14 * hash21(cell + 17.0), fine) * (0.95 + 0.1 * valueNoise(uv * 0.7));
    pattern *= 1.0 - 0.45 * max(paintLine(j.x, 0.03, foot), paintLine(j.y, 0.03, foot));
    base = mix(base, vec3f(0.36, 0.35, 0.33), 0.5);
  }
  // Repair patches: newer, darker rectangles of membrane or screed on a
  // 12 m grid, the biggest scale cue on a plain roof.
  let pc = floor(uv / 12.0);
  let ph = hash22(pc + f32(h & 1023u));
  let pf = fract(uv / 12.0);
  let pLo = 0.1 + ph * 0.3;
  let pHi = pLo + 0.25 + hash22(pc + 7.0) * 0.3;
  if (hash21(pc + 3.3 + f32(h & 255u)) < 0.3 && all(pf > pLo) && all(pf < pHi)) {
    let e = min(min(pf.x - pLo.x, pHi.x - pf.x), min(pf.y - pLo.y, pHi.y - pf.y)) * 12.0;
    pattern *= mix(0.76, 0.62, paintLine(e, 0.08, foot) * 0.5) * (0.95 + 0.1 * hash21(pc));
  }
  let rd = detailXZ(world, 2.0, select(DETAIL_BALLAST, DETAIL_CONCRETE, membrane || panels));
  s.albedo = base * pattern * stain * (rd.b * 2.0) * mix(0.6, 1.0, rd.a);
  s.normal = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), rd, 0.6);
  s.albedo *= mix(0.75, 1.1, hashuf(h ^ 9u));
  // Drains on a jittered 18 m grid, with an irregular ring of dirt where
  // water ponds and dries.
  let dc = floor(uv / 18.0);
  let dp = (dc + 0.3 + 0.4 * hash22(dc + f32(h & 255u))) * 18.0;
  let dr = length(uv - dp);
  let ringR = 4.2 * (0.7 + 0.6 * valueNoise(uv * 0.45 + f32(h & 63u)));
  let dirt = 1.0 - smoothstep(0.3, ringR, dr);
  s.albedo *= 1.0 - 0.4 * dirt - 0.1 * frame.weather.z * dirt;
  s.albedo *= 1.0 + 0.08 * paintLine(abs(dr - ringR * 0.8), 0.25, foot);
  if (dr < 0.2) {
    s.albedo = vec3f(0.05);
    s.metal = 0.6;
  }
  s.rough = 0.9;
  applyWetness(&s, world, 0.0, 0.4);
  return s;
}

// Surface car park: asphalt with 2.5 x 5 m stalls in back-to-back rows along
// uv.x (16 m period: row, 6 m aisle, row), oil drips mid-stall.
fn carParkMat(world: vec3f, n: vec3f, uv: vec2f) -> Surf {
  var s = roadMat(world, n, vec2f(100.0, 0.0), 0u, 0u);
  let foot = max(max(length(dUvX), length(dUvY)), 1e-4);
  let pv = uv.y - floor(uv.y / 16.0) * 16.0;
  let inRow = pv < 5.0 || pv > 11.0;
  let du = abs(fract(uv.x / 2.5 + 0.5) - 0.5) * 2.5;
  var mark = paintLine(min(pv, 16.0 - pv), 0.1, foot);
  if (inRow) {
    mark = max(mark, paintLine(du, 0.1, foot));
    let rowC = select(13.5, 2.5, pv < 5.0);
    let d = vec2f((fract(uv.x / 2.5) - 0.5) * 2.5, (pv - rowC) * 0.7);
    let oil = (1.0 - smoothstep(0.15, 0.85, length(d))) * hash21(floor(vec2f(uv.x / 2.5, uv.y / 8.0)));
    s.albedo *= 1.0 - 0.35 * oil;
  }
  let wear = smoothstep(0.3, 0.8, valueNoise(world.xz * 2.5)) * 0.5;
  s.albedo = mix(s.albedo, vec3f(0.5), mark * (1.0 - wear));
  s.rough = mix(s.rough, 0.6, mark);
  return s;
}

fn signMat(n: vec3f, uv: vec2f, param: u32) -> Surf {
  var s = defaultSurf(n);
  let id = param & 0xffu;
  var rect: vec4f;
  if (id < 32u) {
    rect = vec4f(f32(id % 16u) * 128.0, f32(id / 16u) * 512.0, 128.0, 512.0);
  } else if (id < 48u) {
    let k = id - 32u;
    rect = vec4f(f32(k % 4u) * 512.0, 1024.0 + f32(k / 4u) * 128.0, 512.0, 128.0);
  } else {
    let k = (id - 48u) % 8u;
    rect = vec4f(f32(k % 4u) * 512.0, 1536.0 + f32(k / 4u) * 256.0, 512.0, 256.0);
  }
  let f = fract(uv);
  let px = rect.xy + vec2f(mix(2.0, rect.z - 2.0, f.x), mix(2.0, rect.w - 2.0, f.y));
  let c = textureSampleLevel(signAtlas, linearSampler, px / 2048.0, 0.0).rgb;
  s.albedo = c * 0.6;
  s.rough = 0.3;
  s.emissive = c * c * 1.2 * mix(0.25, 4.5, nightLight());
  return s;
}

fn screenMat(n: vec3f, uv: vec2f, param: u32) -> Surf {
  var s = defaultSurf(n);
  let t = frame.time.x * 0.2 + f32(param & 0xffu) * 0.37;
  let scene = floor(t);
  let k = fract(t);
  let seed = hashu(u32(scene) * 7919u + param);
  let kind = seed % 4u;
  let c1 = 0.5 + 0.5 * cos(6.2831 * (vec3f(0.0, 0.33, 0.67) + hashuf(seed)));
  let c2 = 0.5 + 0.5 * cos(6.2831 * (vec3f(0.0, 0.33, 0.67) + hashuf(seed ^ 9u)));
  var c = mix(c1, c2, uv.y);
  switch (kind) {
    case 0u: {
      // Product shot: a glowing disc that slowly drifts.
      let p = uv - vec2f(0.3 + 0.1 * sin(t * 3.0), 0.5);
      c = mix(c * 0.25, vec3f(1.0), smoothstep(0.22, 0.18, length(p * vec2f(1.8, 1.0))));
      // Headline blocks on the right.
      if (uv.x > 0.55 && uv.x < 0.92 && fract(uv.y * 4.0) < 0.45 && uv.y > 0.2 && uv.y < 0.8) { c = vec3f(1.0); }
    }
    case 1u: {
      // Scrolling ticker band.
      let band = step(0.62, uv.y) * step(uv.y, 0.8);
      let glyph = step(0.5, hash21(vec2f(floor(uv.x * 24.0 + t * 30.0), floor(uv.y * 30.0))));
      c = mix(c * 0.4, vec3f(1.0, 0.9, 0.3) * glyph, band);
    }
    case 2u: {
      // Big brand wordmark: chunky glyph grid.
      let g = vec2f(floor(uv.x * 10.0), floor(uv.y * 4.0));
      let on = step(0.45, hash21(g + f32(seed % 97u))) * step(0.25, uv.y) * step(uv.y, 0.75) * step(0.08, uv.x) * step(uv.x, 0.92);
      c = mix(c, vec3f(1.0), on);
    }
    default: {
      // Swirl.
      let a = atan2(uv.y - 0.5, uv.x - 0.5) + t * 2.0 + length(uv - 0.5) * 8.0;
      c = mix(c1, c2, 0.5 + 0.5 * sin(a * 3.0));
    }
  }
  // Scene transitions and pixel grid.
  c *= smoothstep(0.0, 0.06, k) * smoothstep(1.0, 0.94, k);
  let pix = fract(uv * vec2f(160.0, 90.0));
  c *= 0.75 + 0.25 * step(0.2, pix.x) * step(0.2, pix.y);
  s.albedo = vec3f(0.02);
  s.rough = 0.2;
  s.emissive = c * mix(1.2, 2.6, nightLight());
  return s;
}

fn cityMaterial(world: vec3f, nIn: vec3f, uv: vec2f, matWord: u32, aux: u32) -> Surf {
  let id = matWord & 0xffu;
  let param = matWord >> 8u;
  let n = normalize(nIn);
  var s = defaultSurf(n);
  let night = nightLight();
  switch (id) {
    case M_ROAD: { s = roadMat(world, n, uv, param, aux); }
    case M_ASPHALT: { s = roadMat(world, n, vec2f(100.0, 0.0), 0u, 0u); }
    case M_SIDEWALK: { s = sidewalkMat(world, n); }
    case M_CURB: {
      var t: vec3f;
      var b: vec3f;
      let d = detailTri(world, n, 1.5, DETAIL_CONCRETE, &t, &b);
      s.albedo = vec3f(0.55, 0.54, 0.52) * (0.85 + 0.15 * valueNoise(world.xz * 2.0)) * (d.b * 2.0) * mix(0.6, 1.0, d.a);
      // Granite-like curb blocks every metre.
      let blk = fract((world.x + world.z) * 1.0);
      if (min(blk, 1.0 - blk) < 0.01) { s.albedo *= 0.6; }
      s.normal = detailNormal(n, t, b, d, 0.8);
      s.rough = 0.8;
      applyWetness(&s, world, max(n.y, 0.0), 0.5);
    }
    case M_FACADE: { s = facadeMat(world, n, uv, param, aux); }
    case M_GLASS: { s = curtainWall(world, n, uv, param, aux); }
    case M_ROOF: { s = roofMat(world, n, uv, param); }
    case M_CARPARK: { s = carParkMat(world, n, uv); }
    case M_METAL: { s.albedo = vec3f(0.42, 0.43, 0.45); s.metal = 0.8; s.rough = 0.45; }
    case M_SIGN: { s = signMat(n, uv, param); }
    case M_FOLIAGE: {
      let h = hashuf(aux);
      s.albedo = mix(vec3f(0.08, 0.16, 0.04), vec3f(0.16, 0.24, 0.06), h) * (0.7 + 0.5 * valueNoise(world.xz * 2.0 + world.y));
      s.rough = 0.85;
      // The inner crown core sits in the shade of the leaf cards around it.
      s.ao = clamp(0.3 + 0.3 * n.y, 0.0, 1.0);
      s.albedo *= 0.6;
      s.cls = CLASS_FOLIAGE;
    }
    case M_LEAVES: {
      let l = textureSampleLevel(leafTex, linearSampler, uv, 0.0);
      let h = hashuf(aux);
      let tint = mix(vec3f(0.07, 0.15, 0.035), vec3f(0.17, 0.24, 0.06), h);
      s.albedo = tint * (0.6 + 0.8 * l.r);
      s.rough = 0.8;
      s.ao = clamp(0.5 + 0.5 * n.y, 0.3, 1.0);
      s.cls = CLASS_FOLIAGE;
    }
    case M_BARK: { s.albedo = vec3f(0.16, 0.11, 0.08); s.rough = 0.95; }
    case M_GRASS: {
      s.albedo = mix(vec3f(0.1, 0.17, 0.045), vec3f(0.17, 0.22, 0.07), fbm2(world.xz * 0.2)) * 0.85;
      s.albedo *= 0.8 + 0.2 * valueNoise(world.xz * 3.0) + 0.1 * (hash21(floor(world.xz * 12.0)) - 0.5);
      // Worn, drier patches.
      s.albedo = mix(s.albedo, vec3f(0.2, 0.18, 0.11), smoothstep(0.62, 0.8, fbm2(world.xz * 0.05 + 7.0)) * 0.6);
      s.rough = 0.95;
      // Gravel paths through parks.
      let path = abs(sin(world.x * 0.05 + sin(world.z * 0.04) * 2.0));
      if (path < 0.05) { s.albedo = vec3f(0.42, 0.38, 0.32); }
      s.albedo *= 1.0 - frame.weather.z * 0.35;
      s.rough = max(s.rough - frame.weather.z * 0.2, 0.6);
    }
    case M_LAMP: {
      let sodium = param == 0u;
      let col = select(vec3f(0.9, 0.95, 1.0), vec3f(1.0, 0.6, 0.25), sodium);
      s.albedo = vec3f(0.8);
      s.rough = 0.2;
      s.emissive = col * night * 40.0 * select(0.0, 1.0, n.y < -0.5) + col * night * 4.0;
      if (param == 2u) {
        // Aviation obstruction light: slow red blink.
        let blink = step(0.55, fract(frame.time.x * 0.6 + hash21(floor(world.xz))));
        s.albedo = vec3f(0.5, 0.05, 0.05);
        s.emissive = vec3f(1.0, 0.05, 0.02) * blink * mix(3.0, 30.0, night);
      }
    }
    case M_CONCRETE: {
      var t: vec3f;
      var b: vec3f;
      let d = detailTri(world, n, 2.0, DETAIL_CONCRETE, &t, &b);
      s.normal = detailNormal(n, t, b, d, 0.8);
      s.albedo = vec3f(0.5, 0.49, 0.46) * (0.75 + 0.25 * fbm2(world.xz * 0.3 + world.y * 0.2)) * (d.b * 2.0) * mix(0.6, 1.0, d.a);
      // Formwork joints, water stains and darker undersides.
      let fw = fract((world.x + world.z) / 1.8);
      let fv = fract(world.y / 0.9);
      if (min(fw, 1.0 - fw) < 0.006 || min(fv, 1.0 - fv) < 0.01) { s.albedo *= 0.8; }
      s.albedo *= 1.0 - 0.25 * smoothstep(0.55, 0.8, valueNoise(vec2f((world.x + world.z) * 0.4, world.y * 0.08)));
      if (n.y < -0.5) { s.albedo *= 0.6; }
      s.rough = 0.85;
      applyWetness(&s, world, 0.0, 0.5);
    }
    case M_RAIL: {
      let x = uv.x;
      let d = detailXZ(world, 1.5, DETAIL_BALLAST);
      let ballast = mix(vec3f(0.32, 0.3, 0.28), vec3f(0.42, 0.38, 0.33), valueNoise(world.xz * 0.2));
      s.albedo = ballast * (d.b * 2.0) * mix(0.35, 1.0, d.a);
      s.normal = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), d, 1.0);
      s.rough = 0.95;
      // Concrete sleepers under each track, rust-stained around the fastenings.
      for (var k = -1.0; k <= 1.0; k += 2.0) {
        let tx = abs(x - k * 2.1);
        let sl = fract(uv.y / 0.62);
        if (tx < 1.25 && sl < 0.32) {
          let c = detailUV(uv, 1.0, DETAIL_CONCRETE);
          let rust = smoothstep(0.25, 0.0, abs(tx - 0.53)) * 0.5;
          s.albedo = mix(vec3f(0.5, 0.48, 0.45), vec3f(0.3, 0.17, 0.09), rust) * (c.b * 2.0) * mix(0.6, 1.0, c.a);
          s.normal = n;
          s.rough = 0.85;
        }
      }
      applyWetness(&s, world, 0.0, 0.5);
    }
    case M_SIGNAL: {
      let lamp = param & 3u;
      let group = (param >> 2u) & 1u;
      let phase = f32((param >> 3u) & 0xffu);
      let state = signalState(frame.time.x, phase, group);
      let cols = array<vec3f, 3>(vec3f(0.1, 1.0, 0.75), vec3f(1.0, 0.75, 0.05), vec3f(1.0, 0.08, 0.04));
      s.albedo = vec3f(0.05);
      s.rough = 0.2;
      if (state == lamp) { s.emissive = cols[lamp] * mix(6.0, 14.0, night); } else { s.emissive = cols[lamp] * 0.03; }
    }
    case M_FRAME: { s.albedo = vec3f(0.08); s.metal = 0.6; s.rough = 0.4; }
    case M_PAINT: { s.albedo = paintColor(param); s.rough = 0.5; s.metal = 0.1; applyWetness(&s, world, 0.0, 0.0); }
    case M_SCREEN: { s = screenMat(n, uv, param); }
    case M_TILE: {
      let h = hashu(param * 13u + 1u);
      let cols = array<vec3f, 4>(vec3f(0.12, 0.13, 0.16), vec3f(0.35, 0.18, 0.12), vec3f(0.18, 0.22, 0.3), vec3f(0.3, 0.3, 0.3));
      s.albedo = cols[h % 4u] * (0.8 + 0.2 * step(0.5, fract(uv.y * 4.0)));
      s.rough = 0.55;
      applyWetness(&s, world, 0.0, 0.0);
    }
    case M_WIRE: { s.albedo = vec3f(0.02); s.rough = 0.6; }
    case M_VENDING: {
      let body = array<vec3f, 3>(vec3f(0.75, 0.08, 0.06), vec3f(0.08, 0.2, 0.6), vec3f(0.85));
      s.albedo = body[param % 3u];
      s.rough = 0.4;
      if (uv.y > 0.7 && uv.y < 1.5 && fract(uv.x * 4.0) > 0.1) {
        let row = fract(uv.y * 5.0);
        s.emissive = mix(vec3f(0.9, 0.95, 1.0), vec3f(hash21(floor(uv * 8.0)), 0.6, 0.5), step(0.5, row)) * mix(0.8, 3.0, night);
      }
    }
    case M_LED: {
      let cols = array<vec3f, 4>(vec3f(1.0), vec3f(0.3, 0.6, 1.0), vec3f(0.8, 0.3, 1.0), vec3f(1.0, 0.7, 0.3));
      s.albedo = vec3f(0.3);
      s.emissive = cols[param % 4u] * night * 20.0;
    }
    default: { s.albedo = vec3f(1.0, 0.0, 1.0); }
  }
  return s;
}
