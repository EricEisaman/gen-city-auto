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
// Where rain runs on a blank wall (party walls set it, 0-1: below the
// coping, the old roofline flashing, tie plates and vents); -1 elsewhere,
// where facadeRain uses its general sill / ledge / flow streaks.
var<private> rainSrc: f32;

// Sign atlas (src/render/sign-atlas.ts, 2048 x 2560, 5 mips) through the
// 8x anisotropic clamp sampler. Gradients are in atlas texels per pixel;
// atlasLod is the level the hardware ends up at (the minor axis, or the
// major axis over the anisotropy), so text at a grazing angle up a blade
// sign keeps its strokes instead of dropping to the major axis' mip.
fn atlasLod(gx: vec2f, gy: vec2f) -> f32 {
  let a = length(gx);
  let b = length(gy);
  return log2(max(max(min(a, b), max(a, b) * 0.125), 1e-4));
}

// Samples at px (texels), gradients scaled down so the level never passes
// 3 (beyond it the cells' insets no longer stop neighbours bleeding in).
fn atlasGrad(px: vec2f, gx: vec2f, gy: vec2f, lod: f32) -> vec4f {
  let k = exp2(min(3.0 - lod, 0.0));
  let inv = 1.0 / vec2f(2048.0, 2560.0);
  return textureSampleGrad(signAtlas, linearSampler, px * inv, gx * k * inv, gy * k * inv);
}

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
const M_ROADSIGN = 27u;
const M_HEDGE = 28u;

fn nightLight() -> f32 {
  return smoothstep(0.15, 0.7, frame.time.w);
}

// Artificial light level for signs, shops and rooms: night, or a dark
// overcast or rainy day, when Tokyo switches on its signs and many office
// lights as at dusk (up to ~0.55 in a downpour).
fn gloomLight() -> f32 {
  let gloom = smoothstep(0.55, 0.95, frame.weather.x) * 0.3 + frame.weather.y * 0.3;
  return max(nightLight(), min(gloom, 0.55));
}

fn wallPalette(i: u32) -> vec3f {
  return wallPaletteRaw(i) * 0.68;
}

fn wallPaletteRaw(i: u32) -> vec3f {
  // Tokyo midrises are mostly pale: 7 of 12 light (white, beige, pale grey),
  // 3 mid and 2 dark (brown tile, charcoal).
  switch (i % 12u) {
    case 0u: { return vec3f(0.78, 0.76, 0.72); }  // off-white tile
    case 1u: { return vec3f(0.72, 0.72, 0.7); }   // light grey
    case 2u: { return vec3f(0.45, 0.33, 0.25); }  // brown tile
    case 3u: { return vec3f(0.7, 0.72, 0.74); }   // pale blue grey
    case 4u: { return vec3f(0.7, 0.66, 0.56); }   // beige
    case 5u: { return vec3f(0.55, 0.58, 0.6); }   // blue grey
    case 6u: { return vec3f(0.82, 0.8, 0.78); }   // white
    case 7u: { return vec3f(0.8, 0.76, 0.66); }   // cream
    case 8u: { return vec3f(0.3, 0.29, 0.29); }   // charcoal
    case 9u: { return vec3f(0.66, 0.52, 0.42); }  // terracotta-ish
    case 10u: { return vec3f(0.74, 0.71, 0.66); } // warm light grey
    default: { return vec3f(0.6, 0.59, 0.56); }   // mid concrete
  }
}

fn paintColor(p: u32) -> vec3f {
  if (p == 0x90u) { return vec3f(0.45, 0.46, 0.45); }
  if (p == 0x91u) { return vec3f(0.06, 0.06, 0.06); }
  if (p == 0x92u) { return vec3f(0.8, 0.55, 0.04); }
  // Rail line colour (station bands): JR-style green.
  if (p == 0x0cu) { return vec3f(0.06, 0.46, 0.26); }
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

// Lamp colour presets: 2700 K warm LED / incandescent, 4000 K neutral, and
// cool-white fluorescent (slightly green). Saturated on purpose: AgX bleaches
// bright light toward white, so these land as clearly warm, cream and cool.
fn lampColor(k: u32) -> vec3f {
  if (k == 0u) { return vec3f(1.0, 0.52, 0.2); }
  if (k == 1u) { return vec3f(1.0, 0.78, 0.5); }
  return vec3f(0.62, 0.9, 1.0);
}

// Which preset lights a room: homes choose per room (half warm), offices per
// tenant section (mostly fluorescent).
fn lampKind(seed: u32, office: bool, section: u32) -> u32 {
  // (A third of office rooms are meeting rooms or private offices with
  // their own lights.)
  if (office) {
    let t = hashuf(select(section, seed, hashuf(seed ^ 0x52u) < 0.33) ^ 0x51u);
    return select(select(2u, 1u, t < 0.55), 0u, t < 0.2);
  }
  let t = hashuf(seed ^ 0x7e7u);
  return select(select(2u, 1u, t < 0.75), 0u, t < 0.5);
}

// Electric light in one room (zero when the room is dark). Offices light up
// in tenant sections (one tenant working late); homes room by room, and about
// 40 % of windows stay dark at night. Brightness varies per room and some
// homes are lit only by a television, so no two neighbours match; scaled so
// the brightest window stays below clipping at night.
fn roomLight(seed: u32, office: bool, section: u32) -> vec3f {
  let night = gloomLight();
  var lit: bool;
  if (office) {
    // Tokyo offices keep their fluorescents on all day.
    let sectionLit = hashuf(section ^ 0xbeefu) < mix(0.5, 0.6, night);
    lit = hashuf(seed ^ 0x1234567u) < select(0.08, 0.72, sectionLit);
  } else {
    lit = hashuf(seed ^ 0x1234567u) < mix(0.04, 0.6, night);
  }
  if (!lit) { return vec3f(0.0); }
  let r2 = hashuf(seed ^ 0x5bd1u);
  let k = mix(select(0.12, 0.3, office), 1.0, night);
  if (!office && hashuf(seed ^ 0x7171u) < 0.12) {
    // Only the television on: dim and blue, flickering with the picture.
    let flick = 0.8 + 0.2 * sin(frame.time.x * 7.0 + r2 * 40.0) * sin(frame.time.x * 2.3);
    return vec3f(0.3, 0.45, 1.0) * 0.1 * flick * k;
  }
  return lampColor(lampKind(seed, office, section)) * mix(0.25, 0.85, r2) * select(0.55, 0.42, office) * k;
}

// Furniture against the back wall, seen as a cut-out on a plane parallel to
// the glass: bookshelf, wardrobe, fridge or plant (homes), filing cabinets,
// shelving or a plant (offices). x is relative to the prop centre, y the
// height above the floor. w > 0 on a hit; rgb its albedo.
fn backProp(x: f32, y: f32, kind: u32, office: bool, seed: u32, foot: f32) -> vec4f {
  let ax = abs(x);
  if (kind == 0u) {
    // Shelf of books: dark carcass, rows every 0.36 m, book spines in many
    // colours that fade to their mean once smaller than a pixel.
    if (ax < 0.45 && y < 1.85) {
      let row = floor(y / 0.36);
      let fy = fract(y / 0.36);
      let bw = 0.045;
      let bid = floor((x + 0.45) / bw);
      let bh = hash21(vec2f(bid, row + f32(seed & 63u)));
      let spine = 0.25 + 0.45 * cos(6.2831 * (bh * 0.7 + vec3f(0.0, 0.3, 0.6)));
      let bf = smoothstep(0.006, 0.02, foot);
      let book = mix(mix(spine * 0.7, vec3f(0.18), step(0.85, fract((x + 0.45) / bw))), vec3f(0.3, 0.26, 0.22), bf);
      let filled = fy > 0.08 && fy < mix(0.6, 0.9, bh) && ax < 0.42 && hash21(vec2f(row, f32(seed & 255u))) > 0.15;
      return vec4f(select(vec3f(0.16, 0.11, 0.07), book, filled), 1.0);
    }
  } else if (kind == 1u) {
    if (office) {
      // Steel filing cabinets with drawer lines.
      if (ax < 0.8 && y < 1.1) {
        let d = step(0.03, fract(y / 0.27)) * step(0.02, abs(fract(x / 0.4) - 0.5) * 0.4 + 0.01);
        return vec4f(vec3f(0.42, 0.43, 0.42) * mix(0.75, 1.0, mix(d, 0.9, smoothstep(0.006, 0.02, foot))), 1.0);
      }
    } else if (ax < 0.5 && y < 1.9) {
      // Wardrobe: two doors.
      let gap = mix(step(0.012, ax), 0.97, smoothstep(0.006, 0.02, foot));
      return vec4f(vec3f(0.38, 0.27, 0.18) * gap, 1.0);
    }
  } else if (kind == 2u) {
    if (!office && ax < 0.32 && y < 1.7) {
      // Fridge.
      return vec4f(vec3f(0.62, 0.62, 0.6) * select(1.0, 0.6, abs(y - 1.15) < 0.015), 1.0);
    }
    if (office && ax < 0.6 && y > 1.0 && y < 1.9) {
      // Whiteboard on the wall.
      return vec4f(select(vec3f(0.82), vec3f(0.5), ax > 0.57 || y < 1.03 || y > 1.87), 1.0);
    }
  } else {
    // Potted plant: pot and a lumpy crown of leaves.
    if (y < 0.4 && ax < 0.17 - y * 0.1) { return vec4f(0.3, 0.2, 0.15, 1.0); }
    let q = vec2f(x, y - 0.95) / vec2f(0.38, 0.55);
    let lump = 0.85 + 0.15 * sin(atan2(q.y, q.x) * 7.0 + f32(seed & 7u));
    if (length(q) < lump || (ax < 0.02 && y < 0.6)) { return vec4f(0.07, 0.14, 0.06, 1.0); }
  }
  return vec4f(0.0);
}

// Furniture in the middle of the room: desk with a glowing monitor (offices),
// sofa or table (homes), with a person now and then. rgba as backProp; the
// fourth channel above 1 marks an emissive screen.
fn midProp(x: f32, y: f32, office: bool, seed: u32) -> vec4f {
  let r = hashuf(seed ^ 0x2e2u);
  // A person: a head and tapering shoulders, standing or seated.
  let px = x - mix(-0.6, 0.6, hashuf(seed ^ 0x4e4u));
  let headY = select(1.62, 1.22, office || r < 0.5);
  if (hashuf(seed ^ 0x6e6u) < 0.3) {
    if (length(vec2f(px, (y - headY) * 0.85)) < 0.11) { return vec4f(0.1, 0.08, 0.07, 1.0); }
    if (y < headY - 0.1 && abs(px) < 0.24 - max(headY - 0.22 - y, 0.0) * 0.05 && y > headY - 0.85) { return vec4f(vec3f(0.12, 0.13, 0.17) * (1.0 + r), 1.0); }
  }
  let ax = abs(x);
  if (office) {
    // Desk run with monitors facing away from the window (lit backs) or
    // toward it (a bright screen).
    if (y < 0.72 && y > 0.68 && ax < 1.4) { return vec4f(0.45, 0.42, 0.38, 1.0); }
    if (y < 0.68 && ax < 1.4 && fract(x / 1.4 + 0.5) < 0.06) { return vec4f(0.2, 0.2, 0.2, 1.0); }
    let mx = fract(x / 0.7) - 0.5;
    if (y > 0.76 && y < 1.1 && abs(mx) < 0.22 && ax < 1.3) {
      let facing = hashuf(seed ^ u32(floor(x / 0.7) + 77.0)) < 0.35;
      return vec4f(select(vec3f(0.08), vec3f(0.45, 0.6, 0.9), facing), select(1.0, 2.0, facing));
    }
    if (y > 0.72 && y < 0.76 && abs(mx) < 0.04 && ax < 1.3) { return vec4f(0.1, 0.1, 0.1, 1.0); }
  } else if (r < 0.5) {
    // Sofa with arms and a back.
    if (ax < 0.95 && (y < 0.45 || (y < 0.85 && ax > 0.78) || (y < 0.88 && y > 0.45 && ax < 0.8 && r < 0.25))) {
      return vec4f(mix(vec3f(0.3, 0.25, 0.2), vec3f(0.22, 0.28, 0.35), hashuf(seed ^ 0x8e8u)), 1.0);
    }
  } else {
    // Dining table and chair backs, a pendant lamp over it.
    if ((y > 0.68 && y < 0.73 && ax < 0.7) || (y < 0.7 && abs(ax - 0.62) < 0.03)) { return vec4f(0.3, 0.2, 0.12, 1.0); }
    if (abs(ax - 0.35) < 0.18 && y < 0.95 && y > 0.45 && fract(y * 6.0) > 0.4) { return vec4f(0.18, 0.13, 0.09, 1.0); }
    if (length(vec2f(x, (y - 1.75) * 1.6)) < 0.18) { return vec4f(1.0, 1.0, 1.0, 3.0); }
  }
  return vec4f(0.0);
}

// Fake room behind a window (interior mapping). Returns radiance.
fn interior(local: vec2f, size: vec2f, depth: f32, N: vec3f, T: vec3f, V: vec3f, seed: u32, office: bool, section: u32) -> vec3f {
  let rd = vec3f(dot(V, T), V.y, -dot(V, N));
  // The room's floor is a sill height below the opening and its ceiling a
  // little above it; y is measured from the floor.
  let ro = vec3f(local.x, local.y + 0.8, 0.0);
  let roomH = size.y + 1.15;
  let inv = 1.0 / select(rd, vec3f(1e-4), abs(rd) < vec3f(1e-4));
  let tx = select(-ro.x * inv.x, (size.x - ro.x) * inv.x, rd.x > 0.0);
  let ty = select(-ro.y * inv.y, (roomH - ro.y) * inv.y, rd.y > 0.0);
  let tz = (depth - ro.z) * inv.z;
  let t = min(min(tx, ty), tz);
  let hit = ro + rd * t;
  let r0 = hashuf(seed);
  let r1 = hashuf(seed ^ 0x9e37u);
  let r2 = hashuf(seed ^ 0x5bd1u);
  let r3 = hashuf(seed ^ 0x3c3u);
  let foot = max(length(dWorldX), length(dWorldY));
  let roomL = roomLight(seed, office, section);
  let lit = any(roomL > vec3f(0.0));
  // Homes: warm wallpaper; offices: pale grey or blue-grey partitions.
  let wallC = select(mix(vec3f(0.7, 0.63, 0.52), vec3f(0.6, 0.58, 0.52), r1), mix(vec3f(0.55, 0.55, 0.53), vec3f(0.4, 0.44, 0.47), r1), office);
  var c: vec3f;
  var glow = vec3f(0.0);
  if (t == tz) {
    c = wallC * 0.9;
    // A picture or calendar on the back wall.
    if (abs(hit.x - size.x * mix(0.25, 0.75, r3)) < 0.25 && abs(hit.y - 1.55) < 0.3) { c = vec3f(r2, 0.4, 1.0 - r2) * 0.45; }
  } else if (t == ty) {
    if (rd.y < 0.0) {
      // Office carpet tiles; wooden floor or tatami at home.
      c = select(select(vec3f(0.32, 0.21, 0.12), vec3f(0.42, 0.4, 0.24), r0 < 0.3), vec3f(0.22, 0.24, 0.27), office);
    } else {
      c = vec3f(0.62);
      // Ceiling light panels. Seen steeply from below, the ceiling is
      // compressed into a few pixels: fade the panels to their average
      // before they alias into vertical barcode stripes.
      let ay = max(abs(rd.y), 1e-3);
      let span = foot * (1.0 + (abs(rd.z) + abs(rd.x)) / ay);
      let fk = 1.0 - smoothstep(0.04, 0.15, span);
      if (office) {
        // Suspended ceiling: 600 mm tiles, with rows of light panels.
        let tg = abs(fract(hit.xz / 0.6) - 0.5) * 0.6;
        c *= 1.0 - 0.3 * (1.0 - smoothstep(0.008, 0.02, min(tg.x, tg.y))) * fk;
        let panel = select(0.0, 1.0, fract(hit.z * 0.42 + r2) < 0.25 && abs(fract(hit.x / 1.8 + r3) - 0.5) < 0.17);
        glow += roomL * 1.6 * mix(0.085, panel, fk);
      } else {
        // A round ceiling lamp (the Japanese "ceiling light" disc).
        let d = length(vec2f(hit.x - size.x * 0.5, hit.z - min(depth * 0.45, 2.2)));
        glow += roomL * 3.0 * mix(0.06, 1.0 - smoothstep(0.24, 0.3, d), fk);
      }
    }
  } else {
    c = wallC * 0.75;
  }
  // Furniture: a back-wall piece, then a middle plane nearer the window.
  let zB = depth - 0.45;
  let tB = (zB - ro.z) * inv.z;
  if (tB > 0.0 && tB < t) {
    let pB = ro + rd * tB;
    let kind = hashu(seed ^ 0xb0bu) % 4u;
    let pr = backProp(pB.x - size.x * mix(0.25, 0.75, r3), pB.y, kind, office, seed, foot);
    if (pr.w > 0.0) { c = pr.rgb; glow = vec3f(0.0); }
  }
  let zF = depth * mix(0.3, 0.55, r2);
  let tF = (zF - ro.z) * inv.z;
  if (tF > 0.0 && tF < t) {
    let pF = ro + rd * tF;
    let pr = midProp(pF.x - size.x * (0.3 + 0.4 * r0), pF.y, office, seed);
    if (pr.w > 0.0) {
      c = pr.rgb;
      glow = vec3f(0.0);
      // Screens and lamps light themselves (screens only when someone's in).
      if (pr.w > 2.5 && lit) { glow = roomL * 3.0; }
      if (pr.w > 1.5 && pr.w < 2.5) { glow = pr.rgb * 0.25 * select(0.1, 1.0, lit); }
    }
  }
  // Rooms darken away from the window (less at night: the lamp is inside);
  // at grazing angles the room collapses to its average colour instead of
  // slivers of ceiling and wall.
  c *= mix(1.0, select(0.35, 0.6, lit), clamp(hit.z / depth, 0.0, 1.0));
  let avg = wallC * 0.55;
  c = mix(c, avg, smoothstep(0.4, 0.12, abs(rd.z)));
  glow *= smoothstep(0.12, 0.4, abs(rd.z));
  // Daylight in a room is dim and neutral: seen from the street a room is
  // 5-10x darker than the facade, so the glass reflection dominates.
  let night = nightLight();
  var light = vec3f(luminance(frame.skyAmbient.rgb)) * vec3f(1.0, 0.95, 0.88) * 0.24;
  // Dark offices still show a trace of corridor and exit lighting.
  if (office) { light += vec3f(0.75, 0.85, 1.0) * 0.012 * night; }
  light += roomL;
  return c * light + glow;
}

// Blinds and curtains hanging just behind the glass, drawn to their own
// height in every window, over the room seen through it. p is the position
// in the opening (m, from its bottom left). Lit from behind they glow in the
// room's light colour.
fn windowCover(inside: vec3f, p: vec2f, size: vec2f, seed: u32, office: bool, roomL: vec3f, foot: f32) -> vec3f {
  let h = hashuf(seed ^ 0xabcu);
  let h2 = hashuf(seed ^ 0xdefu);
  let h3 = hashuf(seed ^ 0x919u);
  // Blinds and curtains hang right behind the glass, lit by the open sky: a
  // lowered blind reads as a pale panel against the dark rooms beside it.
  // (Behind clear glass a white blind gets most of the skylight a wall
  // does: it must read nearly as light as the wall beside it.)
  let amb = vec3f(luminance(frame.skyAmbient.rgb)) * vec3f(1.0, 0.96, 0.9) * 0.42;
  let back = roomL * 1.3;
  let drop = size.y * mix(0.15, 1.0, h2);
  let lit = any(roomL > vec3f(0.0));
  // Fine patterns fade to their mean once smaller than ~3 px.
  let fk = 1.0 - smoothstep(0.006, 0.02, foot);
  if (office || (h > 0.55 && h < 0.7)) {
    let venetian = h < select(0.63, 0.45, office);
    let vertical = office && h >= 0.45 && h < 0.56;
    if (venetian) {
      if (p.y < size.y - drop) { return inside; }
      // Aluminium slats every 25 mm, tilted open by a per-window amount; the
      // bottom rail is a darker line.
      // (Slats are drawn at 50 mm so they still read across the street.)
      // The gaps are box-filtered by the pixel's vertical footprint (exact
      // coverage, no moire at any distance); the slat's shading ramp fades
      // to its mean once a slat is under ~4 pixels.
      let open = mix(0.06, 0.55, h3);
      let fy = (abs(dUvX.y) + abs(dUvY.y)) / 0.05;
      let fs = 1.0 - smoothstep(0.15, 0.3, fy);
      let slat = 1.0 - jointCov(p.y / 0.05, fy, open);
      let col = select(vec3f(0.8, 0.8, 0.78), vec3f(0.75, 0.68, 0.55), hashuf(seed ^ 0x3a3u) < 0.3);
      let rad = col * (amb + back * 0.5) * mix(0.875, 0.75 + 0.25 * fract(p.y / 0.05 + open * 0.5), fs);
      var o = mix(inside, rad, slat);
      if (abs(p.y - (size.y - drop)) < 0.025) { o = col * (amb + back * 0.1) * 0.6; }
      return o;
    }
    if (vertical) {
      // Vertical vanes (90 mm), drawn across part of the window.
      let w = size.x * mix(0.3, 1.0, h2);
      if (p.x > w) { return inside; }
      let vane = mix(0.85, select(0.7, 1.0, fract(p.x / 0.09) < 0.85), fk);
      return mix(inside, vec3f(0.8, 0.79, 0.74) * (amb + back * 0.32) * vane, 0.88);
    }
    if (!office) {
      // Roller blind, pulled to a per-window height.
      if (p.y < size.y - drop) { return inside; }
      let col = mix(vec3f(0.85, 0.8, 0.68), vec3f(0.55, 0.6, 0.62), h3);
      return col * (amb + back * 0.5) * select(1.0, 0.7, abs(p.y - (size.y - drop)) < 0.03);
    }
    return inside;
  }
  if (h < 0.3) {
    // Lace curtain over the whole window: the room shows through faintly,
    // with soft folds and a fine pattern.
    let fold = mix(1.0, 0.85 + 0.15 * cos(p.x * 40.0), 1.0 - smoothstep(0.008, 0.025, foot));
    let lace = mix(0.85, 0.7 + 0.3 * valueNoise(p * 40.0), fk);
    var o = inside * 0.3 + vec3f(0.85, 0.84, 0.8) * (amb + back * 0.45) * fold * lace;
    // Somebody standing behind it, now and then.
    let px = p.x - size.x * mix(0.3, 0.7, h3);
    let body = abs(px) < 0.2 - max(p.y - 0.6, 0.0) * 0.15 && p.y < 0.65;
    let head = length(vec2f(px, p.y - 0.82)) < 0.11;
    if (lit && hashuf(seed ^ 0x6161u) < 0.2 && (body || head)) { o *= 0.45; }
    return o;
  }
  if (h < 0.55) {
    // Fabric curtains drawn in from both sides by different amounts.
    let wl = size.x * mix(0.08, 0.5, h2);
    let wr = size.x * mix(0.08, 0.5, h3);
    let edgeD = select(p.x - (size.x - wr), wl - p.x, p.x < size.x * 0.5);
    if (edgeD < 0.0) { return inside; }
    let col = array<vec3f, 4>(vec3f(0.75, 0.66, 0.5), vec3f(0.42, 0.5, 0.38), vec3f(0.25, 0.3, 0.45), vec3f(0.5, 0.22, 0.2))[hashu(seed ^ 0x5c5u) % 4u];
    let fold = mix(0.9, 0.75 + 0.25 * cos(p.x * 26.0), 1.0 - smoothstep(0.01, 0.03, foot));
    // Thick fabric: only a soft glow at night, brightest at the inner edge.
    return col * (amb + back * mix(0.25, 0.45, smoothstep(0.15, 0.0, edgeD))) * fold;
  }
  return inside;
}

// Clutter right behind the glass of one window in ~8: cardboard boxes
// stacked against it (storerooms, back offices), or the back of a bookcase
// or fridge. Big, simple shapes that read across the street. Returns the
// radiance seen through the pane.
fn windowClutter(inside: vec3f, p: vec2f, size: vec2f, seed: u32, roomL: vec3f, foot: f32) -> vec3f {
  let h = hashuf(seed ^ 0x7b0u);
  if (h > 0.13) { return inside; }
  let amb = vec3f(luminance(frame.skyAmbient.rgb)) * vec3f(1.0, 0.96, 0.9) * 0.3;
  let L = amb + roomL * 0.5;
  if (h < 0.09) {
    // Boxes: 2-3 stacks of 0.3-0.45 m cartons, kraft brown, tape line.
    let bw = mix(0.3, 0.45, hashuf(seed ^ 0x7b1u));
    let col = floor(p.x / bw);
    let n = 1.0 + floor(hashuf(seed ^ (u32(col + 10.0) * 0x7b3u)) * 3.0);
    let bh = bw * 0.75;
    if (p.y < n * bh) {
      let q = vec2f(fract(p.x / bw), fract(p.y / bh));
      let tone = 0.85 + 0.3 * hash21(vec2f(col, floor(p.y / bh)) + f32(seed & 63u));
      var c = vec3f(0.5, 0.36, 0.22) * tone;
      if (abs(q.y - 0.55) < 0.06) { c = vec3f(0.62, 0.52, 0.38); }
      if (q.x < 0.03 || q.y < 0.03) { c *= 0.45; }
      return c * L;
    }
    return inside;
  }
  // A bookcase back against the glass: dark board, the lower 70 %.
  if (p.y < size.y * 0.7 && p.x > size.x * 0.15 && p.x < size.x * 0.75) {
    return vec3f(0.18, 0.14, 0.1) * L * select(1.0, 0.6, fract(p.y / 0.35) < 0.08);
  }
  return inside;
}

// Stickers and notices on the glass (pane-local p from the opening's bottom
// left): a security company sticker in a lower corner, a taped A4 notice,
// or a row of faded kids' stickers. Returns colour and coverage.
fn glassSticker(p: vec2f, size: vec2f, seed: u32, foot: f32) -> vec4f {
  let h = hashuf(seed ^ 0x5e1u);
  let fk = 1.0 - smoothstep(0.006, 0.02, foot);
  if (h < 0.14) {
    // Security sticker: 10 x 13 cm, white with a blue band and logo disc.
    let q = (p - vec2f(0.08, 0.1)) / vec2f(0.1, 0.13);
    if (all(q > vec2f(0.0)) && all(q < vec2f(1.0))) {
      var c = vec3f(0.85, 0.85, 0.82);
      if (q.y > 0.7) { c = select(vec3f(0.06, 0.2, 0.6), vec3f(0.7, 0.1, 0.08), hashuf(seed ^ 0x5e2u) < 0.3); }
      if (length((q - vec2f(0.5, 0.38)) * vec2f(1.0, 1.3)) < 0.25 * fk + 0.15 * (1.0 - fk)) { c = vec3f(0.08, 0.2, 0.55); }
      return vec4f(c, 1.0);
    }
  } else if (h < 0.24) {
    // A4 notice taped up at eye level, text lines.
    let q = (p - vec2f(size.x * mix(0.15, 0.6, hashuf(seed ^ 0x5e3u)), size.y * 0.45)) / vec2f(0.21, 0.297);
    if (all(q > vec2f(0.0)) && all(q < vec2f(1.0))) {
      var c = vec3f(0.88, 0.87, 0.82);
      let line = step(0.5, fract(q.y * 9.0)) * step(0.12, q.x) * step(q.x, 0.88) * step(0.12, q.y) * step(q.y, 0.75);
      c = mix(c, mix(c, vec3f(0.1), 0.35), mix(0.5, line, fk));
      if (q.y > 0.8 && q.y < 0.92 && q.x > 0.15 && q.x < 0.85) { c = mix(c, vec3f(0.7, 0.08, 0.06), 0.8); }
      return vec4f(c, 1.0);
    }
  } else if (h < 0.3) {
    // Kids' stickers: a scatter of small faded colour discs low on the pane.
    let cell = floor(p / 0.12);
    let ch = hash21(cell + f32(seed & 255u));
    let ctr = (cell + 0.5) * 0.12;
    if (p.y < 0.6 && ch < 0.3 && length(p - ctr) < 0.04) {
      let c = 0.55 + 0.3 * cos(6.2831 * (ch * 3.0 + vec3f(0.0, 0.33, 0.67)));
      return vec4f(c, mix(0.3, 0.9, fk));
    }
  }
  return vec4f(0.0);
}

// Ground-floor tenancy behind the base's big lights: a small restaurant or
// shop (warm light, a counter with staff, menu boards and pendant lamps), a
// cool-lit office, or a dark, closed unit. Returns radiance.
fn shopInterior(local0: vec2f, size: vec2f, N: vec3f, T: vec3f, V: vec3f, seed: u32, foot: f32) -> vec3f {
  // Heights below are from the shop floor, 0.6 m under the glass.
  let local = local0 + vec2f(0.0, 0.6);
  let night = gloomLight();
  let kind = hashu(seed ^ 0x5e5u) % 10u;
  let room = interior(local0, size, 6.0, N, T, V, seed, kind >= 6u && kind < 9u, seed);
  if (kind >= 6u) {
    // Office (lit like an office section) or closed (dim).
    return select(room, room * 0.25, kind == 9u);
  }
  let ndv = max(-dot(V, N), 0.05);
  let vP = vec2f(dot(V, T), V.y) / ndv;
  let warm = lampColor(select(1u, 0u, kind < 4u));
  // Shops stay lit until late; by day the lamps add to the daylight.
  let k = mix(0.18, 0.75, night);
  let amb = vec3f(luminance(frame.skyAmbient.rgb)) * 0.14;
  // Back wall: warm-lit, with a row of bright menu boards (photos and price
  // lines) up near the ceiling.
  let qb = local + vP * 5.5;
  var c = vec3f(0.55, 0.45, 0.35) * (amb + warm * k * 0.6);
  if (qb.y > 1.75 && qb.y < 2.45) {
    let bx = fract(qb.x / 0.75);
    if (bx > 0.06) {
      let cell = floor(qb.x / 0.75);
      let line = mix(0.9, select(0.55, 1.0, fract(qb.y * 12.0) > 0.3), 1.0 - smoothstep(0.006, 0.02, foot));
      let photo = bx > 0.12 && bx < 0.5 && qb.y > 2.0;
      let board = select(vec3f(0.95, 0.9, 0.75) * line, 0.4 + 0.3 * cos(6.2831 * (hashuf(seed ^ (u32(cell + 100.0) * 0x9e37u)) + vec3f(0.0, 0.3, 0.6))), photo);
      c = board * (amb + vec3f(1.0, 0.9, 0.75) * k * 0.9);
    } else {
      c = vec3f(0.1);
    }
  }
  if (qb.y < 0.0) { c = vec3f(0.3, 0.25, 0.2) * (amb + warm * k * 0.4); }
  // Pendant lamps over the counter.
  let ql = local + vP * 2.6;
  let lp = vec2f(fract(ql.x / 1.1) - 0.5, ql.y - 2.55);
  if (length(lp * vec2f(1.0, 1.5)) < 0.13) { return warm * mix(0.6, 2.2, night); }
  if (abs(lp.x) < 0.006 && ql.y > 2.6) { c = vec3f(0.02); }
  // Staff behind the counter: heads and shoulders above it.
  let qs = local + vP * 3.0;
  let sx = fract(qs.x / 1.7) - 0.5;
  if (hash21(vec2f(floor(qs.x / 1.7), f32(seed & 127u))) > 0.4 && qs.y > 0.9 && qs.y < 1.62 - abs(sx) * 0.4 && abs(sx) < 0.15) {
    c = select(vec3f(0.05, 0.045, 0.045), vec3f(0.5, 0.48, 0.45) * (amb + warm * k * 0.3), qs.y < 1.32 && abs(sx) < 0.11);
  }
  // Counter: dark wood front, a lit top edge, and items on top.
  let qc = local + vP * 2.0;
  if (qc.y < 1.05) {
    c = vec3f(0.3, 0.17, 0.08) * (0.8 + 0.2 * step(0.5, fract(qc.x * 3.0))) * (amb + warm * k * 0.45);
    if (qc.y > 0.98) { c = vec3f(0.6, 0.45, 0.3) * (amb + warm * k * 1.1); }
  }
  // Customers on stools, backs to the window.
  let qd = local + vP * 1.3;
  let dx = fract(qd.x / 0.8) - 0.5;
  if (kind < 4u && hash21(vec2f(floor(qd.x / 0.8), f32(seed & 41u))) > 0.5 && qd.y < 1.35 - abs(dx) * 0.5 && abs(dx) < 0.17 && qd.y > 0.45) {
    c = vec3f(0.05, 0.045, 0.045);
  }
  // A noren-style sign strip or a price poster on the glass, by type.
  let r = hashuf(seed ^ 0x777u);
  if (local0.y > size.y - 0.4 && r < 0.5) {
    let nc = array<vec3f, 3>(vec3f(0.08, 0.1, 0.3), vec3f(0.55, 0.08, 0.06), vec3f(0.85, 0.8, 0.7))[hashu(seed) % 3u];
    return nc * (amb * 2.0 + warm * k * 0.5);
  }
  return c;
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

// Reveal depths (m) of each opening family, behind the wall plane. The
// contract with gen-tile's LOD0 reveal geometry: real jamb/head/sill quads,
// where emitted, use the same depth, so the painted parallax and the
// geometry's silhouette and shadows agree.
const REVEAL_PUNCHED = 0.30;   // main window grid (0.45 between deep piers)
const REVEAL_FROSTED = 0.15;   // rear frosted wired-glass panes
const REVEAL_GLASSBLOCK = 0.15; // stair-core glass block
const REVEAL_SHOP = 0.08;      // shopfront glazing between its frame

// One opening model for every window path: the glass sits D behind the wall
// plane in the rectangle [wx0, wx1] x [sill, wy1] (facade metres, lx/ly the
// shading point). A view ray that meets a reveal face first writes that
// face into `s` (wall-toned, its own normal, contact AO toward the back and
// into the corners, sun cast through the opening, bounce from the lit faces
// opposite and from a lit room) and returns reveal = true. Otherwise it
// returns where the ray meets the glass plane (`g`), with the lintel and
// jamb shadows already in s.sunVis and an edge AO in `glassAo`.
struct OpeningHit {
  reveal: bool,
  g: vec2f,
  glassAo: f32,
};

fn opening(s: ptr<function, Surf>, lx: f32, ly: f32, wx0: f32, wx1: f32, sill: f32, wy1: f32, D: f32,
           V: vec3f, n: vec3f, T: vec3f, wall: vec3f, sl: vec3f, roomL: vec3f) -> OpeningHit {
  var o: OpeningHit;
  let sunLit = sl.z > 0.0;
  let sT = sl.xy;
  let ndv = max(-dot(V, n), 0.05);
  let vT = vec2f(dot(V, T), V.y) / ndv;
  let g = vec2f(lx, ly) + vT * D;
  o.g = g;
  o.reveal = g.x < wx0 || g.x > wx1 || g.y < sill || g.y > wy1;
  if (o.reveal) {
    (*s).albedo = wall * 0.8;
    (*s).rough = 0.8;
    (*s).metal = 0.0;
    // Depth z where the view ray meets the reveal: the face it crosses
    // first is the one seen. (Choosing by the glass-plane point instead
    // let the sill and head shading spill onto the jambs as wedges, so
    // windows read keystoned.)
    let tx = select((wx0 - lx) / min(vT.x, -1e-4), (wx1 - lx) / max(vT.x, 1e-4), vT.x > 0.0);
    let ty = select((sill - ly) / min(vT.y, -1e-4), (wy1 - ly) / max(vT.y, 1e-4), vT.y > 0.0);
    let z = clamp(min(tx, ty), 0.0, D);
    let jamb = tx < ty;
    let hit = vec2f(lx, ly) + vT * z;
    if (jamb) { (*s).normal = select(T, -T, vT.x > 0.0); }
    else { (*s).normal = select(vec3f(0.0, 1.0, 0.0), vec3f(0.0, -1.0, 0.0), vT.y > 0.0); }
    // Contact AO: darker toward the frame at the back of the reveal and
    // into the corners where jamb meets sill or head; the head soffit sees
    // no sky at all.
    let corner = select(min(hit.x - wx0, wx1 - hit.x), min(hit.y - sill, wy1 - hit.y), jamb);
    let soffit = !jamb && vT.y > 0.0;
    (*s).ao = mix(0.85, 0.5, z / D) * mix(0.65, 1.0, smoothstep(0.0, 0.12, corner)) * select(1.0, 0.7, soffit);
    if (sunLit) {
      // March to the light: lit only if the ray leaves through the
      // opening. The face's own edge is N.L's job, so only the opposite
      // edges cast.
      let e = hit + sT * z;
      var ix = min(e.x - wx0, wx1 - e.x);
      var iy = min(e.y - sill, wy1 - e.y);
      if (jamb) { ix = select(e.x - wx0, wx1 - e.x, vT.x < 0.0); }
      else { iy = select(e.y - sill, wy1 - e.y, vT.y < 0.0); }
      (*s).sunVis = min((*s).sunVis, castVis(min(ix, iy)));
    }
    // The inner sill holds water in the rain.
    if (!jamb && vT.y < 0.0) {
      let wet = frame.weather.z;
      (*s).rough = mix((*s).rough, 0.08, wet);
      (*s).albedo *= 1.0 - 0.35 * wet;
    }
    // Light from a lit room spills onto the reveal. In sun, the shaded
    // faces of the recess are lit by the sunlit ones opposite them: without
    // that bounce a shaded jamb goes as dark as the glass and the opening
    // reads as a slanted (keystoned) shape. Faces turned away from the sun
    // (the head soffit, the far jamb) get it too: seen at a grazing angle
    // they fill a large wedge of the opening, black without it.
    (*s).emissive = roomL * wall * 0.2;
    if (sunLit && frame.sunDir.w > 0.0) {
      let direct = (*s).sunVis * smoothstep(0.0, 0.25, dot((*s).normal, frame.sunDir.xyz));
      (*s).emissive += (*s).albedo * frame.sunColor.rgb * clamp(sl.z, 0.0, 1.0) * 0.4 * (1.0 - direct);
    }
    return o;
  }
  // Lintel and side-reveal shadows on the recessed glass and frame.
  if (sunLit) {
    let e = g + sT * D;
    (*s).sunVis = min((*s).sunVis, castVis(min(min(e.x - wx0, wx1 - e.x), min(e.y - sill, wy1 - e.y))));
  }
  o.glassAo = mix(0.55, 1.0, smoothstep(0.0, 0.15, min(min(g.x - wx0, wx1 - g.x), min(g.y - sill, wy1 - g.y))));
  return o;
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
  s.bay = mix(1.5, 3.2, hashuf(h ^ 0x1234u));  // facadeBay() in gen-tile.ts mirrors this
  if (kind == 4u) { s.bay = mix(2.2, 3.4, hashuf(h ^ 0x1234u)); }
  s.winW = mix(0.42, 0.8, hashuf(h ^ 0x22u));
  s.winH = mix(0.42, 0.66, hashuf(h ^ 0x33u));
  s.strip = hashuf(h ^ 0x44u) < select(0.28, 0.6, kind == 0u);
  if (s.strip) { s.winW = 1.0; }
  s.wall = wallPalette(hashu(h ^ 0x55u));
  // Hue jitter so neighbours with the same palette entry never match.
  s.wall *= 1.0 + vec3f(0.04, 0.0, -0.04) * (hashuf(h ^ 0x56u) - 0.5) * 2.0;
  let fam = hashuf(h ^ 0x66u);
  s.family = select(select(select(select(0u, 1u, fam < 0.62), 2u, fam < 0.44), 3u, fam < 0.28), 4u, fam < 0.12);
  if (s.strip) { s.family = 1u; }
  if (s.family == 2u) { s.winW = 0.62; s.winH = 0.72; }
  if (s.family == 3u) { s.wall = mix(vec3f(0.42, 0.44, 0.47), vec3f(0.25, 0.26, 0.28), hashuf(h ^ 0x77u)); s.winW = min(s.winW, 0.5); }
  if (s.family == 4u) { s.wall = vec3f(0.36, 0.355, 0.34) * mix(0.85, 1.1, hashuf(h ^ 0x88u)); }
  if (podium) { s.wall = mix(s.wall, vec3f(0.35, 0.33, 0.3), 0.5); }
  return s;
}

// Per-building trim: window and shopfront frames (and painted canopy
// fascias, M_METAL trim). Anodised aluminium (metallic, rough 0.3) in
// silver (28 %), bronze (14 %) or black (18 %), or painted steel (metal 0):
// white (10 %), cream (10 %), teal (10 %) or rust red (10 %). rgb albedo, w
// metalness. Dark walls never get dark frames, so the window grid still
// reads. Distinct, clearly coloured trims per building (not one blue-grey
// everywhere) are much of a street's colour variety.
fn frameFinish(style: u32, wall: vec3f) -> vec4f {
  let k = hashuf(hashu(style * 2654435761u + 9u));
  var c = vec4f(0.62, 0.62, 0.6, 1.0);
  if (k >= 0.28) { c = vec4f(0.3, 0.21, 0.13, 1.0); }
  if (k >= 0.42) { c = vec4f(0.035, 0.035, 0.038, 0.7); }
  if (k >= 0.6) { c = vec4f(0.78, 0.78, 0.76, 0.0); }
  if (k >= 0.7) { c = vec4f(0.76, 0.68, 0.48, 0.0); }
  if (k >= 0.8) { c = vec4f(0.06, 0.32, 0.32, 0.0); }
  if (k >= 0.9) { c = vec4f(0.45, 0.11, 0.07, 0.0); }
  if (luminance(wall) < 0.2 && ((k >= 0.28 && k < 0.6) || k >= 0.8)) { c = vec4f(0.62, 0.62, 0.6, 1.0); }
  return c;
}

fn frameRough(fin: vec4f) -> f32 {
  return select(0.45, 0.3, fin.w > 0.5);
}

// ---- Facade programs (zones, roles, piers) ---------------------------------
// gen-tile.ts splits every wall into zones (param bits 13-15) and gives each
// footprint edge a role (bits 21-22: 0 front, 1 street side, 2 party wall,
// 3 rear). Bit 23 marks solid wall (corner piers, blank bays): no windows.
// Window fields hold whole bays of facadeStyle's `bay` (facadeBay() in
// gen-tile.ts mirrors it), so windows are never cut at corners.
const FZ_BODY = 0u;
const FZ_BASE = 1u;   // ground floor, FACADE_GROUND tall: granite on street faces
const FZ_LOBBY = 2u;  // entrance glazing; uv.x in metres from its left edge
const FZ_CROWN = 3u;  // parapet, penthouse, core sides: accent tone, solid
const FZ_CORE = 4u;   // stair core strip: accent tone, one stair window per floor
const FZ_TRIM = 5u;   // balcony upstands: body tone (light on dark bodies), solid
const FACADE_GROUND = 4.2;
const FACADE_CORE_W = 2.8;

struct FacadeZone {
  role: u32,
  zone: u32,
  solid: bool,
};

fn facadeZone(param: u32) -> FacadeZone {
  var z: FacadeZone;
  z.zone = (param >> 13u) & 7u;
  z.role = (param >> 21u) & 3u;
  z.solid = ((param >> 23u) & 1u) == 1u || z.zone == FZ_CROWN || z.zone == FZ_TRIM;
  return z;
}

// Crown and core tone: clearly lighter or darker than the body, and light on
// dark bodies, so base / body / crown read as three values from afar.
fn facadeAccent(body: vec3f, aux: u32) -> vec3f {
  let l = luminance(body);
  let h = hashuf(aux ^ 0x3c1u);
  // (Tile textures darken the palette colour a lot, so most bodies count
  // as dark here.)
  if (l < 0.45) { return vec3f(0.62, 0.6, 0.56) * mix(0.85, 1.05, h); }
  return body * select(0.5, 0.65, h < 0.5);
}

// Adjusts the facade style for this wall's role and zone, before the wall
// colour is computed. May mark the wall solid (blank party-wall bays).
fn facadeRole(st: ptr<function, FacadeStyle>, z: ptr<function, FacadeZone>, uv: vec2f, aux: u32) {
  let zone = (*z).zone;
  let role = (*z).role;
  if (zone == FZ_BASE || zone == FZ_LOBBY) { (*st).floorH = FACADE_GROUND; }
  if (zone == FZ_CROWN || zone == FZ_TRIM) { (*st).floorH = 1e4; }
  if (zone == FZ_CROWN || zone == FZ_CORE) { (*st).wall = facadeAccent((*st).wall, aux); }
  if (zone == FZ_TRIM && luminance((*st).wall) < 0.2) { (*st).wall = vec3f(0.6, 0.58, 0.55); }
  if (zone == FZ_CORE) {
    (*st).bay = FACADE_CORE_W;
    (*st).strip = false;
    (*st).family = 5u;
    (*st).winW = 0.9 / FACADE_CORE_W;
    (*st).winH = 1.2 / (*st).floorH;
    return;
  }
  if (role >= 2u) {
    // Party walls and the rear: painted render / ALC, few small windows.
    (*st).wall = vec3f(0.47, 0.46, 0.43) * mix(0.85, 1.12, hashuf(aux ^ 0x4e1u));
    (*st).family = 5u;
    (*st).strip = false;
    if (role == 3u) {
      (*st).winW = 0.45;
      (*st).winH = 0.45;
    } else {
      // Party walls on the lot line have no openings at all.
      (*z).solid = true;
    }
    return;
  }
  if (zone == FZ_BASE) {
    // Granite-clad ground floor with big fixed lights.
    (*st).wall = mix(vec3f(0.11, 0.105, 0.1), vec3f(0.2, 0.19, 0.18), hashuf(aux ^ 0x6a1u));
    (*st).family = 4u;
    (*st).strip = false;
    (*st).winW = 0.8;
    (*st).winH = 0.7;
    return;
  }
  if (role == 1u && !(*st).strip) { (*st).winW *= 0.8; }
}

// Entrance lobby: aluminium-framed glass doors and sidelights in front of a
// lit lobby (timber back wall, mailbox bank, lift, downlights).
fn facadeLobby(uv: vec2f, n: vec3f, T: vec3f, V: vec3f, fin: vec4f) -> Surf {
  var s = defaultSurf(n);
  let lx = uv.x;
  let ly = uv.y;
  let top = 3.3;
  if (ly < 0.0 || ly > top + 0.05) {
    s.albedo = vec3f(0.14, 0.135, 0.13);
    s.rough = 0.35;
    return s;
  }
  let mx = fract(lx / 0.9) * 0.9;
  if (min(mx, 0.9 - mx) < 0.035 || abs(ly - 2.5) < 0.035 || ly < 0.07 || ly > top - 0.02) {
    s.albedo = fin.rgb;
    s.metal = fin.w;
    s.rough = frameRough(fin);
    return s;
  }
  let night = gloomLight();
  let ndv = max(-dot(V, n), 0.05);
  let d = vec2f(dot(V, T), V.y) / ndv;
  let foot = max(length(dWorldX), length(dWorldY));
  // Traced lobby (x along the front, y up, z in): polished dark granite
  // floor, a 3.4 m ceiling of downlights 1.2 m apart, and a back wall 4 m in
  // clad in warm timber slats with a stainless mailbox bank and a lift door
  // (with its lit floor indicator) set into it. The downlights throw
  // scallops down the back wall and mirror in the floor: value contrast, not
  // one flat lit plane.
  let o = vec2f(lx, ly);
  var t = 4.0;
  if (d.y < 0.0) { t = min(t, -ly / d.y); }
  if (d.y > 0.0) { t = min(t, (3.4 - ly) / d.y); }
  let h = o + d * t;
  var c = vec3f(0.0);
  var e = 0.0;
  let sx = fract(h.x / 1.2) - 0.5;
  if (t < 4.0 && d.y > 0.0) {
    c = vec3f(0.3);
    let dl = length(vec2f(sx * 1.2, t - 3.4));
    if (dl < 0.07) { e = 8.0; }
  } else if (t < 4.0) {
    // Granite tiles, 600 mm, with the lights' reflections lying in them.
    let g = abs(fract(vec2f(h.x, t) / 0.6) - 0.5) * 0.6;
    c = vec3f(0.12, 0.115, 0.11) * (0.85 + 0.3 * hash21(floor(vec2f(h.x, t) / 0.6))) * select(1.0, 0.6, min(g.x, g.y) < 0.006 && foot < 0.02);
    e = 0.9 * (1.0 - smoothstep(0.05, 0.3, length(vec2f(sx * 1.2, (t - 3.4) * 0.5))));
  } else {
    let mail = fract((h.x + 0.6) / 4.8);
    let lift = abs(fract(h.x / 4.8) - 0.5) * 4.8;
    // Scallop of light below each downlight.
    let pool = (1.0 - smoothstep(0.0, 0.45, abs(sx) * 1.5 + max(2.5 - h.y, 0.0) * 0.22)) * smoothstep(0.2, 1.2, h.y);
    // Timber slats, 90 mm.
    c = vec3f(0.42, 0.27, 0.15) * select(1.0, 0.55, fract(h.x / 0.09) < 0.2 && foot < 0.015) * (0.5 + 1.7 * pool);
    if (lift < 0.55 && h.y < 2.15) {
      // Brushed steel lift doors, a centre seam.
      c = vec3f(0.6, 0.61, 0.62) * (0.7 + 0.6 * pool) * select(1.0, 0.2, lift < 0.012);
    } else if (lift < 0.65 && h.y < 2.25) {
      c = vec3f(0.15);
    } else if (lift < 0.2 && h.y > 2.3 && h.y < 2.42) {
      // Floor indicator.
      c = vec3f(0.05);
      e = select(0.0, 3.0, abs(fract(h.x * 8.0) - 0.5) < 0.2);
    } else if (mail < 0.25 && h.y > 0.6 && h.y < 1.9) {
      // Mailbox bank: rows of small stainless doors with dark slots.
      let mb = fract(vec2f(h.x / 0.3, (h.y - 0.6) / 0.26));
      c = vec3f(0.58, 0.59, 0.6) * (0.8 + 0.4 * pool);
      if (mb.y > 0.62 && mb.y < 0.7 && mb.x > 0.2 && mb.x < 0.8) { c = vec3f(0.04); }
      if (mb.x < 0.05 || mb.y < 0.05) { c = vec3f(0.2); }
    }
    if (h.y < 0.1) { c = vec3f(0.08); }
  }
  let light = vec3f(1.0, 0.88, 0.72) * (luminance(frame.skyAmbient.rgb) * 0.4 + night * 0.45);
  let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(V, n)), 5.0);
  s.albedo = vec3f(0.02);
  s.rough = 0.05;
  s.emissive = (c * light + vec3f(1.0, 0.85, 0.65) * e * mix(0.15, 0.6, night)) * (1.0 - fres);
  s.cls = CLASS_GLASS;
  return s;
}

// Party wall on the lot line: exposed concrete block or a skim-coated
// render, a mid-dark grey (0.35-0.45) mottled by decades of patching, with
// black grime streaks hanging from the coping, dark waterproofing patches,
// steel tie-rod plates at the slabs with rust bleeding below, at most one
// vent, and often the ghost of a demolished shorter neighbour: the rooms it
// sheltered still show their wallpaper, tile and paint, cut by the scars of
// its floor slabs, partitions and stair, under its old stepped or gabled
// roofline (a black flashing line with tar smeared above it). Everything
// that must read at 50-300 m is at least 0.25 m wide, and every fine line
// fades to its mean by pixel footprint.
//
// gen-tile.ts gives party-wall quads aux = seed << 8 | coping height: the
// wall top in body-zone uv.y, in 0.25 m steps. Base quads' uv.y starts
// FACADE_GROUND - bodyH lower; uv is moved into the body frame here so the
// patterns run on unbroken across the base/body seam.
fn partyWall(s: ptr<function, Surf>, uvIn: vec2f, auxIn: u32, bodyH: f32, base: bool) {
  let aux = hashu(auxIn >> 8u);
  let uv = uvIn + vec2f(0.0, select(0.0, FACADE_GROUND - bodyH, base));
  let coping = f32(auxIn & 0xffu) * 0.25;
  let foot = max(length(dWorldX), length(dWorldY));
  let fFine = 1.0 - smoothstep(0.02, 0.06, foot);
  let ab = f32(aux & 255u);
  var a = (*s).albedo * 0.78;
  (*s).sunVis = 1.0;
  (*s).rough = 0.88;
  if (hashuf(aux ^ 0x9a1u) < 0.5) {
    // 390 x 190 mm blocks in running bond.
    let row = floor(uv.y / 0.2);
    let g = vec2f(uv.x / 0.4 + 0.5 * (row - 2.0 * floor(row * 0.5)), uv.y / 0.2);
    let f = abs(fract(g) - 0.5) * vec2f(0.4, 0.2);
    let d = min(0.2 - f.x, 0.1 - f.y);
    let joint = (1.0 - smoothstep(0.004, 0.004 + foot * 1.5, d)) * clamp(0.008 / max(foot, 1e-4), 0.0, 1.0);
    a *= mix(1.0, 0.9 + 0.2 * hash21(floor(g) + ab), fFine) * (1.0 - 0.3 * joint);
    (*s).rough = 0.92;
  } else {
    // Skim coat: trowel patches.
    a *= 0.93 + 0.14 * valueNoise(uv * vec2f(0.9, 1.6) + 5.0);
  }
  // Decades of patching and paint: 2-6 m blotches of different grey, the
  // value structure that survives to the skyline.
  a *= 0.8 + 0.36 * valueNoise(uv * vec2f(0.22, 0.3) + ab * 0.37);
  let gh = hashuf(aux ^ 0x6057u);
  // Inside the ghost of the demolished neighbour: sheltered for decades, so
  // cleaner and warmer than the weathered wall around it (the coping grime
  // below spares it).
  var ghost = 0.0;
  var src = 0.0;
  if (gh < 0.75) {
    let h0 = mix(5.4, 8.6, hashuf(aux ^ 0x6058u));
    let segW = mix(3.5, 6.5, hashuf(aux ^ 0x6059u));
    var top = h0 + floor(hash21(vec2f(floor(uv.x / segW), ab)) * 3.0) * 0.9 - 0.9;
    if (gh < 0.28) {
      // A pitched-roof house: a gable.
      top = h0 + max(0.0, 2.4 - abs(uv.x - segW * 1.6) * 0.55);
    }
    let d = top - uv.y;
    // The old roofline wanders a little (patched flashing, settlement).
    let dw = d + 0.05 * (valueNoise(vec2f(uv.x * 1.3, 2.0)) - 0.5);
    if (d > 0.0) {
      ghost = smoothstep(0.0, 0.3, d);
      a *= vec3f(1.14, 1.1, 1.0);
      // The vanished rooms: 2.7 m storeys, rooms 2.7-4.5 m wide, each with
      // its own finish, partly torn off down to the bare wall.
      let fl = floor(uv.y / 2.7);
      let ly = uv.y - fl * 2.7;
      let rw = mix(2.7, 4.5, hashuf(aux ^ 0x60a1u));
      let rx = floor(uv.x / rw);
      let lx = uv.x - rx * rw;
      let rh = hash21(vec2f(rx, fl) + ab * 1.3);
      let kind = u32(fract(rh * 7.3) * 4.0);
      let pastel = array<vec3f, 5>(vec3f(0.7, 0.66, 0.55), vec3f(0.55, 0.64, 0.6), vec3f(0.66, 0.56, 0.58), vec3f(0.6, 0.62, 0.66), vec3f(0.72, 0.6, 0.42))[u32(rh * 97.0) % 5u];
      var fin = pastel;
      if (kind == 1u) {
        // Wallpaper: faded stripes or a small print.
        let st = mix(0.9, 0.82 + 0.18 * step(0.5, fract(lx / 0.12)), 1.0 - smoothstep(0.015, 0.04, foot));
        fin = pastel * st * 0.92;
      } else if (kind == 2u) {
        // Bathroom or kitchen: 100 mm white or pale blue tile to 1.8 m,
        // dark grout lines.
        if (ly < 1.8) {
          let tc = select(vec3f(0.78, 0.8, 0.8), vec3f(0.55, 0.68, 0.76), fract(rh * 13.0) < 0.5);
          let tg = abs(fract(uv / 0.1) - 0.5) * 0.1;
          let grout = (1.0 - smoothstep(0.003, 0.006, min(tg.x, tg.y))) * (1.0 - smoothstep(0.005, 0.015, foot));
          fin = tc * (1.0 - 0.45 * grout - 0.08 * smoothstep(0.005, 0.015, foot));
        }
      } else if (kind == 3u) {
        // Bare plaster, darker and stained.
        fin = a * 1.05;
      }
      // Decades of weather have faded every finish toward the wall grey;
      // most of each room's survives, torn back at ragged edges.
      fin = mix(fin, vec3f(luminance(fin)), 0.35) * 0.85;
      let rag = valueNoise(uv * vec2f(0.45, 0.6) + rh * 31.0) * 0.75 + valueNoise(uv * 2.3) * 0.25;
      let keep = smoothstep(0.3, 0.4, rag + 0.25 * smoothstep(0.6, 0.0, d)) * step(0.15, fract(rh * 5.1));
      a = mix(a * 1.08, fin, keep * 0.55);
      // Scars: the floor slabs (dark broken concrete, 0.25 m), partition
      // walls (0.12 m) and, in one bay, the stair stringer climbing a storey
      // per flight with a sawtooth of tread notches.
      let slab = 1.0 - smoothstep(0.12, 0.15 + foot, abs(ly - 0.12));
      let part = (1.0 - smoothstep(0.06, 0.08 + foot, min(lx, rw - lx))) * step(0.3, fract(rh * 3.7));
      var scar = max(slab, part * 0.8);
      if (u32(rx + 1000.0) % 3u == hashu(aux ^ 0x60b1u) % 3u && fl < 2.0) {
        let sx = lx / rw;
        let rise = select(sx, 1.0 - sx, (u32(fl) & 1u) == 1u) * 2.7;
        let tread = abs(fract(lx / 0.27) - 0.5) * 0.18 * fFine;
        let sd = ly - rise + tread;
        scar = max(scar, (1.0 - smoothstep(0.14, 0.17 + foot, abs(sd))) * 0.9);
        // The underside of the flight stays cleaner (and darker grey).
        if (sd < 0.0 && sd > -0.5) { a *= 0.85; }
      }
      a = mix(a, vec3f(0.2, 0.19, 0.18), scar * 0.55);
    } else {
      // Dirt washed down onto the old roof from above, and the bitumen
      // smeared up the wall when the flashing was sealed.
      a *= 1.0 - 0.15 * smoothstep(1.2, 0.0, -d) * (0.6 + 0.4 * valueNoise(vec2f(uv.x * 4.0, 0.0)));
      // Bitumen brushed up the wall over the flashing: a ragged 5-20 cm
      // smear, worn through in places.
      let smear = 0.05 + 0.15 * valueNoise(vec2f(uv.x * 2.2, 9.0));
      let tar = (1.0 - smoothstep(smear - 0.03, smear + foot, -dw)) * smoothstep(0.3, 0.55, valueNoise(vec2f(uv.x * 5.0, 3.0)) + 0.2);
      a = mix(a, vec3f(0.1, 0.095, 0.09), tar * 0.6);
    }
    // The flashing itself: a thin bitumen line (albedo ~0.1) at the old
    // roofline, broken where it has peeled, with short drips hanging off
    // its edge.
    let lw = max(0.035, foot * 0.6);
    let brk = smoothstep(0.2, 0.32, valueNoise(vec2f(uv.x * 1.7, 5.0)));
    var fl = (1.0 - smoothstep(lw * 0.5, lw * 0.5 + foot, abs(dw))) * brk;
    let dc = floor(uv.x / 0.23);
    let dh = hash21(vec2f(dc, ab));
    let dx = abs(fract(uv.x / 0.23) - 0.5) * 0.23;
    let dlen = mix(0.05, 0.35, dh);
    fl = max(fl, step(0.6, dh) * brk * (1.0 - smoothstep(0.012, 0.02 + foot, dx + max(dw, 0.0) / dlen * 0.012)) * step(0.0, dw) * step(dw, dlen) * fFine);
    a = mix(a, vec3f(0.1, 0.095, 0.09), fl * 0.85);
    // Run-off sheds off the old flashing in drips 0.5-2 m long.
    let rc = floor(uv.x / 0.6);
    let rh = hash21(vec2f(rc, ab + 3.0));
    let rx = abs(fract(uv.x / 0.6) - 0.5) * 0.6 / mix(0.06, 0.2, rh);
    src = max(src, step(0.35, rh) * (1.0 - smoothstep(0.4, 1.0, rx)) * smoothstep(mix(0.5, 2.0, fract(rh * 7.0)), 0.0, d) * step(0.0, d));
  }
  // Black grime hanging from the coping: soot and algae streaks starting
  // at the wall top, each running down its own length, over a dark band of
  // dirt right under the coping.
  {
    let below = coping - uv.y;
    let cw = 0.9;
    let col = floor(uv.x / cw);
    let ch = hash21(vec2f(col, ab + 7.0));
    let cx = (uv.x - (col + 0.5 + (fract(ch * 23.0) - 0.5) * 0.5) * cw) / (cw * mix(0.12, 0.4, fract(ch * 5.0)));
    // Each streak tails off at its own length on the way down.
    let len = mix(2.0, 11.0, fract(ch * 11.0));
    let topK = smoothstep(len, len * 0.3, below) * step(0.0, below);
    let body = (1.0 - smoothstep(0.3, 1.0, abs(cx))) * mix(1.0, 0.6 + 0.4 * valueNoise(vec2f(uv.x * 9.0, uv.y * 0.3)), fFine);
    let streak = body * step(0.5, ch) * mix(0.45, 1.0, fract(ch * 31.0)) * topK * (0.55 + 0.45 * valueNoise(vec2f(uv.x * 0.8, uv.y * 0.12)));
    a = mix(a, vec3f(0.11, 0.105, 0.1), clamp(streak * 0.65 * (1.0 - 0.8 * ghost), 0.0, 0.65));
    let band = smoothstep(0.9 + 0.4 * valueNoise(vec2f(uv.x * 1.3, 2.0)), 0.0, below) * step(0.0, below);
    a *= 1.0 - 0.4 * band;
    // Rain follows the same paths the soot did: off the coping's drip
    // edge, down each streak (a little longer than its stain), and a wet
    // band right under the coping.
    let wetLen = len * 1.3;
    src = max(src, body * step(0.5, ch) * smoothstep(wetLen, wetLen * 0.2, below) * step(0.0, below));
    src = max(src, band * 0.8);
  }
  // Repairs: ragged patches of fresh render or dark waterproofing coat over
  // cracks. Both stay matte (rough 0.75+): a glossy patch catches a grazing
  // golden-hour sun and glows white.
  let pc = floor(uv / vec2f(3.1, 2.3));
  let ph = hash21(pc + f32(aux & 511u) + 31.0);
  let pf = fract(uv / vec2f(3.1, 2.3)) - vec2f(0.2 + 0.4 * fract(ph * 7.0), 0.3 + 0.3 * fract(ph * 3.0));
  let rag = 0.06 * (valueNoise(uv * 5.0) - 0.5);
  let ext = vec2f(0.15 + 0.2 * fract(ph * 13.0), 0.1 + 0.25 * fract(ph * 17.0));
  if (ph > 0.86 && all(abs(pf) + rag < ext)) {
    let dark = fract(ph * 29.0) < 0.5;
    a = mix(a, select(a * 1.1 + 0.02, vec3f(0.16, 0.165, 0.16), dark), select(0.6, 0.55, dark));
    (*s).rough = select(0.9, 0.75, dark);
  }
  // Vertical crack sealant line now and then.
  let cx = abs(fract(uv.x / 4.3 + hashuf(aux ^ 0x5c1u)) - 0.5) * 4.3 + 0.02 * sin(uv.y * 3.0);
  if (hash21(vec2f(floor(uv.x / 4.3), f32(aux & 63u))) > 0.6) {
    a *= 1.0 - 0.5 * (1.0 - smoothstep(0.008, 0.008 + foot, cx)) * clamp(0.016 / max(foot, 1e-4), 0.0, 1.0);
  }
  // Tie-rod plates (200 mm, rusty) at each slab line every ~3.6 m; rust
  // bleeds 1-2 m down below each.
  // Set out by hand: each plate a little off the grid, some never fitted.
  let tc = vec2f(floor(uv.x / 3.6), floor(uv.y / 3.3 + 0.5));
  let tj = hash22(tc + ab * 0.71);
  let tp = vec2f(uv.x - (tc.x + 0.5) * 3.6 - (tj.x - 0.5) * 0.9, uv.y - tc.y * 3.3 - 0.1 - (tj.y - 0.5) * 0.25);
  let plate = max(abs(tp.x), abs(tp.y));
  if (hashuf(aux ^ 0x7e1u) < 0.6 && fract(tj.x * 7.3 + tj.y * 3.1) > 0.3) {
    let bleed = (1.0 - smoothstep(0.03, 0.09, abs(tp.x) - max(-tp.y, 0.0) * 0.03)) * smoothstep(-1.6, 0.0, tp.y) * step(tp.y, 0.0);
    a = mix(a, vec3f(0.3, 0.17, 0.08), bleed * 0.35 * mix(0.5, 1.0, fFine));
    src = max(src, bleed * 0.8);
    if (plate < 0.1) {
      a = mix(vec3f(0.2, 0.15, 0.11), vec3f(0.3, 0.16, 0.07), smoothstep(0.05, 0.1, plate));
      (*s).metal = 0.2;
      (*s).rough = 0.8;
      if (length(tp) < 0.025) { a = vec3f(0.12); }
    }
  }
  // At most one vent: a small louvred grille.
  let vh = hashuf(aux ^ 0x7e7u);
  let vp = uv - vec2f(mix(1.2, 4.0, vh), mix(3.0, 7.0, fract(vh * 7.0)));
  if (vh < 0.6 && max(abs(vp.x), abs(vp.y)) < 0.16) {
    a = vec3f(0.45, 0.45, 0.43) * mix(0.9, select(0.55, 1.0, fract(vp.y / 0.04) > 0.4), fFine);
    (*s).metal = 0.3;
    (*s).rough = 0.7;
  }
  if (vh < 0.6) {
    let vb = (1.0 - smoothstep(0.1, 0.2, abs(vp.x))) * smoothstep(-1.4, -0.16, vp.y) * step(vp.y, -0.16);
    src = max(src, vb * 0.8);
  }
  (*s).albedo = a;
  rainSrc = src;
  // A blank wall towering over low roofs gets no street or sign light: at
  // night, light pollution and the glow of the streets below still show
  // its value structure instead of a pitch-black slab.
  (*s).emissive += a * (frame.cityGlow.rgb * 0.4 + vec3f(0.001, 0.0013, 0.002)) * nightLight();
}

// Street-face ground-floor cladding, chosen per tenancy (each pair of
// bays, like the shop type), so a row of shops reads as different
// businesses: the building's dark granite (900 x 600 slabs), warm beige
// granite, terracotta brick slips, small glazed square tiles in teal, cream
// or oxblood, or black polished stone. Joints fade out by pixel footprint.
// Returns albedo and roughness.
fn baseCladding(uv: vec2f, granite: vec3f, aux: u32, bay: f32) -> vec4f {
  let foot = max(length(dWorldX), length(dWorldY));
  let unit = floor(floor(uv.x / bay) / 2.0);
  let k = hashu(aux ^ u32(unit + 3000.0) ^ 0xc1adu) % 7u;
  var size = vec2f(0.9, 0.6);
  var col = granite;
  var grout = 0.6;
  var rough = 0.35;
  if (k == 2u) { col = vec3f(0.46, 0.4, 0.32); }
  if (k == 3u) { size = vec2f(0.227, 0.06); col = vec3f(0.4, 0.19, 0.11); grout = 0.35; rough = 0.7; }
  if (k == 4u) { size = vec2f(0.1, 0.1); col = vec3f(0.1, 0.3, 0.3); grout = 0.4; rough = 0.15; }
  if (k == 5u) { size = vec2f(0.1, 0.1); col = select(vec3f(0.72, 0.68, 0.58), vec3f(0.35, 0.08, 0.07), (aux & 1u) == 1u); grout = 0.45; rough = 0.15; }
  if (k == 6u) { col = vec3f(0.035, 0.035, 0.04); rough = 0.12; }
  let rowOff = select(0.0, 0.5, k == 3u && (u32(floor(uv.y / size.y) + 1000.0) & 1u) == 1u);
  let g = uv / size + vec2f(rowOff, 0.0);
  let f = abs(fract(g) - 0.5) * size;
  let d = min(size.x * 0.5 - f.x, size.y * 0.5 - f.y);
  let jw = select(0.002, 0.004, size.x < 0.5);
  let joint = (1.0 - smoothstep(jw, jw + foot * 1.5, d)) * clamp(jw * 3.0 / max(foot, 1e-4), 0.0, 1.0);
  var a = col * (0.88 + 0.24 * hash21(floor(g) + f32(aux & 255u)));
  let ly = uv.y - floor(uv.y / FACADE_GROUND) * FACADE_GROUND;
  if (ly < 0.18) { a = granite * 0.8; }
  a = mix(a, a * grout, joint);
  return vec4f(a, rough);
}

// Surface overrides once the wall material is done: the granite finish on
// the base, the lobby, and solid walls (no windows). True: `s` is final.
fn facadeZoneSurf(s: ptr<function, Surf>, z: FacadeZone, uv: vec2f, wall: vec3f, n: vec3f, T: vec3f, V: vec3f, aux: u32, bodyH: f32, fin: vec4f, bay: f32) -> bool {
  if (z.zone == FZ_LOBBY) {
    *s = facadeLobby(uv, n, T, V, fin);
    return true;
  }
  if (z.zone == FZ_BASE && z.role <= 1u) {
    let c = baseCladding(uv, wall, aux, bay);
    (*s).albedo = c.rgb;
    (*s).rough = c.a;
    (*s).normal = n;
  }
  if (z.role == 2u && z.zone != FZ_CROWN) { partyWall(s, uv, aux, bodyH, z.zone == FZ_BASE); }
  if (z.role == 3u && z.zone != FZ_CROWN) {
    // Render and ALC panels: no ledges to cast floor shadows; ALC shows a
    // joint every 0.6 m.
    (*s).sunVis = 1.0;
    if (hashuf(aux ^ 0x41cu) < 0.5) {
      let foot = max(length(dWorldX), length(dWorldY));
      let d = abs(fract(uv.y / 0.6) - 0.5) * 0.6;
      let joint = (1.0 - smoothstep(0.004, 0.004 + foot * 1.5, 0.3 - d)) * clamp(0.01 / max(foot, 1e-4), 0.0, 1.0);
      (*s).albedo *= 1.0 - 0.35 * joint;
    }
  }
  if (z.zone == FZ_CROWN || z.zone == FZ_CORE || z.zone == FZ_TRIM) { (*s).sunVis = 1.0; }
  return z.solid;
}
// ---- end facade programs ---------------------------------------------------

// Animated rain run-off: thin rivulets snaking down a vertical surface.
// Returns (coverage, slope across the flow); only resolvable up close, so
// further away it returns its mean coverage and no slope.
fn rivulets(p: vec2f, density: f32, foot: f32) -> vec2f {
  let fk = 1.0 - smoothstep(0.012, 0.045, foot);
  let cw = 0.14;
  let cell = floor(p.x / cw);
  let h = hash21(vec2f(cell, 3.7));
  let cx = (cell + 0.5) * cw + 0.03 * sin(p.y * 2.3 + h * 20.0) + 0.012 * sin(p.y * 9.0 + h * 7.0);
  let w = mix(0.01, 0.022, fract(h * 9.0));
  let d = (p.x - cx) / w;
  // Water arrives in pulses travelling down the trail.
  let pulse = 0.55 + 0.45 * smoothstep(0.6, 1.0, fract(p.y * 0.8 + frame.time.x * mix(1.2, 2.2, h) + h * 5.0));
  let on = step(1.0 - density, h);
  let cov = max(1.0 - d * d, 0.0) * on * pulse;
  return vec2f(mix(density * 0.12, cov, fk), clamp(d, -1.0, 1.0) * on * step(abs(d), 1.0) * fk);
}

// Rain on a facade wall: it soaks darker (porous render more than tile),
// turns satin, carries rivulets (most under the sills and in the wash
// streaks) and wicks up dark from a pooled base. Up-facing ledges, sills and
// slab bevels hold a glossy film.
fn facadeRain(s: ptr<function, Surf>, uv: vec2f, n: vec3f, T: vec3f, washAmt: f32, underSill: f32, porous: f32) {
  let wet = frame.weather.z;
  if (wet <= 0.001) { return; }
  let foot = max(length(dWorldX), length(dWorldY));
  // A blank party wall has no sills: water runs only where something sheds
  // it (rainSrc), and the render soaks unevenly (patches, wetter low down).
  let drip = rainSrc >= 0.0;
  let soak = select(1.0, (0.7 + 0.6 * valueNoise(uv * vec2f(0.4, 0.7) + 17.0)) * mix(1.0, 0.75, smoothstep(2.0, 12.0, uv.y)), drip);
  (*s).albedo *= mix(1.0, 0.6, clamp(wet * porous * soak, 0.0, 1.0));
  // A soaked wall halves its roughness everywhere; the run-off sheets below
  // go near-mirror. The contrast between the two is what reads as wet (the
  // lighting pass boosts the sheen of glossy wet walls): the street-level
  // view up a facade shows grey sky and neon sliding down the streaks.
  // (Soaked render between the drip paths stays matte.)
  (*s).rough = mix((*s).rough, (*s).rough * select(0.5, 0.85, drip), wet);
  let rv = rivulets(uv, select(clamp(0.25 + underSill * 0.6 + washAmt * 0.5, 0.0, 0.9), 0.05 + 0.75 * max(rainSrc, 0.0), drip), foot);
  // Flow streaks: broad (0.2-0.8 m) sheets of run-off that stay glossy
  // and dark, hanging below every sill and ledge and wandering down the
  // wall between them. Big enough to catch the grey sky at 100 m+.
  let fcol = valueNoise(vec2f(uv.x * 1.7, uv.y * 0.07 + 3.0));
  var flow = smoothstep(0.5, 0.8, fcol) * (0.55 + 0.45 * valueNoise(vec2f(uv.x * 0.6, uv.y * 0.25)));
  var sheet = clamp(max(flow, underSill * 0.9 + washAmt * 0.5), 0.0, 1.0);
  if (drip) { sheet = rainSrc * (0.6 + 0.4 * valueNoise(vec2f(uv.x * 4.0, uv.y * 0.5))); }
  (*s).rough = mix((*s).rough, 0.05, sheet * wet * 0.9);
  (*s).albedo *= 1.0 - 0.3 * sheet * wet;
  // The sheet's surface is rippled into vertical runs (5-25 cm), each tilted
  // its own way: the glossy film catches the sky in bright and dark ribbons
  // that read as running water from across the street.
  {
    let rx = uv.x * 9.0 + 1.5 * valueNoise(vec2f(uv.x * 3.0, uv.y * 0.6));
    let rk = (1.0 - smoothstep(0.08, 0.3, foot)) * wet * clamp(sheet + select(0.35, 0.0, drip), 0.0, 1.0);
    // The film also bulges and thins down each run: tilting up and down
    // swings its reflection between the bright sky and the dark street, the
    // contrast that actually reads as a wet wall (sideways tilts only see
    // more of the same grey sky).
    let bulge = valueNoise(vec2f(rx * 0.7 + 5.0, uv.y * 1.1 - frame.time.x * 0.4)) - 0.5;
    (*s).normal = normalize((*s).normal + T * (valueNoise(vec2f(rx, uv.y * 0.15)) - 0.5) * 0.5 * rk + vec3f(0.0, bulge * 0.9 * rk, 0.0));
  }
  let film = clamp(rv.x + select(washAmt * 0.6, 0.0, drip), 0.0, 1.0) * wet;
  (*s).rough = mix((*s).rough, 0.04, film);
  (*s).albedo *= 1.0 - 0.4 * film;
  (*s).normal = normalize((*s).normal + T * rv.y * 0.5 * wet);
  // Pooled water at grade: the wall wicks it up 20-50 cm.
  let pool = (1.0 - smoothstep(0.15, 0.35 + 0.2 * valueNoise(vec2f(uv.x * 1.7, 2.0)), uv.y)) * wet;
  (*s).albedo *= 1.0 - 0.4 * pool;
  (*s).rough = mix((*s).rough, 0.12, pool);
  if (drip) {
    // Splash-back and rising damp: a ragged dark band 0.5-1 m up the base.
    let wick = 1.0 - smoothstep(0.4, 0.8 + 0.4 * valueNoise(vec2f(uv.x * 0.9, 4.0)), uv.y);
    (*s).albedo *= 1.0 - 0.3 * wick * wet;
  }
  let up = smoothstep(0.3, 0.7, (*s).normal.y) * wet;
  (*s).rough = mix((*s).rough, 0.05, up);
  (*s).albedo *= 1.0 - 0.3 * up;
}

// Tenant lettering on upper-floor glass: each floor is let in runs of 2-4
// bays, and about half the runs on zakkyo and office midrises carry the
// tenant's name in big cut-vinyl characters, one per pane, centred across
// the run (カ|ラ|オ|ケ), often with a phone-number strip below. The mask
// is the sign atlas's alpha channel (src/render/sign-atlas.ts, VINYL_*).
// p is the position on the glass from the opening's bottom left, size the
// opening, lxg the bay-local x. Returns (colour, coverage); coverage fades
// to the glyph's mean ink once the glyph is a few pixels tall, so at
// 100-300 m lettered windows read as pale blocks in the dark glass rows.
fn vinyl(p: vec2f, size: vec2f, lxg: f32, bayIdx: f32, floorIdx: f32, bay: f32, aux: u32, kind: u32) -> vec4f {
  let fh = hashu(aux ^ (u32(floorIdx + 500.0) * 0x2c1b3c6du));
  let runLen = 2.0 + f32(fh % 3u);
  let run = floor(bayIdx / runLen);
  let runStart = run * runLen;
  let rs = hashu(fh ^ (u32(run + 1000.0) * 0x9e3779b1u));
  let pLetter = select(0.25, 0.68, kind == 2u || kind == 3u);
  if (hashuf(rs) >= pLetter) { return vec4f(0.0); }
  let nSlot = select(1.0, 2.0, size.x > 1.2);
  let slots = runLen * nSlot;
  var word = (rs >> 4u) % VINYL_WORDS;
  if (f32(VINYL_LEN[word]) > slots) { word = (rs >> 12u) % VINYL_WORDS; }
  if (f32(VINYL_LEN[word]) > slots) { word = 1u; }
  let len = f32(VINYL_LEN[word]);
  // White most often, then yellow, red, and the odd blue or green.
  let ch = hashuf(rs ^ 0xc01u);
  var col = vec3f(0.85, 0.85, 0.82);
  if (ch > 0.45) { col = vec3f(0.9, 0.72, 0.08); }
  if (ch > 0.65) { col = vec3f(0.75, 0.08, 0.06); }
  if (ch > 0.85) { col = select(vec3f(0.06, 0.25, 0.7), vec3f(0.08, 0.45, 0.2), fract(ch * 17.0) < 0.5); }
  let slotW = size.x / nSlot;
  let sash = select(0.0, 1.0, nSlot > 1.5 && p.x > slotW);
  // Facade u runs along T, to the viewer's left: count slots and read
  // glyphs from the other end so the text reads left to right.
  let k = slots - 1.0 - ((bayIdx - runStart) * nSlot + sash) - floor((slots - len) * 0.5);
  let gs = min(min(slotW * 0.82, size.y * 0.5), 1.0);
  let gc = vec2f((sash + 0.5) * slotW, size.y * 0.6);
  var cov = 0.0;
  if (k >= 0.0 && k < len) {
    let q = (p - gc) / gs + 0.5;
    if (all(q > vec2f(0.0)) && all(q < vec2f(1.0))) {
      let cell = word * 8u + u32(k);
      let px = (vec2f(f32(cell % 16u), f32(cell / 16u)) + vec2f(1.0 - q.x, 1.0 - q.y)) * 128.0;
      let want = atlasLod(dUvX * 128.0 / gs, dUvY * 128.0 / gs);
      let a = atlasGrad(px, dUvX * 128.0 / gs, dUvY * 128.0 / gs, want).a;
      // Past mip 3 the cell would bleed: fall back to the mean ink.
      cov = mix(a, 0.3, smoothstep(2.5, 3.5, want));
    }
  }
  // Phone number or notice strip under the characters, centred on the run.
  if (hashuf(rs ^ 0x51u) < 0.6) {
    let runW = runLen * bay;
    let sw = min(runW * 0.7, 2.6);
    let sh = sw / 8.0;
    let sy = gc.y - gs * 0.5 - 0.05 - sh * 0.5;
    let rx = (bayIdx - runStart) * bay + lxg - runW * 0.5;
    let q = vec2f(rx / sw + 0.5, (p.y - sy) / sh + 0.5);
    if (sy - sh * 0.5 > 0.04 && all(q > vec2f(0.0)) && all(q < vec2f(1.0))) {
      let strip = (rs >> 20u) % 32u;
      let px = vec2f(f32(strip % 4u) * 512.0 + (1.0 - q.x) * 512.0, 2048.0 + f32(strip / 4u) * 64.0 + (1.0 - q.y) * 64.0);
      let gxs = vec2f(dUvX.x * 512.0 / sw, dUvX.y * 64.0 / sh);
      let gys = vec2f(dUvY.x * 512.0 / sw, dUvY.y * 64.0 / sh);
      let want = atlasLod(gxs, gys);
      let a = atlasGrad(px, gxs, gys, want).a;
      cov = max(cov, mix(a, 0.25, smoothstep(2.5, 3.5, want)));
    }
  }
  return vec4f(col, cov);
}

// Rear walls: render painted in the building's own colour (cream, pale
// green, blue-grey, off-white or salmon), flaking off near the base where
// damp rises and in the odd patch higher up, showing the grey render
// beneath with a pale lip of lifted paint. Patches are 0.2-1 m so they read
// across a back street; their edges fade by footprint.
fn paintedRender(s: ptr<function, Surf>, uv: vec2f, style: u32, foot: f32) {
  let h = hashu(style * 2246822519u + 0x9a7u);
  // (Weathered exterior paint sits at 0.35-0.5 albedo: brighter pastels
  // blow out to white in a low golden-hour sun.)
  let paint = array<vec3f, 5>(vec3f(0.74, 0.69, 0.57), vec3f(0.6, 0.67, 0.58), vec3f(0.6, 0.65, 0.7), vec3f(0.78, 0.77, 0.73), vec3f(0.74, 0.6, 0.52))[h % 5u] * 0.7;
  let base = (*s).albedo / 0.47;
  let fl = valueNoise(uv * vec2f(1.6, 2.2) + f32(h & 255u)) * 0.7 + valueNoise(uv * 6.0) * 0.3;
  let rise = 0.5 * (1.0 - smoothstep(0.4, 2.6, uv.y)) - 0.17;
  let edge = 0.03 + foot * 0.6;
  let bare = smoothstep(0.66 - edge, 0.66 + edge, fl + rise);
  let lip = (1.0 - smoothstep(0.0, edge * 1.5, abs(fl + rise - 0.66))) * (1.0 - smoothstep(0.02, 0.08, foot));
  (*s).albedo = mix(base * paint, base * vec3f(0.36, 0.35, 0.33), bare) * (1.0 + 0.25 * lip);
  (*s).rough = mix(0.7, 0.92, bare);
}

// Street grime on the bottom of a wall (uv.y = 0 at street level): dirt
// and exhaust soot rising ~1.2 m with a ragged, wandering top edge, over the
// 0-40 cm splash zone where rain throws pavement dirt back up (speckled up
// close). A multiplier, 0.55-0.7 at the foot: it must read at 50 m.
fn groundGrime(uv: vec2f, foot: f32) -> vec3f {
  let top = 1.2 + 0.5 * (valueNoise(vec2f(uv.x * 0.9, 3.0)) - 0.5) + 0.15 * (valueNoise(vec2f(uv.x * 4.0, 7.0)) - 0.5);
  // (Plinths below the street on downhill sides: the dirt fades out below.)
  let dirt = pow(1.0 - smoothstep(0.0, top, uv.y), 1.4) * mix(0.5, 1.0, smoothstep(-2.0, -0.3, uv.y));
  var g = mix(vec3f(1.0), vec3f(0.62, 0.58, 0.52), dirt);
  let sTop = 0.32 + 0.12 * valueNoise(vec2f(uv.x * 2.5, 1.0));
  let speck = mix(0.6, step(0.45, hash21(floor(uv * 60.0))), 1.0 - smoothstep(0.005, 0.015, foot));
  let splash = (1.0 - smoothstep(sTop - 0.1, sTop, uv.y)) + (1.0 - smoothstep(sTop, sTop + 0.15, uv.y)) * speck * 0.5;
  g *= mix(vec3f(1.0), vec3f(0.7, 0.66, 0.6), clamp(splash, 0.0, 1.0) * step(-0.3, uv.y));
  return g;
}

// Packaged goods in a curated, muted retail palette (white and cream
// labels, kraft, brick red, navy, bottle green, mustard, black, orange,
// silver): a shelf reads as rows of products, not a per-item rainbow.
fn goodsColor(h: f32) -> vec3f {
  switch (u32(h * 11.0) % 11u) {
    case 0u: { return vec3f(0.8, 0.78, 0.72); }
    case 1u: { return vec3f(0.74, 0.66, 0.48); }
    case 2u: { return vec3f(0.48, 0.34, 0.2); }
    case 3u: { return vec3f(0.58, 0.13, 0.1); }
    case 4u: { return vec3f(0.12, 0.17, 0.36); }
    case 5u: { return vec3f(0.16, 0.34, 0.19); }
    case 6u: { return vec3f(0.72, 0.55, 0.14); }
    case 7u: { return vec3f(0.07, 0.07, 0.07); }
    case 8u: { return vec3f(0.72, 0.36, 0.12); }
    case 9u: { return vec3f(0.85, 0.84, 0.8); }
    default: { return vec3f(0.5, 0.52, 0.55); }
  }
}

// One shelf of goods. u: metres along the shelf; ry: metres above the shelf
// board; rowH: board pitch; row: a per-shelf id. Products stand in facings
// (2-5 of one item side by side, 0.2-0.55 m per facing): bottles (body,
// shoulder, neck, cap, a label band over the liquid), boxes (pale top band,
// a logo spot) or bags (pillowed tops). Between and above them the shelf
// cavity is dark, which is what makes the shapes read. The board's edge is
// a white price strip with a black lip. drinks: bottles only (coolers).
// Returns albedo and opaque coverage (0 in the gaps); fine shapes fade to
// the facing's own colour by pixel footprint, so a shelf at 30 m is a row
// of muted colour blocks, never noise.
fn shelfGoods(u: f32, ry: f32, rowH: f32, row: f32, drinks: bool, foot: f32) -> vec4f {
  let fk = 1.0 - smoothstep(0.006, 0.02, foot);
  let fs = 1.0 - smoothstep(0.015, 0.05, foot);
  let strip = 0.04;
  let avail = rowH - strip - 0.03;
  let gw = mix(0.2, 0.55, hash21(vec2f(row, 1.7)));
  let gi = floor(u / gw);
  let gh = hash21(vec2f(gi, row * 3.1 + 0.5));
  let gh2 = fract(gh * 37.0);
  let col = goodsColor(fract(gh * 5.3));
  let ht = avail * mix(0.55, 0.95, fract(gh * 13.0));
  let cav = vec3f(0.06, 0.06, 0.065);
  let mean = mix(cav, col * 0.8, 0.6 * ht / avail);
  if (ry < strip) {
    let tag = step(0.8, fract(u / 0.12)) * step(0.012, ry) * fk;
    var c = mix(vec3f(0.85, 0.84, 0.8), vec3f(0.9, 0.75, 0.15), tag);
    if (ry < 0.009) { c = vec3f(0.08); }
    return vec4f(mix(mix(mean, vec3f(0.6), 0.6), c, fs), 1.0);
  }
  let y = ry - strip;
  let nI = 2.0 + floor(gh2 * 4.0);
  let iw = gw / nI;
  let xi = fract(u / iw);
  let dx = abs(xi - 0.5) * 2.0;
  let v = y / ht;
  let shape = select(u32(gh2 * 7.0) % 3u, 0u, drinks);
  var c = col;
  var on = 0.0;
  if (shape == 0u) {
    // Bottle: body to 60 %, shoulder, neck, cap.
    let w = select(select(0.26, mix(0.26, 0.72, smoothstep(0.8, 0.6, v)), v < 0.8), 0.72, v < 0.6);
    on = step(dx, w) * step(v, 1.0);
    let liquid = array<vec3f, 4>(vec3f(0.5, 0.28, 0.1), vec3f(0.62, 0.7, 0.72), vec3f(0.3, 0.42, 0.15), vec3f(0.12, 0.08, 0.06))[u32(fract(gh * 23.0) * 4.0)];
    c = select(liquid, col, v > 0.2 && v < 0.55);
    if (v > 0.9) { c = select(vec3f(0.85), vec3f(0.6, 0.1, 0.08), fract(gh * 31.0) < 0.3); }
  } else if (shape == 1u) {
    on = step(dx, 0.9) * step(v, 1.0);
    c = mix(col, vec3f(0.86, 0.84, 0.8), step(0.78, v) * 0.7);
    if (length(vec2f(dx * iw * 0.5, (v - 0.45) * ht)) < iw * 0.2) {
      c = select(vec3f(0.86), vec3f(0.62, 0.12, 0.1), luminance(col) > 0.45);
    }
  } else {
    on = step(dx, 0.94) * step(v, 1.0 - 0.3 * dx * dx);
    c = col * (0.8 + 0.3 * v);
  }
  // Lit from the ceiling: brighter tops, darker bases, rounded edges.
  c *= mix(0.7, 1.05, clamp(v, 0.0, 1.0)) * (1.0 - 0.35 * smoothstep(0.55, 1.0, dx));
  let res = mix(cav * mix(0.6, 1.0, y / avail), c, on);
  return vec4f(mix(mean, res, fk), mix(0.6 * ht / avail, on, fk));
}

// Magazine rack along the konbini glass: three tiers of covers 0.21 m wide
// over a dark kick panel. Each cover a bold field, a masthead band, a photo
// block and text lines; dark gaps between covers. q.x along the rack, q.y
// up from the floor.
fn magazineRack(q: vec2f, foot: f32) -> vec3f {
  let fk = 1.0 - smoothstep(0.008, 0.03, foot);
  if (q.y < 0.32) { return vec3f(0.12, 0.12, 0.13) * select(1.0, 1.6, q.y > 0.29); }
  let ty = (q.y - 0.32) / 0.27;
  let tier = floor(ty);
  let qx = q.x + tier * 0.08;
  let cv = vec2f(fract(qx / 0.21), fract(ty));
  let h = hash21(vec2f(floor(qx / 0.21), tier + 40.0));
  let bg = array<vec3f, 6>(vec3f(0.85, 0.84, 0.8), vec3f(0.7, 0.12, 0.1), vec3f(0.85, 0.7, 0.15), vec3f(0.08, 0.08, 0.09), vec3f(0.8, 0.6, 0.62), vec3f(0.15, 0.25, 0.5))[u32(h * 6.0)];
  var c = bg;
  let ink = select(vec3f(0.85, 0.84, 0.8), vec3f(0.65, 0.1, 0.08), luminance(bg) > 0.5);
  if (cv.y > 0.8) { c = ink; }
  if (cv.y > 0.22 && cv.y < 0.72 && cv.x > 0.12 && cv.x < 0.88) {
    c = mix(vec3f(0.72, 0.56, 0.45), vec3f(0.35, 0.3, 0.3), step(0.5, fract(h * 17.0)) * step(cv.y, 0.4));
  }
  if (cv.y < 0.18 && cv.y > 0.05 && fract(cv.y * 14.0) > 0.5) { c = mix(c, ink, 0.7); }
  let gap = cv.x < 0.05 || cv.y > 0.96;
  c = select(c, vec3f(0.05), gap);
  let mean = mix(bg, vec3f(0.6, 0.5, 0.45), 0.35) * 0.85;
  return mix(mean, c, fk);
}

// Convenience store seen through its window: a small ray-traced room in
// the tenancy's own frame (x along the shopfront from the unit's left edge,
// y up from the shop floor, z into the store). A magazine rack along the
// glass, gondola runs perpendicular to the window with aisles between them
// (product end caps facing the street under a red/yellow POP header,
// shelves of goods down their sides), side-wall shelving, the back wall of
// lit drinks coolers (bright frames, bottles silhouetted against the lit
// backs), a white floor and a ceiling of bare fluorescent tubes. d is the
// view ray per metre of depth. Returns radiance: konbini are lit cold white
// day and night and at night are the brightest interiors on the street.
// (One room trace and at most four gondola boxes: bounded.)
fn konbiniInterior(p: vec2f, w: f32, d: vec2f, seed: u32, foot: f32) -> vec3f {
  let night = gloomLight();
  let cool = vec3f(0.86, 0.96, 1.1);
  let L = mix(0.32, 0.75, night);
  let fk = 1.0 - smoothstep(0.012, 0.05, foot);
  let dir = vec3f(d, 1.0);
  let o = vec3f(p, 0.0);
  let inv = 1.0 / select(dir, vec3f(1e-4), abs(dir) < vec3f(1e-4));
  // Footprint grows with depth along the ray (the room is seen through the
  // glass); goods use it to fade.
  let footAt = foot * (1.0 + 0.15 * length(dir));
  let sf = f32(seed & 63u);
  // Room: floor, ceiling (2.7 m), back wall (5.6 m), side walls.
  let tyR = select(-o.y * inv.y, (2.7 - o.y) * inv.y, dir.y > 0.0);
  let txR = select(-o.x * inv.x, (w - o.x) * inv.x, dir.x > 0.0);
  var t = min(min(tyR, 5.6), max(txR, 0.0));
  var c = vec3f(0.0);
  var e = vec3f(0.0);
  let hit = o + dir * t;
  if (t == 5.6) {
    // Coolers: glass doors 0.62 m wide from 0.1 to 2.0 m in bright
    // aluminium frames; bottles on wire shelves silhouetted against lit
    // white backs; a lit header strip above.
    let cx = fract(hit.x / 0.62);
    if (hit.y > 0.12 && hit.y < 1.98 && cx > 0.05 && cx < 0.95) {
      let ry = fract((hit.y - 0.12) / 0.31) * 0.31;
      let g = shelfGoods(hit.x, ry, 0.31, floor((hit.y - 0.12) / 0.31) + sf, true, footAt);
      let back = vec3f(0.9, 0.93, 0.95);
      c = mix(back, g.rgb, g.w);
      e = cool * L * mix(0.9, 0.12, g.w);
      // Door handle bar near the hinge-free edge.
      if (abs(cx - 0.88) < 0.012 && hit.y > 0.7 && hit.y < 1.5) { c = vec3f(0.75); e = vec3f(0.0); }
    } else if (hit.y > 2.08 && hit.y < 2.38) {
      // Header strip: the chain's colour bands.
      c = select(vec3f(0.9, 0.9, 0.88), vec3f(0.15, 0.4, 0.75), fract(hit.y * 6.0) < 0.35);
      e = cool * 0.35 * L;
    } else {
      // Frames and mullions: bright brushed aluminium.
      c = vec3f(0.78, 0.8, 0.82);
      e = cool * 0.1 * L;
    }
  } else if (t == tyR && dir.y > 0.0) {
    // Ceiling: rows of bare tubes running along the shopfront.
    c = vec3f(0.85);
    let tz = abs(fract((hit.z - 0.9) / 1.5) - 0.5) * 1.5;
    let tube = 1.0 - smoothstep(0.05, 0.08 + foot * 4.0, tz);
    e = cool * mix(0.15, 8.0, tube) * L;
  } else if (t == tyR) {
    // Polished white vinyl floor, faint 300 mm tile joints, the tubes'
    // reflections lying in it.
    let g = abs(fract(hit.xz / 0.3) - 0.5) * 0.3;
    c = vec3f(0.5, 0.5, 0.49) * (1.0 - 0.15 * (1.0 - smoothstep(0.004, 0.01, min(g.x, g.y))) * fk);
    let rz = abs(fract((hit.z - 0.9) / 1.5) - 0.5) * 1.5;
    e = cool * 0.5 * (1.0 - smoothstep(0.08, 0.25, rz)) * L;
  } else {
    // Side walls: tall shelving, five boards up to 2.0 m, stock boxes above.
    if (hit.y < 0.12) {
      c = vec3f(0.1);
    } else if (hit.y < 1.92) {
      let ry = fract((hit.y - 0.12) / 0.36) * 0.36;
      c = shelfGoods(hit.z, ry, 0.36, floor((hit.y - 0.12) / 0.36) + 20.0 + sf, false, footAt).rgb;
    } else {
      c = select(vec3f(0.55, 0.42, 0.28), vec3f(0.2), fract(hit.z / 0.5) < 0.06) * 0.6;
    }
  }
  // Gondola runs: 0.9 m wide, 1.5 m tall, from 1.5 to 4.6 m deep, every
  // 2.1 m along the front; the ray is tested against the few it can cross.
  let x15 = o.x + dir.x * 1.5;
  let k0 = floor((x15 - 0.6) / 2.1);
  for (var k = -1; k <= 2; k++) {
    let kk = k0 + f32(select(k, -k, dir.x < 0.0));
    let cx0 = 1.05 + kk * 2.1;
    if (cx0 - 0.45 < 0.2 || cx0 + 0.45 > w - 0.2) { continue; }
    let bmin = vec3f(cx0 - 0.45, 0.0, 1.5);
    let bmax = vec3f(cx0 + 0.45, 1.5, 4.6);
    let t0 = (bmin - o) * inv;
    let t1 = (bmax - o) * inv;
    let tn = min(t0, t1);
    let tf = max(t0, t1);
    let tin = max(max(tn.x, tn.y), tn.z);
    let tout = min(min(tf.x, tf.y), tf.z);
    if (tin < tout && tin > 0.0 && tin < t) {
      t = tin;
      let q = o + dir * tin;
      e = vec3f(0.0);
      if (tin == tn.y) {
        c = vec3f(0.55);
      } else if (q.y < 0.1) {
        // Kick plinth.
        c = vec3f(0.12);
      } else if (tin == tn.z) {
        // End cap: a promotion stack on three boards under a POP header.
        if (q.y > 1.2) {
          let pop = hashuf(seed ^ (u32(kk + 50.0) * 0x2c1u));
          c = select(vec3f(0.75, 0.12, 0.08), vec3f(0.92, 0.75, 0.12), pop < 0.5);
          if (abs(q.y - 1.36) < 0.05 && abs(q.x - cx0) < 0.3) { c = vec3f(0.92); }
        } else {
          let ry = fract((q.y - 0.1) / 0.37) * 0.37;
          c = shelfGoods(q.x, ry, 0.37, floor((q.y - 0.1) / 0.37) + kk * 7.0 + 60.0 + sf, false, footAt).rgb;
        }
      } else {
        // Side: four boards of goods.
        let ry = fract((q.y - 0.1) / 0.35) * 0.35;
        c = shelfGoods(q.z, ry, 0.35, floor((q.y - 0.1) / 0.35) + kk * 13.0 + sf, false, footAt).rgb;
        // Shaded side of the run.
        c *= select(1.0, 0.75, (tin == tn.x) == (dir.x > 0.0));
      }
    }
  }
  // Magazine rack along the glass: 0.3 m deep, 1.15 m tall, across the
  // window except the door bay.
  let tm = 0.25;
  let pm = o + dir * tm;
  if (tm < t && pm.y < 1.15 && pm.y > 0.0 && pm.x > 0.3 && pm.x < w - 1.4) {
    c = magazineRack(vec2f(pm.x, pm.y), foot);
    e = vec3f(0.0);
    t = tm;
  }
  // Light falls off a little into the depth of the store.
  return c * cool * L * mix(1.0, 0.75, clamp(t / 6.0, 0.0, 1.0)) + e;
}

// Boutique seen through its window, traced like the konbini (x along the
// unit, y up from the floor, z inward): a pale plaster back wall at 4.5 m
// washed in scallops by warm track spots, a wooden floor, two clothing
// rails across the shop (1.6 m and 3.0 m deep) hung with garments in the
// shop's own three-colour season palette (shirts, dresses and coats:
// shoulders, sleeves, hems at different lengths), and a mannequin standing
// 0.7 m behind the glass. Returns radiance. (Room + two rail planes + one
// mannequin plane: bounded.)
fn boutiqueInterior(p: vec2f, w: f32, d: vec2f, seed: u32, foot: f32) -> vec3f {
  let night = gloomLight();
  let warm = vec3f(1.0, 0.8, 0.58);
  let L = mix(0.28, 0.62, night);
  let fk = 1.0 - smoothstep(0.01, 0.04, foot);
  let dir = vec3f(d, 1.0);
  let o = vec3f(p, 0.0);
  let inv = 1.0 / select(dir, vec3f(1e-4), abs(dir) < vec3f(1e-4));
  let pal = seed % 4u;
  // The season's palette: camel / navy / rust, black / stone / khaki,
  // grey / olive / white or terracotta / cream / slate, plus black.
  var cols = array<vec3f, 4>(vec3f(0.75, 0.68, 0.55), vec3f(0.1, 0.12, 0.2), vec3f(0.5, 0.18, 0.12), vec3f(0.06, 0.06, 0.07));
  if (pal == 1u) { cols[0] = vec3f(0.12, 0.13, 0.15); cols[1] = vec3f(0.7, 0.66, 0.6); cols[2] = vec3f(0.45, 0.4, 0.3); }
  if (pal == 2u) { cols[0] = vec3f(0.6, 0.62, 0.6); cols[1] = vec3f(0.3, 0.36, 0.22); cols[2] = vec3f(0.82, 0.8, 0.76); }
  if (pal == 3u) { cols[0] = vec3f(0.55, 0.3, 0.2); cols[1] = vec3f(0.78, 0.74, 0.66); cols[2] = vec3f(0.18, 0.2, 0.25); }
  // Room.
  let tyR = select(-o.y * inv.y, (2.8 - o.y) * inv.y, dir.y > 0.0);
  let txR = select(-o.x * inv.x, (w - o.x) * inv.x, dir.x > 0.0);
  var t = min(min(tyR, 4.5), max(txR, 0.0));
  let hit = o + dir * t;
  var c = vec3f(0.0);
  var e = vec3f(0.0);
  // Spot pools: a scallop of light under each track spot, every 1.2 m.
  let sx = fract(hit.x / 1.2) - 0.5;
  if (t == tyR && dir.y > 0.0) {
    // Dark ceiling with a black track and bright spot heads.
    c = vec3f(0.12);
    let sz = abs(hit.z - 2.2);
    if (sz < 0.03) { c = vec3f(0.03); }
    if (sz < 0.07 && abs(sx) < 0.05) { e = warm * 6.0 * L; }
  } else if (t == tyR) {
    // Oak floor boards with the spots' pools on them.
    let b = floor(hit.x / 0.15);
    c = vec3f(0.42, 0.28, 0.16) * (0.85 + 0.25 * hash21(vec2f(b, floor(hit.z / 1.2 + hash11(b))))) * select(1.0, 0.7, fract(hit.x / 0.15) < 0.06 && fk > 0.5);
    c *= 1.0 + 1.2 * (1.0 - smoothstep(0.1, 0.35, length(vec2f(sx * 1.2, hit.z - 2.6))));
  } else {
    // Plaster walls washed by scallops of warm light from the track.
    let u = select(hit.z, hit.x, t == 4.5);
    let sc = select(fract(u / 1.2) - 0.5, sx, t == 4.5);
    let pool = (1.0 - smoothstep(0.0, 0.4, abs(sc) * 1.6 + max(2.4 - hit.y, 0.0) * 0.25)) * smoothstep(0.4, 1.4, hit.y);
    c = vec3f(0.66, 0.62, 0.56) * (0.35 + 1.3 * pool);
    // Shelves of folded stock on the back wall.
    if (t == 4.5 && hit.y > 0.9 && hit.y < 1.9 && fract(hit.x / 1.2) > 0.15 && fract(hit.x / 1.2) < 0.85) {
      let ry = fract((hit.y - 0.9) / 0.33);
      if (ry < 0.06) { c = vec3f(0.85); }
      else if (ry < 0.45) {
        let fh = hash21(vec2f(floor(hit.x / 0.3), floor((hit.y - 0.9) / 0.33)));
        c = cols[u32(fh * 4.0) % 4u] * (0.8 + 0.4 * step(0.5, fract(ry * 9.0))) * (1.0 + pool);
      }
    }
    if (hit.y < 0.1) { c = vec3f(0.08); }
  }
  // Clothing rails, then the mannequin, nearest wins.
  for (var r = 1; r >= 0; r--) {
    let depth = 1.6 + f32(r) * 1.4;
    let tr = depth;
    let q = o + dir * tr;
    if (tr > t || q.x < 0.25 || q.x > w - 0.25) { continue; }
    // Rails 1.8 m long with a gap between them.
    let rs = fract((q.x + f32(r) * 0.6) / 2.4);
    if (rs > 0.78) { continue; }
    if (abs(q.y - 1.62) < 0.012 && fk > 0.2) { c = vec3f(0.7); e = vec3f(0.0); t = tr; continue; }
    // Garments every 6-9 cm, grouped by colour; hanger hooks above.
    let gw = 0.075;
    let gid = floor(q.x / gw);
    let gx = fract(q.x / gw);
    let grp = hash21(vec2f(floor(q.x / 0.45), f32(r) * 7.0 + f32(seed & 31u)));
    let gtype = u32(grp * 3.0);
    let bottom = select(select(1.0, 0.55, gtype == 1u), 0.75, gtype == 2u) + 0.05 * hash11(gid);
    let top = 1.56;
    let edge = abs(gx - 0.5);
    let sleeve = q.y > top - 0.3 && q.y < top - 0.05;
    let hookOn = abs(fract(q.x / gw) - 0.5) < 0.08 && q.y > top && q.y < 1.62;
    if (hookOn && fk > 0.3) { c = vec3f(0.6); e = vec3f(0.0); t = tr; continue; }
    let inG = q.y > bottom && q.y < top - edge * 0.12 && (edge < 0.42 || sleeve);
    if (inG) {
      var gc = cols[u32(fract(grp * 7.0) * 3.0 + hash11(gid + 0.5) * 1.3) % 4u];
      // Folds and side shading: each garment is a rounded fold, darker at
      // its edges and hem.
      gc *= (1.0 - 0.45 * smoothstep(0.2, 0.45, edge)) * mix(0.75, 1.0, smoothstep(bottom, bottom + 0.3, q.y));
      // The spot above the rail lights its upper part.
      gc *= 1.0 + 0.8 * (1.0 - smoothstep(0.0, 0.45, abs(fract(q.x / 1.2) - 0.5))) * smoothstep(0.9, 1.5, q.y);
      c = mix(mix(cols[0] * 0.6, cols[1] * 0.6, 0.5), gc, mix(0.4, 1.0, fk));
      e = vec3f(0.0);
      t = tr;
    }
  }
  // Mannequin: a pale fibreglass figure 0.7 m in, dressed in the palette's
  // first colour, one per shop.
  {
    let tmq = 0.7;
    let q = o + dir * tmq;
    let mx = q.x - (0.9 + hashuf(seed ^ 0x3a1u) * max(w - 1.8, 0.0));
    let hy = q.y;
    var on = 0;
    if (length(vec2f(mx, (hy - 1.62) * 0.8)) < 0.1) { on = 1; }
    if (hy > 1.48 && hy < 1.53 && abs(mx) < 0.035) { on = 1; }
    let tw = select(0.21 - (hy - 1.0) * 0.08, 0.17 + (1.0 - hy) * 0.25, hy < 1.0);
    if (hy > 0.55 && hy < 1.48 && abs(mx) < tw) { on = 2; }
    if (hy > 0.08 && hy <= 0.55 && abs(abs(mx) - 0.06) < 0.045) { on = 1; }
    if (hy > 0.0 && hy < 0.04 && abs(mx) < 0.18) { on = 3; }
    if (on > 0 && tmq < t) {
      t = tmq;
      e = vec3f(0.0);
      if (on == 1) { c = vec3f(0.88, 0.86, 0.82); }
      if (on == 2) { c = cols[1] * (1.0 - 0.4 * smoothstep(0.05, 0.2, abs(mx))) * 1.3; }
      if (on == 3) { c = vec3f(0.1); }
    }
  }
  return c * warm * L * mix(1.0, 0.7, clamp(t / 5.0, 0.0, 1.0)) + e;
}

// Integral of a joint indicator (joints occupy [0, g) of each unit period).
fn jointInt(t: f32, g: f32) -> f32 {
  return floor(t) * g + min(fract(t), g);
}

// Fraction of the pixel footprint [x - fw/2, x + fw/2] (in periods) that
// lies in a joint of relative width g centred on each integer: the exact
// box-filtered joint mask, crisp at one pixel and its mean g at range.
fn jointCov(x: f32, fw: f32, g: f32) -> f32 {
  let w = max(fw, 1e-4);
  let a = x + g * 0.5 - w * 0.5;
  return clamp((jointInt(a + w, g) - jointInt(a, g)) / w, 0.0, 1.0);
}

// Glazed facade tile ("nichokake", 227 x 60 mm on a 240 x 69 mm pitch, half
// bond, 8-10 mm recessed cement joints), analytic in facade metres. The
// joints are box-filtered by the pixel footprint along each axis, so they
// stay one crisp line down to a pixel and average to the right mortar
// fraction beyond; per-tile kiln tone, gloss and setting tilt fade out as a
// tile shrinks below ~3 pixels. Replaces the old 0.96 m detail texture,
// whose 4 x 14 fixed tones and mip blur read as blotchy blocks.
struct TileBond {
  mortar: f32,   // filtered joint coverage
  tone: vec3f,   // albedo multiplier of the tile face (1 = palette colour)
  gloss: f32,    // tile face roughness
  tilt: vec2f,   // normal offset along (T, up)
  kTile: f32,    // 1 while a tile spans several pixels
};

fn tileBond(uv: vec2f, aux: u32) -> TileBond {
  var b: TileBond;
  let pitch = vec2f(0.24, 0.069);
  let g = vec2f(0.009, 0.009) / pitch;
  let fw = (abs(dUvX) + abs(dUvY)) / pitch;
  let tv = uv.y / pitch.y;
  let row = floor(tv);
  let odd = row - 2.0 * floor(row * 0.5);
  let tu = uv.x / pitch.x + 0.5 * odd;
  let col = floor(tu);
  let mh = jointCov(tv, fw.y, g.y);
  // Head joints alternate by row: once rows blur together, their mean.
  let mv = mix(jointCov(tu, fw.x, g.x), g.x, smoothstep(0.35, 0.9, fw.y));
  b.mortar = mh + mv - mh * mv;
  let tileF = max(fw.x, fw.y);
  b.kTile = 1.0 - smoothstep(0.5, 1.2, tileF);
  let h = hash22(vec2f(col, row) + f32(aux & 255u) * 0.13);
  let h3 = hash21(vec2f(col, row) * 1.37 + 5.0 + f32(aux & 255u));
  // Kiln tone: most tiles within a few percent, a few flashed darker or
  // paler, a slight warm/cool drift between them.
  let flash = select(0.0, select(-0.18, 0.1, h3 > 0.97), h3 < 0.08 || h3 > 0.97);
  let t = (h.y - 0.5) * 0.26 + flash;
  let tone = vec3f(1.0 + t * 1.1, 1.0 + t, 1.0 + t * 0.85) * vec3f(1.0 + (h.x - 0.5) * 0.05, 1.0, 1.0 - (h.x - 0.5) * 0.05);
  b.tone = mix(vec3f(1.0), tone, b.kTile);
  b.gloss = mix(0.3, mix(0.1, 0.28, h.x), b.kTile);
  // Each tile set a little out of plane, and pillowed: the glaze rolls off
  // into the joint at its edges (visible once a tile is ~6+ pixels).
  let kNear = 1.0 - smoothstep(0.08, 0.25, tileF);
  let q = vec2f(fract(tu), fract(tv)) * 2.0 - 1.0;
  let pillow = sign(q) * pow(abs(q), vec2f(6.0)) * vec2f(0.35, 0.6);
  b.tilt = (h - 0.5) * 0.12 * b.kTile + pillow * kNear;
  return b;
}

fn facadeMat(world: vec3f, n: vec3f, uv: vec2f, param: u32, aux: u32) -> Surf {
  var s = defaultSurf(n);
  rainSrc = -1.0;
  let style = param & 0x1fffu;
  let kind = (param >> 16u) & 7u;
  let shop = ((param >> 19u) & 1u) == 1u;
  let podium = ((param >> 20u) & 1u) == 1u;
  var st = facadeStyle(style, kind, podium);
  var fz = facadeZone(param);
  let bodyH = st.floorH;
  facadeRole(&st, &fz, uv, aux);
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
  var tb: TileBond;
  if (tiled) { tb = tileBond(uv, aux); }
  // (Tile: an analytic bond; wd then carries only its joint cavity.)
  let wd = select(detailUV(uv, 2.4, DETAIL_CONCRETE), vec4f(0.5, 0.5, 0.5, 1.0 - 0.7 * tb.mortar), tiled);
  // Pixel footprint: every pattern below fades to its mean before it gets
  // smaller than a few pixels, and each fine pattern is backed by a 1-10 m
  // one carrying the same idea to a distance.
  let foot = max(length(dWorldX), length(dWorldY));
  let fFine = 1.0 - smoothstep(0.03, 0.1, foot);
  let fMid = 1.0 - smoothstep(0.25, 0.7, foot);
  let wet = frame.weather.z;
  let streak = mix(0.125, valueNoise(vec2f(uv.x * 3.0, uv.y * 0.15)) * 0.25, fFine);
  // (The grout cavity darkens ambient light through s.ao below, not the
  // albedo: tile joints then read in shade, where the sun's N.L can't.)
  var wall = st.wall * (1.0 - streak * 0.5) * mix(1.0, wd.b * 2.0, select(0.6, 1.0, tiled)) * select(mix(0.6, 1.0, wd.a), 1.0, tiled);
  // Each face of the building has its own tone (sun bleach, a different
  // batch), so corners read even in flat light.
  if (tiled) {
    // Tile faces carry their kiln tone; the recessed cement joints are a
    // mid grey that holds whatever the tile colour.
    wall = mix(wall * tb.tone, vec3f(0.22, 0.215, 0.2) * (1.0 - streak * 0.5), tb.mortar);
  }
  let faceH = hashu(aux ^ (u32(round(atan2(n.z, n.x) * 2.546) + 64.0) * 0x9e3779b1u));
  wall *= mix(0.93, 1.07, hashuf(faceH));
  // Tile batches: 2 x 2 tile patches of slightly different kiln tone, the
  // speckled mosaic a tiled facade shows at 30-80 m.
  if (tiled) {
    wall *= mix(1.0, 0.97 + 0.06 * hash21(floor(uv / vec2f(1.92, 1.38)) + f32(aux & 511u)), fMid);
  }
  // Weathering. Rain washes dirt off the slab edges and window sills into
  // dark streaks hanging below them; they shine in the rain.
  var washAmt = 0.0;
  // Below a window's sill (0 elsewhere): where its run-off and rivulets go.
  var underSill = 0.0;
  let slabBelow = st.floorH - ly;
  {
    let wx0e = (1.0 - st.winW) * 0.5 * st.bay;
    let sillE = (1.0 - st.winH) * st.floorH * 0.55;
    let below = sillE - ly;
    let dirtAmt = mix(0.75, 1.0, hashuf(aux ^ 0x5151u)) * (1.0 + 0.4 * wet);
    // Sill ends: a 0.15 m streak under each end of the sill, 1.5 m long;
    // between them thinner drips of varying length off the sill's drip
    // edge. At a distance, their average darkening over the window width.
    let inX = step(wx0e - 0.1, lx) * step(lx, st.bay - wx0e + 0.1);
    let endD = min(abs(lx - wx0e), abs(lx - (st.bay - wx0e)));
    let endLen = 2.2 * mix(0.6, 1.0, hashuf(cellSeed ^ 0x3131u));
    let dripCol = valueNoise(vec2f(uv.x * 9.0, floorIdx * 3.1));
    let dripLen = mix(0.4, 1.6, valueNoise(vec2f(uv.x * 3.1, floorIdx * 1.7 + 4.0)));
    let near = max(smoothstep(0.14, 0.03, endD) * (0.75 + 0.25 * valueNoise(vec2f(uv.x * 23.0, uv.y * 0.4))) * smoothstep(endLen, 0.0, below),
      max(smoothstep(0.45, 0.75, dripCol) * smoothstep(dripLen, 0.0, below) * 0.8, 0.45 * smoothstep(0.5, 0.0, below)) * inX);
    let far = inX * smoothstep(endLen, 0.0, below) * mix(0.55, 0.75, smoothstep(0.14, 0.03, endD));
    if (below > 0.0 && !fz.solid) {
      washAmt = max(washAmt, mix(far, near, fFine));
      underSill = inX * smoothstep(1.5, 0.0, below);
    }
    // Slab and ledge wash: 0.7-1.4 m wide streaks of varying length below
    // every floor line (deep in the top part of the floor below it).
    let col = valueNoise(vec2f(uv.x * 0.9, floorIdx * 5.3 + 7.0));
    let len = mix(0.6, 2.6, valueNoise(vec2f(uv.x * 0.6 + 3.0, floorIdx * 2.7)));
    washAmt = max(washAmt, smoothstep(0.42, 0.8, col) * smoothstep(len, 0.0, slabBelow) * 0.8);
    // Soot fringe under every ledge: a dark band right under the drip edge
    // that frays into drips of every length (0.2-1.8 m), so each floor line
    // carries a ragged shadow-like stain even in flat light.
    {
      let dn = valueNoise(vec2f(uv.x * 2.7, floorIdx * 3.7 + 11.0));
      let dLen = mix(0.2, 1.8, dn * dn) * mix(0.7, 1.0, valueNoise(vec2f(uv.x * 11.0, floorIdx)));
      let fringe = max(smoothstep(dLen, 0.0, slabBelow) * 0.75, smoothstep(0.35, 0.0, slabBelow) * 0.85);
      washAmt = max(washAmt, mix(smoothstep(1.1, 0.0, slabBelow) * 0.55, fringe, fMid) );
    }
    // Fine drips inside the wash fade out at a distance.
    washAmt *= mix(1.0, 0.75 + 0.5 * valueNoise(vec2f(uv.x * 14.0, floorIdx * 7.7)), fFine);
    // Wash is grime, not shadow: a brownish grey.
    wall = mix(wall, wall * vec3f(0.42, 0.39, 0.35), clamp(dirtAmt * washAmt, 0.0, 0.85));
    // Render is trowelled in patches; tile already has its kiln batches.
    if (!tiled) {
      let patchC = floor(uv / vec2f(2.4, st.floorH));
      wall *= mix(1.0, 0.95 + 0.1 * hash21(patchC + f32(aux & 255u)), 0.5);
    }
    // Mortar darkens where water and dirt collect: near the ground, under
    // sills and ledges, and on the corner piers.
    if (tiled) {
      let edgeDirt = clamp(washAmt + select(0.0, 0.5, fz.solid) + smoothstep(2.0, 0.0, uv.y), 0.0, 1.0);
      wall *= mix(1.0, mix(0.6, 1.0, wd.a), edgeDirt * mix(0.5, 1.0, fFine));
      // Efflorescence: white salt bloom in the joints below each slab line,
      // in patches.
      let eff = smoothstep(0.55, 0.8, valueNoise(uv * vec2f(0.8, 1.5) + 13.0)) * smoothstep(1.1, 0.1, slabBelow);
      wall = mix(wall, vec3f(0.78, 0.77, 0.72), eff * mix(0.09, 0.28 * (1.0 - wd.a) + 0.05, fFine) * mix(0.5, 1.0, fMid));
    }
    // Rust bleed: below AC brackets on the rear (about where gen-tile hangs
    // them, under a sill in a third of the bays) and below sign brackets on
    // street-face piers.
    var rx = 1e3;
    var ry = 0.0;
    if (fz.role == 3u && !fz.solid && hashuf(cellSeed ^ 0xac1u) < 0.3) {
      rx = min(abs(lx - st.bay * 0.5 - 0.3), abs(lx - st.bay * 0.5 + 0.3));
      ry = sillE - 0.75 - ly;
    }
    // Corner piers carry the sign spines and brackets (gen-tile's zakkyo
    // stack sits 0.45 m in from the corner, i.e. 0.15 m from the window
    // field's edge, a bracket near the top of each floor).
    var rLen = 1.4;
    if (fz.solid && fz.role <= 1u && fz.zone == FZ_BODY && hashuf(cellSeed ^ 0x51a1u) < 0.75) {
      rx = min(abs(lx - 0.15), abs(lx - (st.bay - 0.15)));
      ry = st.floorH * 0.9 - 0.1 - ly;
      rLen = mix(1.6, 2.6, hashuf(cellSeed ^ 0x51a2u));
    }
    if (ry > 0.0 && rx < 0.3) {
      // A rust tail widening and fading as it runs down, wavering a little.
      let rw = 0.035 + ry * 0.05;
      let rxw = rx + 0.02 * sin(ry * 5.0 + uv.x * 3.0);
      let rust = (1.0 - smoothstep(rw * 0.4, rw, rxw)) * smoothstep(rLen, 0.0, ry) * (0.65 + 0.35 * valueNoise(vec2f(uv.x * 30.0, uv.y * 2.0)));
      wall = mix(wall, vec3f(0.3, 0.15, 0.06), rust * 0.75 * mix(0.6, 1.0, fFine));
    }
  }
  s.albedo = wall;
  s.rough = 0.75;
  // Analytic occlusion tied to the facade's own structure, so it holds at
  // LOD1 where the ledges and canopy are not geometry (screen-space GTAO
  // multiplies on top): under every floor ledge, the base under the canopy
  // line, the wall foot, and the tile joints.
  {
    // Ledges and the base course project on the street faces only (party
    // walls and the rear are flat): full strength over the ground floor,
    // milder under upper floor lines (a ledge or sill course on some
    // buildings, only the slab joint on others).
    var ledgeAO = 1.0;
    if (fz.role <= 1u && fz.zone != FZ_CROWN) {
      ledgeAO = select(mix(0.7, 1.0, smoothstep(0.0, 0.4, slabBelow)), mix(0.6, 1.0, smoothstep(0.0, 0.5, slabBelow)), fz.zone == FZ_BASE);
      // The shop canopy or awning line (gen-tile hangs it at 0.62 of the
      // ground floor, the shopfront transom): the glass and piers below it
      // sit in its shade.
      if (fz.zone == FZ_BASE) {
        let cb = st.floorH * 0.62 - 0.06 - ly;
        ledgeAO *= select(1.0, mix(0.45, 1.0, smoothstep(0.0, 1.1, cb)), cb > 0.0);
      }
      // Under each window's projecting precast sill (and gen-tile's sill
      // course, where it runs).
      if (fz.zone == FZ_BODY && !fz.solid) {
        let wx0s = (1.0 - st.winW) * 0.5 * st.bay;
        let us = (1.0 - st.winH) * st.floorH * 0.55 - 0.08 - ly;
        if (us > 0.0 && lx > wx0s - 0.05 && lx < st.bay - wx0s + 0.05) {
          ledgeAO *= mix(0.65, 1.0, smoothstep(0.0, 0.35, us));
        }
      }
    }
    // (uv.y < 0 is lower floors on a downhill side: no foot there.)
    s.ao = ledgeAO * mix(0.7, 1.0, select(smoothstep(0.0, 0.3, -uv.y), smoothstep(0.0, 0.9, uv.y), uv.y >= 0.0));
    if (tiled) { s.ao *= mix(0.55, 1.0, wd.a); }
  }
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
    if (tiled) {
      // Glazed tile: in sun the wall sparkles tile by tile and the joints
      // stay matte; past a few pixels per tile the tilts average into a
      // broader, duller lobe.
      s.normal = normalize(s.normal + T * tb.tilt.x + vec3f(0.0, tb.tilt.y, 0.0));
      s.rough = mix(tb.gloss, 0.92, tb.mortar);
    } else {
      s.normal = detailNormal(s.normal, T, vec3f(0.0, 1.0, 0.0), wd, 0.5);
    }
    let lyw = uv.y - floor(uv.y / st.floorH) * st.floorH;
    if (lyw < 0.21 && lyw > 0.18) { s.normal = normalize(s.normal + vec3f(0.0, 0.9, 0.0)); }
  }
  // Roughness drifts over the wall (dust, wear, sealer), not one number.
  s.rough = clamp(s.rough + (valueNoise(uv * vec2f(0.35, 0.6) + 21.0) - 0.5) * 0.16, 0.05, 1.0);
  // Floor slab line.
  if (ly < 0.18) { s.albedo = wall * 0.8; }
  // Shadow cast by the floor ledge above (projecting P metres, underside at
  // the next floor line). Works at every LOD, ledge geometry or not.
  if (sunLit) {
    let P = select(0.18, 0.40, st.family == 4u || podium);
    let sy = P * min(sT.y, 6.0);
    s.sunVis = smoothstep(sy - 0.04, sy + 0.04, st.floorH - ly);
  }

  let fin = frameFinish(style, st.wall);
  let zoneDone = facadeZoneSurf(&s, fz, uv, wall, n, T, V, aux, bodyH, fin, st.bay);
  if (fz.role == 3u && fz.zone != FZ_CROWN) { paintedRender(&s, uv, style, foot); }
  if (fz.zone == FZ_BASE) { s.albedo *= groundGrime(uv, foot); }
  if (fz.zone != FZ_LOBBY) { facadeRain(&s, uv, n, T, washAmt, underSill, select(0.6, 0.3, tiled)); }
  if (zoneDone) { return s; }

  // Ground floor shopfront.
  if (shop && abs(floorIdx) < 0.5) {
    // Each pair of bays is one tenancy: a 0.4 m pier between tenancies (the
    // break that keeps a row of lit shops from merging into one band at
    // a distance), and a fifth of them closed behind shutters.
    let unit = floor(bayIdx / 2.0);
    let shopSeed = hashu(aux ^ u32(unit + 3000.0));
    let lxu = uv.x - unit * 2.0 * st.bay;
    let fru = min(lxu, 2.0 * st.bay - lxu);
    let shutter = hashuf(cellSeed ^ 77u) < 0.12 || hashuf(shopSeed ^ 0x5a5u) < 0.2;
    let fr = min(lx, st.bay - lx);
    if (ly > 0.15 && ly < st.floorH * 0.78 && fr > 0.08 && fru > 0.2) {
      if (shutter) {
        // Painted, slightly grimy corrugated steel shutter.
        s.albedo = vec3f(0.36, 0.37, 0.38) * (0.75 + 0.25 * step(0.5, fract(ly * 12.0))) * mix(1.0, 0.7, smoothstep(1.2, 0.2, ly));
        s.metal = 0.25;
        s.rough = 0.65;
        return s;
      }
      // The shopfront sits in a shallow reveal of the cladding (the opening
      // between this bay's piers: 0.2 m at a tenancy edge, else 0.08 m).
      let firstOfPair = lxu < st.bay;
      let sx0 = select(0.08, 0.2, firstOfPair);
      let sx1 = st.bay - select(0.2, 0.08, firstOfPair);
      let oh = opening(&s, lx, ly, sx0, sx1, 0.15, st.floorH * 0.78, REVEAL_SHOP, V, n, T, wall * 0.6, sl,
        vec3f(1.0, 0.9, 0.75) * mix(0.1, 0.6, gloomLight()));
      if (oh.reveal) { return s; }
      s.ao *= oh.glassAo;
      let gdx = oh.g.x - lx;
      let lx = oh.g.x;
      let ly = oh.g.y;
      let lxu = lxu + gdx;
      // Shop type per pair of bays: convenience store, restaurant (noren),
      // boutique, or dark office lobby.
      let shopType = shopSeed % 4u;
      let night = gloomLight();
      let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(V, n)), 5.0);
      var inside = interior(vec2f(lx, ly), vec2f(st.bay, st.floorH), 6.0, n, T, V, cellSeed, false, 0u);
      var glow = vec3f(1.0, 0.85, 0.6) * 0.2;
      // Aluminium shopfront frame: mullions every ~1.8 m and a transom.
      let mw = st.bay / max(1.0, round(st.bay / 1.8));
      let mx = lx - floor(lx / mw) * mw;
      let tr = st.floorH * 0.62;
      if (min(mx, mw - mx) < 0.035 || abs(ly - tr) < 0.03 || ly < 0.22) {
        s.albedo = fin.rgb;
        s.metal = fin.w;
        s.rough = frameRough(fin);
        return s;
      }
      let ndvP = max(-dot(V, n), 0.05);
      let vP = vec2f(dot(V, T), V.y) / ndvP;
      if (shopType == 2u) {
        // Boutique: rails of garments, a mannequin and warm spots, traced.
        inside = boutiqueInterior(vec2f(lxu, ly), 2.0 * st.bay, vP, shopSeed, foot);
        glow = vec3f(1.0, 0.8, 0.55) * 0.12;
      }
      if (shopType == 0u) {
        // Konbini: a lit store traced behind the glass, cold white tubes.
        let ndvS = max(-dot(V, n), 0.05);
        let vS = vec2f(dot(V, T), V.y) / ndvS;
        inside = konbiniInterior(vec2f(lxu, ly), 2.0 * st.bay, vS, shopSeed, foot);
        glow = vec3f(0.0);
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
      // Posters taped inside the glass at eye level (sale, new product,
      // part-timers wanted): a bold colour field, a white title band and a
      // photo block, lit through from behind by the shop.
      if (shopType <= 2u) {
        let half = st.bay * 0.5;
        let slot = floor(lx / half);
        let ps = hashu(cellSeed ^ (u32(slot + 7.0) * 0x3d1u));
        let pq = vec2f(lx - (slot + 0.5) * half - (hashuf(ps ^ 1u) - 0.5) * 0.25, ly - mix(1.05, 1.45, hashuf(ps ^ 2u)));
        let psz = vec2f(mix(0.42, 0.6, hashuf(ps ^ 3u)), 0.7);
        if (hashuf(ps) < select(0.4, 0.7, shopType == 0u) && abs(pq.x) < psz.x * 0.5 && abs(pq.y) < psz.y * 0.5) {
          let pc = array<vec3f, 5>(vec3f(0.85, 0.12, 0.1), vec3f(0.95, 0.75, 0.1), vec3f(0.1, 0.35, 0.8), vec3f(0.1, 0.6, 0.3), vec3f(0.9, 0.4, 0.6))[hashu(ps ^ 4u) % 5u];
          let v = pq.y / psz.y + 0.5;
          var col = pc;
          if (v > 0.74 && v < 0.94) { col = vec3f(0.92, 0.9, 0.86); }
          if (v > 0.2 && v < 0.62 && abs(pq.x) < psz.x * 0.36) { col = mix(vec3f(0.7, 0.6, 0.5), 0.5 + 0.4 * cos(6.2831 * (hashuf(ps ^ 5u) + vec3f(0.0, 0.33, 0.67))), 0.6); }
          s.albedo = col;
          s.rough = 0.5;
          s.emissive = col * luminance(inside) * 0.35;
          return s;
        }
      }
      s.albedo = vec3f(0.02);
      s.rough = 0.04;
      // Every shop is lit to its own level; the konbini always at full.
      let shopK = select(mix(0.45, 1.15, hashuf(shopSeed ^ 0x1e1u)), 1.3, shopType == 0u);
      s.emissive = (inside * 1.2 * (1.0 - fres) + glow * mix(0.3, 1.0, night)) * shopK;
      s.cls = CLASS_GLASS;
      return s;
    }
    // Piers between tenancies and the band over the glass keep the
    // tenancy's cladding (facadeZoneSurf).

    return s;
  }

  // Windows.
  let wx0 = (1.0 - st.winW) * 0.5 * st.bay;
  let wx1 = st.bay - wx0;
  let sill = (1.0 - st.winH) * st.floorH * 0.55;
  let wy1 = sill + st.winH * st.floorH;
  // (Rear rooms are pantries, toilets and flats: lit room by room, warm or
  // cool, curtained, never one office section's uniform fluorescent.)
  let office = kind <= 2u && !(kind == 2u && hashuf(style) < 0.4) && fz.role != 3u;
  // Office tenants: one per floor and ~6 m of facade, so a floor never
  // lights up as one slab.
  let section = hashu(aux ^ (u32(floorIdx + 500.0) * 7919u) ^ (u32(floor(uv.x / 6.0) + 500.0) * 104729u));
  // Street-face ground floor: a shop, restaurant or office tenancy.
  let baseShop = fz.zone == FZ_BASE && fz.role <= 1u;
  let roomL = roomLight(cellSeed, office, section) * select(1.0, 0.0, baseShop);
  // Stair column: the stair core strip, else one bay in ~11 (about one per
  // building face) holds the stairwell: a small glass-block window per floor
  // that is always lit at night. The stack of identical cool lights is the
  // classic night read.
  let core = fz.zone == FZ_CORE;
  let stairBay = core || ((kind == 2u || kind == 3u || kind == 5u) && floorIdx >= 1.0 && !st.strip && st.family != 3u
    && fz.role != 2u && ((u32(bayIdx + 1000.0) + (aux >> 4u)) % 11u) == 0u);
  if (stairBay) {
    let hw = min(0.45, st.bay * 0.3);
    let y0 = st.floorH * 0.3;
    if (abs(lx - st.bay * 0.5) < hw && ly > y0 && ly < y0 + 1.2) {
      // Set in its own shallow reveal; the stair light (always on at night)
      // spills onto it.
      // The core's small windows are landings and lobby rooms: each lit
      // (or not) like a home's, warm or cool, some curtained.
      let coreL = roomLight(cellSeed, false, section);
      let stairL = select(vec3f(0.7, 0.9, 1.0) * mix(0.02, 0.6, gloomLight()), coreL, core);
      let oh = opening(&s, lx, ly, st.bay * 0.5 - hw, st.bay * 0.5 + hw, y0, y0 + 1.2, REVEAL_GLASSBLOCK, V, n, T, wall, sl, stairL);
      if (oh.reveal) { return s; }
      let lx = oh.g.x;
      let ly = oh.g.y;
      let sx = abs(lx - st.bay * 0.5);
      let sy = ly - y0;
      s.ao = oh.glassAo;
      let e = min(hw - sx, min(sy, 1.2 - sy));
      if (e < 0.045) {
        s.albedo = fin.rgb;
        s.metal = fin.w;
        s.rough = frameRough(fin);
        return s;
      }
      if (core) {
        let pq = vec2f(lx - (st.bay * 0.5 - hw), sy);
        let rs = vec2f(2.0 * hw, 1.2);
        let ps = hash22(vec2f(bayIdx, floorIdx) + f32(aux & 1023u) + 0.7);
        s.normal = normalize(n + T * (ps.x - 0.5) * 0.12 + vec3f(0.0, (ps.y - 0.5) * 0.16, 0.0));
        var inside = interior(pq, rs, mix(2.5, 4.5, hashuf(cellSeed)), n, T, V, cellSeed, false, section);
        inside = windowCover(inside, pq, rs, cellSeed, false, coreL, foot);
        let fresC = 0.04 + 0.96 * pow(1.0 - abs(dot(V, n)), 5.0);
        s.albedo = vec3f(0.035, 0.045, 0.045) * mix(0.7, 1.5, ps.y);
        s.rough = mix(0.03, 0.09, ps.x);
        s.emissive = inside * (1.0 - fresC);
        s.cls = CLASS_GLASS;
        return s;
      }
      // Glass block (190 mm, pale mortar joints): translucent, greenish
      // grey by day; the joints fade to their mean by pixel footprint.
      let gb = abs(fract(vec2f(lx, ly) / 0.19) - 0.5) * 0.19;
      let joint = (1.0 - smoothstep(0.006, 0.02, foot)) * (1.0 - smoothstep(0.006, 0.012, min(gb.x, gb.y))) + 0.15 * smoothstep(0.006, 0.02, foot);
      let cellG = 0.9 + 0.2 * hash21(floor(vec2f(lx, ly) / 0.19) + f32(aux & 255u)) * (1.0 - smoothstep(0.02, 0.06, foot));
      // The flight of stairs behind it: a blurred diagonal shadow,
      // alternating direction floor by floor.
      let slope = select(0.8, -0.8, (u32(floorIdx + 100.0) & 1u) == 0u);
      let flight = 1.0 - 0.45 * (1.0 - smoothstep(0.05, 0.14, abs(sy - 0.6 - (lx - st.bay * 0.5) * slope)));
      s.albedo = mix(vec3f(0.36, 0.42, 0.42) * cellG, vec3f(0.6, 0.6, 0.58), joint);
      s.rough = 0.2;
      s.emissive = vec3f(0.7, 0.9, 1.0) * mix(0.02, 0.2, gloomLight()) * (1.0 - 0.7 * joint) * cellG * flight;
      return s;
    }
  }
  if (!stairBay && lx >= wx0 && lx <= wx1 && ly >= sill && ly <= wy1) {
    // Window reveal (shared opening model): deeper between piers, shallower
    // for the rear's frosted panes.
    let frosted = fz.role == 3u && hashuf(cellSeed ^ 0xf05u) < 0.35;
    let D = select(select(REVEAL_PUNCHED, 0.45, st.family == 2u), REVEAL_FROSTED, frosted);
    let oh = opening(&s, lx, ly, wx0, wx1, sill, wy1, D, V, n, T, wall, sl, roomL);
    if (oh.reveal) { return s; }
    let lxg = oh.g.x;
    let lyg = oh.g.y;
    let fx = min(lxg - wx0, wx1 - lxg);
    let fy = min(lyg - sill, wy1 - lyg);
    let roomSize = vec2f(wx1 - wx0, wy1 - sill);
    // Sash, mullions (ribbon windows) and the meeting rail of sliding sashes,
    // as a distance to the nearest bar so thin bars antialias instead of
    // crawling.
    var barD = min(fx, fy) - 0.045;
    if (st.strip) { barD = min(barD, (0.5 - abs(fract(uv.x / 1.6) - 0.5)) * 1.6 - 0.048); }
    if (!st.strip && roomSize.x > 1.2) { barD = min(barD, abs(lxg - (wx0 + wx1) * 0.5) - 0.022); }
    let barCov = 1.0 - smoothstep(-0.5 * foot, 0.5 * foot, barD);
    let sash = fin.rgb;
    if (barCov > 0.999) {
      // Anodised aluminium sash in the building's finish.
      s.albedo = sash;
      s.metal = fin.w;
      s.rough = mix(frameRough(fin), 0.12, wet);
      return s;
    }
    if (frosted) {
      // Frosted wired glass (bathrooms and toilets): pale and translucent
      // by day; at night a dim, warm, featureless glow when someone's in,
      // with the diamond wire mesh showing up close.
      let q = vec2f(lxg - wx0, lyg - sill);
      let dq = abs(fract(vec2f(q.x + q.y, q.x - q.y) / 0.035) - 0.5) * 0.035;
      let wire = (1.0 - smoothstep(0.0015, 0.003, min(dq.x, dq.y))) * (1.0 - smoothstep(0.004, 0.012, foot));
      let gl = gloomLight();
      let litF = hashuf(cellSeed ^ 0xf06u) < mix(0.03, 0.5, gl);
      let glowF = select(vec3f(0.0), vec3f(1.0, 0.62, 0.32) * mix(0.08, 0.2, hashuf(cellSeed ^ 0xf07u)) * gl, litF);
      s.albedo = mix(vec3f(0.5, 0.52, 0.51) * (1.0 - 0.45 * wire), sash, barCov);
      s.rough = mix(0.4, frameRough(fin), barCov);
      s.metal = fin.w * barCov;
      s.emissive = glowF * (1.0 - 0.5 * wire) * (1.0 - barCov);
      s.ao = oh.glassAo;
      return s;
    }
    // Each pane sits slightly out of plane and bows a little, so neighbours
    // (and the two sashes of one window) reflect different sky and city.
    // Glass gets no wall tile relief.
    let paneSeed = hash22(vec2f(bayIdx, floorIdx) + f32(aux & 1023u) + select(0.0, 0.5, lxg > (wx0 + wx1) * 0.5));
    // (A few degrees: enough to swing a pane from blue sky to a bright cloud
    // or the street, so a glass band breaks into panes at any distance.)
    let wob = (paneSeed - 0.5) * vec2f(0.12, 0.16);
    let pc = (vec2f(lxg - wx0, lyg - sill) / roomSize - 0.5) * 2.0;
    let bow = select(-1.0, 1.0, paneSeed.x > 0.5) * 0.03;
    // Float-glass roller wave: a slow, pane-specific ripple that warps the
    // reflected sky and street differently in every pane (resolves at any
    // distance where the pane spans a few pixels).
    let pw = vec2f(lxg, lyg) * vec2f(1.3, 2.1) + paneSeed * 37.0;
    let warp = vec2f(valueNoise(pw), valueNoise(pw.yx + 11.0)) - 0.5;
    s.normal = normalize(n + T * (wob.x + pc.x * bow + warp.x * 0.02) + vec3f(0.0, wob.y + pc.y * bow + warp.y * 0.03, 0.0));
    // Clean and smudged panes; smudges only where they resolve.
    var rivulet = 0.0;
    var glassRough = mix(0.025, 0.07, fract(paneSeed.y * 7.0))
      + 0.04 * smoothstep(0.6, 0.9, valueNoise(vec2f(lxg, lyg) * 3.0 + paneSeed * 9.0)) * (1.0 - smoothstep(0.02, 0.08, foot));
    if (wet > 0.01) {
      // Rain on the glass: beads up close, and rivulets running down it
      // (heaviest under the head of the frame).
      if (foot < 0.01) {
        let dq = vec2f(lxg, lyg) / 0.03;
        let dc = floor(dq);
        let dh = hash22(dc + f32(aux & 255u));
        let df = fract(dq) - 0.5 - (dh - 0.5) * 0.4;
        let dr = length(df);
        let drop = (1.0 - smoothstep(0.15, 0.3, dr)) * step(0.45, dh.x) * frame.weather.y * (1.0 - smoothstep(0.004, 0.01, foot));
        s.normal = normalize(s.normal + (T * df.x + vec3f(0.0, df.y, 0.0)) * 2.5 * drop);
      }
      // (Drawn at 1.8x scale: water on glass beads into fat trails that
      // must read from the street, not hairlines.)
      let rv = rivulets(vec2f(lxg + f32(cellSeed & 15u) * 0.37, lyg) / 1.8, 0.6 + 0.3 * smoothstep(0.6, 0.0, wy1 - lyg), foot / 1.8);
      s.normal = normalize(s.normal + T * rv.y * 1.2 * wet);
      glassRough = mix(glassRough, 0.12, rv.x * wet * 0.5);
      rivulet = rv.x * wet;
    }
    var inside: vec3f;
    if (baseShop) {
      // Tenancies of two bays, each lit to its own level and a fifth of them
      // closed for the night, so a row of shops never merges into one
      // white band at a distance.
      let unitH = hashu(aux ^ u32(floor(bayIdx / 2.0) + 3000.0) ^ 0x1e1u);
      let unitK = select(mix(0.3, 1.0, hashuf(unitH)), 0.06, hashuf(unitH ^ 0x5a5u) < 0.2);
      inside = shopInterior(vec2f(lxg - wx0, lyg - sill), roomSize, n, T, V, cellSeed, foot) * unitK;
    } else {
      inside = interior(vec2f(lxg - wx0, lyg - sill), roomSize, mix(3.5, 7.0, hashuf(cellSeed)), n, T, V, cellSeed, office, section);
      inside = windowCover(inside, vec2f(lxg - wx0, lyg - sill), roomSize, cellSeed, office, roomL, foot);
      if (!office) { inside = windowClutter(inside, vec2f(lxg - wx0, lyg - sill), roomSize, cellSeed, roomL, foot); }
    }
    let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(V, n)), 5.0);
    // Float glass (faintly green), or on some office buildings a reflective
    // solar film (silver, bronze or blue) that hides the room by day. A
    // water film makes any pane more of a mirror.
    var gl = vec3f(0.035, 0.045, 0.045);
    var see = 1.0;
    if (office && !baseShop && hashuf(hashu(style * 2246822519u + 77u)) < 0.3) {
      gl = array<vec3f, 3>(vec3f(0.22, 0.23, 0.24), vec3f(0.22, 0.17, 0.12), vec3f(0.12, 0.18, 0.26))[hashu(style) % 3u];
      see = mix(0.3, 0.75, nightLight());
    }
    // Every pane is its own batch, tilt and cleanliness: tint and haze
    // vary so a glass band breaks into panes at 50-300 m instead of reading
    // as one dark stripe.
    gl *= mix(0.65, 1.7, paneSeed.y) * mix(vec3f(1.0), vec3f(0.85, 1.0, 1.2), fract(paneSeed.x * 7.0));
    if (fract(paneSeed.x * 13.0) < 0.2) { glassRough = max(glassRough, mix(0.1, 0.18, paneSeed.y)); }
    // Grime collects in the glass's corners and along the bottom bead
    // (wiped clean in the middle): duller, greyer edges on every pane.
    let edgeD = min(min(fx, fy * 1.6), (lyg - sill) * 0.6) - 0.045;
    let grime = (1.0 - smoothstep(0.0, mix(0.08, 0.2, paneSeed.x), edgeD)) * mix(0.35, 0.9, fract(paneSeed.y * 5.0)) * (0.6 + 0.4 * valueNoise(vec2f(lxg, lyg) * 9.0));
    gl = mix(gl, vec3f(0.11, 0.1, 0.09), grime * 0.5);
    glassRough = mix(glassRough, 0.3, grime * 0.6);
    s.albedo = mix(gl + vec3f(0.06) * wet, sash, barCov);
    s.rough = mix(glassRough, frameRough(fin), barCov);
    s.metal = fin.w * barCov;
    // Water trails on the glass refract the room: it breaks up behind them.
    s.emissive = inside * (1.0 - fres) * see * (1.0 - 0.2 * wet) * (1.0 - 0.45 * rivulet) * (1.0 - barCov);
    // Each trail is a lens gathering the bright sky above: pale streaks
    // down the dark glass.
    s.emissive += (frame.skyAmbient.rgb * 0.35 + frame.cityGlow.rgb * 2.0) * rivulet * (1.0 - barCov);
    s.ao = oh.glassAo;
    s.cls = select(CLASS_GLASS, CLASS_DEFAULT, barCov > 0.5);
    if (!baseShop) {
      let sk = glassSticker(vec2f(lxg - wx0, lyg - sill), roomSize, cellSeed, foot);
      let c = sk.a * (1.0 - barCov);
      if (c > 0.0) {
        s.albedo = mix(s.albedo, sk.rgb, c);
        s.rough = mix(s.rough, 0.5, c);
        s.metal *= 1.0 - c;
        s.emissive = mix(s.emissive, sk.rgb * luminance(roomL) * 1.5, c);
        s.cls = select(s.cls, CLASS_DEFAULT, c > 0.5);
      }
    }
    if (!baseShop && fz.zone == FZ_BODY && fz.role <= 1u && (kind == 0u || kind == 2u || kind == 3u)) {
      let vn = vinyl(vec2f(lxg - wx0, lyg - sill), roomSize, lxg, bayIdx, floorIdx, st.bay, aux, kind);
      let c = vn.a * (1.0 - barCov);
      if (c > 0.0) {
        s.albedo = mix(s.albedo, vn.rgb, c);
        s.rough = mix(s.rough, 0.45, c);
        s.metal *= 1.0 - c;
        // Lit from behind by the room, the translucent film glows in its
        // own colour; a dark room leaves it lit by the street only.
        s.emissive = mix(s.emissive, vn.rgb * luminance(roomL) * 2.4, c);
        s.cls = select(s.cls, CLASS_DEFAULT, c > 0.5);
      }
    }
    return s;
  }
  // Window sill: a pale, slightly projecting precast sill; a glossy water
  // film on its top in the rain.
  if (!stairBay && !fz.solid && ly < sill && ly > sill - 0.08 && lx > wx0 - 0.05 && lx < wx1 + 0.05) {
    s.albedo = mix(wall, vec3f(0.62, 0.6, 0.56), 0.6) * (1.0 - 0.3 * wet);
    s.normal = normalize(n + vec3f(0.0, 0.6, 0.0));
    s.rough = mix(0.7, 0.05, wet);
  }
  // Lit windows spill a faint glow onto the wall around them.
  {
    let dx = max(max(wx0 - lx, lx - wx1), 0.0);
    let dy = max(max(sill - ly, ly - wy1), 0.0);
    s.emissive += roomL * s.albedo * 0.05 * smoothstep(0.4, 0.0, length(vec2f(dx, dy))) * f32(!stairBay);
    if (!stairBay && !fz.solid) {
      // Contact darkening round the opening (the reveal's inner corner and
      // the frame's sealant line), strongest at the bottom corners where
      // dirt collects; and the sill's shadow and drip line on the wall just
      // under it, a crisp dark band that reads as a projecting sill.
      let dO = length(vec2f(dx, dy));
      let cornerK = select(1.0, 1.6, dy > 0.0 && ly < sill);
      s.ao *= mix(1.0 - 0.35 * cornerK, 1.0, smoothstep(0.0, 0.1, dO));
      let under = sill - 0.08 - ly;
      if (lx > wx0 - 0.05 && lx < wx1 + 0.05 && under > 0.0) {
        s.albedo *= mix(0.55, 1.0, smoothstep(0.0, 0.07, under));
      }
    }
  }
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

// --- Roads, junction plates, sidewalks, curbs (agents/asset-direction-road.md)
// Road strip uv: x = signed lateral metres (traffic toward the strip's end
// drives on x < 0), y = metres along. aux = lanes | chainSeed << 8.

// Per-chain hash: seed, an integer index and a salt.
fn rdH(seed: u32, k: i32, salt: u32) -> f32 {
  return hashuf(seed ^ hashu(bitcast<u32>(k) * 0x9e3779b9u + salt * 0x85ebca6bu + 0x632be5abu));
}

// Coverage of a filled shape from its signed distance (negative inside) and
// its thinnest dimension w: antialiased, coverage-conserving once the shape
// is thinner than a pixel.
fn rdCov(sd: f32, w: f32, foot: f32) -> f32 {
  return paintLine(max(sd + w * 0.5, 0.0), w, foot);
}

fn rdBox(p: vec2f, b: vec2f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

fn rdSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Isosceles triangle, apex at the origin, base (half width q.x) at y = q.y.
fn rdTri(pIn: vec2f, q: vec2f) -> f32 {
  let p = vec2f(abs(pIn.x), pIn.y);
  let a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
  let b = p - q * vec2f(clamp(p.x / q.x, 0.0, 1.0), 1.0);
  let s = -sign(q.y);
  let d = min(vec2f(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2f(dot(b, b), s * (p.y - q.y)));
  return -sqrt(d.x) * sign(d.y);
}

fn rdRhombus(pIn: vec2f, b: vec2f) -> f32 {
  let p = abs(pIn);
  let nd = (b.x - 2.0 * p.x) * b.x - (b.y - 2.0 * p.y) * b.y;
  let h = clamp(nd / dot(b, b), -1.0, 1.0);
  let d = length(p - 0.5 * b * vec2f(1.0 - h, 1.0 + h));
  return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}

// Dashed line along t: dashes `on` long every `period`, starting at t = 0.
// Returns the distance (along t) to the nearest dash centre.
fn rdDash(t: f32, period: f32, on: f32) -> f32 {
  let u = fract((t - on * 0.5) / period) * period;
  return min(u, period - u);
}

// World tangents of the uv axes (dP/du, dP/dv), from the captured
// derivatives; horizontal and normalized (only used close to the camera).
fn rdUvFrame(T: ptr<function, vec3f>, B: ptr<function, vec3f>) {
  let det = dUvX.x * dUvY.y - dUvX.y * dUvY.x;
  let sd = select(det, 1e-8, abs(det) < 1e-10);
  let t = (dWorldX * dUvY.y - dWorldY * dUvX.y) / sd;
  let b = (dWorldY * dUvX.x - dWorldX * dUvY.x) / sd;
  *T = normalize(vec3f(t.x, 0.0, t.z) + vec3f(1e-6, 0.0, 0.0));
  *B = normalize(vec3f(b.x, 0.0, b.z) + vec3f(0.0, 0.0, 1e-6));
}

// Asphalt by age (0 = fresh binder-rich, near black and satin; 1 = aged,
// grey and open-textured): (base albedo, roughness, aggregate influence).
fn asphaltParams(age: f32) -> vec3f {
  return vec3f(mix(0.06, 0.175, smoothstep(0.15, 0.85, age)), mix(0.72, 0.92, age), mix(0.35, 1.0, age));
}

// Asphalt with the given params (blended across patch edges). Aggregate
// detail at two non-harmonic scales; per-chip albedo fades to the layer's
// mean once a chip is under a pixel (the scales beat into bands otherwise).
// Crack-sealant coverage of the last asphaltSurf call (roadMat lays it back
// over coloured surfacing and paint, which crack with the road).
var<private> rdTar: f32;

fn asphaltSurf(world: vec3f, n: vec3f, p: vec3f, foot: f32, dd: ptr<function, vec4f>) -> Surf {
  var s = defaultSurf(n);
  let d1 = detailXZ(world, 1.3, DETAIL_ASPHALT);
  let rot = mat2x2f(0.6, -0.8, 0.8, 0.6);
  let d2 = detailAt(rot * world.xz, rot * dWorldX.xz, rot * dWorldY.xz, 3.7, DETAIL_ASPHALT);
  let d = mix(d1, d2, 0.4);
  *dd = d;
  let mean = textureSampleLevel(detailTex, detailSampler, vec2f(0.5), DETAIL_ASPHALT, 9.0);
  // Fade the chips by what the (8x anisotropic) sampler resolves, budgeted
  // at 4x: the minor axis, or the major over 4. By the isotropic (major)
  // footprint a grazing street-level view lost the aggregate within 3 m
  // and the carriageway went to a smeared mean.
  let fa = length(dWorldX);
  let fb = length(dWorldY);
  let footA = max(min(fa, fb), max(fa, fb) * 0.25);
  let fade = smoothstep(0.004, 0.02, footA);
  let bb = mix(d.b, mean.b, fade);
  let aa = mix(d.a, mean.a, fade);
  let mref = mean.b * 2.0 * mix(0.55, 1.0, mean.a);
  let m = bb * 2.0 * mix(0.55, 1.0, aa);
  let drift = valueNoise(world.xz * 0.05);
  s.albedo = vec3f(1.02, 1.0, 0.975) * p.x * max(1.0 + p.z * (m - mref), 0.2) * (0.95 + 0.1 * drift);
  // At grazing angles the per-chip gloss and bump turn into horizontal
  // sheen streaks down the far carriageway: calm them toward the mean.
  let ndv = clamp(dot(n, normalize(frame.camPos.xyz - world)), 0.0, 1.0);
  let gz = smoothstep(0.02, 0.2, ndv);
  s.rough = p.y + ((1.0 - aa) * 0.06 - (bb - mean.b) * 0.15) * p.z * mix(0.3, 1.0, gz);
  s.cls = CLASS_GROUND;
  s.normal = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), d, mix(0.5, 1.0, p.z) * mix(0.35, 1.0, gz));
  rdTar = 0.0;
  return s;
}

// Lay sealed-crack tar of coverage c on a surface: glossy black sealant
// (albedo ~0.04, rough ~0.25), so the lines catch the sky at grazing angles.
fn rdApplyTar(s: ptr<function, Surf>, c: f32) {
  // (Dusty and matte once trafficked: at 0.25 the lines mirrored the sky
  // and read as constant blue-black ink at grazing angles.)
  (*s).albedo = mix((*s).albedo, vec3f(0.05, 0.049, 0.047), c);
  (*s).rough = mix((*s).rough, 0.85, c);
  rdTar = max(rdTar, c);
}

// A crack line of width w at distance d (metres), for a footprint fp
// measured across the line (its screen-space rate, not the isotropic
// footprint: a transverse crack at eye level is squeezed along the view, a
// longitudinal one is not). The drawn width never drops under ~0.8 px, so
// cracks survive the anisotropy at street level; coverage beyond the true
// width is allowed up to 2x before the line fades.
fn rdCrackLine(d: f32, w: f32, fp: f32) -> f32 {
  let wf = max(w, fp * 0.8);
  return (1.0 - smoothstep(wf * 0.5 - fp * 0.5, wf * 0.5 + fp * 0.5, d)) * min(1.0, 2.0 * w / wf);
}

// Voronoi edge distance (exact border distance, two-pass) for cells of
// unit size; returns (edge distance, cell hash).
fn rdVoronoiEdge(x: vec2f) -> vec2f {
  let ip = floor(x);
  let fp = fract(x);
  var mr = vec2f(0.0);
  var mg = vec2f(0.0);
  var md = 8.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let o = hash22(ip + g) * 0.8 + 0.1;
      let r = g + o - fp;
      let d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  var ed = 8.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = mg + vec2f(f32(i), f32(j));
      let o = hash22(ip + g) * 0.8 + 0.1;
      let r = g + o - fp;
      let dr = r - mr;
      if (dot(dr, dr) > 1e-5) { ed = min(ed, dot(0.5 * (mr + r), normalize(dr))); }
    }
  }
  return vec2f(ed, hash21(ip + mg));
}

// Coverage of sealed-crack tar on asphalt at world xz: about a third of an
// aged surface carries a block-crack network (1-2 % of the area is tar),
// plus the odd long wandering crack. Coverage-conserving at range.
fn rdCrackNet(q: vec2f, foot: f32) -> f32 {
  let zone = smoothstep(0.55, 0.64, valueNoise(q * 0.07 + 4.0));
  let lone = smoothstep(0.62, 0.7, valueNoise(q * 0.05 + 21.0));
  if (zone + lone < 0.01) { return 0.0; }
  // Mean tar coverage, for footprints too big to resolve a crack.
  let mean = zone * 0.02 + lone * 0.004;
  let fade = 1.0 - smoothstep(0.1, 0.22, foot);
  if (fade <= 0.0) { return mean; }
  let warp = vec2f(valueNoise(q * 2.7), valueNoise(q * 2.7 + 17.0)) - 0.5;
  let v = rdVoronoiEdge(q / 1.8 + warp * 0.12);
  // Sealant strip 4-6 cm, its width wandering along the crack.
  let w = 0.04 + 0.025 * valueNoise(q * 1.3 + 5.0);
  // Some stretches are not cracked (or not sealed): break the net open.
  let keep = smoothstep(0.28, 0.38, valueNoise(q * 0.9 + 13.0));
  let fp = sqrt(length(dWorldX) * length(dWorldY));
  var c = rdCrackLine(v.x * 1.8, w, fp) * zone * keep;
  // Long cracks: an iso-line of low-frequency noise (gradient ~0.4 / m).
  let lw = vec2f(valueNoise(q * 1.9 + 9.0), valueNoise(q * 1.9 + 31.0)) - 0.5;
  let ln = abs(valueNoise(q * 0.25 + lw * 0.15) - 0.5) / 0.4;
  c = max(c, rdCrackLine(ln, w * 0.3, fp) * lone);
  return mix(mean, c, fade);
}

// Sealed cracks on a road strip, laid out the way asphalt actually fails
// (coverage of tar). Mostly longitudinal: down the wheel paths and along
// the paving-lane joints, in broken runs; transverse thermal cracks every
// 5-10 m across part of the width; alligator (fatigue) blocks only inside
// the wheel paths of the oldest stretches. `ck` = how cracked this surface
// is (0 fresh .. 1 old). Line footprints are measured across each line (the
// screen rate of uv.x for longitudinal, of uv.y for transverse ones).
// Paint-erosion halo of the last rdRoadCracks call: 1 within ~2 cm of a
// crack (ragged), so markings flake away either side of it.
var<private> rdNearC: f32;

fn rdNearLine(d: f32, w: f32, n: f32) -> f32 {
  return 1.0 - smoothstep(w * 0.5 + 0.004, w * 0.5 + 0.012 + 0.07 * n * n, d);
}

fn rdRoadCracks(x: f32, along: f32, o: f32, hw: f32, laneW: f32, li: f32, side: i32, seed: u32, ck: f32, foot: f32) -> f32 {
  rdNearC = 0.0;
  if (ck <= 0.0) { return 0.0; }
  // Mean coverage for footprints too coarse to resolve a crack.
  let mean = 0.006 * ck;
  let fade = 1.0 - smoothstep(0.12, 0.3, foot);
  if (fade <= 0.0) { return mean; }
  let fpL = max(length(vec2f(dUvX.x, dUvY.x)), 1e-4);
  let fpT = max(length(vec2f(dUvX.y, dUvY.y)), 1e-4);
  let ax = abs(x);
  var c = 0.0;
  // Width wanders 1.5-7 cm along each crack (two scales), and each run
  // tapers to a hairline over its last metre.
  // Width: hairline over most of a run, opening to 4-8 cm where it has
  // spalled (squared noise: mostly thin, a few wide stretches).
  let wv = valueNoise(vec2f(x * 3.3, along * 3.3) + 2.0);
  let w = (0.02 + 0.035 * valueNoise(vec2f(x * 1.3, along * 1.3) + 5.0)) * (0.15 + 1.7 * wv * wv);
  let en = valueNoise(vec2f(x, along) * 30.0) * 0.6 + valueNoise(vec2f(x, along) * 7.0 + 4.0) * 0.4;
  // Longitudinal, wheel paths: runs of 3-12 m in 9 m cells.
  {
    let cell = floor(along / 9.0);
    let wp = sign(o + 1e-5);
    let hk = i32(cell) * 32 + i32(li) * 4 + side * 2 + select(0, 1, wp > 0.0);
    if (rdH(seed, hk, 80) < 0.5 * ck) {
      let s0 = cell * 9.0 + 6.0 * rdH(seed, hk, 81);
      let s1 = s0 + 3.0 + 9.0 * rdH(seed, hk, 82);
      let span = smoothstep(s0, s0 + 1.0, along) * (1.0 - smoothstep(s1 - 1.0, s1, along));
      let wander = (valueNoise(vec2f(along * 0.7, f32(hk))) - 0.5) * 0.3 + (valueNoise(vec2f(along * 4.0, f32(hk) + 3.0)) - 0.5) * 0.05;
      let dd = abs(abs(o) - 0.85 - wander);
      c = max(c, rdCrackLine(dd, w * (0.25 + 0.75 * span), fpL) * smoothstep(0.0, 0.3, span));
      rdNearC = max(rdNearC, rdNearLine(dd, w, en) * smoothstep(0.0, 0.3, span));
    }
  }
  // Longitudinal, paving joints (lane lines and the crown): long runs.
  {
    let jx = round(ax / laneW) * laneW;
    let cell = floor(along / 14.0);
    let hk = i32(cell) * 16 + i32(round(ax / laneW)) * 2 + side;
    if (rdH(seed, hk, 83) < 0.55 * ck) {
      let s0 = cell * 14.0 + 4.0 * rdH(seed, hk, 84);
      let s1 = s0 + 6.0 + 10.0 * rdH(seed, hk, 85);
      let span = smoothstep(s0, s0 + 1.0, along) * (1.0 - smoothstep(s1 - 1.0, s1, along));
      let wander = (valueNoise(vec2f(along * 0.5, f32(hk) + 9.0)) - 0.5) * 0.16 + (valueNoise(vec2f(along * 5.0, f32(hk))) - 0.5) * 0.04;
      let dd = abs(ax - jx - 0.12 - wander);
      c = max(c, rdCrackLine(dd, w * (0.25 + 0.75 * span), fpL) * smoothstep(0.0, 0.3, span));
      rdNearC = max(rdNearC, rdNearLine(dd, w, en) * smoothstep(0.0, 0.3, span));
    }
  }
  // Transverse: one per 5-10 m cell on old surface, across 30-100 % of the
  // width, wandering and skewed a little.
  {
    let cell = floor(along / 7.5);
    let hk = i32(cell);
    if (rdH(seed, hk, 86) < 0.85 * ck) {
      let t0 = cell * 7.5 + 0.8 + 5.9 * rdH(seed, hk, 87);
      let x0 = mix(-1.0, 0.4, rdH(seed, hk, 88)) * hw;
      let x1 = x0 + mix(0.3, 1.6, rdH(seed, hk, 89)) * hw;
      // Tapers over its last 1.5 m to a hairline, and opens and closes
      // along its length (spalled stretches 3-4x the hairline), with a
      // chipped halo where it crosses paint.
      let span = smoothstep(x0, x0 + 1.5, x) * (1.0 - smoothstep(x1 - 1.5, x1, x));
      let tp = valueNoise(vec2f(x * 0.8, f32(hk) + 5.0));
      let wander = (valueNoise(vec2f(x * 0.9, f32(hk) + 1.0)) - 0.5) * 0.35 + (valueNoise(vec2f(x * 6.0, f32(hk) + 2.0)) - 0.5) * 0.05 + x * (rdH(seed, hk, 90) - 0.5) * 0.08;
      let dd = abs(along - t0 - wander);
      c = max(c, rdCrackLine(dd, w * (0.12 + 0.88 * span * span) * (0.35 + 1.3 * tp * tp), fpT) * smoothstep(0.0, 0.2, span));
      rdNearC = max(rdNearC, rdNearLine(dd, w * (0.5 + 1.5 * tp), en) * smoothstep(0.0, 0.3, span));
    }
  }
  // Alligator blocks in the wheel paths of the oldest stretches.
  {
    let band = 1.0 - smoothstep(0.18, 0.4, abs(abs(o) - 0.85));
    let zone = smoothstep(0.62, 0.72, valueNoise(vec2f(along * 0.11, li * 5.0 + f32(side) * 11.0) + f32(seed & 0xffu))) * smoothstep(0.6, 0.9, ck);
    if (band * zone > 0.01 && foot < 0.05) {
      let q = vec2f(x, along);
      let warp = vec2f(valueNoise(q * 3.1), valueNoise(q * 3.1 + 17.0)) - 0.5;
      let v = rdVoronoiEdge(q / 0.32 + warp * 0.2);
      c = max(c, paintLine(v.x * 0.32, 0.025, foot) * band * zone * (1.0 - smoothstep(0.025, 0.05, foot)));
      rdNearC = max(rdNearC, rdNearLine(v.x * 0.32, 0.025, en) * band * zone);
    }
  }
  return mix(mean, c, fade);
}

// Steel gully grating: bars across (along the road's `t`), slots between.
// Returns (albedo, metal-ness weight); filtered to the mean beyond ~1 cm px.
fn rdGrate(t: f32, foot: f32) -> f32 {
  let slot = 1.0 - paintLine(rdDash(t, 0.03, 0.02), 0.02, foot);
  return slot;
}

// Standing water on a road surface already given its wet film: a damp,
// glossier margin, then a dark mirror (rough 0.02, flat: the aggregate
// bump drowns) with rain ripples.
fn rdPuddle(s: ptr<function, Surf>, world: vec3f, n: vec3f, puddle: f32, margin: f32) {
  (*s).rough = mix((*s).rough, 0.1, margin);
  (*s).albedo *= 1.0 - 0.15 * margin;
  if (puddle <= 0.001) { return; }
  (*s).rough = mix((*s).rough, 0.02, puddle);
  (*s).albedo = mix((*s).albedo, (*s).albedo * 0.3, puddle);
  (*s).metal = mix((*s).metal, 0.0, puddle);
  (*s).normal = normalize(mix((*s).normal, n, puddle));
  if (frame.weather.y > 0.01) {
    let cell = floor(world.xz * 3.0);
    let f = fract(world.xz * 3.0) - 0.5;
    let t = fract(frame.time.x * 1.3 + hash21(cell));
    let r = length(f + (hash22(cell) - 0.5) * 0.4);
    let ring = sin((r - t * 0.5) * 60.0) * exp(-r * 8.0) * (1.0 - t);
    let g = normalize(f + 1e-4) * ring * 0.12 * frame.weather.y;
    (*s).normal = normalize((*s).normal + vec3f(g.x, 0.0, g.y) * puddle);
  }
}

// Cast-iron manhole lid (0.6 m) centred at local p = 0 (metres, along the
// world axes px / py): a cracked darker collar, a 3 cm dark frame gap,
// concentric rings and a grid or radial ribs, rust. Returns lid coverage.
fn rdManhole(s: ptr<function, Surf>, p: vec2f, px: vec3f, py: vec3f, hk: i32, seed: u32, foot: f32, dist: f32) -> f32 {
  let r = length(p);
  if (r >= 0.5) { return 0.0; }
  let collar = 1.0 - smoothstep(0.42, 0.5, r);
  (*s).albedo *= 1.0 - 0.18 * collar;
  let lid = rdCov(r - 0.3, 0.6, foot);
  let gap = paintLine(abs(r - 0.315), 0.03, foot);
  let det = 1.0 - smoothstep(0.004, 0.015, foot);
  let ring = paintLine(abs(fract(r / 0.06) - 0.5) * 0.06, 0.015, foot);
  let ang = atan2(p.y, p.x);
  var rib: f32;
  if (rdH(seed, hk, 63) < 0.5) {
    rib = max(paintLine(abs(fract(p.x / 0.05) - 0.5) * 0.05, 0.012, foot), paintLine(abs(fract(p.y / 0.05) - 0.5) * 0.05, 0.012, foot));
  } else {
    rib = paintLine(abs(fract(ang / 0.2618) - 0.5) * 0.2618 * r, 0.012, foot);
  }
  let raised = max(ring * step(0.2, r), rib * step(r, 0.2));
  let rust = smoothstep(0.55, 0.8, valueNoise(p * 9.0 + f32(hk))) * 0.6;
  var iron = mix(vec3f(0.24, 0.21, 0.18), vec3f(0.3, 0.18, 0.1), rust);
  iron *= mix(0.92, mix(0.7, 1.12, raised), det);
  (*s).albedo = mix((*s).albedo, iron, lid);
  (*s).metal = mix((*s).metal, 0.55, lid);
  (*s).rough = mix((*s).rough, mix(0.38, 0.6, rust) - 0.08 * raised * det, lid);
  (*s).albedo = mix((*s).albedo, vec3f(0.03), gap * 0.8);
  if (dist < 12.0) {
    let rp = normalize(p + 1e-5);
    let tl = (raised - 0.5) * 0.25 * det * lid;
    (*s).normal = normalize((*s).normal + (px * rp.x + py * rp.y) * tl * 0.5);
  }
  (*s).emissive *= 1.0 - lid;
  return lid;
}

// Anti-skid red wear fields at lane offset o (+ toward the curb) and world
// xz q: (wheel-path signed distance in metres, < 0 worn through; red
// islands left inside it, > 0; scuffed-through spots elsewhere, > 0).
// Isotropic in world xz: the paths wander +-0.2 m across the lane on a
// domain warp, with ragged 5-15 cm flaking along their edges.
fn rdRedWear(o: f32, q: vec2f, sideF: f32, fine: f32) -> vec3f {
  let wq = q + vec2f(sideF * 13.1, sideF * 7.3);
  let warp = (valueNoise(wq * 0.32) - 0.5) * 0.4 + (valueNoise(wq * 1.1 + 5.0) - 0.5) * 0.1;
  let wd = abs(abs(o + warp) - 0.85);
  let halfW = 0.15 + 0.13 * valueNoise(wq * 0.45 + 3.0);
  let e = (valueNoise(wq * 5.0 + 31.0) - 0.5) * 0.2 + (valueNoise(wq * 17.0 + 7.0) - 0.5) * 0.09 * fine;
  let sd = wd - halfW + e;
  let isl = valueNoise(wq * 3.3 + 13.0) * 0.75 + (e / 0.2 + 0.5) * 0.25 - 0.6;
  let spots = valueNoise(wq * 1.6 + 8.0) * 0.75 + (e / 0.2 + 0.5) * 0.25 - 0.77;
  return vec3f(sd, isl, spots);
}

fn roadMat(world: vec3f, n: vec3f, uv: vec2f, param: u32, aux: u32) -> Surf {
  let foot = max(length(dWorldX), length(dWorldY));
  let kind = param & 3u;
  let crossStart = (param & 4u) != 0u;
  let crossEnd = (param & 8u) != 0u;
  let len = f32(param >> 4u);
  let widths = array<f32, 4>(7.0, 10.0, 16.0, 24.0);
  let laneDef = array<u32, 4>(1u, 2u, 4u, 6u);
  let w = widths[kind];
  let hw = w * 0.5;
  var lanes = aux & 0xffu;
  if (lanes == 0u) { lanes = laneDef[kind]; }
  var seed = aux >> 8u;
  // Until the chain seed is in the vertex: a stand-in from param (kind,
  // signal ends and length are constant along a chain).
  if (seed == 0u) { seed = hashu(param * 0x2c1b3c6du + 0x5eedu) | 1u; }
  let x = uv.x;
  let ax = abs(x);
  let along = uv.y;
  let fromEnd = len - along;
  let side = select(0, 1, x < 0.0);
  // Approach coordinate: each half carries traffic toward one end.
  let a = select(along, fromEnd, x < 0.0);
  let sig = select(crossStart, crossEnd, x < 0.0);
  let dist = distance(world, frame.camPos.xyz);
  let night = nightLight();

  // ---- S1: resurfacing sections ---------------------------------------
  let tt = along + 37.0 * rdH(seed, 0, 1);
  let k0 = i32(floor(tt / 70.0));
  let bm = f32(k0 - 1) * 70.0 + 25.0 * (rdH(seed, k0 - 1, 2) - 0.5);
  let b0 = f32(k0) * 70.0 + 25.0 * (rdH(seed, k0, 2) - 0.5);
  let b1 = f32(k0 + 1) * 70.0 + 25.0 * (rdH(seed, k0 + 1, 2) - 0.5);
  let b2 = f32(k0 + 2) * 70.0 + 25.0 * (rdH(seed, k0 + 2, 2) - 0.5);
  var sk = k0;
  var dT = min(tt - b0, b1 - tt);
  var seamK = k0;
  if (tt < b0) { sk = k0 - 1; dT = min(b0 - tt, tt - bm); }
  else if (tt >= b1) { sk = k0 + 1; dT = min(tt - b1, b2 - tt); }
  // Which boundary is nearest (for its sealant overband hash).
  seamK = select(sk + 1, sk, abs(tt - select(select(b0, b1, tt >= b1), bm, tt < b0)) < dT + 1e-3);
  // Neighbouring sections alternate between a mid-aged and an old grey
  // contract, so every seam is a visible step (>= 25 sRGB in sun).
  let odd = ((sk + i32(seed & 1u)) & 1) == 1;
  var age = select(0.75 + 0.25 * rdH(seed, sk, 3), 0.35 + 0.1 * rdH(seed, sk, 3), odd);
  var dL = 1e3;
  if (rdH(seed, sk, 4) < 0.35) {
    // One direction resurfaced on its own: a seam down the centre line.
    if (x < 0.0) { age = select(0.35 + 0.1 * rdH(seed, sk, 5), 0.75 + 0.25 * rdH(seed, sk, 5), odd); }
    dL = ax;
  }
  // Signalized mouths are their own contract, mid-aged grey (on near-black
  // fresh binder the stop-line oil band and rubber would not read).
  let mouthS = crossStart && along < 25.0;
  let mouthE = crossEnd && fromEnd < 25.0;
  if (mouthS || mouthE) {
    age = 0.5 + 0.15 * rdH(seed, select(0, 1, mouthE), 21);
    dT = select(abs(along - 25.0), abs(fromEnd - 25.0), mouthE);
    dL = 1e3;
  } else {
    if (crossStart) { dT = min(dT, abs(along - 25.0)); }
    if (crossEnd) { dT = min(dT, abs(fromEnd - 25.0)); }
  }
  // The strip meets the junction plate at a sealed construction joint.
  dT = min(dT, min(abs(along), abs(fromEnd)));
  let ageHost = age;
  // Trench patch: one longitudinal trench on 55 % of chains plus service
  // cuts out to the gutter every 7-12 m.
  var trSd = 1e3;
  var trAc = 0.0;
  var tr0 = 0.0;
  var tr1 = -1.0;
  let trSide = select(-1.0, 1.0, rdH(seed, 0, 31) < 0.5);
  let trX = trSide * (hw - 1.1);
  if (rdH(seed, 0, 30) < 0.55 && len > 30.0) {
    tr0 = 8.0 + rdH(seed, 0, 32) * max(len - 50.0, 0.0);
    tr1 = min(tr0 + 25.0 + 65.0 * rdH(seed, 0, 33), len - 8.0);
    let mid = (tr0 + tr1) * 0.5;
    trSd = rdBox(vec2f(x - trX, along - mid), vec2f(0.4, (tr1 - tr0) * 0.5));
    let ci = floor(along / 9.5);
    let cc = ci * 9.5 + 4.75 + (rdH(seed, i32(ci), 34) - 0.5) * 4.0;
    if (rdH(seed, i32(ci), 35) < 0.7 && cc > tr0 && cc < tr1) {
      let cx0 = trX;
      let cx1 = trSide * (hw - 0.4);
      trSd = min(trSd, rdBox(vec2f(x - (cx0 + cx1) * 0.5, along - cc), vec2f(abs(cx1 - cx0) * 0.5, 0.3)));
    }
  }
  // Utility cut patches: rectangles 1-2.6 x 1.2-3.5 m in the lanes, in
  // ~45 % of 11 m cells per direction (2-4 per approach), plus one in front
  // of most stop lines. Kept inside their cell.
  {
    let pc = floor(a / 11.0);
    let hk = i32(pc) * 2 + side;
    var pr = 0.45;
    if (sig && pc == 1.0) { pr = 0.8; }
    if (rdH(seed, hk, 37) < pr && a > 5.5) {
      let pl = (0.5 + 0.8 * rdH(seed, hk, 38)) * select(1.0, 0.75, kind == 0u);
      let pw = 0.6 + 0.7 * rdH(seed, hk, 39);
      let lat0 = select(0.0, 0.25, kind >= 1u) + pw + 0.1;
      let lat1 = max(hw - 0.9 - pw, lat0);
      let pxc = mix(lat0, lat1, rdH(seed, hk, 46));
      let pac = pc * 11.0 + 2.0 + pl + (7.0 - 2.0 * pl) * rdH(seed, hk, 47);
      trSd = min(trSd, rdBox(vec2f(ax - pxc, a - pac), vec2f(pw, pl * 1.75)));
    }
  }
  // Patch edges are saw cuts that wander: +-5 cm, with ragged bits.
  if (trSd < 1.0) {
    let pe = (valueNoise(world.xz * 4.0 + 3.0) - 0.5) * 0.1 + (valueNoise(world.xz * 19.0 + 8.0) - 0.5) * 0.035 * (1.0 - smoothstep(0.005, 0.02, foot));
    trSd += pe;
  }
  trAc = rdCov(trSd, 0.6, foot);
  // A patch is a different contract: the other end of the age range (a
  // >= 30 sRGB step in sun), plus its own tone and gloss.
  let agePatch = select(ageHost + 0.5, ageHost - 0.5, ageHost > 0.5);
  age = mix(ageHost, agePatch, trAc);
  var ap = mix(asphaltParams(ageHost), asphaltParams(agePatch), trAc);
  ap.x *= 1.0 + trAc * select(0.12, -0.1, ageHost > 0.5);
  ap.y += trAc * select(0.06, -0.1, ageHost > 0.5);
  var dd: vec4f;
  var s = asphaltSurf(world, n, ap, foot, &dd);
  if (trAc > 0.0) {
    // The patch's own surface: roller passes along the road (1 m bands),
    // a blotchy tone where it was raked and compacted unevenly, a
    // different gloss (fresh fill satin, old fill open and matte).
    let roll = valueNoise(vec2f(x * 1.1, along * 0.12) + 19.0);
    let mot = valueNoise(world.xz * 1.6 + 5.0) * 0.7 + valueNoise(world.xz * 5.0 + 1.0) * 0.3;
    s.albedo *= mix(1.0, 0.88 + 0.14 * roll + 0.16 * (mot - 0.5), trAc);
    s.rough = mix(s.rough, s.rough - 0.1 * (roll - 0.5) + 0.1 * (mot - 0.5), trAc);
  }

  // Sealed saw-cut seams (2.5 cm) plus a tar overband on half of them.
  {
    let band = select(0.0, 0.4, rdH(seed, seamK, 6) < 0.5);
    var seam = max(paintLine(dT, 0.025, foot), band * paintLine(dT, 0.15, foot));
    seam = max(seam, max(paintLine(dL, 0.025, foot), select(0.0, 0.4, rdH(seed, sk, 7) < 0.5) * paintLine(dL, 0.15, foot)));
    if (trSd < 100.0) {
      // Patch outlines: a 5 cm glossy tar seal all round, wandering a
      // little; a 15 cm overband on half the chains.
      // Bitumen seal band over the cut: 6-16 cm, squeegeed on so its
      // outer edge is ragged and thin in places, dusted with sand.
      let ts = abs(trSd + (valueNoise(world.xz * 4.0) - 0.5) * 0.03);
      let bw = 0.06 + 0.1 * valueNoise(world.xz * 1.3 + 2.0) * select(0.6, 1.0, rdH(seed, 0, 36) < 0.5);
      let bandE = bw * (0.75 + 0.5 * valueNoise(world.xz * 11.0 + 6.0));
      let sealB = max(paintLine(ts, 0.03, foot), 0.8 * paintLine(ts, bandE, foot));
      let sand = 1.0 + 0.5 * smoothstep(0.7, 0.85, valueNoise(world.xz * 37.0)) * (1.0 - smoothstep(0.004, 0.012, foot));
      s.albedo = mix(s.albedo, vec3f(0.035, 0.034, 0.032) * sand, sealB);
      s.rough = mix(s.rough, 0.4, sealB);
    }
    s.albedo = mix(s.albedo, vec3f(0.03), seam);
    s.rough = mix(s.rough, 0.3, seam);
  }

  // ---- Lanes ------------------------------------------------------------
  let perDir = max(1.0, floor(f32(lanes) * 0.5));
  let laneW = (hw - 0.5) / perDir;
  let li = clamp(floor(ax / laneW), 0.0, perDir - 1.0);
  let lc = (li + 0.5) * laneW;
  // Lateral offset from the lane centre, + toward the curb (Tokyo: left).
  let o = ax - lc;
  var track = exp(-pow((abs(o) - 0.85) * 2.8, 2.0));
  track = mix(track, 0.22, smoothstep(0.08, 0.35, foot));
  // Edge line / gutter geometry.
  let green = kind <= 1u && rdH(seed, 0, 40) < 0.5;
  let ec = select(hw - 0.525, hw - 1.175, green);
  let gIn = select(hw - 0.45, hw - 0.4, kind >= 2u);
  let inner = select(0.0, 0.25, kind >= 1u);
  let inCross = (crossStart && along < 5.0) || (crossEnd && fromEnd < 5.0);
  // Sealed cracks (laid over again on coloured surfacing and paint below).
  rdApplyTar(&s, rdRoadCracks(x, along, o, hw, laneW, li, side, seed, smoothstep(0.3, 0.8, age), foot) * (1.0 - smoothstep(gIn - 0.35, gIn - 0.1, ax)));

  // ---- S3: coloured surfacing ---------------------------------------------
  var surfCol = vec3f(0.0);
  var surfCov = 0.0;
  var surfRough = 0.9;
  var isRed = false;
  var redWorn = 0.0;
  // Anti-skid red on 35 % of signalized kind >= 2 approaches.
  if (sig && kind >= 2u && rdH(seed, 0, 41) < 0.22 && side == select(0, 1, rdH(seed, 0, 45) < 0.5)) {
    let a1 = 22.0 + 12.0 * rdH(seed, side, 42);
    let c = rdCov(rdBox(vec2f(ax - (inner + ec - 0.075) * 0.5, a - (7.0 + a1) * 0.5), vec2f((ec - 0.075 - inner) * 0.5, (a1 - 7.0) * 0.5)), 1.0, foot);
    if (c > 0.0) {
      // Calcined-bauxite chips in resin: a dull, dusty brick red (well
      // below the salmon of fresh resin), mottled chip by chip and in broad
      // patches, worn through to the grey asphalt in the wheel paths.
      let mott = (dd.b * 2.0 - 1.0) * 0.7 + 0.22 * (valueNoise(world.xz * 0.9 + 4.0) - 0.5) + 0.08 * (valueNoise(world.xz * 7.0) - 0.5);
      let red = vec3f(0.24, 0.13, 0.11) * clamp(1.0 + mott, 0.7, 1.3);
      // Wear-through: isotropic world-xz fields (no lane-stretched noise:
      // squeezed 40:1 along the lane it read as motion blur), edges AA'd
      // by their own screen-space rate (finite differences one pixel over
      // in x and y), not by the isotropic footprint, which at a grazing
      // view is the along-view rate and smeared every edge over a metre.
      let sxl = sign(x + 1e-6);
      let doX = sxl * dUvX.x;
      let doY = sxl * dUvY.x;
      let fineK = 1.0 - smoothstep(0.006, 0.02, sqrt(length(dWorldX) * length(dWorldY)));
      let sideF = li * 3.7 + f32(side) * 9.0;
      let f0 = rdRedWear(o, world.xz, sideF, fineK);
      let fX = rdRedWear(o + doX, world.xz + dWorldX.xz, sideF, fineK);
      let fY = rdRedWear(o + doY, world.xz + dWorldY.xz, sideF, fineK);
      let fw = sqrt((fX - f0) * (fX - f0) + (fY - f0) * (fY - f0));
      // x: path sd (m), y: islands, z: scuffs; hard edges (t +- 0.03 /
      // 4 mm) widened to the pixel rate.
      let kw = max(vec3f(0.004, 0.03, 0.03), fw * 0.6);
      let path = 1.0 - smoothstep(-kw.x, kw.x, f0.x);
      let isl = smoothstep(-kw.y, kw.y, f0.y);
      let spots = smoothstep(-kw.z, kw.z, f0.z);
      redWorn = clamp(max(path * (1.0 - isl), spots), 0.0, 1.0);
      surfCol = mix(red, s.albedo, redWorn);
      surfCov = c;
      surfRough = mix(0.93, s.rough, redWorn);
      isRed = true;
    }
  }
  // Blue bike lane band on 25 % of kind 3 chains.
  let bikeBand = kind == 3u && rdH(seed, 0, 43) < 0.25;
  if (bikeBand && !inCross) {
    let c = rdCov(abs(ax - (hw - 1.1)) - 0.5, 1.0, foot) * smoothstep(6.0, 7.0, select(a, 1e3, !sig));
    if (c > surfCov) { surfCol = vec3f(0.08, 0.25, 0.6); surfCov = c; surfRough = 0.8; }
  }
  // Green school-route belt outside the edge line (kinds 0-1).
  if (green && !inCross) {
    let c = rdCov(abs(ax - (ec + 0.075 + gIn) * 0.5) - (gIn - ec - 0.075) * 0.5, gIn - ec - 0.075, foot);
    if (c > surfCov) { surfCol = mix(vec3f(0.12, 0.38, 0.18), s.albedo, 0.25 * track); surfCov = c; surfRough = 0.75; }
  }
  if (surfCov > 0.0) {
    s.albedo = mix(s.albedo, surfCol, surfCov);
    s.rough = mix(s.rough, surfRough, surfCov);
    if (isRed) {
      // Grazing aggregate: 1-3 mm bauxite chips, finer and lower than the
      // asphalt's (half the bump at twice the frequency), gone once a chip
      // is under a pixel.
      let ag = detailXZ(world, 0.65, DETAIL_ASPHALT);
      let agK = 0.9 * (1.0 - smoothstep(0.005, 0.02, sqrt(length(dWorldX) * length(dWorldY))));
      s.normal = normalize(mix(s.normal, detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), ag, agK), surfCov * (1.0 - redWorn)));
    }
  }

  // ---- S4: traffic wear -------------------------------------------------
  {
    let old = age > 0.5;
    // Wheel paths: rubber-darkened and polished on grey asphalt, the
    // binder scrubbed greyer on fresh. Streaky along the road.
    // At grazing angles every roughness wobble becomes a long sheen
    // streak down the carriageway: damp the wear's gloss terms there.
    let ndv = clamp(dot(n, normalize(frame.camPos.xyz - world)), 0.0, 1.0);
    let gz = mix(0.35, 1.0, smoothstep(0.03, 0.25, ndv));
    // Intact resin surfacing is not tyre-polished (only where worn through).
    let redK = 1.0 - 0.8 * surfCov * select(0.0, 1.0 - redWorn, isRed);
    // Blotchy, mildly streaky (3:1, not the 40:1 that read as motion blur).
    let streak = 0.75 + 0.5 * (valueNoise(vec2f(o * 5.0, along * 1.6)) * 0.5 + valueNoise(world.xz * 0.9 + 2.0) * 0.5);
    s.albedo *= 1.0 - select(-0.12, 0.26, old) * track * streak * redK;
    s.rough -= select(0.06, 0.2, old) * track * gz * redK;
    // Oil drip line down every lane centre (cars idle and drip there),
    // blotchy, between the wheel paths.
    let drip = exp(-pow(o / 0.45, 2.0)) * smoothstep(0.35, 0.7, valueNoise(vec2f(o * 3.0, along * 1.2) + 7.0) * 0.6 + valueNoise(world.xz * 0.35) * 0.6) * redK;
    s.albedo *= 1.0 - select(0.25, 0.35, old) * drip * select(1.0, 0.0, kind == 0u);
    s.rough -= 0.15 * drip * gz;
    // Oil / rubber band behind the stop line, down the lane centre: where
    // the queue waits, a 1.2 m black stain fading out over 25 m, plus
    // braking rubber in the wheel paths.
    if (sig && a > 6.0 && a < 34.0) {
      let fadeA = smoothstep(6.0, 6.8, a) * (1.0 - smoothstep(20.0, 34.0, a));
      let blot = 0.7 + 0.6 * valueNoise(world.xz * 1.1 + 3.0);
      let g = exp(-pow(o / 0.6, 2.0)) * fadeA * blot;
      s.albedo *= 1.0 - clamp(0.65 * g * mix(1.0, 0.5, clamp((a - 6.5) / 25.0, 0.0, 1.0)), 0.0, 0.8);
      s.rough -= 0.25 * min(g, 1.0) * gz;
      // Discrete drips where each queued car stood: elongated along the
      // lane (dragged by the tyres), 0.2-0.45 m, densest just behind the
      // stop line, round-ended and sharp (AA'd on their own rate).
      {
        let dc = floor((a - 6.8) / 1.7);
        let hk = i32(dc) * 8 + i32(li) * 2 + side;
        let pr = 0.75 * (1.0 - smoothstep(4.0, 16.0, dc));
        if (rdH(seed, hk, 91) < pr) {
          let dctr = vec2f((rdH(seed, hk, 92) - 0.5) * 0.35, 6.8 + (dc + 0.2 + 0.6 * rdH(seed, hk, 93)) * 1.7);
          let rr = vec2f(0.07 + 0.08 * rdH(seed, hk, 94), 0.12 + 0.16 * rdH(seed, hk, 95));
          let dq = vec2f(o, a) - dctr;
          let ed = (length(dq / rr) - 1.0) * min(rr.x, rr.y) + (valueNoise(world.xz * 14.0) - 0.5) * 0.04;
          let ow = (1.0 - smoothstep(-0.02 - foot * 0.3, 0.008 + foot * 0.3, ed)) * (0.7 + 0.3 * valueNoise(world.xz * 6.0 + 3.0));
          let halo = 1.0 - smoothstep(0.0, 0.18, ed);
          s.albedo *= (1.0 - 0.3 * ow) * (1.0 - 0.1 * halo);
          s.rough -= 0.3 * ow * gz;
        }
      }
      let rub = track * smoothstep(6.0, 7.0, a) * (1.0 - smoothstep(9.0, 22.0, a));
      s.albedo *= 1.0 - 0.3 * rub;
      s.rough -= 0.1 * rub;
    }
    // Dust and debris in the metre next to the gutter.
    let dz = smoothstep(hw - 1.3, hw - 1.1, ax) * (1.0 - smoothstep(gIn - 0.02, gIn, ax));
    s.albedo *= 1.0 + 0.12 * dz;
    s.rough += 0.04 * dz;
    if (dist < 20.0) {
      // Grit, gum and pits: round dots of 0.5-2 cm on jittered 7 cm cells
      // (a grid of hard squares read as a texture artefact).
      let gq = world.xz / 0.07;
      let gcl = floor(gq);
      let gh = hash22(gcl + 0.71);
      let gr = (0.07 + 0.22 * gh.y) * 0.5;
      let gd = length(fract(gq) - 0.5 - (gh - 0.5) * (0.9 - 2.0 * gr)) - gr;
      let gfw = foot / 0.07;
      let spk = step(hash21(gcl * 1.3 + 4.0), 0.16) * (1.0 - smoothstep(-gfw * 0.5, gfw * 0.5, gd)) * dz * smoothstep(0.012, 0.004, foot);
      s.albedo *= 1.0 - mix(0.45, 0.65, gh.x) * spk;
    }
  }

  s.rough = max(s.rough, 0.18);

  // ---- S3: markings, as coverage terms --------------------------------
  // Edge wobble: the line wanders a centimetre.
  let axw = ax + (valueNoise(vec2f(along * 1.3, f32(side) * 7.0)) - 0.5) * 0.02 * smoothstep(0.03, 0.01, foot);
  var covW = 0.0;
  var covY = 0.0;
  var bev = 0.0;          // raised-edge coverage of the dominant line
  var bevDir = vec2f(0.0); // its outward direction in (x, along)
  var edgeD = 0.06;        // distance in from the dominant mark's edge (m)
  var cwBar = -1.0;        // crosswalk bar index (per-bar wear), or -1
  let sx = sign(x + 1e-6);
  // Edge line.
  if (!inCross) {
    let c = paintLine(abs(axw - ec), 0.15, foot);
    covW = c;
    bevDir = vec2f(sx * sign(axw - ec), 0.0);
    edgeD = 0.075 - abs(axw - ec);
  }
  // Centre line: dashed white on kind 1, double yellow on kinds 2-3
  // (solid white on kind 1 within 30 m of a signal).
  if (kind == 1u && !inCross) {
    let dash = select(paintLine(rdDash(along, 10.0, 5.0), 5.0, foot), 1.0, sig && a < 30.0);
    let c = paintLine(ax, 0.15, foot) * dash;
    if (c > covW) { covW = c; bevDir = vec2f(sx, 0.0); }
  }
  if (kind >= 2u && !inCross) {
    let c = paintLine(abs(axw - 0.155), 0.15, foot);
    covY = c;
    if (c > covW) { bevDir = vec2f(sx * sign(axw - 0.155), 0.0); }
  }
  // Lane lines: dashed, solid in the last 30 m before a signal.
  if (kind >= 2u && perDir > 1.0 && !inCross) {
    let kk = clamp(round(ax / laneW), 1.0, perDir - 1.0);
    let period = select(12.0, 15.0, kind == 3u);
    let on = select(5.0, 6.0, kind == 3u);
    let dash = select(paintLine(rdDash(along, period, on), on, foot), 1.0, sig && a > 6.3 && a < 30.0);
    let c = paintLine(abs(axw - kk * laneW), 0.15, foot) * dash;
    if (c > covW) { covW = c; bevDir = vec2f(sx * sign(axw - kk * laneW), 0.0); edgeD = 0.075 - abs(axw - kk * laneW); }
    // Ghost of an old lane line in 30 % of sections.
    if (rdH(seed, sk, 8) < 0.3 && !(mouthS || mouthE)) {
      let off = (0.6 + 0.3 * rdH(seed, sk, 9)) * select(-1.0, 1.0, rdH(seed, sk, 10) < 0.5);
      let g = paintLine(abs(ax - kk * laneW - off), 0.15, foot) * paintLine(rdDash(along + 3.0, period, on), on, foot);
      s.albedo *= 1.0 - 0.15 * g;
      s.rough -= 0.05 * g;
    }
  }
  // Crosswalk bars (0.45 / 0.45) and stop line.
  {
    let cw = (crossStart && along < 5.0) || (crossEnd && fromEnd < 5.0);
    if (cw) {
      let ac = select(along, fromEnd, crossEnd && fromEnd < 5.0);
      let bar = paintLine(abs(fract(x / 0.9 - 0.25 + 0.5) - 0.5) * 0.9, 0.45, foot);
      let c = bar * rdCov(abs(ac - 2.55) - 1.95, 3.9, foot) * rdCov(ax - (gIn - 0.1), 1.0, foot);
      if (c > covW) {
        covW = c;
        bevDir = vec2f(sign(fract(x / 0.9 - 0.25 + 0.5) - 0.5), 0.0);
        edgeD = min(0.225 - abs(fract(x / 0.9 - 0.25 + 0.5) - 0.5) * 0.9, 1.95 - abs(ac - 2.55));
        cwBar = floor(x / 0.9 - 0.25 + 0.5);
      }
    }
    if (sig && a < 7.0) {
      let c = paintLine(abs(a - 6.225), 0.45, foot) * rdCov(abs(ax - (inner + ec) * 0.5) - (ec - inner) * 0.5, 1.0, foot);
      if (c > covW) {
        covW = max(covW, c);
        bevDir = vec2f(0.0, sign(a - 6.225) * select(-1.0, 1.0, x < 0.0));
        edgeD = 0.225 - abs(a - 6.225);
      }
    }
  }
  // Arrows (14 / 32 m) and diamonds (36 / 56 m) in the approach lanes.
  if (sig && kind >= 1u && a > 9.0 && a < 60.0) {
    // Arrow local frame: u lateral (+ toward the curb), v back from the tip.
    let ac = select(32.0, 14.0, a < 23.0);
    let p = vec2f(o, a - (ac - 2.5));
    if ((kind >= 2u || kind == 1u) && a < 40.0) {
      var sd = rdTri(p, vec2f(0.45, 1.5));
      sd = min(sd, rdBox(p - vec2f(0.0, 3.25), vec2f(0.075, 1.75)));
      // Turn branches: leftmost lane straight+left, rightmost straight+right.
      var turn = 0.0;
      if (kind >= 2u && li >= perDir - 1.0) { turn = 1.0; }
      if (kind >= 2u && li <= 0.0) { turn = select(-1.0, 0.0, perDir <= 1.0); }
      if (turn != 0.0) {
        let q0 = vec2f(0.0, 3.6);
        let q1 = vec2f(turn * 0.55, 2.55);
        sd = min(sd, rdSeg(p, q0, q1) - 0.075);
        let dir = normalize(q1 - q0);
        let apex = q1 + dir * 0.85;
        let r = p - apex;
        let lp = vec2f(dot(r, vec2f(-dir.y, dir.x)), dot(r, -dir));
        sd = min(sd, rdTri(lp, vec2f(0.32, 0.85)));
      }
      if (!(kind == 1u && ac > 20.0)) {
        covW = max(covW, rdCov(sd, 0.15, foot));
      }
    }
    if (a > 33.0) {
      let dc = select(56.0, 36.0, a < 46.0);
      let sd = rdRhombus(vec2f(o, a - dc), vec2f(0.75, 1.5));
      covW = max(covW, paintLine(abs(sd + 0.1), 0.2, foot));
    }
  }
  // Blue bike marks: arrow + white glyph every 10 m in the curb lane.
  let bc = floor(a / 10.0) * 10.0 + 5.0;
  if (kind >= 2u && !inCross && !(sig && bc < 14.0)) {
    let p = vec2f(ax - (hw - 1.1), a - bc);
    let arrow = min(rdTri(p - vec2f(0.0, -0.8), vec2f(0.375, 0.7)), rdBox(p - vec2f(0.0, 0.35), vec2f(0.17, 0.45)));
    let bcov = rdCov(arrow, 0.34, foot);
    if (bcov > 0.0) {
      s.albedo = mix(s.albedo, mix(vec3f(0.08, 0.25, 0.6), s.albedo, 0.3 * track), bcov);
      s.rough = mix(s.rough, 0.6, bcov);
    }
    let g = p - vec2f(0.0, 2.6);
    var gd = min(abs(length(g - vec2f(0.0, -0.42)) - 0.25), abs(length(g - vec2f(0.0, 0.42)) - 0.25));
    gd = min(gd, rdSeg(g, vec2f(0.0, -0.42), vec2f(0.0, 0.42)));
    covW = max(covW, paintLine(gd, 0.05, foot));
    if (bikeBand) {
      covW = max(covW, paintLine(abs(ax - (hw - 1.675)), 0.15, foot) * paintLine(rdDash(along, 3.0, 2.0), 2.0, foot));
    }
  }
  // Fire-hydrant frame every ~110 m near the gutter.
  {
    let hc = floor(along / 110.0);
    let hp = hc * 110.0 + 15.0 + 80.0 * rdH(seed, i32(hc) * 2 + side, 44);
    let p = vec2f(ax - (ec - 0.75), along - hp);
    covY = max(covY, paintLine(abs(rdBox(p, vec2f(0.25))), 0.1, foot));
  }

  // Paint response: dirty off-white / yellow thermoplastic, worn in the
  // wheel paths and in aged sections; aggregate pokes through.
  var cov = max(covW, covY);
  var paintCov = 0.0;
  if (cov > 0.001) {
    let yellow = covY > covW;
    // Worn through where tyres run: the wheel-path mask (its strength
    // different on every crosswalk bar and stretch of line) broken up by
    // 2-5 cm noise into ragged holes, chipped along the edges, and pitted
    // with aggregate speckle (chips of asphalt showing through) everywhere.
    // Older sections wear more. Fine terms fade to their mean with range.
    let tr0w = exp(-pow((abs(o) - 0.85) * 2.4, 2.0));
    let fineK = 1.0 - smoothstep(0.004, 0.012, foot);
    let midK = 1.0 - smoothstep(0.01, 0.03, foot);
    let barV = select(valueNoise(vec2f(along * 0.25, o * 0.6) + 11.0), hash11(cwBar * 7.31 + f32(seed & 0xffu)), cwBar > -0.5);
    let track = tr0w * mix(0.35, 1.15, barV) + select(0.0, 0.12, ageHost > 0.6);
    let n4 = mix(0.5, valueNoise(world.xz * 22.0), midK) * 0.6 + mix(0.5, valueNoise(world.xz * 55.0 + 3.0), fineK) * 0.4;
    let chip = (1.0 - smoothstep(0.0, 0.05, edgeD)) * mix(0.5, valueNoise(world.xz * 40.0 + 7.0), fineK) * 0.55;
    let holeF = smoothstep(0.5, 0.56, track * 0.82 + (n4 - 0.5) * 0.7 + chip + 0.04);
    // Aggregate speckle: round 0.5-1.2 cm chips poking through, jittered
    // in 2 cm cells, denser in the tracks.
    let sq = world.xz / 0.02;
    let sc = floor(sq);
    let sh = hash22(sc + 0.5);
    let sr = length(fract(sq) - 0.5 - (sh - 0.5) * 0.5);
    let speck = step(1.0 - (0.04 + 0.12 * tr0w), hash21(sc * 1.3 + 2.0)) * (1.0 - smoothstep(0.12 + 0.18 * sh.x, 0.2 + 0.18 * sh.x, sr)) * (1.0 - smoothstep(0.002, 0.006, foot));
    let hole = mix(max(holeF, speck), 0.06 + 0.4 * tr0w * mix(0.35, 1.15, barV), smoothstep(0.012, 0.06, foot));
    var wear = (1.0 - 0.95 * hole) * select(1.0, 0.88, ageHost > 0.6);
    let poke = mix(smoothstep(0.35, 0.95, dd.a), 0.8, smoothstep(0.01, 0.04, foot));
    wear *= mix(0.75, 1.0, poke);
    // Paint flakes away for a ragged 1-3 cm either side of a crack.
    wear *= 1.0 - 0.9 * rdNearC;
    paintCov = cov * wear;
    // Dirty thermoplastic: off-white ~0.72, yellow; grimier on old
    // sections; paint residue left in the pores of the worn holes.
    let grime = select(1.0, 0.92, ageHost > 0.6) * (0.94 + 0.08 * valueNoise(world.xz * 0.8));
    var col = select(vec3f(0.655, 0.65, 0.62), vec3f(0.64, 0.44, 0.055), yellow) * grime;
    // Tyre-black smudges where the queue brakes and pulls away: the
    // crosswalk and stop line in the wheel paths.
    if (sig && a < 9.0) {
      let sm = tr0w * smoothstep(0.35, 0.75, valueNoise(vec2f(o * 3.0, along * 0.9) + 21.0) * 0.7 + valueNoise(world.xz * 3.0) * 0.3);
      col *= 1.0 - 0.45 * sm;
    }
    s.albedo = mix(s.albedo, mix(s.albedo, col, 0.2), cov * hole);
    s.albedo = mix(s.albedo, col, paintCov);
    s.rough = mix(s.rough, 0.5, paintCov);
    s.metal = 0.0;
    // Thermoplastic fills the aggregate: a smooth skin over the bump (on a
    // wet road the bumped paint glittered pixel by pixel).
    s.normal = normalize(mix(s.normal, n, paintCov * 0.8));
    // Raised 2-3 mm edge: the normal leans outward across the AA band, and
    // the worn holes' rims.
    if (dist < 30.0 && cov < 0.999) {
      var T: vec3f;
      var B: vec3f;
      rdUvFrame(&T, &B);
      let tilt = 0.45 * 4.0 * cov * (1.0 - cov) * smoothstep(30.0, 18.0, dist);
      s.normal = normalize(s.normal + (T * bevDir.x + B * bevDir.y) * tilt);
    }
    // Glass beads: a few glossy 3 mm cells, close up.
    let bead = step(0.98, hash21(floor(world.xz / 0.003))) * smoothstep(0.006, 0.002, foot) * (1.0 - frame.weather.z);
    s.rough = mix(s.rough, 0.15, bead * paintCov);
    // Retroreflection: at night, headlights near the eye light the beads
    // back toward a viewer at driving height.
    // Brightest straight ahead along the road and at grazing angles, where
    // the headlight cone lands; a faint glow from higher viewpoints.
    let drv = mix(0.25, 1.0, 1.0 - smoothstep(2.5, 6.0, frame.camPos.y - world.y));
    let vdir = normalize(frame.camPos.xyz - world);
    let graze = 1.0 - smoothstep(0.05, 0.45, vdir.y);
    // (Faint: there is no car of our own lighting it; at 0.22 isolated
    // stripes glowed near-white on an unlit road.)
    // (0.035 still read as near-emissive stripes on a dark road at low
    // night views.)
    s.emissive += col * paintCov * night * drv * mix(0.3, 1.0, graze) * smoothstep(60.0, 8.0, dist) * 0.012;
  }
  // Crack sealant runs on over coloured surfacing and paint.
  {
    let t = rdTar * max(surfCov, paintCov);
    s.albedo = mix(s.albedo, vec3f(0.05, 0.049, 0.047), t);
    s.rough = mix(s.rough, 0.9, t);
    paintCov *= 1.0 - rdTar;
  }

  // ---- S2: gutter, side ditch, catch basins ---------------------------
  var gutterC = 0.0;
  var basin = 0.0;
  {
    let gc = smoothstep(gIn - foot * 0.5, gIn + foot * 0.5, ax);
    if (gc > 0.0) {
      // Two rotated, non-harmonic samples of the concrete layer: one 1.5 m
      // tile repeated down a long gutter read as a regular dot grid.
      let rot = mat2x2f(0.6, -0.8, 0.8, 0.6);
      let c = mix(detailUV(uv, 1.5, DETAIL_CONCRETE), detailUV(rot * uv + 7.3, 2.3, DETAIL_CONCRETE), 0.5);
      var g = defaultSurf(n);
      g.cls = CLASS_GROUND;
      g.normal = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), c, 0.6);
      if (kind >= 2u) {
        // Concrete L-gutter, 2 m units, each its own tone; grime builds up
        // toward the curb (a gradient, streaked along the flow) with silt
        // in the flow line; random grit, not a lattice.
        let unit = floor(along / 2.0);
        g.albedo = vec3f(0.34, 0.335, 0.32) * (c.b * 2.0) * mix(0.7, 1.0, c.a) * (0.93 + 0.14 * rdH(seed, i32(unit) * 2 + side, 52));
        g.rough = 0.85;
        g.albedo *= mix(1.0, 0.7, paintLine(rdDash(along, 2.0, 0.0), 0.01, foot));
        let gt = clamp((ax - gIn) / max(hw - gIn, 0.01), 0.0, 1.0);
        let flow = 0.7 + 0.6 * valueNoise(vec2f(ax * 12.0, along * 0.4));
        g.albedo *= 1.0 - 0.45 * gt * gt * flow;
        g.albedo = mix(g.albedo, vec3f(0.12, 0.105, 0.09), 0.35 * smoothstep(0.55, 0.75, gt) * smoothstep(0.4, 0.7, valueNoise(vec2f(ax * 4.0, along * 0.7) + 5.0)));
        g.rough -= 0.1 * gt;
        // Apron against the kerb, 20-40 cm: sediment and silt (darker,
        // brown-grey), a tide line where the run-off stands, and leaf litter
        // in drifts.
        let apW = 0.2 + 0.2 * valueNoise(vec2f(along * 0.25, 4.0 + f32(side)));
        let apr = smoothstep(hw - apW - 0.04, hw - apW + 0.04, ax);
        let sed = vec3f(0.15, 0.14, 0.125) * (0.8 + 0.4 * valueNoise(vec2f(ax * 20.0, along * 2.5)));
        g.albedo = mix(g.albedo, sed, apr * 0.6);
        g.rough += 0.05 * apr;
        g.albedo *= 1.0 - 0.3 * paintLine(abs(ax - (hw - apW) - 0.01 * valueNoise(vec2f(along * 3.0, 1.0))), 0.015, foot);
        if (foot < 0.03) {
          let lq = vec2f(ax, along) / 0.07;
          let lc = floor(lq);
          let drift = smoothstep(0.45, 0.75, valueNoise(vec2f(along * 0.35, 8.0 + f32(side))));
          let lh = hash22(lc + 0.5);
          if (hash21(lc * 1.7 + 3.0) < 0.22 * drift * smoothstep(hw - 0.2, hw - 0.08, ax)) {
            let la = lh.x * 3.1416;
            let ld = fract(lq) - 0.5 - (lh - 0.5) * 0.4;
            let lr = vec2f(dot(ld, vec2f(cos(la), sin(la))), dot(ld, vec2f(-sin(la), cos(la))));
            let leaf = (1.0 - smoothstep(0.85, 1.0, length(lr / vec2f(0.45, 0.22)))) * (1.0 - smoothstep(0.012, 0.03, foot));
            let lcol = mix(vec3f(0.13, 0.085, 0.045), vec3f(0.22, 0.16, 0.07), lh.y) * (0.6 + 0.4 * hash21(lc + 7.0));
            g.albedo = mix(g.albedo, lcol, leaf);
            g.rough = mix(g.rough, 0.7, leaf);
          }
        }
        let gq = uv * 40.0;
        let gcell = floor(gq);
        let gr = length(fract(gq) - 0.5 - (hash22(gcell + 0.37) - 0.5) * 0.6);
        let grit = step(0.9, hash21(gcell * 1.13 + 9.1)) * (1.0 - smoothstep(0.1, 0.18, gr)) * smoothstep(0.03, 0.01, foot);
        g.albedo *= 1.0 - 0.45 * grit;
        // Catch basin: 0.4 x 0.75 m grate every 15-20 m per side.
        let bci = floor(along / 17.5);
        let bp = bci * 17.5 + 2.0 + 13.5 * rdH(seed, i32(bci) * 2 + side, 50);
        let bsd = rdBox(vec2f(ax - (hw - 0.25), along - bp), vec2f(0.2, 0.375));
        basin = rdCov(bsd, 0.4, foot);
        if (basin > 0.0) {
          let slot = mix(rdGrate(along, foot), 0.33, smoothstep(0.006, 0.02, foot));
          let frameRim = paintLine(abs(bsd + 0.025), 0.05, foot);
          let gA = mix(vec3f(0.16, 0.15, 0.14), vec3f(0.03), slot);
          g.albedo = mix(g.albedo, mix(gA, vec3f(0.2, 0.19, 0.17), frameRim), basin);
          g.metal = mix(g.metal, 0.6 * (1.0 - slot), basin);
          g.rough = mix(g.rough, 0.5, basin);
        }
      } else {
        // Side ditch: precast covers 0.5 m long; every 4th a steel grating.
        let ci = floor(along / 0.5);
        g.albedo = vec3f(0.38, 0.37, 0.35) * (c.b * 2.0) * mix(0.7, 1.0, c.a) * (0.94 + 0.12 * hash11(ci + f32(seed & 0xffu)));
        g.rough = 0.85;
        g.albedo *= mix(1.0, 0.45, paintLine(rdDash(along, 0.5, 0.0), 0.012, foot));
        if (u32(ci + 4096.0) % 4u == 0u) {
          let slot = mix(rdGrate(ax * 1.0 + along * 0.0 + fract(along / 0.5) * 0.5, foot), 0.33, smoothstep(0.006, 0.02, foot));
          let inside = rdCov(abs(ax - (gIn + hw) * 0.5) - (hw - gIn) * 0.5 + 0.04, 0.3, foot);
          g.albedo = mix(g.albedo, mix(vec3f(0.16, 0.15, 0.14), vec3f(0.03), slot), inside);
          g.metal = 0.6 * (1.0 - slot) * inside;
          g.rough = mix(g.rough, 0.5, inside);
        }
      }
      // Gutter takes the asphalt's place (paint stops at it).
      s.albedo = mix(s.albedo, g.albedo, gc);
      s.rough = mix(s.rough, g.rough, gc);
      s.metal = mix(s.metal, g.metal, gc);
      s.normal = normalize(mix(s.normal, g.normal, gc));
      s.emissive *= 1.0 - gc;
      paintCov *= 1.0 - gc;
      gutterC = gc;
    }
    // Dark wet halo around catch basins (on asphalt and concrete alike).
    if (kind >= 2u) {
      let bci = floor(along / 17.5);
      let bp = bci * 17.5 + 2.0 + 13.5 * rdH(seed, i32(bci) * 2 + side, 50);
      let hd = rdBox(vec2f(ax - (hw - 0.25), along - bp), vec2f(0.2, 0.375));
      let halo = (1.0 - smoothstep(0.0, 0.4, hd)) * (1.0 - basin);
      s.albedo *= 1.0 - 0.2 * halo;
      basin = max(basin, 1.0 - smoothstep(0.3, 0.6, hd));
    }
  }

  // ---- S4: ironwork --------------------------------------------------------
  // Manholes: 0.6 m cast iron, polished, lighter than fresh asphalt; one
  // per lane per 25-60 m, in a wheel path or beside a lane line.
  if (kind >= 1u && !inCross) {
    let cell = floor(along / 25.0);
    let hk = i32(cell) * 16 + i32(li) * 2 + side;
    if (rdH(seed, hk, 60) < 0.55) {
      let mp = cell * 25.0 + 2.0 + 21.0 * rdH(seed, hk, 61);
      let pick = rdH(seed, hk, 62);
      let lat = select(select(0.85, -0.85, pick < 0.66), laneW * 0.5 - 0.4, pick < 0.33);
      let p = vec2f(o - clamp(lat, -laneW * 0.5 + 0.4, laneW * 0.5 - 0.4), along - mp);
      if (length(p) < 0.5) {
        var T: vec3f;
        var B: vec3f;
        rdUvFrame(&T, &B);
        let lid = rdManhole(&s, p, T * sx, B, hk, seed, foot, dist);
        paintCov *= 1.0 - lid;
      }
    }
  }
  // Square valve covers near the gutter (~30 m) and NTT covers on trenches.
  {
    let vc = floor(along / 30.0);
    let vp = vc * 30.0 + 4.0 + 22.0 * rdH(seed, i32(vc) * 2 + side, 64);
    var vsd = rdBox(vec2f(ax - (ec - 0.45), along - vp), vec2f(0.125));
    if (tr1 > tr0 && rdH(seed, 0, 65) < 0.2) {
      vsd = min(vsd, rdBox(vec2f(x - trX, along - (tr0 + tr1) * 0.5), vec2f(0.3, 0.45)));
    }
    let vcov = rdCov(vsd, 0.25, foot);
    if (vcov > 0.0 && !inCross) {
      let chk = paintLine(abs(fract((uv.x + uv.y) / 0.04) - 0.5) * 0.04, 0.01, foot);
      let iron = vec3f(0.23, 0.21, 0.19) * mix(0.95, mix(0.8, 1.1, chk), 1.0 - smoothstep(0.004, 0.015, foot));
      s.albedo = mix(s.albedo, iron, vcov);
      s.metal = mix(s.metal, 0.5, vcov);
      s.rough = mix(s.rough, 0.42, vcov);
      s.albedo = mix(s.albedo, vec3f(0.03), paintLine(abs(vsd), 0.02, foot) * 0.7);
    }
  }

  // ---- S5: rain --------------------------------------------------------------
  // Standing water only where the road holds it: against the curb, in the
  // wheel ruts of old sections, in patch dips, round the gullies and in a
  // few broad sags (15-25 % of the carriageway). Everything else is a
  // soaked film (rough ~0.25); the crown sheds it; paint stands proud.
  // Drainage asphalt (kind 3 and half of kind 2) pools only in the gutter.
  let drains = kind == 3u || (kind == 2u && rdH(seed, 0, 70) < 0.5);
  if (frame.weather.z > 0.001) {
    let tr0r = exp(-pow((abs(o) - 0.85) * 2.4, 2.0));
    var sag = 0.1;
    sag = max(sag, smoothstep(hw - 1.05, hw - 0.7, ax));
    sag = max(sag, 0.85 * tr0r * smoothstep(0.45, 0.6, age));
    sag = max(sag, 0.8 * max(trAc, paintLine(abs(trSd), 0.25, foot)));
    sag = max(sag, basin);
    sag = max(sag, 0.75 * smoothstep(0.58, 0.72, fbm2(world.xz * 0.045 + 3.0)));
    sag *= smoothstep(0.6, 1.1, ax);
    if (drains) { sag = select(0.0, sag, ax > hw - 1.0); }
    let nb = valueNoise(world.xz * 0.55) * 0.6 + valueNoise(world.xz * 2.3 + 9.0) * 0.4;
    let pv = sag + (nb - 0.5) * 0.8;
    let puddle = smoothstep(0.56, 0.62, pv) * (1.0 - paintCov) * frame.weather.z;
    let margin = smoothstep(0.44, 0.56, pv) * (1.0 - paintCov) * frame.weather.z;
    let dryA = s.albedo;
    applyWetness(&s, world, 0.0, 0.6);
    // Wet diffuse no darker than ~0.65x dry (at 0.45x the lamp pools
    // vanished in night rain: the road went to a black mirror between
    // streaks). Puddles darken further below.
    s.albedo = max(s.albedo, dryA * mix(1.0, 0.6, frame.weather.z));
    // The soaked film: where the water sheet lies (most of the surface,
    // streaky along the road), rough 0.08-0.15, the aggregate's bump half
    // drowned, so the street lights draw long streaks in it; on the crown
    // and the drier wheel-path ridges a satin 0.2-0.28. Wet asphalt is
    // ~0.6x its dry albedo (applyWetness takes it to ~0.45).
    let wn = valueNoise(vec2f(x * 0.8, along * 0.12) + 3.0) * 0.6 + valueNoise(world.xz * 0.07 + 11.0) * 0.4;
    let wmask = smoothstep(0.22, 0.42, wn + 0.25 * sag) * (1.0 - surfCov);
    let film = mix(0.18 + 0.06 * wn, 0.08 + 0.07 * valueNoise(world.xz * 0.6 + 5.0), wmask);
    s.rough = mix(s.rough, film, frame.weather.z * (1.0 - gutterC * 0.5));
    s.normal = normalize(mix(s.normal, n, 0.6 * wmask * frame.weather.z));
    s.albedo *= mix(1.0, 1.1, frame.weather.z * (1.0 - gutterC));
    // Sealed cracks stay glossy black lines on the soaked surface.
    let tw = rdTar * frame.weather.z * (1.0 - gutterC);
    s.albedo = mix(s.albedo, vec3f(0.018), tw * 0.7);
    s.rough = mix(s.rough, 0.06, tw);
    rdPuddle(&s, world, n, puddle * (1.0 - surfCov), margin * (1.0 - surfCov));
    if (surfCov > 0.0) {
      // Coloured surfacing: the resin-bound chips drain, so it is a satin
      // wet everywhere with water lying in 0.5-3 m patches (filled flush:
      // flat and glossy), low-passed so it never speckles chip by chip.
      let wp = valueNoise(world.xz * 0.45 + 3.0) * 0.65 + valueNoise(world.xz * 1.3 + 7.0) * 0.35;
      let pw = smoothstep(0.45, 0.62, wp) * frame.weather.z;
      s.rough = mix(s.rough, mix(0.5, 0.14, pw), surfCov * frame.weather.z);
      s.normal = normalize(mix(s.normal, n, surfCov * mix(0.7, 1.0, pw)));
      // Resin surfacing soaks up less than open asphalt: it stays red.
      s.albedo *= mix(1.0, mix(1.2, 1.0, pw), surfCov * frame.weather.z);
    }
    // Wet markings stay legible.
    let lum = max(max(s.albedo.r, s.albedo.g), s.albedo.b);
    s.albedo = mix(s.albedo, s.albedo * max(1.0, 0.55 / max(lum, 0.01)), paintCov);
    // Wet thermoplastic: satin ~0.2, not mirror; a little rougher with
    // range so pixel-sized chip / bead / hole cells don't flicker.
    s.rough = mix(s.rough, mix(0.2, 0.32, smoothstep(0.004, 0.03, foot)), max(paintCov, cov * 0.8) * frame.weather.z);
  }
  return s;
}

// Junction plate (CM.asphaltPlain): uv = world xz, param = age hash |
// 0x100 signalized; aux (optional) = the junction centre, x and z in
// quarter metres + 32768, 16 bits each (0 = unknown).
// The box is the same contract as the signalized mouths around it (same
// age range, world-space aggregate and noise, so no tone step at the
// crosswalks), but the hardest-worked asphalt on the road: cracked, oil-
// stained, rubbered in the turning paths, cut by utility patches, with
// manholes. Around the centre (where right-turners wait) the oil and rubber
// gather.
fn junctionMat(world: vec3f, n: vec3f, param: u32, aux: u32) -> Surf {
  let foot = max(length(dWorldX), length(dWorldY));
  let dist = distance(world, frame.camPos.xyz);
  let jh = param & 0xffu;
  let jseed = hashu(jh * 0x9e3779b9u + 0x7a11u) | 1u;
  let age = 0.5 + 0.15 * hashuf(jh * 0x45d9f3bu + 7u);
  let hasC = aux != 0u;
  let cxz = vec2f(f32(aux & 0xffffu), f32(aux >> 16u)) * 0.25 - 8192.0;
  let rc = select(1e3, distance(world.xz, cxz), hasC);
  // Utility patches: in ~35 % of 9 m world cells, a rotated rectangle
  // 1-2.6 x 1-3.2 m, kept inside its cell.
  var pSd = 1e3;
  {
    let cell = floor(world.xz / 9.0);
    let hc = hash22(cell * 1.37 + vec2f(f32(jh), 3.0));
    if (hash21(cell + 41.0) < 0.3) {
      // Trench cuts run square to the streets (a quarter turn at most, no
      // odd rotations that read as a dropped decal), and none in the
      // middle of the box, where the crowned surface is one pour.
      let hs = vec2f(0.5 + 0.8 * hc.x, 0.5 + 1.1 * hc.y);
      let ctr = (cell + 0.5) * 9.0 + (hash22(cell + 5.0) - 0.5) * (9.0 - 2.0 * length(hs) - 0.4);
      let d = world.xz - ctr;
      let r = select(d, d.yx, hash21(cell + 17.0) < 0.5);
      let rcen = select(1e3, distance(ctr, cxz), hasC);
      pSd = select(rdBox(r, hs), 1e3, rcen < 5.0);
    }
  }
  let pAc = rdCov(pSd, 1.0, foot);
  // Patches are a newer contract, but a weathered one: a step, not a hole.
  let ageP = select(age + 0.3, age - 0.25, age > 0.5);
  var ap = mix(asphaltParams(age), asphaltParams(ageP), pAc);
  ap.x *= 1.0 - 0.04 * pAc;
  var dd: vec4f;
  var s = asphaltSurf(world, n, ap, foot, &dd);
  // Every movement crosses the box: the whole surface carries the rubber
  // and drip haze of a wheel path (the mouths only have it in their lanes),
  // in broad soft swathes.
  let haze = 0.7 + 0.6 * valueNoise(world.xz * 0.12 + 5.0);
  s.albedo *= 1.0 - 0.17 * haze * (1.0 - pAc);
  s.rough -= 0.08 * haze;
  // Patch outline: 5 cm glossy tar seal, wandering a little.
  if (pSd < 1.0) {
    let ts = abs(pSd + (valueNoise(world.xz * 4.0) - 0.5) * 0.03);
    let seam = max(paintLine(ts, 0.05, foot), 0.5 * paintLine(ts, 0.15, foot));
    s.albedo = mix(s.albedo, vec3f(0.035), seam);
    s.rough = mix(s.rough, 0.25, seam);
  }
  // Turning paths: tyre rubber arcs, in pairs 1.7 m apart (the wheels),
  // polished and darkened; `wheel` is the broad band they sweep.
  let base = floor(world.xz / 40.0);
  var scuff = 0.0;
  var wheel = 0.0;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let cell = base + vec2f(f32(i), f32(j)) - select(vec2f(0.0), vec2f(1.0), fract(world.xz / 40.0) < vec2f(0.5));
      let hc = hash22(cell * 1.7 + 3.1);
      let c = (cell + hc) * 40.0;
      let R = 8.0 + 6.0 * hash21(cell + 9.0);
      let q = world.xz - c;
      let ang = atan2(q.y, q.x);
      let a0 = hash21(cell + 4.0) * 6.2832;
      let arc = smoothstep(0.0, 0.3, cos(ang - a0) - 0.3);
      let lq = length(q);
      let st = 0.7 + 0.6 * valueNoise(vec2f(ang * R * 0.3, lq * 2.0));
      scuff = max(scuff, max(paintLine(abs(lq - R), 0.45, foot), paintLine(abs(lq - R - 1.7), 0.45, foot)) * arc * st);
      wheel = max(wheel, (1.0 - smoothstep(0.6, 1.8, abs(lq - R - 0.85))) * arc);
    }
  }
  // Through movements: the box's own wheel paths, broad soft bands in
  // world noise (where the approaches' lanes run on across it).
  wheel = max(wheel, smoothstep(0.55, 0.7, valueNoise(world.xz * 0.18 + vec2f(f32(jh), 2.0))));
  // Sealed cracks: block cracking and long cracks where the wheels work
  // the box (about 60 % fewer than an even net), not on the fresh patches.
  let crackKeep = smoothstep(0.42, 0.52, max(wheel * 1.1, valueNoise(world.xz * 0.22 + vec2f(5.0, f32(jh))) * 0.62));
  rdApplyTar(&s, rdCrackNet(world.xz, foot) * (1.0 - pAc) * crackKeep);
  s.albedo *= 1.0 - 0.28 * scuff;
  s.rough -= 0.12 * scuff;
  // Oil drips: round-ended drops dragged a little along the direction of
  // travel (radial: toward the centre down the approaches), in ~12 % of
  // 3.5 m cells, more round the centre where turners wait; each a dark
  // glossy core and a soft halo, sometimes a smaller satellite drop. (The
  // random-orientation head + tail smears read as fish.) Most of the oil is
  // on the approaches, behind the stop lines (roadMat).
  {
    let cell = floor(world.xz / 3.5);
    let pr = select(0.1, 0.08 + 0.35 * exp(-rc * rc / 40.0), hasC);
    if (hash21(cell + 91.0) < pr) {
      let ctr = (cell + 0.3 + 0.4 * hash22(cell + 13.0)) * 3.5;
      let tng = select(normalize(ctr - cxz + 1e-3), vec2f(1.0, 0.0), !hasC);
      let d = world.xz - ctr;
      let u = dot(d, tng);
      let v = dot(d, vec2f(-tng.y, tng.x));
      let rr = vec2f(0.18 + 0.2 * hash21(cell + 7.0), 0.1 + 0.08 * hash21(cell + 2.0));
      let ed = (length(vec2f(u, v) / rr) - 1.0) * rr.y;
      let ow = 1.0 - smoothstep(-0.006 - foot * 0.3, 0.006 + foot * 0.3, ed);
      let sat = d - tng * rr.x * 1.6 - vec2f(-tng.y, tng.x) * (hash21(cell + 4.0) - 0.5) * 0.2;
      let sw = 1.0 - smoothstep(-0.004 - foot * 0.3, 0.004 + foot * 0.3, length(sat) - rr.y * 0.45);
      let halo = 1.0 - smoothstep(0.0, 0.3, ed);
      let oil = max(ow, sw * step(0.5, hash21(cell + 6.0)));
      s.albedo *= (1.0 - 0.45 * oil) * (1.0 - 0.12 * halo);
      s.rough -= 0.25 * oil;
    }
  }
  // Right-turn waiting area round the centre: rubber and oil haze.
  if (hasC) {
    let g = exp(-rc * rc / 40.0);
    s.albedo *= 1.0 - 0.22 * g * (0.75 + 0.5 * valueNoise(world.xz * 0.8));
    s.rough -= 0.08 * g;
  }
  // Manholes (in ~25 % of 8 m cells) and square valve covers.
  {
    let cell = floor(world.xz / 8.0);
    if (hash21(cell + 23.0) < 0.25) {
      let ctr = (cell + 0.2 + 0.6 * hash22(cell + 29.0)) * 8.0;
      let p = world.xz - ctr;
      if (length(p) < 0.5) {
        _ = rdManhole(&s, p, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), i32(cell.x * 31.0 + cell.y), jseed, foot, dist);
      }
    }
  }
  s.rough = max(s.rough, 0.2);
  // Rain: the crowned box sheds water; an even soaked film (no world-noise
  // puddle blotches, which read as dirt), streaky gloss; patch dips hold a
  // little water; sealed cracks stay glossy black lines.
  if (frame.weather.z > 0.001) {
    let dryA = s.albedo;
    applyWetness(&s, world, 0.0, 0.6);
    // Wet diffuse capped at ~0.65x dry (see roadMat): the lamp pools stay
    // on the box in the rain, not just their streaks.
    s.albedo = max(s.albedo, dryA * mix(1.0, 0.6, frame.weather.z));
    // The same water sheet as the approaches (rough 0.08-0.15 under it,
    // satin on the crown), so the luminaires streak across the box.
    let wn = valueNoise(world.xz * vec2f(0.3, 0.1) + 3.0) * 0.6 + valueNoise(world.xz * 0.07 + 11.0) * 0.4;
    let wmask = smoothstep(0.22, 0.42, wn);
    let film = mix(0.18 + 0.06 * wn, 0.08 + 0.07 * valueNoise(world.xz * 0.6 + 5.0), wmask);
    s.rough = mix(s.rough, film, frame.weather.z);
    s.normal = normalize(mix(s.normal, n, 0.6 * wmask * frame.weather.z));
    s.albedo *= mix(1.0, 1.1, frame.weather.z);
    let tw = rdTar * frame.weather.z;
    s.albedo = mix(s.albedo, vec3f(0.018), tw * 0.7);
    s.rough = mix(s.rough, 0.06, tw);
    let pv = pAc * (0.6 + 0.5 * valueNoise(world.xz * 0.9));
    rdPuddle(&s, world, n, smoothstep(0.62, 0.7, pv) * frame.weather.z, smoothstep(0.45, 0.62, pv) * frame.weather.z);
  }
  return s;
}

// Sidewalks: param 0 = interior plaza (uv = world xz); param 1 = the curb
// band (uv.x metres along the curb, uv.y metres in from the curb face top;
// aux: 0-1 road kind, 2 crossing apron, 3 planting strip, 4 tree pit,
// 8-15 band width in 2 cm units).
fn paversSurf(world: vec3f, n: vec3f) -> Surf {
  var s = defaultSurf(n);
  let d = detailXZ(world, 1.2, DETAIL_PAVERS);
  // Each stretch of sidewalk gets one of a few restrained paver colours:
  // mostly neutral grey, some pink-beige, a few darker brick walks.
  let zone = hash21(floor(world.xz / 60.0));
  let grey = vec3f(0.42, 0.413, 0.4) * (0.955 + 0.09 * hash21(floor(world.xz / 60.0) + 5.0));
  let base = select(select(grey, vec3f(0.46, 0.41, 0.36), zone < 0.3), vec3f(0.38, 0.33, 0.3), zone < 0.1);
  s.albedo = base * (d.b * 2.0) * mix(0.55, 1.0, d.a) * (0.95 + 0.1 * valueNoise(world.xz * 0.3));
  // Foot-traffic grime, and 0.5-2 m spill / damp stains (darker, a little
  // brown) here and there.
  s.albedo *= 1.0 - 0.14 * smoothstep(0.5, 0.8, valueNoise(world.xz * 0.15 + 9.0));
  let spill = smoothstep(0.72, 0.84, valueNoise(world.xz * 0.6 + 31.0) * 0.8 + valueNoise(world.xz * 3.1) * 0.2);
  s.albedo = mix(s.albedo, s.albedo * vec3f(0.84, 0.81, 0.78), spill);
  s.rough = 0.8 + (1.0 - d.a) * 0.15;
  s.cls = CLASS_GROUND;
  s.normal = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), d, 1.0);
  // Per-paver tone (+-11 %, a faint warm/cool cast), roughness (+-0.1) and
  // set (a slight tilt), on the 200 x 100 mm running bond of the detail
  // layer; ~2 % are replacements from another batch (cleaner and paler, a
  // darker grey or a pinker block). The tone holds until a paver is under
  // ~2 px (area footprint: at eye level the along-view footprint alone
  // killed it within 10 m), then averages out.
  let foot = max(length(dWorldX), length(dWorldY));
  let fa = sqrt(length(dWorldX) * length(dWorldY));
  let pk = 1.0 - smoothstep(0.05, 0.12, fa);
  let row = floor(world.z / 0.1);
  let odd = fract(row * 0.5) > 0.25;
  let col = floor((world.x + select(0.0, 0.1, odd)) / 0.2);
  let cid = vec2f(col, row);
  let ph = hash22(cid + 0.37);
  var tone = vec3f(0.89 + 0.22 * ph.x) * vec3f(1.0 + 0.03 * (ph.y - 0.5), 1.0, 1.0 - 0.03 * (ph.y - 0.5));
  var pr = (hash21(cid * 0.71 + 3.3) - 0.5) * 0.2;
  let rep = hash21(cid * 1.31 + 7.7);
  if (rep < 0.02) {
    let rt = hash21(cid + 51.0);
    tone = select(select(vec3f(1.2, 1.17, 1.12), vec3f(1.12, 0.96, 0.86), rt < 0.35), vec3f(0.72, 0.72, 0.74), rt < 0.15);
    pr = -0.12;
  }
  s.albedo *= mix(vec3f(1.0), tone, pk);
  s.rough += pr * pk;
  // Joints: 3 mm of dark sand and grit (coverage-conserving at range,
  // so the bond still reads as a fine grid), a 1-2 mm bevel either side.
  let lx = fract((world.x + select(0.0, 0.1, odd)) / 0.2);
  let ly = fract(world.z / 0.1);
  let ex = min(lx, 1.0 - lx) * 0.2;
  let ey = min(ly, 1.0 - ly) * 0.1;
  let ed = min(ex, ey);
  let jt = paintLine(ed, 0.004, foot);
  s.albedo *= 1.0 - 0.5 * jt;
  s.ao *= 1.0 - 0.35 * jt;
  let det = 1.0 - smoothstep(0.003, 0.01, foot);
  if (det > 0.0) {
    let bv = (1.0 - smoothstep(0.002, 0.006, ed)) * det;
    let ox = select(-1.0, 1.0, lx > 0.5);
    let oz = select(-1.0, 1.0, ly > 0.5);
    let bdir = select(vec3f(0.0, 0.0, oz), vec3f(ox, 0.0, 0.0), ex < ey);
    s.normal = normalize(s.normal + bdir * bv * 0.7);
  }
  let tilt = (hash22(cid + 3.1) - 0.5) * 0.08 * pk;
  s.normal = normalize(s.normal + vec3f(tilt.x, 0.0, tilt.y));
  // Old chewing gum: flattened discs 1.5-3 cm, mostly grey-black, some
  // pale grey; sparse, coverage-conserving at range.
  if (fa < 0.03) {
    let gq = world.xz / 0.35;
    let gc = floor(gq);
    if (hash21(gc + 19.3) < 0.1) {
      let rr = 0.008 + 0.008 * hash21(gc);
      let gr = length(fract(gq) - 0.5 - (hash22(gc + 2.0) - 0.5) * 0.6) * 0.35;
      let gum = rdCov(gr - rr, rr * 2.0, foot) * (1.0 - smoothstep(0.015, 0.03, fa));
      let gcol = select(vec3f(0.13, 0.125, 0.12), vec3f(0.5, 0.49, 0.47), hash21(gc + 8.0) < 0.3);
      s.albedo = mix(s.albedo, gcol, gum * 0.9);
      s.rough = mix(s.rough, 0.55, gum);
    }
  }
  return s;
}

fn sidewalkMat(world: vec3f, n: vec3f, uv: vec2f, param: u32, aux: u32) -> Surf {
  var s = paversSurf(world, n);
  if (param != 1u) {
    // Pavement darkens evenly in rain and pools only in low spots.
    applyWetness(&s, world, 0.15, 0.7);
    return s;
  }
  let foot = max(length(dWorldX), length(dWorldY));
  let kind = aux & 3u;
  let apron = (aux & 4u) != 0u;
  let plant = (aux & 8u) != 0u;
  let bw = select(f32((aux >> 8u) & 0xffu) * 0.02, 2.5, ((aux >> 8u) & 0xffu) == 0u);
  let dist = distance(world, frame.camPos.xyz);
  let y = uv.y;
  var T: vec3f;
  var B: vec3f;
  rdUvFrame(&T, &B);
  // Tactile guide line (kinds >= 1), clear of the planting strip.
  var tc = clamp(0.5 * bw, 0.8, 1.6);
  if (plant) { tc = max(tc, 1.6); }
  tc = min(tc, bw - 0.25);
  // 300 mm concrete slabs between the curb top and the tactile line.
  if (y < tc - 0.15 && y >= 0.18) {
    let c = detailUV(uv, 1.8, DETAIL_CONCRETE);
    s.albedo = vec3f(0.43, 0.425, 0.41) * (c.b * 2.0) * mix(0.7, 1.0, c.a) * (0.96 + 0.08 * hash21(floor(uv / 0.3)));
    let jx = paintLine(rdDash(uv.x, 0.3, 0.0), 0.006, foot);
    let jy = paintLine(rdDash(y - 0.18, 0.3, 0.0), 0.006, foot);
    s.albedo *= 1.0 - 0.35 * max(jx, jy);
    s.rough = 0.82;
    s.normal = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), c, 0.6);
  }
  // Walking wear: the beaten path down the middle of the walk, polished
  // and grimed a little darker, varying along; a rust-and-grime line under
  // the guard fence (0.35 m in), heavier below each post.
  {
    let wy0 = min(tc + 0.35, bw - 0.4);
    let wb = smoothstep(wy0, wy0 + 0.5, y) * (1.0 - smoothstep(bw - 0.6, bw - 0.2, y));
    let wv = 0.55 + 0.45 * valueNoise(vec2f(uv.x * 0.15, 3.0)) + 0.15 * (valueNoise(uv * vec2f(0.8, 2.5)) - 0.5);
    s.albedo *= 1.0 - 0.2 * wb * wv;
    s.albedo *= mix(vec3f(1.0), vec3f(0.97, 0.96, 0.95), wb);
    s.rough -= 0.14 * wb * wv;
    // Dirt banked against the frontage (the 30 cm along the walk's back
    // edge, swept there and never washed) and against the kerb top: darker,
    // a little brown, ragged at its edge, grit packed into the joints.
    let rag = valueNoise(vec2f(uv.x * 2.2, 5.0)) * 0.6 + valueNoise(vec2f(uv.x * 9.0, y * 6.0)) * 0.4;
    let backD = (1.0 - smoothstep(0.04 + 0.2 * rag, 0.12 + 0.3 * rag, bw - y)) * (0.4 + 0.6 * valueNoise(vec2f(uv.x * 0.7, 11.0)));
    let kerbD = (1.0 - smoothstep(0.24 + 0.14 * rag, 0.42 + 0.2 * rag, y)) * step(0.18, y);
    let dirt = max(backD * 0.8, kerbD);
    s.albedo = mix(s.albedo, s.albedo * vec3f(0.56, 0.52, 0.46), dirt * (0.7 + 0.3 * rag));
    s.rough += 0.06 * dirt;
    // Grit packed into the joint behind the kerb top: a dark, broken line.
    let kj = paintLine(abs(y - 0.19 - 0.006 * (rag - 0.5)), 0.018, foot) * (0.6 + 0.4 * valueNoise(vec2f(uv.x * 6.0, 2.0)));
    s.albedo *= 1.0 - 0.45 * kj;
    if (kind >= 2u) {
      let post = 1.0 - smoothstep(0.03, 0.12, abs(fract(uv.x / 2.0) - 0.5) * 2.0);
      let fence = (1.0 - smoothstep(0.03, 0.09, abs(y - 0.36))) * (0.35 + 0.65 * post) * smoothstep(0.3, 0.6, valueNoise(vec2f(uv.x * 1.3, 2.0)));
      s.albedo = mix(s.albedo, s.albedo * vec3f(0.78, 0.62, 0.48), fence * 0.7);
      // Drip stains under the guard-fence rail: a rusty-dark ring every
      // 15-40 cm where water falls off it, each 4-9 cm, drying paler inside.
      // A continuous damp line right under the rail (where most of the
      // water lands), then the drip marks: 6-14 cm splash rings every
      // 20-35 cm, darker heavier ones below each post.
      let dline = (1.0 - smoothstep(0.02, 0.06 + 0.03 * valueNoise(vec2f(uv.x * 4.0, 7.0)), abs(y - 0.36))) * (0.5 + 0.5 * valueNoise(vec2f(uv.x * 1.7, 9.0)));
      s.albedo = mix(s.albedo, s.albedo * vec3f(0.7, 0.64, 0.58), dline * 0.7);
      let dq = uv.x / 0.27;
      let dc = floor(dq);
      let dh = hash22(vec2f(dc, 17.0));
      if (dh.x < 0.75) {
        let dp = vec2f((fract(dq) - 0.5 - (dh.y - 0.5) * 0.5) * 0.27, y - 0.36 - (hash21(vec2f(dc, 4.0)) - 0.5) * 0.06);
        let dr = length(dp * vec2f(1.0, 1.3)) / (0.03 + 0.04 * dh.y + 0.03 * post);
        let ring = (1.0 - smoothstep(0.7, 1.1, dr + 0.3 * (valueNoise(dp * 50.0) - 0.5))) * mix(0.5, 1.0, smoothstep(0.3, 0.9, dr));
        s.albedo = mix(s.albedo, s.albedo * vec3f(0.5, 0.43, 0.36), ring * 0.85);
      }
    }
    if (plant) {
      // Soil splash and drips off the planting strip onto the pavers
      // either side of its edging.
      let sp = max(1.0 - smoothstep(0.0, 0.18 + 0.12 * rag, y - 1.25), 0.0) * step(1.25, y);
      s.albedo = mix(s.albedo, s.albedo * vec3f(0.7, 0.62, 0.52), sp * (0.5 + 0.5 * valueNoise(uv * 14.0)));
    }
  }
  let night = nightLight();
  _ = night;
  if (kind >= 1u) {
    let tcov = rdCov(abs(y - tc) - 0.15, 0.3, foot);
    if (tcov > 0.0) {
      // Four raised linear bars per 300 mm tile, running along the walk.
      let bar = abs(fract((y - tc + 0.15) / 0.075) - 0.5) * 0.075;
      // Bars run along the walk: their detail lives across it, so fade by
      // the screen rate of uv.y, not the isotropic footprint (looking down
      // the walk the bars hold for metres more).
      let fpY = length(vec2f(dUvX.y, dUvY.y));
      let det = 1.0 - smoothstep(0.008, 0.025, fpY);
      let joint = paintLine(rdDash(uv.x, 0.3, 0.0), 0.006, foot);
      let yel = vec3f(0.78, 0.6, 0.08) * (1.0 - 0.3 * joint) * (0.95 + 0.1 * valueNoise(uv * 3.0));
      s.albedo = mix(s.albedo, yel, tcov);
      s.rough = mix(s.rough, 0.6, tcov);
      let slope = sign(fract((y - tc + 0.15) / 0.075) - 0.5) * smoothstep(0.012, 0.022, bar) * 1.6;
      s.normal = normalize(mix(s.normal, normalize(n + B * slope * det), tcov));
      // Grit in the grooves between the bars, sunlit tops worn paler; the
      // grooves' mean darkness stays at range.
      let groove = 1.0 - smoothstep(0.016, 0.026, bar);
      s.albedo *= mix(1.0, mix(mix(1.12, 0.4, groove), 0.8, 1.0 - det), tcov);
      s.ao = mix(s.ao, mix(mix(1.0, 0.35, groove), 0.75, 1.0 - det), tcov);
    }
  }
  // Crossing apron: warning dot blocks, 0.6 m deep behind the curb top.
  if (apron) {
    let acov = rdCov(abs(y - 0.48) - 0.3, 0.6, foot);
    if (acov > 0.0) {
      let q = (fract(vec2f(uv.x, y - 0.18) / 0.06) - 0.5) * 0.06;
      // Dome edges AA'd by the pixel size, so the dots hold to ~2.5 px per
      // 6 cm pitch (area footprint: the along-view rate alone killed them
      // within a metre; at 4 px the pads were flat by eye distance).
      let fpA = sqrt(length(dWorldX) * length(dWorldY));
      let dot = 1.0 - smoothstep(0.0125 - max(0.0015, fpA * 0.5), 0.0125 + max(0.0015, fpA * 0.5), length(q));
      let det = 1.0 - smoothstep(0.016, 0.03, fpA);
      let joint = max(paintLine(rdDash(uv.x, 0.3, 0.0), 0.006, foot), paintLine(rdDash(y - 0.18, 0.3, 0.0), 0.006, foot));
      s.albedo = mix(s.albedo, vec3f(0.78, 0.6, 0.08) * (1.0 - 0.3 * joint) * mix(1.0, 1.08, dot * det), acov);
      s.rough = mix(s.rough, 0.6, acov);
      // Domes: rim slopes lean out, the dome top flat; grit round each foot.
      let rq = length(q);
      let rim = smoothstep(0.004, 0.011, rq) * dot;
      let qn = normalize(q + 1e-5) * rim * det * 1.8;
      s.normal = normalize(s.normal + (T * qn.x + B * qn.y) * acov);
      let foot2 = (1.0 - dot) * (1.0 - smoothstep(0.014, 0.024, rq));
      // Grit ring round each foot, sunlit worn-pale dome tops; at range a
      // dotted mean (darker, and a little rougher) so the apron still reads
      // as studded, not flat yellow.
      s.albedo *= mix(1.0, mix(mix(1.0, 0.35, foot2), 0.74, 1.0 - det), acov);
      s.albedo *= mix(1.0, mix(1.0, 1.18, dot * det), acov);
      s.ao = mix(s.ao, mix(mix(1.0, 0.3, foot2), 0.7, 1.0 - det), acov);
      s.rough = mix(s.rough, s.rough + 0.1 * (1.0 - det) - 0.12 * dot * det, acov);
    }
  }
  // Planting strip: soil and mulch up close, the hedge-top green at range
  // (the LOD1 view of the hedge), between pale edging kerbs.
  if (plant && !apron) {
    let pcov = rdCov(abs(y - 0.75) - 0.5, 1.0, foot);
    if (pcov > 0.0) {
      let soil = vec3f(0.12, 0.09, 0.07) * (0.8 + 0.4 * valueNoise(uv * 6.0));
      let hedge = vec3f(0.08, 0.15, 0.05) * (0.85 + 0.3 * valueNoise(uv * 0.8));
      var pc = mix(soil, hedge, smoothstep(40.0, 70.0, dist));
      let edging = max(paintLine(abs(y - 0.3), 0.1, foot), paintLine(abs(y - 1.2), 0.1, foot));
      pc = mix(pc, vec3f(0.44, 0.43, 0.41), edging);
      s.albedo = mix(s.albedo, pc, pcov);
      s.rough = mix(s.rough, mix(0.95, 0.85, edging), pcov);
      s.normal = normalize(mix(s.normal, n, pcov * (1.0 - edging)));
      if (edging < 0.5) { s.cls = select(s.cls, CLASS_FOLIAGE, pcov > 0.5 && dist > 70.0); }
    }
  }
  // Curb top: precast blocks, pale, chamfered toward the road, 1 m joints,
  // black tyre scuffs on the outer edge.
  let ctop = 1.0 - smoothstep(0.18 - foot * 0.5, 0.18 + foot * 0.5, y);
  if (ctop > 0.0) {
    let c = detailUV(uv, 1.5, DETAIL_CONCRETE);
    var col = vec3f(0.46, 0.455, 0.44) * (c.b * 2.0) * mix(0.7, 1.0, c.a);
    let blk = floor(uv.x);
    col *= 0.95 + 0.1 * hash11(blk * 1.31 + 0.5);
    col *= 1.0 - 0.4 * paintLine(rdDash(uv.x, 1.0, 0.0), 0.005, foot);
    if (hash11(blk * 7.13 + 2.0) < 0.35) {
      let st = fract(uv.x);
      let l0 = 0.05 + 0.4 * hash11(blk * 3.7);
      let sl = 0.2 + 0.5 * hash11(blk * 5.3);
      // A soft, irregular rubber smear: ends feathered over 10-20 cm, its
      // inner edge wandering, streaky along the rub.
      let streak = 0.5 + 0.5 * valueNoise(vec2f(uv.x * 30.0, y * 8.0));
      let ends = smoothstep(0.0, 0.15, st - l0) * (1.0 - smoothstep(sl - 0.2, sl, st - l0));
      let reach = 0.03 + 0.05 * valueNoise(vec2f(uv.x * 6.0, 3.0 + blk));
      let scuffM = ends * (1.0 - smoothstep(reach * 0.4, reach, y)) * streak;
      col *= 1.0 - 0.6 * scuffM;
    }
    // Chipped arris: notches knocked out of the outer edge (rougher, the
    // aggregate showing, in shade), a few per block.
    let chipN = valueNoise(vec2f(uv.x * 7.0, 1.0)) * 0.7 + valueNoise(vec2f(uv.x * 23.0, 5.0)) * 0.3;
    let chipD = 0.012 + 0.05 * smoothstep(0.55, 0.85, chipN);
    let chipped = (1.0 - smoothstep(chipD - 0.006, chipD, y)) * smoothstep(0.55, 0.62, chipN) * (1.0 - smoothstep(0.004, 0.015, foot));
    col *= 1.0 - 0.35 * chipped;
    // Grime and old water stains creeping up from the gutter side.
    col *= 1.0 - 0.15 * (1.0 - smoothstep(0.0, 0.09, y)) * (0.5 + 0.5 * valueNoise(vec2f(uv.x * 2.0, 9.0)));
    s.albedo = mix(s.albedo, col, ctop);
    s.rough = mix(s.rough, 0.7 + 0.15 * chipped, ctop);
    var cn = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), c, 0.6);
    // Chamfer: the outer 2.5 cm leans 45 degrees toward the road (-B).
    let ch = 1.0 - smoothstep(0.02, 0.03, y);
    cn = normalize(mix(cn, normalize(n - B), ch * (1.0 - smoothstep(0.01, 0.03, foot))));
    s.normal = normalize(mix(s.normal, cn, ctop));
  }
  applyWetness(&s, world, 0.15 + 0.6 * (1.0 - smoothstep(0.0, 0.5, y)), 0.7);
  return s;
}

// Coverage of a paint line of width w at distance d from its centre, for a
// pixel footprint `foot`: antialiased up close, fading (coverage conserved)
// once the line is thinner than a pixel.
fn paintLine(d: f32, w: f32, foot: f32) -> f32 {
  let fw = max(w, foot);
  return (1.0 - smoothstep(fw * 0.5 - foot * 0.5, fw * 0.5 + foot * 0.5, d)) * (w / fw);
}

// Curb face (CM.curb): uv.x metres along the face, uv.y metres up from its
// foot. Same precast block as the curb top; joints every metre; road grime
// along the bottom.
fn curbMat(world: vec3f, n: vec3f, uv: vec2f) -> Surf {
  var s = defaultSurf(n);
  let foot = max(length(dWorldX), length(dWorldY));
  var t: vec3f;
  var b: vec3f;
  let d = detailTri(world, n, 1.5, DETAIL_CONCRETE, &t, &b);
  s.albedo = vec3f(0.46, 0.455, 0.44) * (0.93 + 0.07 * valueNoise(world.xz * 2.0)) * (d.b * 2.0) * mix(0.7, 1.0, d.a);
  s.albedo *= 0.95 + 0.1 * hash11(floor(uv.x) * 1.31 + 0.5);
  s.albedo *= 1.0 - 0.4 * paintLine(rdDash(uv.x, 1.0, 0.0), 0.005, foot);
  // Damp band at the toe: 10-15 cm of wicked-up moisture with a ragged
  // tide line (a hard-ish edge, not a soft gradient), darker and satin.
  let tide = 0.1 + 0.05 * valueNoise(vec2f(uv.x * 2.3, 3.0)) + 0.015 * (valueNoise(vec2f(uv.x * 17.0, 9.0)) - 0.5);
  let damp = 1.0 - smoothstep(tide - 0.006 - foot * 0.5, tide + 0.006 + foot * 0.5, uv.y);
  s.albedo *= mix(1.0, 0.62 + 0.1 * smoothstep(0.0, tide, uv.y), damp);
  s.albedo *= 1.0 - 0.12 * paintLine(abs(uv.y - tide), 0.01, foot);
  // Tyre scuffs: black rubber smears along the lower face of some blocks
  // (parking cars rub the kerb), streaky along the face.
  let blk = floor(uv.x);
  if (hash11(blk * 4.71 + 1.3) < 0.3) {
    let l0 = hash11(blk * 2.9) * 0.5;
    let sl = 0.25 + 0.5 * hash11(blk * 6.1);
    let st = fract(uv.x);
    let streak = 0.5 + 0.5 * valueNoise(vec2f(uv.x * 25.0, uv.y * 30.0));
    let ends = smoothstep(0.0, 0.15, st - l0) * (1.0 - smoothstep(sl - 0.2, sl, st - l0));
    let top = 0.07 + 0.07 * valueNoise(vec2f(uv.x * 5.0, 7.0 + blk));
    let sc = ends * (1.0 - smoothstep(top * 0.5, top, uv.y)) * smoothstep(0.0, 0.03, uv.y) * streak;
    s.albedo *= 1.0 - 0.65 * sc;
  }
  s.normal = detailNormal(n, t, b, d, 0.8);
  s.rough = mix(0.75, 0.55, damp);
  applyWetness(&s, world, max(n.y, 0.0), 0.5);
  return s;
}

// Clipped-hedge leaf sprays: the max of soft domes (radius ~0.75 cell) on a
// jittered unit lattice at q; returns (height 0-1, d height / dq).
fn hedgeClusters(q: vec2f) -> vec3f {
  let ip = floor(q);
  let fq = fract(q);
  var best = vec3f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let hp = hash22(ip + g);
      let r = g + 0.15 + 0.7 * hp - fq;
      let rad = 0.6 + 0.35 * hash21(ip + g + 3.7);
      let t = 1.0 - dot(r, r) / (rad * rad);
      if (t > 0.0) {
        let hgt = t * t * (0.75 + 0.25 * hp.y);
        if (hgt > best.x) {
          // d/dq of t^2 = 2 t * (2 r / rad^2) (r = c - q, so dr/dq = -1).
          best = vec3f(hgt, 4.0 * t * r / (rad * rad) * (0.75 + 0.25 * hp.y));
        }
      }
    }
  }
  return best;
}

// Sidewalk utility cover (WALK_COVER_MAT: CM.hedge 2, uv 0..1; u along the
// road, v across from the kerb side; aux >> 16 = kind (bits 0-1: 0 NTT
// telecom, 1 water meter / valve, 2 gas valve, 3 common-duct hatch), bit 2
// round (a 10-gon lid in the uv square: radial ribs), bits 3-15 hash).
// `span` is the uv range the mesh spans (1), so the lid's size in metres
// is |dP/du| * span.
// A ductile-iron lid in a steel frame: polished, worn-bright frame rim, a
// dark 3 mm gap, a cast tread (diamond lugs on NTT / duct, square studs on
// water and gas), a raised emblem roundel per utility (gas painted yellow,
// water a blue-grey ring), and a rust and dirt ring creeping in from the
// gap, darker grime packed between the lugs.
// Antialiased step for coverMat's glyph strokes (cvStep(edge, x) ~ step).
var<private> cvGlyphW: f32;
fn cvStep(edge: f32, x: f32) -> f32 {
  return smoothstep(edge - cvGlyphW, edge + cvGlyphW, x);
}

fn coverMat(world: vec3f, n: vec3f, uv: vec2f, span: f32, aux: u32) -> Surf {
  var s = defaultSurf(n);
  // Area footprint: lids are seen at a grazing angle, where the major axis
  // blurred the tread and frame lines into a plate.
  let foot = sqrt(length(dWorldX) * length(dWorldY));
  var T: vec3f;
  var B: vec3f;
  let det = dUvX.x * dUvY.y - dUvX.y * dUvY.x;
  let sd = select(det, 1e-8, abs(det) < 1e-10);
  let tu = (dWorldX * dUvY.y - dWorldY * dUvX.y) / sd;
  let tv = (dWorldY * dUvX.x - dWorldX * dUvY.x) / sd;
  let size = vec2f(length(tu), length(tv)) * span;
  T = normalize(tu + vec3f(1e-6, 0.0, 0.0));
  B = normalize(tv + vec3f(0.0, 0.0, 1e-6));
  let kind = (aux >> 16u) & 3u;
  let isRound = ((aux >> 18u) & 1u) != 0u;
  let h = aux >> 19u;
  let hf = hashuf(h * 0x9e3779b9u + 0x51u);
  let p = (uv - 0.5) * size;        // metres from the centre
  let hs = size * 0.5;
  // Distance in from the lid's edge (round lids: the disc inscribed in
  // the uv square, an ellipse if the derivatives disagree).
  let pe = p / max(hs, vec2f(1e-3));
  let e = select(min(hs.x - abs(p.x), hs.y - abs(p.y)), (1.0 - length(pe)) * min(hs.x, hs.y), isRound);
  // Tread detail by the area footprint (the along-view rate alone lost it
  // within a couple of metres at eye level).
  let fk = 1.0 - smoothstep(0.004, 0.014, sqrt(length(dWorldX) * length(dWorldY)));
  // The lid mesh is the whole casting: from its edge in, a near-black
  // 12 mm seating gap, then the cast frame ring (2.5 cm), a hairline gap,
  // then the lid proper.
  let seat = 0.012;
  let frameW = seat + 0.025;
  let outerGap = 1.0 - smoothstep(seat - foot * 0.5, seat + foot * 0.5, e);
  let inFrame = (1.0 - smoothstep(frameW - foot * 0.5, frameW + foot * 0.5, e)) * (1.0 - outerGap);
  let gap = max(paintLine(abs(e - frameW - 0.002), 0.004, foot), outerGap);
  let q = p;                        // lid coordinates
  // Tread.
  var tread = 0.0;
  var tg = vec2f(0.0);              // tread slope (outward from lug) for the normal
  if (isRound) {
    // Round lids: concentric ribs and radial spokes (a cast radial
    // pattern), dense studs between.
    let rr0 = length(q);
    let ang = atan2(q.y, q.x);
    let ringR = paintLine(abs(fract(rr0 / 0.035) - 0.5) * 0.035, 0.008, foot);
    let spoke = paintLine(abs(fract(ang / 0.3927) - 0.5) * 0.3927 * rr0, 0.008, foot) * step(0.06, rr0);
    tread = max(ringR, spoke);
    tg = normalize(q + 1e-4) * (ringR - 0.5) * 0.6;
  } else {
    // Cast diamond lattice: raised ribs 1.2-1.5 cm wide on a 45-degree
    // grid (6.5 cm pitch on NTT / duct lids, 5 cm on water and gas), with
    // a small square stud in each pocket on the water / gas pattern.
    // Edges AA'd by the pixel's size in lattice units; the lattice fades
    // to its mean only once a pocket is under ~3 px (a coarse pattern so
    // it still reads at eye distance; the 3 cm lugs were a blur by 4 m).
    let pitch = select(0.05, 0.065, kind == 0u || kind == 3u);
    let rq = mat2x2f(0.7071, -0.7071, 0.7071, 0.7071) * q / pitch;
    let f = fract(rq) - 0.5;
    let px = foot / pitch;
    let rw = select(0.11, 0.1, kind == 0u || kind == 3u);
    // Distance to the nearest rib (lattice units) on each axis.
    let dr = 0.5 - abs(f);
    let ribX = 1.0 - smoothstep(rw - px * 0.7, rw + px * 0.7, dr.x);
    let ribY = 1.0 - smoothstep(rw - px * 0.7, rw + px * 0.7, dr.y);
    var lat = max(ribX, ribY);
    // Rib flanks lean outward from the rib centre line.
    var g = vec2f(sign(f.x) * ribX * (1.0 - ribY), sign(f.y) * ribY * (1.0 - ribX)) * smoothstep(rw * 0.3, rw, min(dr.x, dr.y) + rw * 0.5);
    if (kind == 1u || kind == 2u) {
      let m = max(abs(f.x), abs(f.y));
      let stud = 1.0 - smoothstep(0.13 - px * 0.7, 0.13 + px * 0.7, m);
      lat = max(lat, stud);
      g -= select(vec2f(0.0, sign(f.y)), vec2f(sign(f.x), 0.0), abs(f.x) > abs(f.y)) * stud * smoothstep(0.06, 0.13, m);
    }
    let lk = 1.0 - smoothstep(0.3, 0.45, px);
    tread = mix(0.36, lat, lk);
    tg = mat2x2f(0.7071, 0.7071, -0.7071, 0.7071) * g * lk * 0.8;
  }
  // Emblem roundel: a smooth raised disc with a ring, centred (the duct
  // hatch's off to one end), radius by lid size.
  let er = min(hs.x, hs.y) * select(0.55, 0.4, kind == 3u);
  let ec = select(vec2f(0.0), vec2f(-hs.x * 0.45, 0.0), kind == 3u);
  let rr = length(q - ec);
  let disc = 1.0 - smoothstep(er - 0.004, er + 0.002, rr);
  let ring = paintLine(abs(rr - er * 0.82), 0.008, foot) * disc;
  // A glyph inside: bars (stand-ins for the cast lettering), per kind.
  let gq = (q - ec) / max(er, 0.03);
  cvGlyphW = max(foot / max(er, 0.03) * 0.6, 0.01);
  var glyph = 0.0;
  if (kind == 0u) {
    // Three letters' worth of uprights and bars.
    glyph = max(cvStep(abs(gq.y), 0.28) * cvStep(abs(fract(gq.x * 2.2 + 0.5) - 0.5), 0.09) * cvStep(abs(gq.x), 0.6),
                cvStep(abs(gq.y - 0.25), 0.06) * cvStep(abs(gq.x), 0.6));
  } else if (kind == 1u) {
    // Water: a 水-like cross with a ring.
    glyph = max(cvStep(abs(gq.x), 0.07) * cvStep(abs(gq.y), 0.5), cvStep(abs(gq.y + 0.05), 0.06) * cvStep(abs(gq.x), 0.42));
  } else if (kind == 2u) {
    // Gas: a bold "G"-ish arc.
    let gr = length(gq);
    glyph = cvStep(abs(gr - 0.38), 0.08) * cvStep(-0.2, gq.x + gq.y * 0.2) + cvStep(abs(gq.y), 0.06) * cvStep(0.0, gq.x) * cvStep(gq.x, 0.42);
  } else {
    // Duct hatch: a lifting-arrow.
    glyph = max(cvStep(abs(gq.x), 0.07) * cvStep(abs(gq.y + 0.1), 0.4), cvStep(abs(gq.x) + gq.y * 0.9, 0.35) * cvStep(-gq.y, 0.75) * cvStep(gq.y, -0.25));
  }
  glyph = min(glyph, 1.0) * disc * (1.0 - smoothstep(0.01, 0.03, foot));
  // Iron colour: worn bright on the raised tread and frame, dark between.
  let tone = 0.92 + 0.16 * hf;
  var iron = vec3f(0.23, 0.215, 0.2) * tone;
  let lift = max(tread * (1.0 - disc), max(ring, glyph));
  var col = mix(iron * 0.75, iron * 1.3, lift);
  col = mix(col, iron * 1.05 * (0.9 + 0.2 * valueNoise(q * 40.0)), disc * (1.0 - max(ring, glyph)) * 0.8);
  // Utility paint: gas lids carry a yellow roundel, water a grey-blue one,
  // worn off the raised parts.
  if (kind == 2u) { col = mix(col, vec3f(0.55, 0.42, 0.06), disc * (1.0 - 0.7 * max(ring, glyph)) * 0.85); }
  if (kind == 1u) { col = mix(col, vec3f(0.17, 0.22, 0.28), disc * (1.0 - 0.8 * max(ring, glyph)) * 0.7); }
  // Dirt packed in the pockets between the ribs: near-black grime (~0.05)
  // in most of them, lighter dust in some.
  let pocket = (1.0 - lift) * (1.0 - disc);
  let dn = valueNoise(p * 9.0 + hf * 11.0);
  col = mix(col, vec3f(0.05, 0.046, 0.04) * (0.8 + 0.6 * dn), pocket * mix(0.5, 0.85, smoothstep(0.3, 0.7, dn)));
  // Rust and dirt ring: from the gap inward 2-6 cm, ragged, brown; grime
  // in the tread, more toward one side (where people step less).
  let rw = 0.02 + 0.04 * valueNoise(p * 12.0 + hf * 30.0);
  let rustR = (1.0 - smoothstep(rw * 0.5, rw, e - frameW)) * step(frameW, e);
  let rn = valueNoise(p * 55.0 + 3.0);
  col = mix(col, vec3f(0.24, 0.13, 0.06) * (0.7 + 0.5 * rn), rustR * mix(0.75, smoothstep(0.35, 0.6, rn), fk) * 0.85);
  let grime = smoothstep(0.4, 0.8, valueNoise(p * 4.0 + hf * 17.0)) * (1.0 - lift) * 0.3;
  col *= 1.0 - grime;
  // Frame: plain steel, polished by feet.
  col = mix(col, vec3f(0.3, 0.29, 0.275) * (0.85 + 0.25 * valueNoise(p * 30.0)), inFrame);
  col = mix(col, vec3f(0.02), gap * 0.85);
  s.albedo = col;
  // Mostly a dusty dielectric (a polished-metal lid mirrored the low sun
  // as a cream plate): only the worn rib tops and the frame are bare
  // metal, and those at roughness 0.45, the pockets 0.55.
  s.metal = mix(0.0, 0.45, lift * (1.0 - pocket)) * (1.0 - rustR * 0.8) * (1.0 - 0.6 * f32(kind == 2u) * disc) * (1.0 - gap);
  s.metal = mix(s.metal, 0.5, inFrame);
  s.rough = mix(0.55, 0.45, lift);
  s.rough = mix(s.rough, 0.48, inFrame);
  s.rough = mix(s.rough, 0.8, rustR * 0.8);
  // Relief: the ribs' flanks and the emblem's rim.
  let sl = tg * (1.0 - disc);
  let rimN = (q - ec) / max(rr, 1e-4) * smoothstep(er - 0.008, er, rr) * disc * 0.8 * fk;
  s.normal = normalize(n + T * (sl.x + rimN.x) + B * (sl.y + rimN.y));
  s.ao = mix(1.0, 0.55, pocket * 0.8) * (1.0 - 0.5 * gap);
  s.cls = CLASS_GROUND;
  applyWetness(&s, world, 0.1, 0.0);
  return s;
}

// Planting-strip hedge (param 0, box uv in metres) and cast-iron tree grate
// (param 1, uv 0..1 over 1.2 m); utility covers (param 2, see coverMat).
fn hedgeMat(world: vec3f, n: vec3f, uv: vec2f, param: u32, aux: u32) -> Surf {
  var s = defaultSurf(n);
  if (param == 2u) { return coverMat(world, n, uv, 1.0, aux); }
  if (param == 1u) {
    let p = (uv - 0.5) * 1.2;
    let r = length(p);
    let ang = atan2(p.y, p.x);
    let foot = max(length(dWorldX), length(dWorldY));
    // Radial slots in three rings around a 0.3 m trunk hole.
    let ringI = floor((r - 0.17) / 0.14);
    let inRing = fract((r - 0.17) / 0.14);
    let nSlots = 12.0 + ringI * 8.0;
    let sa = abs(fract(ang / 6.2832 * nSlots) - 0.5) * 6.2832 / nSlots * r;
    var slot = paintLine(sa, 0.025, foot) * step(0.15, inRing) * step(inRing, 0.85) * step(0.17, r) * step(ringI, 2.0);
    slot = mix(slot, 0.2, smoothstep(0.01, 0.03, foot));
    s.albedo = mix(vec3f(0.2, 0.18, 0.16), vec3f(0.03), slot);
    if (r < 0.15) { s.albedo = vec3f(0.12, 0.09, 0.07); }
    s.metal = 0.5 * (1.0 - slot);
    s.rough = 0.55;
    applyWetness(&s, world, 0.1, 0.0);
    return s;
  }
  // Clipped box/azalea: a smooth, softly swelling clipped mass (0.3-1 m
  // lumps, low-frequency shading only: no cells) covered in ~5 cm leaf
  // clusters (two octaves of noise in albedo and normal: lit tips, dark
  // gaps), dark and bare-ish at the base, light new growth on top.
  let h = uv.y;
  let isTop = n.y > 0.7;
  // Face coordinates: a world-space planar projection (xz on the top, the
  // dominant vertical plane on the sides), so the leaf pattern is the same
  // size everywhere (the run's uv stretched it along the shoulders and
  // round the bulges).
  let xSide = abs(n.x) > abs(n.z);
  let fp = select(select(world.xy, world.zy, xSide), world.xz, isTop);
  // Detail by the area footprint (the sides are mostly seen at a grazing
  // angle along the run, where the major axis faded the leaves to a
  // horizontal smear a few metres out).
  let foot = sqrt(length(dWorldX) * length(dWorldY));
  let det = 1.0 - smoothstep(0.01, 0.04, foot);
  var T: vec3f;
  var B: vec3f;
  if (isTop) { T = vec3f(1.0, 0.0, 0.0); B = vec3f(0.0, 0.0, 1.0); }
  else { T = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), xSide); B = vec3f(0.0, 1.0, 0.0); }
  // Low-frequency swell and its slope (finite differences, 5 cm).
  let sp = fp + vec2f(3.1, 7.7);
  let sw = valueNoise(sp * 1.4) * 0.7 + valueNoise(sp * 3.3) * 0.3;
  let swx = valueNoise((sp + vec2f(0.05, 0.0)) * 1.4) * 0.7 + valueNoise((sp + vec2f(0.05, 0.0)) * 3.3) * 0.3;
  let swy = valueNoise((sp + vec2f(0.0, 0.05)) * 1.4) * 0.7 + valueNoise((sp + vec2f(0.0, 0.05)) * 3.3) * 0.3;
  let gS = vec2f(swx - sw, swy - sw) / 0.05;
  // Leaf clusters: two octaves (~6 cm and ~2.5 cm) of overlapping soft
  // domes on jittered, rotated lattices (round sprays, no grid, no cell
  // facets), faded to their mean with range.
  // Lobes: the clipped mass is a crowd of 25-40 cm leaf masses, not one
  // even skin: a jittered dome field on a domain-warped lattice (a broad
  // warp, then a finer one, so no row or cell reads), with voids between
  // them in deep shade (x0.4).
  let wq = fp * 0.9 + vec2f(1.7, 4.2);
  let warp1 = vec2f(valueNoise(wq), valueNoise(wq + 23.0)) - 0.5;
  let fpw = fp + warp1 * 0.3;
  let wq2 = fpw * 3.1;
  let warp2 = vec2f(valueNoise(wq2 + 7.0), valueNoise(wq2 + 41.0)) - 0.5;
  let fpw2 = fpw + warp2 * 0.06;
  let lobeK = 1.0 - smoothstep(0.03, 0.09, foot);
  let lobeC = hedgeClusters(fpw2 * 3.2 + 2.3);
  let lobe = mix(0.55, smoothstep(0.0, 0.55, lobeC.x), lobeK);
  // Leaf clusters: two octaves (~6 cm and ~2.5 cm) of overlapping soft
  // domes on the warped lattices (round sprays, no grid, no cell facets),
  // faded to their mean with range.
  var leaf = 0.5;
  var gL = vec2f(0.0);
  if (det > 0.0) {
    let c1 = hedgeClusters(fpw2 * 16.0);
    let c2 = hedgeClusters(mat2x2f(0.8, -0.6, 0.6, 0.8) * fpw * 40.0 + 7.3);
    leaf = mix(0.5, c1.x * 0.7 + c2.x * 0.3, det);
    gL = (c1.yz * 16.0 * 0.7 + (transpose(mat2x2f(0.8, -0.6, 0.6, 0.8)) * c2.yz) * 40.0 * 0.3) * det;
  }
  let lit = smoothstep(0.15, 0.7, leaf) * mix(0.55, 1.0, lobe);
  var col = mix(vec3f(0.03, 0.06, 0.025), vec3f(0.1, 0.19, 0.06), lit) * (0.85 + 0.3 * sw);
  // Each 6.5 m planting its own green (+-8 % hue: bluer box, yellower
  // azalea) and value.
  let segC = floor(world.xz / 6.5);
  let seg = hash21(segC + 0.5) - 0.5;
  let hj = vec3f(1.0 + 0.16 * seg, 1.0, 1.0 - 0.16 * seg) * (0.9 + 0.2 * hash21(segC + 9.0));
  col *= hj;
  // Dead and browned patches: 0.2-0.6 m, a few per run, grey-brown twigs
  // and dry leaves, a little lighter than the live green.
  let deadN = valueNoise(fpw * 3.2 + vec2f(13.0, 3.0) + segC * 7.1) * 0.7 + valueNoise(fpw * 9.0 + 2.0) * 0.3;
  let dead = smoothstep(0.7, 0.76, deadN + 0.08 * (hash21(segC + 21.0) - 0.5));
  col = mix(col, vec3f(0.11, 0.085, 0.05) * mix(0.6, 1.15, lit), dead * 0.75);
  // New growth: yellow-green tips on top and the upper edge of the sides.
  let topness = select(smoothstep(0.35, 0.68, h), 1.0, isTop);
  col = mix(col, vec3f(0.22, 0.3, 0.08), smoothstep(0.55, 0.85, leaf * topness * lobe + 0.15 * sw) * 0.7 * topness * (1.0 - dead));
  s.albedo = col;
  // Shading: the clipped top rolls over, the swell and the lobes tilt the
  // faces, the clusters break it up up close.
  let top = smoothstep(0.58, 0.7, h);
  var nn = n + vec3f(0.0, top * 0.6 * (1.0 - n.y), 0.0);
  nn += (T * gS.x + B * gS.y) * 0.08;
  nn -= (T * lobeC.y + B * lobeC.z) * 0.18 * lobeK;
  nn -= (T * gL.x + B * gL.y) * 0.012;
  s.normal = normalize(nn);
  // AO: ~0.3 at the base where the mass is old wood and shade; the voids
  // between lobes x0.4; gaps between clusters darker.
  let baseAo = select(mix(0.3, 1.0, smoothstep(0.0, 0.6, h)), 1.0, isTop);
  s.ao = baseAo * mix(0.4, 1.0, lobe) * (1.0 - 0.45 * (1.0 - smoothstep(0.15, 0.7, leaf)) * det - 0.12 * (1.0 - det));
  s.rough = 0.8;
  s.cls = CLASS_FOLIAGE;
  return s;
}

// Street-tree bark: grey-brown with vertical furrows (ridges lighter and
// lichen-flecked, furrows dark), a bump from the furrow profile. Uses the
// trunk's uv (x around in metres, y up) when the mesh carries one, else a
// per-face coordinate; flat (soil, caps) faces stay a dark brown.
fn barkMat(world: vec3f, n: vec3f, uv: vec2f) -> Surf {
  var s = defaultSurf(n);
  s.rough = 0.92;
  if (abs(n.y) > 0.6) {
    s.albedo = vec3f(0.12, 0.09, 0.07) * (0.8 + 0.4 * valueNoise(world.xz * 8.0));
    s.rough = 0.95;
    return s;
  }
  let T = normalize(vec3f(-n.z, 0.0, n.x));
  let hasUv = abs(uv.x) + abs(uv.y) > 1e-4;
  let p = select(vec2f(dot(world, T), world.y), uv, hasUv);
  let foot = max(length(dWorldX), length(dWorldY));
  let det = 1.0 - smoothstep(0.006, 0.03, foot);
  // Furrows: ~3 cm period around, wandering and splitting up the trunk.
  let w = valueNoise(vec2f(p.x * 8.0, p.y * 1.2)) * 1.2 + valueNoise(vec2f(p.x * 20.0, p.y * 3.0)) * 0.4;
  let f = fract(p.x / 0.035 + w);
  let ridge = smoothstep(0.0, 0.35, f) * (1.0 - smoothstep(0.55, 1.0, f));
  let plates = valueNoise(vec2f(p.x * 30.0, p.y * 9.0));
  let lichen = smoothstep(0.62, 0.8, valueNoise(p * vec2f(6.0, 2.0) + 4.0)) * 0.6;
  var col = mix(vec3f(0.07, 0.055, 0.045), vec3f(0.24, 0.2, 0.16), mix(0.55, ridge * (0.7 + 0.3 * plates), det));
  col = mix(col, vec3f(0.32, 0.34, 0.26), lichen * mix(0.3, ridge, det));
  s.albedo = col;
  let slope = select(0.0, 1.0, f < 0.35) - select(0.0, 1.0, f > 0.55);
  s.normal = normalize(n + T * slope * 0.6 * det);
  s.ao = mix(0.6, 1.0, mix(0.6, ridge, det));
  applyWetness(&s, world, 0.0, 0.8);
  return s;
}

// Japanese 7-segment-ish digit (0..9) in a 0.5 x 0.8 box centred on p.
fn rdDigit(p: vec2f, dgt: u32, th: f32) -> f32 {
  // Segments a(top) b(top-right) c(bottom-right) d(bottom) e(bottom-left) f(top-left) g(mid).
  let masks = array<u32, 10>(0x3fu, 0x06u, 0x5bu, 0x4fu, 0x66u, 0x6du, 0x7du, 0x07u, 0x7fu, 0x6fu);
  let m = masks[dgt % 10u];
  let W = 0.22;
  let H = 0.36;
  var d = 1e3;
  if ((m & 1u) != 0u) { d = min(d, rdSeg(p, vec2f(-W, H), vec2f(W, H))); }
  if ((m & 2u) != 0u) { d = min(d, rdSeg(p, vec2f(W, H), vec2f(W, 0.0))); }
  if ((m & 4u) != 0u) { d = min(d, rdSeg(p, vec2f(W, 0.0), vec2f(W, -H))); }
  if ((m & 8u) != 0u) { d = min(d, rdSeg(p, vec2f(-W, -H), vec2f(W, -H))); }
  if ((m & 16u) != 0u) { d = min(d, rdSeg(p, vec2f(-W, 0.0), vec2f(-W, -H))); }
  if ((m & 32u) != 0u) { d = min(d, rdSeg(p, vec2f(-W, H), vec2f(-W, 0.0))); }
  if ((m & 64u) != 0u) { d = min(d, rdSeg(p, vec2f(-W, 0.0), vec2f(W, 0.0))); }
  return d - th;
}

// Physical width / height of a sign face whose uv spans 0..1 (from the
// screen derivatives), to tell plates of different shapes apart.
fn signAspect() -> f32 {
  let det = dUvX.x * dUvY.y - dUvX.y * dUvY.x;
  let du = (dWorldX * dUvY.y - dWorldY * dUvX.y) / det;
  let dv = (dWorldY * dUvX.x - dWorldX * dUvY.x) / det;
  return length(du) / max(length(dv), 1e-6);
}

// Road signs (CM.roadSign): uv 0..1 over the face. Kinds 0-5 regulatory
// discs/squares, 16-23 overhead guide signs, 24-31 intersection-name
// plates; 0x100 = back face.
fn roadSignMat(world: vec3f, n: vec3f, uv: vec2f, param: u32) -> Surf {
  var s = defaultSurf(n);
  s.rough = 0.45;
  if ((param & 0x100u) != 0u) {
    s.albedo = vec3f(0.45);
    s.metal = 0.6;
    applyWetness(&s, world, 0.0, 0.0);
    return s;
  }
  let k = param & 0xffu;
  let foot = max(length(dUvX), length(dUvY));
  let white = vec3f(0.8, 0.8, 0.78);
  let blue = vec3f(0.03, 0.15, 0.48);
  let red = vec3f(0.62, 0.06, 0.05);
  let p = (uv - 0.5) * vec2f(1.0, -1.0);
  let r = length(p);
  let aa = max(foot, 0.004);
  var col = vec3f(0.45);
  if (k <= 5u && k != 4u) {
    // Discs.
    let disc = 1.0 - smoothstep(0.5 - aa, 0.5, r);
    if (k <= 1u) {
      col = mix(white, red, smoothstep(0.38 - aa, 0.38, r));
      let d0 = rdDigit((p - vec2f(-0.13, 0.0)) * vec2f(1.6, 1.25) , select(5u, 4u, k == 0u), 0.035);
      let d1 = rdDigit((p - vec2f(0.13, 0.0)) * vec2f(1.6, 1.25), 0u, 0.035);
      col = mix(col, blue, 1.0 - smoothstep(-aa, aa, min(d0, d1)));
    } else if (k == 2u) {
      col = mix(blue, red, smoothstep(0.38 - aa, 0.38, r));
      let sl = rdSeg(p, vec2f(-0.28, 0.28), vec2f(0.28, -0.28)) - 0.05;
      col = mix(col, red, 1.0 - smoothstep(-aa, aa, sl));
    } else if (k == 3u) {
      col = blue;
      var ad = rdSeg(p, vec2f(0.05, -0.3), vec2f(0.05, 0.12)) - 0.05;
      ad = min(ad, rdTri(p - vec2f(0.05, 0.32), vec2f(0.13, 0.22)));
      ad = min(ad, rdSeg(p, vec2f(0.05, -0.05), vec2f(-0.15, 0.05)) - 0.05);
      ad = min(ad, rdTri(vec2f(p.y - 0.05, -(p.x + 0.17)) * vec2f(1.0, 1.0) , vec2f(0.12, 0.18)));
      col = mix(col, white, 1.0 - smoothstep(-aa, aa, ad));
    } else {
      col = red;
      let bar = rdBox(p, vec2f(0.3, 0.07));
      col = mix(col, white, 1.0 - smoothstep(-aa, aa, bar));
    }
    col = mix(vec3f(0.45), col, disc);
  } else if (k == 4u) {
    // Pedestrian crossing: blue square, white triangle with a walker.
    col = blue;
    let tri = rdTri(vec2f(p.x, -(p.y - 0.32)), vec2f(0.36, 0.6));
    col = mix(col, white, 1.0 - smoothstep(-aa, aa, tri));
    var man = length(p - vec2f(0.0, 0.08)) - 0.045;
    man = min(man, rdSeg(p, vec2f(0.0, 0.02), vec2f(0.0, -0.12)) - 0.025);
    man = min(man, rdSeg(p, vec2f(0.0, -0.12), vec2f(-0.07, -0.24)) - 0.022);
    man = min(man, rdSeg(p, vec2f(0.0, -0.12), vec2f(0.07, -0.24)) - 0.022);
    col = mix(col, blue, 1.0 - smoothstep(-aa, aa, man));
    col = mix(col, white, paintLine(abs(rdBox(p, vec2f(0.46))), 0.03, aa));
  } else if (k >= 16u && k < 24u) {
    // Overhead guide sign: blue, white border, arrow diagram, text blocks.
    let v = k - 16u;
    col = blue;
    let q = p * vec2f(2.0, 1.0);
    col = mix(col, white, paintLine(abs(rdBox(q, vec2f(0.97, 0.47))), 0.025, aa));
    var ad = rdSeg(q, vec2f(0.0, -0.4), vec2f(0.0, 0.25)) - 0.04;
    ad = min(ad, rdTri(q - vec2f(0.0, 0.4), vec2f(0.09, 0.15)));
    ad = min(ad, rdSeg(q, vec2f(-0.35, -0.05), vec2f(0.35, -0.05)) - 0.03);
    ad = min(ad, rdTri(vec2f(q.y + 0.05, -(q.x + 0.47)), vec2f(0.08, 0.12)));
    ad = min(ad, rdTri(vec2f(-(q.y + 0.05), q.x - 0.47), vec2f(0.08, 0.12)));
    // Text blocks: three destinations (left, right, ahead) + route shields.
    let rows = array<vec4f, 3>(vec4f(-0.7, -0.15, 0.22, 0.07), vec4f(0.7, -0.15, 0.22, 0.07), vec4f(0.0, 0.48 - 0.3, 0.0, 0.0));
    for (var i = 0u; i < 2u; i++) {
      let rr = rows[i];
      let cq = q - rr.xy;
      let chars = abs(fract(cq.x / 0.11 + 0.5) - 0.5) * 0.11;
      let tb = max(rdBox(cq, rr.zw), 0.035 - chars);
      ad = min(ad, tb);
      let sub = rdBox(cq - vec2f(0.0, -0.13), vec2f(rr.z * 0.8, 0.03));
      ad = min(ad, sub);
    }
    let top = q - vec2f(0.0, 0.33 + 0.02 * f32(v % 2u));
    ad = min(ad, max(rdBox(top - vec2f(0.4, 0.0), vec2f(0.18, 0.06)), 0.035 - abs(fract(top.x / 0.11) - 0.5) * 0.11));
    col = mix(col, white, 1.0 - smoothstep(-aa, aa, ad));
    // Route shield.
    let sh = length(q - vec2f(-0.45, 0.33)) - 0.08;
    col = mix(col, white, 1.0 - smoothstep(-aa, aa, sh));
  } else if (k >= 24u && k < 32u && signAspect() < 2.9) {
    // Platform number plate (gen-base, 1.1 x 0.5 m; the road's name plates
    // are 3.6:1): JR-style white plate, the track number in a dark ring on
    // the left, a "bansen" / "Track" text block beside it.
    let q = p * vec2f(2.2, 1.0);
    col = white * 1.05;
    let num = (k - 24u) % 8u + 1u;
    let ring = length(q - vec2f(-0.68, 0.0));
    col = mix(col, vec3f(0.06, 0.2, 0.12), 1.0 - smoothstep(0.36 - aa, 0.36, ring));
    col = mix(col, white * 1.05, 1.0 - smoothstep(0.3 - aa, 0.3, ring));
    let dg = rdDigit((q - vec2f(-0.68, 0.0)) * 1.55, num, 0.06) / 1.55;
    col = mix(col, vec3f(0.04), 1.0 - smoothstep(-aa, aa, dg));
    let chars = abs(fract((q.x - 0.05) / 0.26) - 0.5) * 0.26;
    let jp = max(rdBox(q - vec2f(0.33, 0.1), vec2f(0.24, 0.13)), 0.025 - chars);
    let en = rdBox(q - vec2f(0.33, -0.2), vec2f(0.24, 0.035));
    col = mix(col, vec3f(0.05), 1.0 - smoothstep(-aa, aa, min(jp, en)));
    // Line-colour band along the bottom edge.
    col = mix(col, vec3f(0.1, 0.55, 0.2), step(p.y, -0.4));
  } else if (k >= 24u && k < 32u) {
    // Intersection-name plate: blue with a white name line.
    col = blue;
    let q = p * vec2f(3.6, 1.0);
    let chars = abs(fract(q.x / 0.5 + 0.5 + f32(k) * 0.1) - 0.5) * 0.5;
    let tb = max(rdBox(q - vec2f(0.0, 0.06), vec2f(1.2, 0.2)), 0.1 - chars);
    let sub = rdBox(q - vec2f(0.0, -0.3), vec2f(0.9, 0.06));
    col = mix(col, white, 1.0 - smoothstep(-aa, aa, min(tb, sub)));
  }
  s.albedo = col;
  s.metal = 0.0;
  // Retroreflective sheeting: a faint glow at night.
  s.emissive = col * nightLight() * 0.15;
  applyWetness(&s, world, 0.0, 0.0);
  return s;
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
    // Each sheet its own batch and fade; a dark 3 cm lap seam with the
    // lighter raised lip of the upper sheet beside it, every metre, so the
    // roof reads as laid sheets from the air (averaging to a fine stripe
    // further away rather than vanishing).
    pattern = mix(1.0, 0.86 + 0.26 * hash21(sheet), fine);
    pattern *= 1.0 - 0.45 * max(paintLine(lap, 0.03, foot), paintLine(end, 0.03, foot));
    pattern *= 1.0 + 0.25 * paintLine(abs(lap - 0.04), 0.025, foot);
    // UV chalking and foot-traffic grime in broad, soft patches.
    pattern *= 0.82 + 0.36 * fbm2(uv * 0.22 + f32(h & 63u));
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
  var pondK = 0.0;
  // Ponding: shallow dips (a third of 6 m cells) where water stands after
  // rain and dries to a dark, green-grey silt stain inside pale tide marks.
  {
    let pc = floor(uv / 6.0);
    let ph = hash21(pc + 51.0 + f32(h & 255u));
    let pp = (pc + 0.25 + 0.5 * hash22(pc + 9.0)) * 6.0;
    let pr = mix(0.8, 2.0, fract(ph * 13.0)) * (0.75 + 0.5 * valueNoise(uv * 0.9 + pc));
    let pd = length((uv - pp) * vec2f(1.0, mix(0.6, 1.4, fract(ph * 7.0))));
    if (ph < 0.35) {
      let pond = 1.0 - smoothstep(pr * 0.7, pr, pd);
      s.albedo = mix(s.albedo, s.albedo * vec3f(0.62, 0.66, 0.58), pond);
      s.albedo *= 1.0 + 0.25 * (paintLine(abs(pd - pr), 0.08, foot) + 0.6 * paintLine(abs(pd - pr * 0.8), 0.05, foot));
      pondK = pond;
    }
  }
  if (dr < 0.2) {
    s.albedo = vec3f(0.05);
    s.metal = 0.6;
  }
  s.rough = 0.9;
  applyWetness(&s, world, 0.0, 0.4);
  // In the rain the dips hold standing water.
  s.rough = mix(s.rough, 0.03, pondK * frame.weather.z);
  s.albedo *= 1.0 - 0.5 * pondK * frame.weather.z;
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

// Sign atlas (src/city/signs.ts): 2048x2560. param = id | flags << 8:
// 0x100 fabric (unlit cloth), 0x200 striped awning canvas; bits 10-13 a shop
// sign colourway offset (see shopSign).
fn signMat(world: vec3f, n: vec3f, uv: vec2f, param: u32) -> Surf {
  var s = defaultSurf(n);
  let id = param & 0xffu;
  let fabric = (param & 0x100u) != 0u;
  if ((param & 0x200u) != 0u) {
    // Awning canvas: stripes of the shop color and off-white along u, a
    // little sag shading across v.
    let col = signPalette(id);
    let st = step(0.5, fract(uv.x * 0.5));
    s.albedo = mix(col * 0.55, vec3f(0.72, 0.7, 0.66), st) * (0.8 + 0.2 * sin(uv.y * 3.14159));
    s.rough = 0.9;
    // Back-lit by the shop at night: a faint translucent glow.
    s.emissive = s.albedo * 0.08 * nightLight();
    return s;
  }
  // Station name boards: gen-base packs ids 56..71 for them (the atlas only
  // wraps those onto billboards), so they are drawn here as JR boards.
  if (id >= 56u && id < 72u && (param & 0x300u) == 0u) {
    if ((param & NAME_BIG) != 0u) {
      // Concourse main board: one board unit stretched NB_SCALE x over the
      // whole face (gen-base NAME_BIG), a little less bright per area.
      dUvX /= NB_SCALE;
      dUvY /= NB_SCALE;
      var nb = railNameBoard(world, n, uv / NB_SCALE, id);
      nb.emissive *= 0.6;
      return nb;
    }
    return railNameBoard(world, n, uv, id);
  }
  var rect: vec4f;
  if (id < 32u) {
    rect = vec4f(f32(id % 16u) * 128.0, f32(id / 16u) * 512.0, 128.0, 512.0);
  } else if (id < 48u) {
    let k = id - 32u;
    rect = vec4f(f32(k % 4u) * 512.0, 1024.0 + f32(k / 4u) * 128.0, 512.0, 128.0);
  } else if (id < 72u) {
    let k = (id - 48u) % 8u;
    rect = vec4f(f32(k % 4u) * 512.0, 1536.0 + f32(k / 4u) * 256.0, 512.0, 256.0);
  } else {
    let k = (id - 72u) % 16u;
    rect = vec4f(f32(k % 8u) * 256.0, 2048.0 + f32(k / 8u) * 256.0, 256.0, 256.0);
  }
  let f = fract(uv);
  // Mip level from the uv footprint, capped so the inset keeps neighbouring
  // signs from bleeding in.
  let dx = dUvX * rect.zw;
  let dy = dUvY * rect.zw;
  let lod = atlasLod(dx, dy);
  let lodC = clamp(lod, 0.0, 3.0);
  // Inset by the filter's reach: its mip texel, plus half the anisotropic
  // span along each atlas axis.
  let inset = min(vec2f(2.0 * exp2(lodC)) + 0.5 * (abs(dx) + abs(dy)) * exp2(min(3.0 - lod, 0.0)), rect.zw * 0.1);
  let px = rect.xy + mix(inset, rect.zw - inset, f);
  let c = atlasGrad(px, dx, dy, lod).rgb;
  if (id < 44u || id >= 72u) {
    return shopSign(s, n, c, px, dx, dy, lod, rect, id, param, fabric);
  }
  if (fabric) {
    // Printed cloth: matte, lit only by the scene (a faint glow at night
    // from shop light behind it).
    s.albedo = c * 0.75;
    s.rough = 0.9;
    s.emissive = c * 0.06 * nightLight();
    return s;
  }
  s.albedo = c * 0.6;
  s.rough = 0.3;
  if (id >= 48u && id < 72u) {
    // Billboards are printed panels floodlit from lamps over the top edge,
    // not light boxes: bright pools under the lamps, falling off down the
    // panel to about a third at the bottom. Off by day.
    let fy = clamp(f.y, 0.0, 1.0);
    let pool = max(exp(-pow((f.x - 0.25) / 0.2, 2.0)), exp(-pow((f.x - 0.75) / 0.2, 2.0)));
    let flood = (0.3 + 0.7 * exp(-fy * 2.2)) * mix(1.0, 0.7 + 0.5 * pool, exp(-fy * 1.5));
    s.rough = 0.45;
    s.emissive = c * (0.15 + 0.85 * c) * 1.4 * flood * mix(0.02, 4.0, gloomLight());
    return s;
  }
  s.emissive = c * c * 1.2 * mix(0.25, 4.5, gloomLight());
  return s;
}

// JR line colours by board id.
fn railLineColour(id: u32) -> vec3f {
  let lines = array<vec3f, 8>(
    vec3f(0.32, 0.61, 0.03), // Yamanote yellow-green
    vec3f(0.88, 0.1, 0.02),  // Chuo orange
    vec3f(1.0, 0.66, 0.0),   // Sobu yellow
    vec3f(0.0, 0.44, 0.78),  // Keihin-Tohoku sky blue
    vec3f(0.0, 0.41, 0.32),  // Saikyo green
    vec3f(0.0, 0.13, 0.52),  // Yokosuka blue
    vec3f(0.0, 0.44, 0.12),  // Joban emerald
    vec3f(0.62, 0.0, 0.04)); // private-line red
  return lines[id & 7u];
}

// JR-style station name board (ids 64..71; box UV in metres, uv.y up from
// the board's bottom edge, so the layout is anchored there whatever the
// board's size). The lettering comes from the sign atlas' station cells
// (ids 44..47, src/render/sign-atlas.ts): one 2.4 x 0.6 m board unit per
// cell, repeated along the board: the name in bold kanji with its romaji,
// and a band in the line colour carrying the adjacent stations in white
// with arrows. A white light box, lit from inside at night.
// Ids 56..63 are the bridge-number plates on the columns (uv 0..1, v down).
// gen-base NAME_BIG / NB_SCALE: the concourse's big name board.
const NAME_BIG = 0x400u;
const NB_SCALE = 4.5;

fn railNameBoard(world: vec3f, n: vec3f, uv: vec2f, id: u32) -> Surf {
  var s = defaultSurf(n);
  let fp = max(length(dWorldX), length(dWorldY));
  let fu = uvFoot();
  let lc = railLineColour(id);
  if (id < 64u) {
    // Bridge-number plate (0.4 x 0.26 m): white enamel, a line-colour rule
    // at the top, a black bridge number in stencil digits, rusty edge.
    var tu: vec3f;
    var tv: vec3f;
    uvDirs(&tu, &tv);
    let rgt = cross(-n, vec3f(0.0, 1.0, 0.0));
    let x = select(1.0 - uv.x, uv.x, dot(tu, rgt) >= 0.0);
    let q = vec2f((x - 0.5) * 0.4, (0.5 - uv.y) * 0.26);
    var c = vec3f(0.84, 0.84, 0.81);
    c = mix(c, lc, bandF(q.y, 0.075, 0.105, fu.y * 0.26));
    let num = hashu(u32(i32(floor(world.x * 0.25)) + 65536) * 0x9e37u + u32(i32(floor(world.z * 0.25)) + 65536)) % 1000u;
    let k = 0.12;
    var gd = 1e3;
    for (var i = 0u; i < 3u; i++) {
      let dg = (num / select(select(1u, 10u, i == 1u), 100u, i == 0u)) % 10u;
      gd = min(gd, rdDigit((q - vec2f((f32(i) - 1.0) * 0.08, -0.03)) / k, dg, 0.09) * k);
    }
    let ink = 1.0 - smoothstep(-fp * 0.5, fp * 0.5, gd);
    c = mix(c, vec3f(0.04), ink * (1.0 - smoothstep(0.01, 0.03, fp)) + 0.25 * smoothstep(0.01, 0.03, fp) * step(abs(q.y + 0.03), 0.05) * step(abs(q.x), 0.12));
    let edge = 1.0 - bandF(q.x, -0.19, 0.19, fu.x * 0.4) * bandF(q.y, -0.12, 0.12, fu.y * 0.26);
    c = mix(c, vec3f(0.3, 0.17, 0.09), edge * 0.7);
    s.albedo = c * 0.85;
    s.rough = 0.25;
    return s;
  }
  let y = uv.y;
  // Atlas cell 44 + (id & 3): 512 x 128 texels over 2.4 x 0.6 m.
  let U = 2.4;
  let V = 0.6;
  let rect = vec4f(f32(id & 3u) * 512.0, 1408.0, 512.0, 128.0);
  let f = vec2f(fract(uv.x / U), clamp(1.0 - y / V, 0.0, 1.0));
  let dx = dUvX * vec2f(512.0 / U, -128.0 / V);
  let dy = dUvY * vec2f(512.0 / U, -128.0 / V);
  let lod = atlasLod(dx, dy);
  let inset = vec2f(min(2.0 * exp2(clamp(lod, 0.0, 3.0)), 12.0), 1.0);
  let px = rect.xy + mix(inset, rect.zw - inset, f);
  let t = atlasGrad(px, dx, dy, lod).rgb;
  let lum = dot(t, vec3f(0.2126, 0.7152, 0.0722));
  let inBand = bandF(y, 0.04, 0.17, fu.y);
  var c = vec3f(0.88, 0.88, 0.86);
  c = mix(c, lc, inBand);
  // Black lettering on the white face (only inside the cell's 0.6 m), white
  // lettering in the band.
  let ink = (1.0 - smoothstep(0.08, 0.6, lum)) * (1.0 - inBand) * step(y, V - 0.01);
  let wtxt = smoothstep(0.4, 0.85, lum) * inBand;
  c = mix(c, vec3f(0.03), ink);
  c = mix(c, vec3f(0.95), wtxt);
  // A thin dark rule over the band and a grey frame line along the bottom.
  c = mix(c, vec3f(0.12), bandF(y, 0.17, 0.182, fu.y) * 0.8);
  s.albedo = c * 0.85;
  s.rough = 0.3;
  s.emissive = c * c * mix(0.25, 3.5, gloomLight());
  return s;
}

// Shop signs: the atlas cell holds masks (R lettering, G frame ring and
// letter outlines, B bevel height; src/render/sign-atlas.ts), painted in one
// of the SIGN_WAYS colourways (src/city/signs.ts) picked by the id and the
// building's offset in param bits 10-13.
fn shopSign(
  s0: Surf, n: vec3f, m: vec3f, px: vec2f, dx: vec2f, dy: vec2f, lod: f32,
  rect: vec4f, id: u32, param: u32, fabric: bool,
) -> Surf {
  var s = s0;
  var wi = (id * 5u + ((param >> 10u) & 15u)) & 15u;
  // Cloth is printed: the lit-letter looks (channel, neon) become light-box
  // colourways, so a white-on-white scheme never blanks a banner.
  if (fabric && SIGN_WAYS[wi].style != 0u && SIGN_WAYS[wi].style != 3u) { wi = (wi + 4u) & 15u; }
  let w = SIGN_WAYS[wi];
  var col = mix(w.bg, w.edge, m.g);
  col = mix(col, w.fg, m.r);
  if (fabric) {
    // Printed cloth: matte, lit only by the scene (a faint glow at night
    // from shop light behind it).
    s.albedo = col * 0.75;
    s.rough = 0.9;
    s.emissive = col * 0.06 * nightLight();
    return s;
  }
  // Raised lettering: a bevel normal from the height mask's slope, fading
  // out once a texel no longer covers a few pixels.
  var relief = 0.35;
  if (w.style == 1u) { relief = 1.0; }
  else if (w.style == 2u) { relief = 0.8; }
  else if (w.style == 3u) { relief = 0.5; }
  relief *= 1.0 - smoothstep(0.5, 2.0, lod);
  if (relief > 0.0) {
    let o = exp2(clamp(lod, 0.0, 3.0)) * 1.5;
    let hx = atlasGrad(px + vec2f(o, 0.0), dx, dy, lod).b - atlasGrad(px - vec2f(o, 0.0), dx, dy, lod).b;
    let hy = atlasGrad(px + vec2f(0.0, o), dx, dy, lod).b - atlasGrad(px - vec2f(0.0, o), dx, dy, lod).b;
    // World tangents along the cell's u and v (metres per unit uv) from the
    // screen derivatives.
    let det = dUvX.x * dUvY.y - dUvX.y * dUvY.x;
    if (abs(det) > 1e-12) {
      let dPdu = (dWorldX * dUvY.y - dWorldY * dUvX.y) / det;
      let dPdv = (dWorldY * dUvX.x - dWorldX * dUvY.x) / det;
      let lu = max(length(dPdu), 1e-4);
      let lv = max(length(dPdv), 1e-4);
      // 12 mm of relief per unit of mask; slopes in metres per metre.
      let su = clamp(hx / (2.0 * o) * rect.z * 0.012 / lu, -1.5, 1.5) * relief;
      let sv = clamp(hy / (2.0 * o) * rect.w * 0.012 / lv, -1.5, 1.5) * relief;
      s.normal = normalize(n - dPdu / lu * su - dPdv / lv * sv);
      // The letters' returns read as a dark rim (most on channel letters).
      s.ao = 1.0 - min(length(vec2f(su, sv)), 1.0) * 0.45;
    }
  }
  let gl = gloomLight();
  switch (w.style) {
    case 1u: {
      // Channel letters: an unlit panel, letters lit from inside (faint by day).
      s.albedo = col * 0.7;
      s.rough = 0.45;
      s.emissive = w.fg * w.fg * m.r * 1.3 * mix(0.06, 4.5, gl);
    }
    case 2u: {
      // Neon tubes (lettering and frame) on a dark gloss backing, with a halo
      // from a coarse mip of the lettering.
      let halo = atlasGrad(px, dx * 8.0, dy * 8.0, lod + 3.0).r;
      let tube = max(m.r, m.g);
      s.albedo = mix(w.bg * 0.8, col * 0.5, tube);
      s.rough = mix(0.25, 0.4, tube);
      let glow = w.fg * m.r + w.edge * m.g * (1.0 - m.r);
      s.emissive = (glow * 1.6 + w.fg * halo * 0.3 * (1.0 - tube)) * mix(0.12, 4.5, gl);
    }
    case 3u: {
      // Painted board: unlit, a little floodlight spill at night.
      s.albedo = col * 0.75;
      s.rough = 0.55;
      s.emissive = col * 0.08 * gl;
    }
    default: {
      // Light box: the whole translucent face glows, dark ink stays dark.
      s.albedo = col * 0.6;
      s.rough = 0.3;
      s.emissive = col * col * 1.2 * mix(0.25, 4.5, gl);
    }
  }
  return s;
}

// Linear sign color, matching signColor() in src/city/signs.ts.
fn signPalette(id: u32) -> vec3f {
  switch ((id * 7u + (id >> 3u)) % 8u) {
    case 0u: { return vec3f(1.0, 0.15, 0.1); }
    case 1u: { return vec3f(1.0, 0.75, 0.1); }
    case 2u: { return vec3f(0.2, 0.9, 1.0); }
    case 3u: { return vec3f(1.0, 0.25, 0.7); }
    case 4u: { return vec3f(0.3, 1.0, 0.35); }
    case 5u: { return vec3f(1.0, 1.0, 0.95); }
    case 6u: { return vec3f(0.35, 0.4, 1.0); }
    default: { return vec3f(1.0, 0.45, 0.05); }
  }
}

// A kanji-like glyph (p in -0.5..0.5, 1 = stroke): 1-4 horizontal and 1-3
// vertical strokes picked by h, a dot for some.
fn fauxKanji(p: vec2f, h: u32) -> f32 {
  if (abs(p.x) > 0.5 || abs(p.y) > 0.5) { return 0.0; }
  let w = 0.07;
  var g = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let yk = -0.36 + f32(k) * 0.24;
    if (((h >> k) & 1u) == 1u || k == 0u) {
      let x0 = select(-0.4, -0.18, ((h >> (k + 4u)) & 1u) == 1u);
      g = max(g, step(abs(p.y - yk), w) * step(x0, p.x) * step(p.x, 0.4));
    }
  }
  for (var k = 0u; k < 3u; k++) {
    if (((h >> (k + 8u)) & 1u) == 1u || k == 1u) {
      let xk = -0.28 + f32(k) * 0.28;
      let y1 = select(0.4, 0.1, ((h >> (k + 12u)) & 1u) == 1u);
      g = max(g, step(abs(p.x - xk), w) * step(-0.42, p.y) * step(p.y, y1));
    }
  }
  g = max(g, step(length(p - vec2f(0.3, 0.36)), 0.08) * f32((h >> 16u) & 1u));
  return g;
}

// Station departure board (CM.screen DEPARTURE | station, uv 0..1 over a
// 1.8 x 0.44 m face, v up): an amber / green LED dot-matrix (7.5 mm pitch)
// in a dark housing. Three rows: two departures (train type in green or
// orange kanji, the time in amber digits, the destination in kanji
// rasterised from the sign atlas' station cells, the car count) and an
// orange ticker scrolling along the bottom. The dots fall back to their
// lit mean once the pitch is under ~2 px.
fn depGlyph(dc: vec2f, si: u32, t: f32) -> vec4f {
  let amber = vec3f(1.0, 0.42, 0.04);
  let green = vec3f(0.25, 1.0, 0.3);
  let orange = vec3f(1.0, 0.2, 0.02);
  var on = 0.0;
  var col = amber;
  // Row r (0 = top), 0.1 m glyphs on a 0.125 m pitch.
  let r = clamp(floor((0.41 - dc.y) / 0.125), 0.0, 2.0);
  let yb = 0.41 - (r + 1.0) * 0.125 + 0.0125;
  let ly = (dc.y - yb) / 0.1 - 0.5;
  if (abs(ly) < 0.5 && r < 2.0) {
    let hr = hashu(si * 0x9e37u + u32(r) * 0x51u + u32(floor(t / 90.0)));
    let x = dc.x;
    if (x < 0.27) {
      // Train type: two kanji, green (local) or orange (rapid).
      let rapid = (hr & 1u) == 1u;
      col = select(green, orange, rapid);
      let ci = floor((x - 0.05) / 0.1);
      let p = vec2f(fract((x - 0.05) / 0.1) - 0.5, ly);
      on = fauxKanji(p * 1.15, hashu(hr ^ u32(ci + 3.0))) * step(0.05, x) * step(ci, 1.0);
    } else if (x < 0.66) {
      // Departure time h:mm / hh:mm in amber digits.
      col = amber;
      let mins = 600u + (hr % 700u) + u32(r) * 7u;
      let hh = (mins / 60u) % 24u;
      let mm = mins % 60u;
      let dg = array<u32, 4>(hh / 10u, hh % 10u, mm / 10u, mm % 10u);
      let ci = clamp(floor((x - 0.3) / 0.08), 0.0, 3.0);
      let c0 = 0.3 + ci * 0.08 + 0.04 + select(0.0, 0.04, ci > 1.5);
      let k = 0.11;
      let d = rdDigit(vec2f(x - c0, ly * 0.1) / k, dg[u32(ci)], 0.12) * k;
      on = step(d, 0.0);
      on = max(on, step(abs(x - 0.46), 0.006) * step(abs(abs(ly) - 0.2), 0.08));
    } else if (x < 1.5) {
      // Destination: kanji from an atlas station cell's name field,
      // sampled at the dot centres; two small green kanji after it.
      col = amber;
      let cell = (hr >> 4u) & 3u;
      let ax = (x - 0.7) / 0.5;
      if (ax > 0.0 && ax < 1.0) {
        let a = vec2f(1.2 + (ax - 0.5) * 1.0, 0.385 - ly * 0.24);
        let px = vec2f(f32(cell) * 512.0 + a.x / 2.4 * 512.0, 1408.0 + (1.0 - a.y / 0.6) * 128.0);
        let tx = textureSampleLevel(signAtlas, linearSampler, px / vec2f(2048.0, 2560.0), 0.0).rgb;
        on = 1.0 - smoothstep(0.25, 0.55, dot(tx, vec3f(0.2126, 0.7152, 0.0722)));
      }
      let vx = x - 1.25;
      if (vx > 0.0) {
        col = green;
        on = fauxKanji(vec2f(fract(vx / 0.1) - 0.5, ly) * 1.2, hashu(hr ^ u32(floor(vx / 0.1) + 9.0)));
      }
    } else {
      // Car count: "10" or "15" and a kanji.
      col = green;
      let cx = x - 1.52;
      let k = 0.11;
      let five = ((hr >> 6u) & 1u) == 1u;
      if (cx < 0.08) {
        on = step(rdDigit(vec2f(cx - 0.04, ly * 0.1) / k, 1u, 0.12) * k, 0.0);
      } else if (cx < 0.16) {
        on = step(rdDigit(vec2f(cx - 0.12, ly * 0.1) / k, select(0u, 5u, five), 0.12) * k, 0.0);
      } else {
        on = fauxKanji(vec2f((cx - 0.21) / 0.1, ly) * 1.15, 0x1a5u);
      }
    }
  } else if (abs(ly) < 0.5) {
    // Ticker: orange kanji scrolling left at 0.25 m/s, in 8-glyph words.
    col = orange;
    let sx = dc.x + t * 0.25;
    let ci = floor(sx / 0.1);
    let gap = (u32(i32(ci) + 100000) % 9u) == 8u;
    on = select(fauxKanji(vec2f(fract(sx / 0.1) - 0.5, ly) * 1.15, hashu(u32(i32(ci) + 100000) * 0x2c1bu + si)), 0.0, gap);
  }
  return vec4f(col, on);
}

fn departureBoard(n: vec3f, uv: vec2f, si: u32) -> Surf {
  var s = defaultSurf(n);
  var tu: vec3f;
  var tv: vec3f;
  uvDirs(&tu, &tv);
  let rgt = cross(-n, vec3f(0.0, 1.0, 0.0));
  let ux = select(1.0 - uv.x, uv.x, dot(tu, rgt) >= 0.0);
  let q = vec2f(ux * 1.8, uv.y * 0.44);
  let fp = max(length(dWorldX), length(dWorldY));
  let pitch = 0.0075;
  let dc = (floor(q / pitch) + 0.5) * pitch;
  let t = frame.time.x;
  let field = step(0.03, q.x) * step(q.x, 1.77) * step(0.03, q.y) * step(q.y, 0.41);
  // Glyphs on the dot grid while the dots resolve; once a pixel covers
  // more than ~1 dot they are drawn as smooth shapes, 2x2 supersampled
  // over the pixel footprint, so the rows keep crisp, steady edges at
  // 10-20 m instead of breaking into blocky dot-centre noise.
  let blend = smoothstep(pitch * 0.6, pitch * 1.6, fp);
  var col = vec3f(1.0, 0.42, 0.04);
  var on = 0.0;
  if (blend < 1.0) {
    let g = depGlyph(dc, si, t);
    col = g.rgb;
    on = g.w;
  }
  if (blend > 0.0) {
    let dqx = vec2f(dUvX.x * 1.8, dUvX.y * 0.44);
    let dqy = vec2f(dUvY.x * 1.8, dUvY.y * 0.44);
    var acc = vec4f(0.0);
    for (var k = 0u; k < 4u; k++) {
      let o = vec2f(f32(k & 1u), f32(k >> 1u)) * 0.5 - 0.25;
      let g = depGlyph(q + dqx * o.x + dqy * o.y, si, t);
      acc += vec4f(g.rgb * g.w, g.w);
    }
    col = mix(col, acc.rgb / max(acc.w, 1e-4), blend * step(1e-4, acc.w));
    on = mix(on, acc.w * 0.25, blend);
  }
  on *= field;
  // Each LED a round dot (~60 % of the pitch); past ~2 px a pitch the dots
  // blur into their area mean.
  let dq = (fract(q / pitch) - 0.5) * pitch;
  let dotK = 1.0 - smoothstep(pitch * 0.25, pitch * 0.35 + fp * 0.5, length(dq));
  let dotF = mix(dotK, 0.38, smoothstep(pitch * 0.4, pitch * 1.2, fp));
  // Unlit dots show faintly; the housing is dark grey.
  let housing = 1.0 - field;
  s.albedo = mix(vec3f(0.015), vec3f(0.12, 0.12, 0.13), housing);
  s.rough = mix(0.25, 0.5, housing);
  s.emissive = (col * on * dotF * mix(2.2, 4.0, gloomLight()) + vec3f(0.02, 0.012, 0.005) * dotF) * field;
  return s;
}

// Platform vending machine display front (CM.vending VENDING_FRONT, box UV
// u 0..0.9, v 0.7..1.5 visible between the proud lower door and header):
// a white moulded frame, a lit logo strip along the top, three rows of
// sample drinks each over a dark strip of lit selection buttons, and the
// coin / IC-card panel at the bottom right (grey, a blue IC reader, a red
// price LED). Rows and gaps are >= 4 cm, so they hold at 10-20 m.
fn vendingWindow(n: vec3f, uv: vec2f, brand: vec3f, seed: u32) -> Surf {
  var s = defaultSurf(n);
  let fu = uvFoot();
  let foot = max(length(dWorldX), length(dWorldY));
  let u = clamp(uv.x, 0.0, 0.9);
  let v = uv.y;
  let gl = gloomLight();
  let inner = bandF(u, 0.035, 0.865, fu.x) * bandF(v, 0.735, 1.465, fu.y);
  // Frame: white plastic, a little yellowed, a dark reveal line inside it.
  var a = vec3f(0.82, 0.82, 0.78);
  var e = vec3f(0.0);
  s.rough = 0.35;
  let reveal = bandF(u, 0.03, 0.87, fu.x) * bandF(v, 0.73, 1.47, fu.y) * (1.0 - inner);
  a = mix(a, vec3f(0.05), reveal);
  if (inner > 0.0) {
    var c = vec3f(0.0);
    var ce = vec3f(0.0);
    if (v > 1.38) {
      // Logo strip: a lit white light box with the brand colour and a
      // chunky wordmark.
      let lx = (u - 0.07) / 0.065;
      let li = floor(lx);
      let wk = bandF(v, 1.395, 1.45, fu.y) * step(0.0, lx) * step(li, 7.0) * step(0.18, fract(lx)) * step(fract(lx), 0.86);
      let gx = vec2f(fract(lx), (v - 1.395) / 0.055);
      let gh = hashu(seed * 0x9e37u + u32(li + 1.0));
      let glyph = fauxKanji((gx - 0.5) * vec2f(1.0, 1.1), gh) * (1.0 - smoothstep(0.004, 0.012, foot));
      let wmk = mix(0.55 * wk, wk * glyph, 1.0 - smoothstep(0.006, 0.015, foot));
      c = mix(brand, vec3f(0.95), wmk);
      ce = c * mix(0.9, 3.2, gl);
    } else {
      let ry = v - 0.735;
      let row = floor(ry / 0.215);
      let fy = ry - row * 0.215;
      let ic = bandF(u, 0.63, 0.865, fu.x) * step(row, 0.5);
      if (ic > 0.5) {
        // Coin / IC panel: brushed grey; IC reader (lit blue square), coin
        // slot (a dark slit in a chrome bezel), red price LED, bill slot.
        let pu = u - 0.63;
        c = vec3f(0.3, 0.31, 0.32);
        let rd = bandF(pu, 0.04, 0.12, fu.x) * bandF(fy, 0.11, 0.19, fu.y);
        c = mix(c, vec3f(0.05, 0.12, 0.3), rd);
        ce = vec3f(0.25, 0.55, 1.0) * rd * mix(0.6, 2.4, gl) * (0.7 + 0.3 * step(0.06, abs(pu - 0.08) + abs(fy - 0.15)));
        let coin = bandF(pu, 0.16, 0.2, fu.x) * bandF(fy, 0.1, 0.2, fu.y);
        c = mix(c, vec3f(0.7), coin);
        c = mix(c, vec3f(0.02), bandF(pu, 0.175, 0.185, 0.002 + fu.x) * bandF(fy, 0.115, 0.185, fu.y));
        let led = bandF(pu, 0.04, 0.2, fu.x) * bandF(fy, 0.04, 0.075, fu.y);
        c = mix(c, vec3f(0.03), led);
        ce += vec3f(1.0, 0.12, 0.03) * led * step(0.4, fract(pu * 70.0)) * mix(0.6, 2.2, gl);
        c = mix(c, vec3f(0.03), bandF(pu, 0.03, 0.2, fu.x) * bandF(fy, 0.0, 0.015, fu.y));
        s.rough = 0.45;
      } else if (fy < 0.045) {
        // Button strip: dark, with a lit green-white button under each
        // sample (every 0.083 m), the price tags just above it.
        let bx = fract(u / 0.0833 + 0.5);
        let btn = bandF(bx, 0.3, 0.7, fu.x / 0.0833) * bandF(fy, 0.012, 0.03, fu.y);
        c = vec3f(0.03);
        ce = vec3f(0.35, 1.0, 0.5) * btn * mix(0.4, 2.2, gl) + vec3f(0.6, 0.62, 0.6) * 0.15 * bandF(fy, 0.034, 0.045, fu.y) * mix(0.5, 2.0, gl);
        s.rough = 0.3;
      } else {
        // Samples on the lit white backing.
        let g = shelfGoods(u, fy - 0.045 + 0.04, 0.17 + 0.04, row + f32(seed * 7u), true, foot);
        let k = min(g.w * 1.4, 1.0);
        c = mix(vec3f(0.72), g.rgb, k);
        ce = mix(vec3f(0.5, 0.52, 0.55), g.rgb * 1.15, k) * mix(0.8, 3.0, gl);
        s.rough = 0.08;
      }
    }
    a = mix(a, c, inner);
    e = ce * inner;
  }
  s.albedo = a;
  s.emissive = e;
  return s;
}

fn screenMat(n: vec3f, uv: vec2f, param: u32) -> Surf {
  // (Ad screens carry a 16-bit seed: 1 in 256 of them lands in this range.)
  if ((param >> 16u) == 1u) { return departureBoard(n, uv, param & 0xffu); }
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
  s.emissive = c * mix(1.2, 2.6, gloomLight());
  return s;
}

// Street tree species (src/city/gen-tile.ts TREE): 0 zelkova (green),
// 1 ginkgo (yellow-green, some trees turned gold), 2 columnar (dark
// blue-green). h varies the tone per tree.
fn leafTint(species: u32, h: f32) -> vec3f {
  switch (species) {
    case 1u: {
      // Ginkgo: a fresh mid green in season; one tree in ten already
      // turning gold.
      let gold = step(0.9, h);
      return mix(mix(vec3f(0.085, 0.17, 0.04), vec3f(0.14, 0.23, 0.05), h / 0.9),
                 mix(vec3f(0.36, 0.3, 0.04), vec3f(0.45, 0.35, 0.05), (h - 0.9) / 0.1), gold);
    }
    case 2u: { return mix(vec3f(0.045, 0.1, 0.045), vec3f(0.08, 0.15, 0.06), h); }
    default: { return mix(vec3f(0.06, 0.145, 0.04), vec3f(0.12, 0.22, 0.065), h); }
  }
}

// Painted structural steel (fire stairs, landings, railings), param
// PAINT_STEEL | seed: seed & 3 picks the colour (dark brown, grey, cream,
// green), the rest varies the wear. Patterns are in world space (members
// come with any uv): chipped paint showing bare steel (metal 0.4), rust
// pooled on treads and landings and blooming around chips, and rust
// streaks running down the vertical faces. Fine detail fades by footprint.
// fire stair steel: gen-tile.ts uses this param
// FRP sectional water tank (paint 0xd1, the pale box on every Tokyo roof;
// uv in metres from a face corner): 1 m pressed panels, each domed so the
// light breaks the box into a grid from the air, joined by darker flanges
// bolted every 10 cm; rust weeping down from some bolts, grime gathering
// toward the base, grey-green dirt on the lid.
fn frpTank(world: vec3f, n: vec3f, uv: vec2f) -> Surf {
  var s = defaultSurf(n);
  let foot = max(length(dWorldX), length(dWorldY));
  let fk = 1.0 - smoothstep(0.008, 0.03, foot);
  let side = abs(n.y) < 0.5;
  let T = normalize(dWorldX * dUvY.y - dWorldY * dUvX.y + vec3f(1e-6));
  let B = select(normalize(cross(n, T)), vec3f(0.0, 1.0, 0.0), side);
  let cell = floor(uv);
  let f = fract(uv) - 0.5;
  let e = 0.5 - max(abs(f.x), abs(f.y));
  var a = vec3f(0.74, 0.74, 0.69) * (0.95 + 0.08 * hash21(cell + floor(world.xz)));
  // Domed panels (fade to flat past a few pixels per panel).
  let dk = 1.0 - smoothstep(0.05, 0.2, foot);
  s.normal = normalize(n + (T * f.x + B * f.y) * 0.45 * dk);
  // Flanges: a 5 cm darker lip round every panel, bolts along it.
  let fl = 1.0 - smoothstep(0.025, 0.025 + foot * 1.5, e);
  let flMean = clamp(0.05 / max(foot, 0.05), 0.0, 1.0);
  a *= 1.0 - 0.3 * mix(flMean * 0.5, fl, fk);
  if (fl > 0.5 && fk > 0.3) {
    s.normal = n;
    let along = select(uv.y, uv.x, abs(f.y) > abs(f.x));
    if (length(vec2f((fract(along / 0.1) - 0.5) * 0.1, e - 0.012)) < 0.008) { a = vec3f(0.32, 0.24, 0.16); }
  }
  if (side) {
    // Rust tails below a third of the bolts on each horizontal seam.
    let dy = ceil(uv.y + 1e-3) - uv.y;
    let bi = floor(uv.x / 0.1);
    let bx = abs(fract(uv.x / 0.1) - 0.5) * 0.1;
    let rh = hash21(vec2f(bi, ceil(uv.y + 1e-3) + floor(world.x)));
    let len = mix(0.2, 0.9, fract(rh * 7.0));
    let rust = (1.0 - smoothstep(0.006, 0.014 + dy * 0.02, bx)) * smoothstep(len, 0.0, dy) * step(rh, 0.22);
    a = mix(a, vec3f(0.42, 0.24, 0.12), mix(0.1, rust * 0.85, fk));
    // Grime toward the base, wavering.
    a *= mix(1.0, 0.72, smoothstep(1.4, 0.0, uv.y + 0.3 * valueNoise(vec2f(uv.x * 2.0, 1.0))));
  } else {
    a *= mix(vec3f(1.0), vec3f(0.72, 0.76, 0.66), smoothstep(0.35, 0.8, valueNoise(uv * 1.3 + 3.0)));
  }
  s.albedo = a;
  s.rough = 0.55;
  return s;
}

const PAINT_STEEL = 0x300u;
// Road poles (street-light columns: packMat(CM.metal, POLE_METAL); signal
// and sign columns: packMat(CM.paint, POLE_PAINT)), cylinder uv: x metres
// around, y metres up from the foot (SINK = 0.3 m below the pavement).
const POLE_METAL = 0x10u;
const POLE_PAINT = 0x93u;
const POLE_SINK = 0.3;

// A street pole: galvanised or painted steel with vertical weathering
// streaks (rough 0.35-0.5) running down from the top, splash dirt and grime
// over the bottom half metre, and sticker scraps (fly-posted, then torn
// off: paper remnants and pale glue patches) at hand height.
fn roadPole(world: vec3f, n: vec3f, uv: vec2f, base: vec3f, metal: f32) -> Surf {
  var s = defaultSurf(n);
  let foot = max(length(dWorldX), length(dWorldY));
  let gy = uv.y - POLE_SINK;
  let st = valueNoise(vec2f(uv.x * 14.0, uv.y * 0.35)) * 0.7 + valueNoise(vec2f(uv.x * 40.0, uv.y * 1.5)) * 0.3;
  // Each pole its own age (installed in different years): tone +-12 %,
  // and a broad mottle of weathering up its height.
  let ph = hash21(floor(world.xz * 0.5) + 0.3);
  let mottle = valueNoise(vec2f(uv.x * 3.0, uv.y * 0.6) + ph * 20.0);
  s.albedo = base * (0.8 + 0.34 * st) * (0.88 + 0.24 * ph) * (0.84 + 0.32 * mottle);
  s.metal = metal;
  // Roughness in broad patches that read at eye distance (35-70 %: chalky
  // weathered paint against the original sheen), finer streaks on top.
  let rb = valueNoise(vec2f(uv.x * 2.5, uv.y * 0.45) + ph * 7.0);
  s.rough = mix(0.35, 0.7, smoothstep(0.3, 0.7, rb)) + 0.12 * (smoothstep(0.3, 0.75, st) - 0.5);
  s.albedo *= mix(1.06, 0.92, smoothstep(0.3, 0.7, rb));
  // Streaks under the sleeve joints / fittings (every 3 m up the column):
  // a dark run from the joint down 0.4-1.6 m in about half of 8 slots
  // round it, tapering out.
  {
    let jy = floor(gy / 3.0) * 3.0 + 3.0;
    let slot = floor(uv.x / 0.14);
    let jh = hash21(vec2f(slot, jy + ph * 31.0));
    let jl = 0.4 + 1.2 * fract(jh * 7.3);
    let below = jy - gy;
    let jx = abs(fract(uv.x / 0.14) - 0.5) * 2.0;
    let jw = mix(0.25, 0.6, fract(jh * 3.1)) * mix(1.0, 0.5, below / jl);
    let js = step(jh, 0.5) * step(0.5, jy) * (1.0 - smoothstep(jl * 0.6, jl, below)) * (1.0 - smoothstep(jw * 0.6, jw, jx));
    s.albedo *= 1.0 - 0.35 * js;
    s.albedo = mix(s.albedo, s.albedo * vec3f(1.0, 0.9, 0.78), js * 0.5);
    s.rough = mix(s.rough, 0.75, js * 0.6);
  }
  // Bottom 0.6 m: a grime gradient building toward the foot.
  let gg = 1.0 - smoothstep(0.0, 0.6 + 0.12 * valueNoise(vec2f(uv.x * 4.0, 1.0)), gy);
  s.albedo *= 1.0 - 0.45 * gg * gg;
  s.rough = mix(s.rough, 0.8, gg);
  // Run-off grime streaks from the top joint, arm and fittings: dark
  // vertical runs 2-6 cm wide, strongest high up and thinning down.
  let rs = valueNoise(vec2f(uv.x * 22.0, uv.y * 0.12 + 3.0));
  let runs = smoothstep(0.55, 0.8, rs) * (0.55 + 0.45 * valueNoise(vec2f(uv.x * 22.0, uv.y * 0.9)));
  s.albedo *= 1.0 - 0.5 * runs - 0.12 * smoothstep(0.5, 0.8, st);
  s.albedo = mix(s.albedo, s.albedo * vec3f(1.0, 0.88, 0.72), runs * 0.6);
  s.rough = mix(s.rough, 0.8, runs * 0.7);
  if (abs(n.y) < 0.6) {
    // Bottom 0.5 m: road splash and dog-height dirt, brown-grey, ragged
    // top, with splash flecks above it.
    let dTop = 0.45 + 0.2 * valueNoise(vec2f(uv.x * 9.0, 2.0));
    let dirt = 1.0 - smoothstep(dTop - 0.12, dTop, gy);
    // Rust bloom at the foot (the base plate and the first 15 cm).
    let rustF = (1.0 - smoothstep(0.05, 0.18 + 0.1 * valueNoise(vec2f(uv.x * 12.0, 4.0)), gy)) * smoothstep(0.35, 0.6, valueNoise(vec2f(uv.x * 7.0, gy * 5.0) + ph * 9.0));
    let fleck = smoothstep(0.62, 0.72, valueNoise(vec2f(uv.x, gy) * 45.0)) * (1.0 - smoothstep(dTop, dTop + 0.35, gy)) * (1.0 - smoothstep(0.004, 0.012, foot));
    s.albedo = mix(s.albedo, vec3f(0.12, 0.105, 0.085) * (0.75 + 0.5 * st), max(dirt * 0.92, fleck * 0.7));
    s.albedo = mix(s.albedo, vec3f(0.2, 0.1, 0.045), rustF * 0.8);
    s.rough = mix(s.rough, 0.9, max(dirt, fleck * 0.5));
    s.metal = mix(s.metal, 0.0, dirt);
    // Stickers at 1.1-1.9 m: in ~30 % of 12 cm cells, a 4-9 cm scrap.
    if (gy > 1.05 && gy < 1.95 && foot < 0.02) {
      let q = vec2f(uv.x, gy) / 0.12;
      let c = floor(q);
      let h = hash22(c + 0.5);
      if (hash21(c * 1.9 + 4.0) < 0.3) {
        let half = vec2f(0.17 + 0.2 * h.x, 0.12 + 0.2 * h.y);
        let d = rdBox(fract(q) - 0.5 - (h - 0.5) * 0.2, half);
        let torn = valueNoise(q * 9.0 + h * 13.0);
        let paper = (1.0 - smoothstep(-0.02, 0.0, d)) * step(0.35, torn);
        let glue = (1.0 - smoothstep(-0.02, 0.0, d)) * (1.0 - step(0.35, torn));
        let pc = mix(vec3f(0.75, 0.73, 0.68), select(vec3f(0.7, 0.62, 0.15), vec3f(0.55, 0.12, 0.08), h.x > 0.6), step(0.55, h.y));
        s.albedo = mix(s.albedo, pc, paper);
        s.albedo = mix(s.albedo, s.albedo * 1.15 + 0.03, glue * 0.6);
        s.rough = mix(s.rough, 0.8, max(paper, glue * 0.5));
        s.metal = mix(s.metal, 0.0, paper);
      }
    }
  }
  applyWetness(&s, world, 0.0, 0.0);
  return s;
}
const METAL_TRIM = 0x2000u;
fn paintedSteel(world: vec3f, n: vec3f, param: u32) -> Surf {
  let seed = param & 0xffu;
  let cols = array<vec3f, 4>(vec3f(0.11, 0.065, 0.045), vec3f(0.3, 0.31, 0.31), vec3f(0.6, 0.56, 0.46), vec3f(0.07, 0.14, 0.1));
  return paintedSteelC(world, n, seed, cols[seed & 3u] * mix(0.9, 1.1, hashuf(seed * 0x9e37u)));
}

// paintedSteel's wear (chips, pooled rust, run-down streaks) over a given
// paint colour (rail girders pass their own palette).
fn paintedSteelC(world: vec3f, n: vec3f, seed: u32, paint: vec3f) -> Surf {
  var s = defaultSurf(n);
  let wearK = mix(0.6, 1.3, hashuf(seed ^ 0x51u));
  let foot = max(length(dWorldX), length(dWorldY));
  let fk = 1.0 - smoothstep(0.006, 0.025, foot);
  // Plane coordinates: along the face horizontally and up (vertical
  // faces), or the ground plane (treads, landings, undersides).
  let horiz = normalize(vec2f(-n.z, n.x) + vec2f(1e-4, 0.0));
  var p = vec2f(dot(world.xz, horiz), world.y);
  if (abs(n.y) > 0.6) { p = world.xz; }
  // Chips: small flakes, clustered by a larger wear mask.
  let wear = smoothstep(0.55, 0.9, valueNoise(p * 1.1 + f32(seed))) * wearK;
  let flake = valueNoise(p * 30.0 + 3.0) * 0.7 + valueNoise(p * 85.0) * 0.3;
  let chipF = smoothstep(0.7, 0.74, flake + wear * 0.3);
  let chip = mix(wear * 0.12, chipF, fk);
  // Rust: pooled on up-facing surfaces, blooming around chips, and
  // under everything (undersides stay damp).
  let up = smoothstep(0.5, 0.9, n.y);
  let down = smoothstep(0.5, 0.9, -n.y);
  var rust = clamp(chip * 0.7 + up * wear * 0.5 + down * 0.25 + wear * 0.15, 0.0, 1.0);
  // Streaks: run down vertical faces from landings and bolts, about one
  // per 30-60 cm, each a different length.
  if (abs(n.y) < 0.6) {
    let cw = 0.35;
    let c = floor(p.x / cw);
    let ch = hash21(vec2f(c, f32(seed) + 3.0));
    let dx = abs(p.x - (c + 0.5) * cw) / (cw * mix(0.08, 0.3, fract(ch * 7.0)));
    let len = mix(0.4, 1.6, fract(ch * 13.0));
    let fy = fract(p.y / 1.65 + ch) * 1.65;
    let st = (1.0 - smoothstep(0.4, 1.0, dx)) * smoothstep(len, 0.0, 1.65 - fy) * step(0.45, ch) * wearK;
    rust = max(rust, mix(st * 0.25, st * 0.8, fk));
  }
  let rustC = mix(vec3f(0.22, 0.1, 0.04), vec3f(0.36, 0.17, 0.06), valueNoise(p * 9.0));
  s.albedo = mix(paint * mix(1.0, 0.85, rust), rustC, rust * 0.7);
  s.rough = mix(0.55, 0.85, rust);
  s.metal = 0.0;
  // Bare steel where the paint has flaked off right down to the metal.
  let bare = chipF * fk * (1.0 - rust * 0.5);
  s.albedo = mix(s.albedo, vec3f(0.32, 0.3, 0.28), bare);
  s.metal = mix(s.metal, 0.45, bare);
  s.rough = mix(s.rough, 0.5, bare);
  return s;
}

// ---------------------------------------------------------------------------
// Elevated rail viaduct (shared contract: agents/asset-direction-rail.md §3;
// the same constants live in src/city/gen-base.ts).
// Viaduct faces carry uv.x in "bent units" (12 per segment: bents on
// multiples of 12, gantries on multiples of 48) and, on vertical faces, uv.y
// in metres down from the face's top edge, so joints, scuppers and stains sit
// on the structure. Everything fades to its mean below ~3 px: the base mesh
// has no LOD, so a 300 m view is these shaders at a 0.3-1 m footprint.
// packMat(CM.concrete, role | flags); role 0 is the generic (expressway) look.
const RC_FASCIA = 1u;
const RC_BEAM = 2u;
const RC_COLUMN = 3u;
const RC_PARAPET = 4u;
const RC_TROUGH = 5u;
const RC_PLATFORM = 6u;
const RC_PLATFORM_FACE = 7u;
const RC_STATION = 8u;
const RC_SOUNDWALL = 9u;
const RC_ROADSIDE = 0x10u;
const RC_GLAZED = 0x20u;
const RC_WIDE = 0x40u;
// packMat(CM.metal, ...) / packMat(CM.paint, ...) params.
const RAIL_STEEL = 0x4000u;
const RAIL_WEB = 0x4001u;
const GALV = 0x8000u;
const RAIL_GIRDER = 0x500u;
const INSULATOR = 0xf9u;

fn railFoot() -> f32 { return max(length(dWorldX), length(dWorldY)); }

// World directions of +u and +v on the face, from the screen derivatives.
fn uvDirs(tu: ptr<function, vec3f>, tv: ptr<function, vec3f>) {
  let det = dUvX.x * dUvY.y - dUvX.y * dUvY.x;
  let sg = select(-1.0, 1.0, det >= 0.0);
  *tu = normalize((dWorldX * dUvY.y - dWorldY * dUvX.y) * sg + vec3f(1e-7));
  *tv = normalize((dWorldY * dUvX.x - dWorldX * dUvY.x) * sg + vec3f(1e-7));
}

// Pixel footprint along u and v (uv units per pixel).
fn uvFoot() -> vec2f {
  return vec2f(length(vec2f(dUvX.x, dUvY.x)), length(vec2f(dUvX.y, dUvY.y))) + 1e-5;
}

// Box-filtered band y0 < y < y1 (1 inside), footprint f.
fn bandF(y: f32, y0: f32, y1: f32, f: f32) -> f32 {
  let w = max(f, 1e-4);
  return clamp((min(y + w * 0.5, y1) - max(y - w * 0.5, y0)) / w, 0.0, 1.0);
}

// Concrete detail texture sampled along the face (vertical faces) or by
// dominant axis, as the generic M_CONCRETE does.
fn concreteDetail(world: vec3f, n: vec3f, t: ptr<function, vec3f>, b: ptr<function, vec3f>) -> vec4f {
  if (abs(n.y) < 0.7) {
    *t = normalize(vec3f(-n.z, 0.0, n.x));
    *b = vec3f(0.0, 1.0, 0.0);
    let tt = *t;
    return detailAt(vec2f(dot(world, tt), world.y), vec2f(dot(dWorldX, tt), dWorldX.y), vec2f(dot(dWorldY, tt), dWorldY.y), 2.0, DETAIL_CONCRETE);
  }
  return detailTri(world, n, 2.0, DETAIL_CONCRETE, t, b);
}

// Run-off stain hanging from (x0, y0) in face metres (y down), w wide at
// the source and tapering, len long, darkest at the top. Its edge widens
// with the footprint and its amplitude drops as it gets thinner than a
// pixel, so a distant stain keeps its mean instead of flickering.
fn runStain(ux: f32, uy: f32, x0: f32, y0: f32, w: f32, len: f32, fp: f32) -> f32 {
  let k = clamp((uy - y0) / len, 0.0, 1.0);
  let hw = w * 0.5 * mix(1.0, 0.65, k);
  let ew = max(hw, fp);
  let prof = 1.0 - smoothstep(ew * 0.55, ew * 1.1, abs(ux - x0));
  let fall = pow(1.0 - k, 0.7) * smoothstep(y0 - 0.06 - fp, y0 + 0.06, uy);
  return prof * fall * (hw / ew);
}

// Rain streak hanging from (x0, y0) in face metres (y down): w wide at the
// source, fanning out to ~2.3 w over len while it fades, its centre
// meandering, its edges and tail broken by noise and darker fingers inside.
// sd decorrelates the noise per streak. Each noise octave falls back to its
// mean before it drops under ~3 px, and the amplitude drops once the streak
// is thinner than a pixel, so a distant stain keeps its mean.
fn fanStreak(ux: f32, uy: f32, x0: f32, y0: f32, w: f32, len: f32, sd: f32, fp: f32) -> f32 {
  let dy = uy - y0;
  if (dy < -0.3 || dy > len * 1.25 + 0.3) { return 0.0; }
  let k = clamp(dy / len, 0.0, 1.0);
  let e1 = 1.0 - smoothstep(0.07, 0.16, fp);
  let e2 = 1.0 - smoothstep(0.015, 0.045, fp);
  let wob = (valueNoise(vec2f(sd * 3.7, uy * 0.8)) - 0.5) * w * 0.9 * k;
  let hw = w * 0.5 * (1.0 + 1.3 * k);
  let edgeN = mix(0.5, valueNoise(vec2f((ux - x0) * 2.6 + sd, uy * 1.4)), e1);
  let ew = hw * (0.65 + 0.7 * edgeN);
  let dx = abs(ux - x0 - wob);
  let prof = 1.0 - smoothstep(ew * 0.4, ew + fp, dx);
  let tailN = mix(0.5, valueNoise(vec2f(ux * 3.1 + sd * 2.3, sd)), e1);
  let kk = clamp(k + (tailN - 0.5) * 0.45, 0.0, 1.0);
  let fall = pow(1.0 - kk, 1.3) * smoothstep(y0 - 0.04 - fp, y0 + 0.08, uy);
  let fing = mix(1.0, 0.3 + 0.95 * valueNoise(vec2f((ux - x0) / max(w, 0.1) * 5.0 + sd, uy * 0.45)), e2);
  return prof * fall * clamp(fing, 0.0, 1.0) * mix(1.0, 0.6, k) * min(1.0, ew / max(fp * 1.5, 1e-4));
}

// Black-green rain stains on a deck face: one scupper streak per bent near
// mid-span (width, length, offset and darkness hashed), two faint coping
// drips somewhere along the bent, and a narrower one under half the joints.
fn deckStains(ux: f32, uy: f32, y0: f32, seed: u32, fp: f32) -> f32 {
  let b = floor(ux / 12.0);
  let h = hashu((seed * 0x9e3779b1u) ^ u32(i32(b) + 65536));
  let w = mix(0.4, 1.1, hashuf(h));
  let len = mix(1.5, 4.0, hashuf(h ^ 0x11u));
  let x0 = b * 12.0 + 6.0 + (hashuf(h ^ 0x22u) - 0.5) * 1.8;
  var st = fanStreak(ux, uy, x0, y0, w, len, f32(h & 0xffu), fp) * mix(0.65, 1.0, hashuf(h ^ 0x33u));
  for (var q = 0u; q < 2u; q++) {
    let hk = hashu(h ^ (0x5555u + q * 0x101u));
    let xk = b * 12.0 + 0.9 + hashuf(hk) * 10.2;
    let wk = mix(0.15, 0.45, hashuf(hk ^ 2u));
    st = max(st, mix(0.25, 0.6, hashuf(hk ^ 1u)) * fanStreak(ux, uy, xk, y0, wk, mix(0.6, 2.2, hashuf(hk ^ 3u)), f32(hk & 0xffu), fp));
  }
  let j = round(ux / 12.0);
  let hj = hashu((seed * 0x85ebca6bu) ^ u32(i32(j) + 65536));
  if (hashuf(hj) < 0.55) {
    st = max(st, 0.7 * fanStreak(ux, uy, j * 12.0 + (hashuf(hj ^ 5u) - 0.5) * 0.4, y0, mix(0.2, 0.45, hashuf(hj ^ 6u)), mix(1.0, 2.6, hashuf(hj ^ 7u)), f32(hj & 0xffu), fp));
  }
  return clamp(st * 1.45, 0.0, 1.0);
}

// Fascia drain spout (uv.y, metres down from the fascia top under the
// coping lip): the geometry's spout leaves the face at 0.09..0.22.
const SCUPPER_Y = 0.17;

// Crisp drip stain hanging from a scupper at (x0, y0) in face metres (y
// down): a hard-topped dark tongue as wide as the spout, then 3-7 rivulet
// fingers of different lengths, hard-edged, each fading out through noise,
// inside a faint fanning halo. The fingers drop to their mean once they
// are under ~1.5 px; the head and halo keep the read at any range.
fn scupperDrip(ux: f32, uy: f32, x0: f32, y0: f32, w: f32, len: f32, sd: f32, fp: f32) -> f32 {
  let dy = uy - y0;
  if (dy < -0.1 - fp || dy > len * 1.2 + 0.3) { return 0.0; }
  let fw = max(fp, 1e-3);
  let k = clamp(dy / len, 0.0, 1.0);
  let dx = ux - x0;
  let top = smoothstep(-fw * 0.5, fw * 0.5, dy);
  // Head: 15-35 cm of solid stain under the spout, widening a little.
  let headL = len * 0.05 + 0.1;
  let hw = w * 0.5 * (1.0 + 0.6 * clamp(dy / headL, 0.0, 1.0));
  let head = (1.0 - smoothstep(hw - fw * 0.5, hw + fw * 0.5, abs(dx))) * (1.0 - smoothstep(headL * 0.7, headL * 1.3 + fw, dy + 0.08 * (valueNoise(vec2f(dx * 9.0, sd)) - 0.5)));
  // Fingers: cells across the spread, one rivulet each.
  let spread = w * 0.5 * (1.0 + 1.1 * k);
  let cw = max(w * 0.35, 0.12);
  let ci = floor(dx / cw);
  var fing = 0.0;
  for (var j = -1; j <= 1; j++) {
    let c = ci + f32(j);
    let hc = hash21(vec2f(c, sd));
    if (hc < 0.2) { continue; }
    let cx = (c + 0.5) * cw + (fract(hc * 13.0) - 0.5) * cw * 0.6;
    if (abs(cx) > spread + cw) { continue; }
    let fl = len * mix(0.5, 1.0, fract(hc * 7.3)) * (1.0 - 0.5 * smoothstep(0.3, 1.0, abs(cx) / max(spread, 1e-3)));
    let fk = clamp(dy / fl, 0.0, 1.0);
    let wob = (valueNoise(vec2f(uy * 2.5, c * 3.1 + sd)) - 0.5) * cw * 0.5;
    let fhw = cw * mix(0.6, 0.35, fk) * mix(0.7, 1.2, fract(hc * 29.0));
    let prof = 1.0 - smoothstep(fhw - fw * 0.5, fhw + fw * 0.5, abs(dx - cx - wob));
    let fade = (1.0 - 0.15 * fk) * (1.0 - smoothstep(0.6, 1.0, fk + 0.3 * (valueNoise(vec2f(c * 5.7 + sd, uy * 3.0)) - 0.5)));
    fing = max(fing, prof * fade * min(1.0, fhw * 2.0 / (fw * 1.5)) * mix(0.75, 1.0, fract(hc * 41.0)));
  }
  let halo = 0.4 * (1.0 - smoothstep(spread * 0.5, spread + fw, abs(dx) + 0.1 * spread * (valueNoise(vec2f(dx * 4.0, uy * 2.0 + sd)) - 0.5))) * pow(1.0 - k, 1.2);
  return top * clamp(max(max(head, fing), halo), 0.0, 1.0);
}

// A cement repair patch on a face (1 = inside), on ~35 % of bents: a
// rectangle 0.8-3 m wide with ragged edges while they resolve.
fn repairPatch(ux: f32, uy: f32, x0: f32, x1: f32, y0: f32, y1: f32, hp: u32, fu: vec2f, fp: f32) -> f32 {
  if (hashuf(hp) > 0.35) { return 0.0; }
  let cx = mix(x0, x1, hashuf(hp ^ 1u));
  let cy = mix(y0, y1, hashuf(hp ^ 2u));
  let hw = mix(0.4, 1.5, hashuf(hp ^ 3u));
  let hh = mix(0.25, 0.7, hashuf(hp ^ 4u));
  let rag = (valueNoise(vec2f(ux, uy) * 6.0 + f32(hp & 0xffu)) - 0.5) * 0.12 * (1.0 - smoothstep(0.02, 0.05, fp));
  return bandF(ux + rag, cx - hw, cx + hw, fu.x) * bandF(uy - rag, cy - hh, cy + hh, fu.y);
}

// Street-level clutter on one pier face (q = metres along the face from its
// edge, metres above ground; fw = face width): a pasted bill (kind 1), sun
// faded and torn, or a spray-painted throw-up (kind 2). rgb + coverage.
fn pierBill(q: vec2f, fw: f32, kind: u32, h: u32, fu: vec2f, fp: f32) -> vec4f {
  let fine = 1.0 - smoothstep(0.004, 0.012, fp);
  if (kind == 1u) {
    let w = mix(0.4, min(0.6, fw - 0.15), hashuf(h));
    let ht = w * 1.414;
    let x0 = (fw - w) * mix(0.3, 0.7, hashuf(h ^ 1u));
    let y0 = mix(1.05, 1.45, hashuf(h ^ 2u));
    let p = vec2f((q.x - x0) / w, (q.y - y0) / ht);
    // Torn: the lower corners and a ragged bottom edge peeled away.
    let tear = valueNoise(p * vec2f(6.0, 4.0) + f32(h & 0xffu)) * 0.35 + p.y * 1.1 + (0.5 - abs(p.x - 0.5)) * 0.4;
    let cov = bandF(p.x, 0.0, 1.0, fu.x / w) * bandF(p.y, 0.0, 1.0, fu.y / ht);
    let keep = select(1.0, smoothstep(0.26, 0.34, tear), hashuf(h ^ 9u) < 0.5);
    let bgs = array<vec3f, 4>(vec3f(0.78, 0.77, 0.72), vec3f(0.82, 0.68, 0.18), vec3f(0.42, 0.58, 0.72), vec3f(0.78, 0.42, 0.5));
    let acc = array<vec3f, 4>(vec3f(0.72, 0.07, 0.05), vec3f(0.06, 0.14, 0.45), vec3f(0.04, 0.04, 0.04), vec3f(0.08, 0.42, 0.18));
    var c = bgs[h & 3u];
    c = mix(c, acc[(h >> 3u) & 3u], step(0.8, p.y));
    let ph = step(0.12, p.x) * step(p.x, 0.88) * step(0.4, p.y) * step(p.y, 0.74);
    c = mix(c, mix(acc[(h >> 5u) & 3u] * 1.3, vec3f(0.85, 0.7, 0.55), valueNoise(p * vec2f(5.0, 4.0) + f32(h & 0x3fu))), ph);
    let rowY = p.y * 16.0;
    let txt = step(0.5, valueNoise(vec2f(p.x * 26.0, floor(rowY) * 3.1 + f32(h & 0xffu)))) * step(0.35, fract(rowY))
      * step(0.06, p.y) * step(p.y, 0.34) * step(0.1, p.x) * step(p.x, 0.9);
    c = mix(c, mix(c, vec3f(0.05), 0.55), mix(0.3, 1.0, fine) * txt);
    // Sun-bleached and grimy, by age.
    let age = hashuf(h ^ 7u);
    c = mix(c, vec3f(0.66, 0.64, 0.58), age * 0.55) * mix(1.0, 0.8, age);
    return vec4f(c, cov * keep);
  }
  // Throw-up: three fat slanted bubble letters (rounded boxes with a
  // counter or a notch each, bouncing on the baseline) in one fill colour
  // with a black outline, plus a faint overspray halo.
  let c0 = vec2f(fw * 0.5, mix(1.0, 1.35, hashuf(h ^ 5u)));
  let sd = f32(h & 0xffu);
  let wq = q + (vec2f(valueNoise(q * 7.0 + sd), valueNoise(q * 7.0 + sd + 17.0)) - 0.5) * 0.03;
  let lw = (fw - 0.08) / 3.0;
  let xs = wq.x - 0.04 - (wq.y - c0.y) * 0.3;
  let k0 = floor(xs / lw);
  var dmin = 1e3;
  for (var j = -1; j <= 1; j++) {
    let k = clamp(k0 + f32(j), 0.0, 2.0);
    let hk = hashu(h ^ (u32(k) * 0x9e37u + 0x51u));
    let lp = vec2f(xs - (k + 0.5) * lw, wq.y - c0.y + (hashuf(hk) - 0.5) * 0.08);
    let hb = vec2f(lw * 0.5 + 0.015, mix(0.17, 0.23, hashuf(hk ^ 1u)));
    let body = rdBox(lp, hb - 0.07) - 0.07;
    let ho = vec2f(0.0, select(0.06, -0.05, hashuf(hk ^ 2u) < 0.5));
    let hole = rdBox(lp - ho, vec2f(0.012, 0.035)) - 0.018;
    let notch = rdBox(lp - vec2f(select(-1.0, 1.0, hashuf(hk ^ 3u) < 0.5) * lw * 0.45, 0.0), vec2f(lw * 0.2, 0.02)) - 0.01;
    let dl = max(body, -select(notch, hole, hashuf(hk ^ 4u) < 0.6));
    dmin = min(dmin, dl);
  }
  let soft = 0.004 + fp * 1.5;
  let fill = 1.0 - smoothstep(-soft, soft, dmin + 0.012);
  let outl = 1.0 - smoothstep(-soft, soft, dmin - 0.022);
  let halo = (1.0 - smoothstep(0.0, 0.07, dmin)) * 0.25;
  let cols = array<vec3f, 5>(vec3f(0.62, 0.63, 0.65), vec3f(0.85, 0.3, 0.55), vec3f(0.2, 0.62, 0.75), vec3f(0.85, 0.72, 0.1), vec3f(0.75, 0.12, 0.08));
  // Fill fades to a second tone toward the bottom.
  let fc = mix(cols[h % 5u], cols[(h >> 4u) % 5u] * 0.8, smoothstep(c0.y + 0.15, c0.y - 0.2, q.y));
  var c = mix(vec3f(0.03), fc * mix(0.85, 1.0, valueNoise(q * 9.0)), fill);
  // Old buffed-over tags: patchy grey roller paint round it.
  let buff = smoothstep(0.55, 0.6, valueNoise(q * 1.3 + sd)) * (1.0 - smoothstep(0.3, 0.5, abs(q.y - c0.y))) * step(0.6, hashuf(h ^ 11u));
  let cov = max(max(outl, halo), buff * 0.8);
  c = select(c, vec3f(0.33, 0.33, 0.32), outl < 0.5 && buff > 0.0);
  return vec4f(c, cov * mix(0.85, 1.0, hashuf(h ^ 12u)));
}

// A lit station hall seen through glazing (local = metres along the glass
// and up from 1.1 m above the floor, h = pane height), as parallax layers
// front to back: a bank of ticket gates (concourse only, h > 2) with lit
// blue / green indicator tops, people crossing, then the back wall 6 m in
// (pale tiled panels, a stair flight with its handrail, a row of lit fare
// machines, posters and a yellow-on-black wayfinding sign), under a ceiling
// of fluorescent rows ~3x the wall. Returns radiance at unit light (the
// caller scales it; walls ~0.6, tubes ~1.8, nothing saturates).
fn stationHall(local: vec2f, h: f32, N: vec3f, T: vec3f, V: vec3f, seed: u32, fp: f32) -> vec3f {
  let rd = vec3f(dot(V, T), V.y, -dot(V, N));
  let ro = vec3f(local.x, local.y + 1.1, 0.0);
  // (Concourse, h > 2: a suspended ceiling at 3.3 m, so the upper glazing
  // looks along its rows of tubes; above it a dark bulkhead / plenum.)
  let roomH = select(max(h + 1.6, 3.2), 3.3, h > 2.0);
  if (ro.y > roomH) {
    return vec3f(0.07, 0.075, 0.08) + vec3f(0.5, 0.53, 0.55) * (1.0 - smoothstep(0.0, 0.06, ro.y - roomH));
  }
  let fine = 1.0 - smoothstep(0.02, 0.06, fp);
  let sd = f32(seed & 0xffu);
  let rz = max(rd.z, 0.05);
  // Ceiling / floor hit distance.
  let ty = select(-ro.y / min(rd.y, -1e-4), (roomH - ro.y) / max(rd.y, 1e-4), rd.y > 0.0);
  // Ticket gates, 2 m in: cabinets 0.2 m wide on a 0.9 m pitch, 1.05 m
  // tall, in a 7 m bank somewhere along each 14 m of hall.
  if (h > 2.0) {
    let tg = 2.0 / rz;
    if (tg < ty) {
      let p = ro + rd * tg;
      let bank = floor(p.x / 14.0);
      let bx = p.x - bank * 14.0 - mix(1.0, 6.0, hash21(vec2f(bank, sd)));
      if (bx > 0.0 && bx < 7.2 && p.y < 1.05) {
        let cx = fract(bx / 0.9) * 0.9;
        if (cx < 0.2) {
          var c = vec3f(0.55, 0.56, 0.58) * (0.75 + 0.25 * step(0.6, p.y));
          // Lit indicator panel on top, blue or green by gate.
          let gi = floor(bx / 0.9);
          let ind = select(vec3f(0.3, 0.6, 1.6), vec3f(0.3, 1.5, 0.6), hash21(vec2f(gi, bank + sd)) < 0.6);
          c = mix(c, ind, step(0.97, p.y) * step(0.04, cx) * step(cx, 0.16));
          // Card reader: a dark slot face.
          c = mix(c, vec3f(0.06), step(0.85, p.y) * step(p.y, 0.93) * fine);
          return c;
        }
      }
    }
  }
  // People crossing, 3.2 m in: dark coats, a lit face / shirt band.
  {
    let tp = 3.2 / rz;
    if (tp < ty) {
      let p = ro + rd * tp;
      let cell = floor(p.x / 1.3);
      let hp = hash21(vec2f(cell, sd + 7.0));
      if (hp < 0.3) {
        let px = fract(p.x / 1.3) * 1.3 - 0.65 + (hp - 0.15) * 2.0;
        let ht = mix(1.55, 1.8, fract(hp * 23.0));
        let body = step(abs(px), 0.21 - 0.06 * smoothstep(ht - 0.35, ht - 0.2, p.y)) * step(p.y, ht - 0.22);
        let head = step(length(vec2f(px, p.y - ht + 0.12)), 0.11);
        if (body + head > 0.0) {
          let coat = array<vec3f, 4>(vec3f(0.05), vec3f(0.1, 0.1, 0.12), vec3f(0.22, 0.2, 0.17), vec3f(0.08, 0.1, 0.16))[u32(hp * 100.0) % 4u];
          return select(coat, vec3f(0.38, 0.28, 0.22), head > 0.0);
        }
      }
    }
  }
  let depth = 6.0;
  let tz = depth / rz;
  let t = min(tz, ty);
  let hit = ro + rd * t;
  var c: vec3f;
  if (t == tz) {
    // Back wall: 0.6 m panels, a mid grey (the room is lit from the
    // ceiling: the wall is never as bright as the tubes).
    c = vec3f(0.48, 0.48, 0.46) * (1.0 - 0.25 * fine * max(jointCov(hit.x / 0.6, 0.02, 0.02), jointCov(hit.y / 0.6, 0.02, 0.02)));
    // Posters between the stairs, framed.
    let pxp = fract((hit.x + sd * 0.7) / 3.0) * 3.0;
    let poster = step(0.6, pxp) * step(pxp, 1.5) * step(1.0, hit.y) * step(hit.y, 2.3);
    let pc = 0.35 + 0.3 * cos(6.2831 * (hash21(vec2f(floor((hit.x + sd * 0.7) / 3.0), sd)) + vec3f(0.0, 0.33, 0.67)));
    c = mix(c, pc * (0.8 + 0.2 * step(0.5, fract(hit.y * 3.0))), poster);
    // Fare machines: a row of lit screens on dark bodies.
    let fm = fract((hit.x + sd) / 8.0) * 8.0;
    if (fm > 4.0 && fm < 6.4 && hit.y < 1.7) {
      let mx = fract((fm - 4.0) / 0.8);
      c = vec3f(0.12, 0.13, 0.15);
      c = mix(c, vec3f(0.9, 1.0, 1.15), step(0.15, mx) * step(mx, 0.85) * step(1.0, hit.y) * step(hit.y, 1.45));
    }
    // Stair flight rising along x (one flight per 9 m of wall), its
    // stringer a dark diagonal and a steel handrail 0.9 m above it.
    // Only some 9 m cells have a flight (by hash), each rising its own way.
    let scell = floor((hit.x + hashuf(seed) * 9.0) / 9.0);
    let hst = hash21(vec2f(scell, sd + 41.0));
    if (hst < 0.4) {
      let sx0 = fract((hit.x + hashuf(seed) * 9.0) / 9.0) * 9.0;
      let sx = select(sx0, 9.0 - sx0, hst < 0.2);
      let sy = hit.y - sx * 0.55 + 1.2 + fract(hst * 17.0) * 0.8;
      c = mix(c, vec3f(0.1, 0.1, 0.11), step(abs(sy), 0.2));
      c = mix(c, vec3f(0.2, 0.21, 0.22), step(sy, -0.2) * step(-1.4, sy) * 0.6);
      c = mix(c, vec3f(0.4, 0.42, 0.45), step(abs(sy - 0.9), 0.03) * fine);
    }
    // Wayfinding sign: yellow on dark.
    let wx = fract(hit.x / 4.8) * 4.8;
    let wsg = step(1.0, wx) * step(wx, 2.2) * step(abs(hit.y - (roomH - 0.45)), 0.13);
    c = mix(c, vec3f(0.06, 0.06, 0.07), wsg);
    c = mix(c, vec3f(1.0, 0.82, 0.1) * 1.4, wsg * step(0.55, valueNoise(vec2f(wx * 14.0, hit.y * 20.0))) * fine);
    // Light falls off away from the ceiling.
    c *= mix(0.45, 1.0, clamp(hit.y / roomH, 0.0, 1.0));
  } else if (rd.y > 0.0) {
    // Ceiling panels with fluorescent rows running along the hall.
    // (The ceiling round the tubes is lit by them: brighter near each row.)
    let row = abs(fract(hit.z / 1.8) - 0.5) * 1.8;
    c = vec3f(0.26, 0.27, 0.28) * (1.0 - 0.3 * fine * jointCov(hit.x / 0.6, 0.02, 0.03)) * (0.75 + 0.5 * (1.0 - smoothstep(0.1, 0.6, row)));
    c = mix(c, vec3f(1.75, 1.85, 1.95), 1.0 - smoothstep(0.07, 0.11, row));
  } else {
    // Floor: grey terrazzo with the tube rows mirrored in it, darker toward
    // the glass.
    let row = abs(fract(hit.z / 1.8) - 0.5) * 1.8;
    c = vec3f(0.17, 0.165, 0.155) * mix(0.6, 1.0, hit.z / depth) + vec3f(0.09) * (1.0 - smoothstep(0.08, 0.25, row));
  }
  return c * vec3f(0.93, 0.97, 1.0);
}

// Board-formed concrete on a face (u, v metres; v either way): pw x ph
// plywood panels, each its own tone with a release-oil bloom toward one
// edge, thin dark joints with a pale grout fin, and a tie-hole grid (dark
// cones in a paler mortar plug) at half the panel pitch. All of it falls
// back to its mean once under ~2 px. x = albedo multiplier, y = joint
// coverage (for roughness), z = tie-hole cell hash, w = 1 where a hole is.
// A leak down a face from a joint / drain above (round 8): a dark wet core
// about x0 (hw half-width, meandering with v) with a ragged edge and a
// white efflorescence fringe either side, its strength wandering along v.
// x = core, y = fringe; both fall to a soft mean once under ~2 px.
fn leakStreak(u: f32, v: f32, x0: f32, hw: f32, sd: f32, fp: f32) -> vec2f {
  let e1 = 1.0 - smoothstep(0.04, 0.12, fp);
  let wob = (valueNoise(vec2f(v * 0.7, sd)) - 0.5) * hw * 1.4;
  let edgeN = mix(0.5, valueNoise(vec2f((u - x0) * 3.0 + sd, v * 1.3)), e1);
  let dx = abs(u - x0 - wob);
  let ew = hw * (0.7 + 0.6 * edgeN);
  let core = 1.0 - smoothstep(ew * 0.45, ew + fp, dx);
  let rim = (1.0 - smoothstep(ew * 1.25, ew * 1.8 + fp, dx)) * (1.0 - core);
  let str = mix(0.55, 1.0, valueNoise(vec2f(sd * 1.9, v * 0.9)));
  return vec2f(core * str, rim * str * mix(0.6, 1.0, e1));
}

fn boardForm(u: f32, v: f32, sd: f32, pw: f32, ph: f32, fu: vec2f, fp: f32) -> vec4f {
  let pnl = vec2f(floor(u / pw), floor(v / ph));
  let hpl = hash21(pnl + vec2f(sd * 0.71, 3.0));
  let pq = vec2f(fract(u / pw), fract(v / ph));
  // (Round 8: the panel tone is a smooth field across the joints, bilinear
  // between panel centres, with only +-2 % stepping at each joint: hard
  // per-panel tones read as a checkerboard on the crossbeams.)
  let tn = valueNoise(vec2f(u / pw, v / ph) - 0.5 + vec2f(sd * 0.71, 3.0));
  var m = mix(0.9, 1.06, tn) * mix(0.98, 1.02, hpl) * (1.0 - 0.04 * select(pq.x, 1.0 - pq.x, fract(hpl * 9.0) < 0.5));
  let f1 = 1.0 - smoothstep(0.03, 0.09, fp);
  m *= 1.0 + 0.14 * (valueNoise(vec2f(u, v) * vec2f(3.0, 4.0) + sd) - 0.5) * f1;
  let jl = max(jointCov(u / pw, fu.x / pw, 0.02 / pw), jointCov(v / ph, fu.y / ph, 0.02 / ph));
  let fin = max(jointCov((u - 0.03) / pw, fu.x / pw, 0.015 / pw), jointCov((v - 0.03) / ph, fu.y / ph, 0.015 / ph));
  m *= (1.0 - 0.42 * jl) * (1.0 + 0.12 * fin * (1.0 - jl));
  let tp = vec2f(pw * 0.5, ph * 0.5);
  let tc = floor(vec2f(u, v) / tp);
  let tq = (fract(vec2f(u, v) / tp) - 0.5) * tp;
  let tr = length(tq);
  let tw = max(fp, 1e-3);
  let hole = (1.0 - smoothstep(0.018 - tw * 0.5, 0.018 + tw * 0.5, tr)) * min(1.0, (0.018 * 0.018) / (tw * tw) * 1.6);
  let plug = (1.0 - smoothstep(0.03 - tw * 0.5, 0.03 + tw * 0.5, tr)) * min(1.0, (0.03 * 0.03) / (tw * tw)) * f1;
  m *= (1.0 + 0.1 * plug) * (1.0 - 0.75 * hole);
  return vec4f(m, jl, hash21(tc + sd * 0.37 + 11.0), step(tr, 0.1));
}

// Soffit pattern coordinates: uv.x along, and metres across from the world
// position (the centre soffit's 'h' uv.y is |lateral|, the same at both
// edges, so it carries no across coordinate). Across = n x grad(u), with
// grad(u) solved in the face plane from the screen derivatives.
fn soffitUV(uv: vec2f, world: vec3f, n: vec3f) -> vec2f {
  let D = dot(cross(dWorldX, dWorldY), n);
  let g = (cross(dWorldY, n) * dUvX.x - cross(dWorldX, n) * dUvY.x) / select(D, 1e-9, abs(D) < 1e-12);
  let along = normalize(g + vec3f(1e-7, 0.0, 0.0));
  return vec2f(uv.x, dot(world, cross(n, along)));
}

// Deck soffit seen from below (p = metres along the line, across it): a
// cast-in-place slab shows its formwork (1.8 x 0.9 m plywood panels, each
// its own tone, dark seams, tie holes), a damp dark band along every 12 m
// deck joint with white efflorescence crusting along it and spreading out
// of it in lime fingers 0.3-1.8 m long (and stalactite drip spots), and
// rust blooms round the drain fittings. The panel tones, damp bands and
// lime fans are >= 0.3 m, so the soffit keeps its rhythm from the street.
// Returns albedo multiplier (rgb), efflorescence (a).
fn soffitPattern(p: vec2f, seed: u32, fp: f32, fu: vec2f) -> vec4f {
  let sd = f32(seed & 0xffu);
  let bf = boardForm(p.x, p.y, sd, 1.8, 0.9, fu, fp);
  var m = vec3f(bf.x);
  // Deck joints: damp band, crust and drip spots.
  let jn = round(p.x / 12.0);
  let dx = p.x - jn * 12.0;
  let jd = abs(dx);
  let hj = hash21(vec2f(jn, sd + 3.0));
  let damp = (1.0 - smoothstep(0.15, 0.55 + 0.5 * hj, jd + 0.25 * (valueNoise(p * vec2f(1.5, 0.8) + sd) - 0.5)));
  m *= mix(vec3f(1.0), vec3f(0.6, 0.62, 0.58), damp);
  var eff = (1.0 - smoothstep(0.03, 0.12 + fp, jd)) * mix(0.5, 1.0, valueNoise(vec2f(p.y * 3.0, sd)));
  // Lime fingers: one per 0.45 m cell across the deck on ~60 % of cells,
  // leaching out to one side of the joint (or both), a ragged tapering
  // white tongue.
  let cw = 0.45;
  let ci = floor(p.y / cw);
  var fan = 0.0;
  for (var k = -1; k <= 1; k++) {
    let c = ci + f32(k);
    let hc = hash21(vec2f(c, jn * 7.31 + sd));
    if (hc < 0.4) { continue; }
    let side = select(-1.0, 1.0, fract(hc * 17.0) < 0.5);
    let both = fract(hc * 29.0) < 0.3;
    let along = select(dx * side, jd, both);
    let fl = mix(0.3, 1.8, fract(hc * 7.3)) * mix(0.6, 1.0, hj);
    let fk = clamp(along / fl, 0.0, 1.0);
    let cy = (c + 0.5) * cw + (fract(hc * 13.0) - 0.5) * cw * 0.5 + (valueNoise(vec2f(p.x * 2.5, c * 3.1)) - 0.5) * 0.12;
    let fhw = cw * mix(0.32, 0.12, fk) * mix(0.7, 1.2, fract(hc * 41.0)) + 0.02;
    let prof = 1.0 - smoothstep(fhw * 0.6, fhw + fp, abs(p.y - cy));
    let tail = 1.0 - smoothstep(0.55, 1.0, fk + 0.25 * (valueNoise(vec2f(p.x * 4.0, c * 5.7)) - 0.5));
    fan = max(fan, prof * tail * step(-0.05, along) * mix(0.55, 1.0, fract(hc * 53.0)));
  }
  eff = max(eff, fan * 0.85);
  let fine = 1.0 - smoothstep(0.01, 0.03, fp);
  let drip = smoothstep(0.78, 0.86, valueNoise(p * 7.0 + sd)) * (1.0 - smoothstep(0.2, 0.9, jd)) * fine;
  eff = max(eff * step(0.25, hj), drip);
  // Precast deck planks between the girders: a transverse joint every
  // 3 m, a dark sealed line with lime crusting out of it in patches.
  {
    let tj = abs(fract(p.x / 3.0 + 0.5) - 0.5) * 3.0;
    let tl = jointCov(p.x / 3.0 + 0.5, fu.x / 3.0, 0.025 / 3.0);
    m *= 1.0 - 0.35 * tl;
    let tcell = floor(p.x / 3.0 + 0.5);
    let tef = (1.0 - smoothstep(0.02, 0.12 + fp, tj)) * smoothstep(0.4, 0.7, valueNoise(vec2f(p.y * 1.7, tcell * 3.1 + sd)));
    eff = max(eff, 0.75 * tef * step(0.3, hash21(vec2f(tcell, sd + 9.0))));
  }
  // Damp patch round the drain under each span's scupper (the same x0 as
  // the fascia's scupper streak): a broad dark blotch with a pale lime
  // tide mark at its edge, patchy across the deck.
  {
    let sb = floor(p.x / 12.0);
    let hsc = hashu((seed * 0x9e3779b1u) ^ u32(i32(sb) + 65536));
    let scx = sb * 12.0 + 6.0 + (hashuf(hsc ^ 0x22u) - 0.5) * 1.8;
    let dr = abs(p.x - scx) + 0.9 * (fbm2(p * 0.7 + sd) - 0.5);
    let dmp = (1.0 - smoothstep(0.5, mix(1.2, 2.2, hashuf(hsc ^ 0x5u)), dr)) * smoothstep(0.3, 0.6, fbm2(vec2f(p.y * 0.35, sb + sd)));
    m *= mix(vec3f(1.0), vec3f(0.6, 0.63, 0.59), dmp);
    eff = max(eff, 0.45 * dmp * (1.0 - smoothstep(0.0, 0.25, abs(dmp - 0.35))));
  }
  // Rust blooms round drain fittings, one per bay.
  let rp = vec2f(fract(p.x / 12.0) * 12.0 - mix(3.0, 9.0, hj), p.y - mix(0.5, 3.0, fract(hj * 7.0)));
  let rust = 1.0 - smoothstep(0.1, 0.6, length(rp * vec2f(0.6, 1.0)) + 0.15 * valueNoise(p * 5.0));
  m = mix(m, vec3f(1.0, 0.55, 0.28), 0.65 * rust);
  return vec4f(m, eff);
}

// Filtered 45-degree hazard stripes (1 = yellow).
fn hazardStripe(ux: f32, uy: f32, fp: f32) -> f32 {
  return 1.0 - jointCov((ux + uy) / 0.4, fp * 1.6 / 0.4, 0.5);
}

// Span-to-span crossfade on the deck faces (uv.x in bent units): x = the
// neighbouring bent's offset (-1 / +1), y = its weight, 0.5 right on the
// bent line and 0 from r metres in, so per-span tones meet without a seam.
// The expansion joints (bent i % 4 == 2, under the gen-base cover plates)
// keep a hard break: there the deck really is a different pour.
fn spanBlend(ux: f32, r: f32) -> vec2f {
  let b = floor(ux / 12.0);
  let x = ux - b * 12.0;
  let left = x < 6.0;
  let d = select(12.0 - x, x, left);
  let jb = i32(select(b + 1.0, b, left));
  let joint = ((jb % 4) + 4) % 4 == 2;
  let w = select(0.5 * (1.0 - smoothstep(0.0, r, d)), 0.0, joint);
  return vec2f(select(1.0, -1.0, left), w);
}

// Accent span kind (gen-base RC_ACCENT_SHIFT = 9): 0 none, 1 repaired,
// 2 protective coating, 3 old.
const RC_ACCENT_SHIFT = 9u;
fn railAccent(param: u32) -> u32 { return (param >> RC_ACCENT_SHIFT) & 3u; }

fn railConcrete(world: vec3f, n: vec3f, uv: vec2f, param: u32, aux: u32) -> Surf {
  var s = defaultSurf(n);
  let role = param & 0xfu;
  let roadside = (param & RC_ROADSIDE) != 0u;
  let glazed = (param & RC_GLAZED) != 0u;
  let fp = railFoot();
  let fu = uvFoot();
  let fine = 1.0 - smoothstep(0.01, 0.02, fp);
  let seed = aux >> 16u;
  let vert = abs(n.y) < 0.5;
  let wet = frame.weather.z;
  var t: vec3f;
  var b: vec3f;
  let d = concreteDetail(world, n, &t, &b);
  s.normal = detailNormal(n, t, b, d, 0.8);
  let ux = uv.x;
  let uy = uv.y;
  let bent = floor(ux / 12.0);
  // Each span (and each pier, whose seed is its own) is its own pour: +-10 %
  // value and a warm or cool cast, so a run of bents is not one clean grey.
  let hsp = hashu((seed * 0x2c1b3c6du) ^ u32(i32(bent) + 65536));
  // (On the fascia the neighbouring span's pour blends in over the last
  // 2 m to each bent, except at the expansion joints: see spanBlend.)
  let sbl = select(vec2f(0.0), spanBlend(ux, 2.0), vert && (param & 0xfu) == RC_FASCIA);
  let hspN = hashu((((seed + u32(i32(sbl.x))) & 0xffffu) * 0x2c1b3c6du) ^ u32(i32(bent + sbl.x) + 65536));
  let tone = mix(mix(0.88, 1.1, hashuf(hsp)), mix(0.88, 1.1, hashuf(hspN)), sbl.y);
  let hue = mix(mix(vec3f(1.045, 1.0, 0.93), vec3f(0.95, 0.99, 1.05), hashuf(hsp ^ 0x51u)), mix(vec3f(1.045, 1.0, 0.93), vec3f(0.95, 0.99, 1.05), hashuf(hspN ^ 0x51u)), sbl.y);
  let tex = mix(1.0, d.b * 2.0, 0.45) * mix(0.75, 1.0, d.a);
  // Large soft weathering blotches (world space, so they run across joints).
  let blot = fbm2(vec2f(world.x * 0.11 + world.z * 0.07, world.y * 0.22 + world.z * 0.05) + f32(seed & 0x3fu) * 0.37);
  // Warm grey, ~0.37 (not the generic 0.5, which blows out at golden hour).
  // (The fascia, the biggest surface in a street view, keeps only a trace
  // of them: there it read as a soft blurry blotch field. Its variety
  // comes from crisp formwork panels and stains instead.)
  let fasciaV = vert && role == RC_FASCIA;
  var a = vec3f(0.38, 0.37, 0.35) * tone * hue * tex * mix(select(0.8, 0.9, fasciaV), 1.04, blot);
  s.rough = 0.85;
  // A field of faint vertical weathering streaks on every vertical face
  // (falls back to its mean once the streaks are under ~3 px).
  if (vert && role <= RC_PARAPET && !fasciaV) {
    let sx = ux + select(0.0, f32(seed & 0xffu) * 1.7, role == RC_COLUMN);
    let f1 = 1.0 - smoothstep(0.08, 0.2, fp);
    let sf = smoothstep(0.5, 0.85, valueNoise(vec2f(sx * 2.2, uy * 0.22 + 3.0))) * smoothstep(0.25, 0.7, valueNoise(vec2f(sx * 0.45, uy * 0.4 + 9.0)));
    a *= 1.0 - 0.25 * mix(0.12, sf, f1);
  }
  // Cement repair patches on the long faces: a fresher pale or a dark
  // wet-cured grey, flat and smoother than the board-marked pour.
  if (vert && (role == RC_FASCIA || role == RC_BEAM || role == RC_PARAPET) && ux > 6.0) {
    let pk = repairPatch(ux, uy, bent * 12.0 + 1.5, bent * 12.0 + 10.5, 0.25, 1.4, hashu(hsp ^ 0xa11u), fu, fp);
    let pc = select(vec3f(0.3, 0.3, 0.29), vec3f(0.44, 0.435, 0.42), hashuf(hsp ^ 0xa12u) < 0.55) * mix(0.92, 1.05, d.b * 2.0 - 0.5);
    a = mix(a, pc, pk * 0.65);
  }
  var stain = 0.0;
  var porous = 0.6;
  var flat = 0.0;
  // Rain: the wet trail under a fascia scupper (feeds the wet field below).
  var wetTrail = 0.0;
  switch (role) {
    case RC_FASCIA: {
      if (vert) {
        // Board-formed face (uv.x bent units ~ metres): 1.2 x 0.9 m plywood
        // panels (10 per span, rows break at 0.16 and at deck level 1.06),
        // each its own tone; thin dark, rougher joint lines with a pale
        // grout fin beside them; a tie-hole grid; a mottled finer octave.
        let sdf = f32(seed & 0xffu);
        let py = uy - 0.16;
        let pnl = vec2f(floor(ux / 1.2), floor(py / 0.9));
        let hpl = hash21(pnl + vec2f(sdf * 0.71, 3.0));
        // Release-oil bloom: each panel a touch darker toward one edge.
        let pq = vec2f(fract(ux / 1.2), fract(py / 0.9));
        a *= mix(0.89, 1.03, hpl) * (1.0 - 0.06 * select(pq.x, 1.0 - pq.x, fract(hpl * 9.0) < 0.5));
        // Rain wash per panel column: each 1.2 m strip of the pour
        // weathers its own way, darker toward the foot, crisp at the joints.
        let hcol = hash21(vec2f(pnl.x, sdf + 7.0));
        a *= 1.0 - mix(0.0, 0.09, hcol * hcol) * smoothstep(0.2, 2.0, uy);
        let f1 = 1.0 - smoothstep(0.03, 0.09, fp);
        let f2 = 1.0 - smoothstep(0.008, 0.025, fp);
        let mott = (valueNoise(vec2f(ux, uy) * vec2f(3.0, 4.0) + sdf) - 0.5) * f1 + (valueNoise(vec2f(ux, uy) * 13.0 + sdf * 1.3) - 0.5) * 0.6 * f2;
        a *= 1.0 + 0.16 * mott;
        let jv = jointCov(ux / 1.2, fu.x / 1.2, 0.02 / 1.2);
        let jh = jointCov(py / 0.9, fu.y / 0.9, 0.02 / 0.9) * step(-0.05, py);
        let jl = max(jv, jh);
        let fin = max(jointCov((ux - 0.03) / 1.2, fu.x / 1.2, 0.015 / 1.2), jointCov((py - 0.03) / 0.9, fu.y / 0.9, 0.015 / 0.9) * step(0.0, py));
        a *= (1.0 - 0.4 * jl) * (1.0 + 0.12 * fin * (1.0 - jl));
        s.rough = mix(s.rough, 0.95, jl);
        // Tie holes, 0.6 x 0.45 m: dark 3.5 cm cones with a paler mortar plug
        // ring, filtered to their area mean; one in six bleeds rust.
        let tc = vec2f(floor(ux / 0.6), floor(py / 0.45));
        let tq = (fract(vec2f(ux / 0.6, py / 0.45)) - 0.5) * vec2f(0.6, 0.45);
        let tr = length(tq);
        let tw = max(fp, 1e-3);
        let hole = (1.0 - smoothstep(0.018 - tw * 0.5, 0.018 + tw * 0.5, tr)) * min(1.0, (0.018 * 0.018) / (tw * tw) * 1.6);
        let plug = (1.0 - smoothstep(0.03 - tw * 0.5, 0.03 + tw * 0.5, tr)) * min(1.0, (0.03 * 0.03) / (tw * tw)) * f1;
        let hth = hash21(tc + sdf * 0.37 + 11.0);
        if (py > 0.0) {
          a *= (1.0 + 0.1 * plug) * (1.0 - 0.75 * hole);
          if (hth < 0.17) {
            let rr = runStain(tq.x, tq.y, 0.0, 0.02, 0.05, mix(0.2, 0.6, fract(hth * 37.0)), fp);
            a = mix(a, vec3f(0.24, 0.17, 0.12), 0.5 * rr * f1);
          }
        }
        // Coping shadow band: a crisp darker 16 cm under the lip, then dirt
        // washed down from it fading over half a metre.
        a *= 1.0 - 0.35 * bandF(uy, -1.0, 0.1, fu.y) - 0.14 * (1.0 - smoothstep(0.1, 0.55, uy)) * (1.0 - bandF(uy, -1.0, 0.1, fu.y));
        // Scupper near mid-span (x0 = gen-base scupperU(): 12 i + 6 +-0.9):
        // a crisp drip stain from right under the spout, size and length
        // hashed per span; coping drips and the old joint run-off, fainter.
        let hsc = hashu((seed * 0x9e3779b1u) ^ u32(i32(bent) + 65536));
        let scx = bent * 12.0 + 6.0 + (hashuf(hsc ^ 0x22u) - 0.5) * 1.8;
        let scl = mix(1.0, 1.9, hashuf(hsc ^ 0x11u));
        var dr = scupperDrip(ux, uy, scx, SCUPPER_Y, mix(0.25, 0.45, hashuf(hsc)), scl, f32(hsc & 0xffu), fp) * mix(0.8, 1.0, hashuf(hsc ^ 0x33u));
        // Coping drips: 1-3 per span where the lip's drip groove has
        // clogged, full-height crisp runs from under the coping shadow.
        for (var q = 0u; q < 4u; q++) {
          let hk = hashu(hsc ^ (0x2b3u + q * 0x95u));
          if (q > 0u && hashuf(hk ^ 4u) < 0.4) { continue; }
          var xk = bent * 12.0 + 0.8 + hashuf(hk) * 10.4;
          xk += select(0.0, 1.2, abs(xk - scx) < 0.6);
          dr = max(dr, mix(0.75, 1.0, hashuf(hk ^ 1u)) * scupperDrip(ux, uy, xk, 0.16, mix(0.15, 0.35, hashuf(hk ^ 2u)), mix(1.7, 2.8, hashuf(hk ^ 3u)), f32(hk & 0xffu) + 31.0, fp));
        }
        stain = max(min(1.0, dr * 1.35), 0.35 * deckStains(ux + 6.0, uy, 0.12, seed ^ 0x3a7u, fp));
        // In the rain each scupper spills a dark wet trail down the full
        // face, widening as it falls.
        wetTrail = (1.0 - smoothstep(0.5, 1.0, abs(ux - scx + 0.1 * (valueNoise(vec2f(uy * 1.5, sdf)) - 0.5)) / (0.25 + 0.2 * uy))) * smoothstep(SCUPPER_Y - 0.02, SCUPPER_Y + 0.1, uy);
        // Soot / traffic grime on the lower third of the slab edge: a broad
        // ~25 % darker band (>= 0.6 m, so it holds at 300 m), heaviest at
        // the drip edge along the foot.
        // (Round 8: deeper and a cool soot grey, so it survives golden
        // light's warm wash.)
        let soot = smoothstep(1.0, 1.6, uy) * (0.75 + 0.25 * blot);
        a *= 1.0 - 0.36 * soot - 0.14 * smoothstep(1.65, 1.95, uy);
        a *= mix(vec3f(1.0), vec3f(0.93, 0.96, 1.0), soot);
        // Broad (mip-stable, >= 0.8 m) per-span terms so a run of spans
        // reads at 150-300 m, where the drip fingers and panel joints have
        // averaged away: a dirt band under the coping (0.1-0.6 m, ragged
        // foot), a wide washed-dark zone round each scupper's run-off and a
        // narrower one down each bent joint, darkness hashed per span.
        let eid = (seed - u32(i32(bent))) & 0xffffu;
        let bN = bent + sbl.x;
        let hscN = hashu((((seed + u32(i32(sbl.x))) & 0xffffu) * 0x9e3779b1u) ^ u32(i32(bN) + 65536));
        let cb = 1.0 - smoothstep(0.45, 0.65 + 0.1 * (valueNoise(vec2f(ux * 1.7, 3.0 + f32(eid & 0xffu))) - 0.5), uy);
        a *= (1.0 - 0.36 * cb * (1.0 - bandF(uy, -1.0, 0.1, fu.y))) * mix(mix(0.93, 1.07, hashuf(hsc ^ 0x55u)), mix(0.93, 1.07, hashuf(hscN ^ 0x55u)), sbl.y);
        let zs = 1.0 - smoothstep(0.35, 0.9, abs(ux - scx) / (0.6 + 0.6 * smoothstep(0.2, 2.0, uy)));
        let zj = 1.0 - smoothstep(0.15, 0.45, abs(ux - round(ux / 12.0) * 12.0));
        a *= 1.0 - mix(0.18, 0.34, hashuf(hsc ^ 0x44u)) * zs * smoothstep(0.1, 0.4, uy) - 0.16 * zj;
        // Span identity (all terms >= 0.8 m, so they hold at 300 m and in
        // the low mips): each span its own value and a warm or cool cast,
        // cross-faded into its neighbours over 2.5 m either side of a bent
        // (hard only at the expansion joints, under the cover plates), and
        // 2-3 broad rain curtains hanging from the coping, kept inside
        // their span so none is cut off at a bent line.
        {
          let hsi = hashu((eid * 0x632be5abu) ^ u32(i32(bent) + 65536));
          let hsiN = hashu((eid * 0x632be5abu) ^ u32(i32(bN) + 65536));
          let sv = mix(mix(0.8, 1.16, hashuf(hsi)), mix(0.8, 1.16, hashuf(hsiN)), sbl.y);
          let sh = mix(mix(vec3f(1.09, 1.0, 0.86), vec3f(0.9, 0.98, 1.09), hashuf(hsi ^ 0x3u)), mix(vec3f(1.09, 1.0, 0.86), vec3f(0.9, 0.98, 1.09), hashuf(hsiN ^ 0x3u)), sbl.y);
          a *= sv * sh;
          var cur = 0.0;
          for (var q = 0u; q < 3u; q++) {
            let hq = hashu(hsi ^ (0x71u + q * 0x2fu));
            if (q == 2u && hashuf(hq ^ 7u) < 0.5) { continue; }
            let hw = mix(0.45, 1.3, hashuf(hq ^ 1u));
            let xc = bent * 12.0 + mix(hw + 0.2, 11.8 - hw, hashuf(hq));
            let wob = 0.25 * (valueNoise(vec2f(uy * 0.9, f32(hq & 0xffu))) - 0.5);
            let pr = 1.0 - smoothstep(0.35, 1.0, abs(ux - xc + wob) / hw);
            let vlen = mix(1.2, 2.4, hashuf(hq ^ 2u));
            let vk = smoothstep(0.05, 0.35, uy) * (1.0 - smoothstep(vlen * 0.6, vlen, uy));
            cur = max(cur, pr * vk * mix(0.12, 0.3, hashuf(hq ^ 3u)));
          }
          a *= 1.0 - cur;
          // Accent spans from the geometry (RC_ACCENT_SHIFT, one span in ~5,
          // also on that span's coping lip): +-15 % value so a 12 m span
          // reads lighter / darker at 300 m. The grime (coping band, soot,
          // curtains, scupper drips) carries on over it, only lighter, so
          // the dirt does not stop dead at the span ends; a sealed joint
          // line marks each end.
          let acc = railAccent(param);
          if (acc != 0u) {
            let jk = jointCov(ux / 12.0, fu.x / 12.0, 0.03 / 12.0);
            if (acc == 1u) {
              // Repaired: fresh pale patch-repair mortar, cooler, its drips
              // and lime mostly gone.
              a = mix(a, a * vec3f(1.3, 1.32, 1.34) + vec3f(0.03), 0.8);
              stain *= 0.45;
            } else if (acc == 2u) {
              // Protective coating: warm grey-beige, flatter and cleaner,
              // satin.
              let lum = dot(a, vec3f(0.3, 0.59, 0.11));
              a = mix(a, vec3f(0.5, 0.46, 0.4) * (lum / 0.3) * 0.95, 0.75);
              stain *= 0.5;
              s.rough = 0.6;
            } else {
              // Old: darker, heavier soot and run-off.
              a *= vec3f(0.8, 0.79, 0.77);
              stain = min(1.0, stain * 1.35 + 0.25 * cur);
            }
            a *= 1.0 - 0.4 * jk;
          }
        }
        // Recessed band under the coping (RC_RECESS): set back in the lip's
        // shadow and damp, so it reads as a dark line in flat light too.
        if ((param & 0x40u) != 0u) { a *= vec3f(0.58, 0.6, 0.58); }
        // Bent joints: 2 cm sealed gaps on uv.x = 0 mod 12, and white
        // efflorescence crusting along and fanning below half of them (from
        // the deck cold joint), plus a lime run from some scuppers.
        let jc = jointCov(ux / 12.0, fu.x / 12.0, 0.02 / 12.0);
        a *= 1.0 - 0.45 * jc;
        let j = round(ux / 12.0);
        let hj = hashu((seed * 0x27d4eb2du) ^ u32(i32(j) + 65536));
        if (hashuf(hj) < 0.75) {
          let ef = fanStreak(ux, uy, j * 12.0 + (hashuf(hj ^ 8u) - 0.5) * 0.2, mix(0.3, 1.1, hashuf(hj ^ 9u)), mix(0.25, 0.6, hashuf(hj ^ 3u)), mix(0.6, 1.8, hashuf(hj ^ 4u)), f32(hj & 0xffu) + 50.0, fp);
          let crust = mix(1.0, smoothstep(0.35, 0.65, valueNoise(vec2f(ux, uy) * 11.0)), 1.0 - smoothstep(0.01, 0.03, fp));
          a = mix(a, vec3f(0.72, 0.71, 0.67), clamp(0.8 * ef * mix(0.6, 1.0, crust) + 0.5 * jc * step(uy, 1.6), 0.0, 1.0));
        }
      } else if (n.y < -0.5) {
        let sp = soffitPattern(soffitUV(uv, world, n), seed, fp, fu);
        a *= 0.66 * sp.rgb;
        a = mix(a, vec3f(0.56, 0.56, 0.53), 0.75 * sp.a);
      }
    }
    case RC_BEAM: {
      if (n.y < -0.5) {
        // Soffits: shaded, damp, with the formwork, joints and stains.
        let sp = soffitPattern(soffitUV(uv, world, n), seed, fp, fu);
        a *= 0.68 * sp.rgb * mix(0.92, 1.04, valueNoise(world.xz * 0.6 + f32(seed & 0xffu)));
        a = mix(a, vec3f(0.56, 0.56, 0.53), 0.75 * sp.a);
      } else if (vert) {
        // Board-formed like the fascia (1.2 x 0.9 m panels, tie holes);
        // on the deck strips (uv.y down from the top) also lime leaching
        // out of every transverse deck joint and running down the face.
        let sdf = f32(seed & 0xffu);
        let bf = boardForm(ux, uy, sdf, 1.2, 0.9, fu, fp);
        a *= bf.x;
        s.rough = mix(s.rough, 0.95, bf.y);
        // Drip streaks hanging from the cantilever soffit above.
        stain = deckStains(ux + 3.0, uy, 0.0, seed ^ 0x5bd1u, fp) * 0.85;
        if (ux < 11.0) {
          // Crossbeams / cap beams (metre UVs from one end): leaks from
          // the deck joint and drain outlets over them, a dark wet streak
          // with a lime fringe in about half of each 3 m of face, and a
          // darker re-entrant corner band along the transverse beam's top
          // under the deck (uv.y down from it).
          let lc = floor(ux / 3.0);
          let hk = hashu((seed * 0x1d8e4e27u) ^ u32(i32(lc) + 4096));
          if (hashuf(hk) < 0.6) {
            let lk = leakStreak(ux, uy, lc * 3.0 + mix(0.5, 2.5, hashuf(hk ^ 1u)), mix(0.08, 0.22, hashuf(hk ^ 2u)), f32(hk & 0xffu), fp);
            a *= 1.0 - 0.42 * lk.x;
            a = mix(a, vec3f(0.62, 0.615, 0.58), 0.5 * lk.y);
          }
          a *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.35, uy));
        }
        if (ux > 11.0) {
          let j = round(ux / 12.0);
          let hj = hashu((seed * 0x27d4eb2du) ^ u32(i32(j) + 65536));
          var ef = 0.0;
          for (var q = 0u; q < 3u; q++) {
            let hq = hashu(hj ^ (q * 0x51u + 7u));
            if (q > 0u && hashuf(hq) < 0.45) { continue; }
            let xq = j * 12.0 + (hashuf(hq ^ 1u) - 0.5) * select(0.25, 1.4, q > 0u);
            ef = max(ef, mix(0.6, 1.0, hashuf(hq ^ 2u)) * fanStreak(ux, uy, xq, mix(0.0, 0.25, hashuf(hq ^ 3u)), mix(0.2, 0.5, hashuf(hq ^ 4u)), mix(0.5, 1.3, hashuf(hq ^ 5u)), f32(hq & 0xffu) + 70.0, fp));
          }
          let crust = mix(1.0, smoothstep(0.3, 0.6, valueNoise(vec2f(ux, uy) * 11.0)), 1.0 - smoothstep(0.01, 0.03, fp));
          a = mix(a, vec3f(0.66, 0.655, 0.62), clamp(ef * mix(0.6, 1.0, crust), 0.0, 1.0) * step(0.2, hashuf(hj)));
        }
        // Rust bleeding from the bearing anchor bolts and drain brackets at
        // each bent (deck strips only: box caps keep metre UVs from 0).
        if (ux > 11.0) {
          let j = round(ux / 12.0);
          let hr = hashu((seed * 0x165667b1u) ^ u32(i32(j) + 65536));
          var rb = 0.0;
          for (var q = 0u; q < 2u; q++) {
            let hq = hashu(hr ^ (q * 0x3bu + 1u));
            let xq = j * 12.0 + select(-1.0, 1.0, q == 0u) * mix(0.25, 0.9, hashuf(hq));
            rb = max(rb, step(0.3, hashuf(hq ^ 4u)) * fanStreak(ux, uy, xq, mix(0.05, 0.5, hashuf(hq ^ 1u)), mix(0.1, 0.3, hashuf(hq ^ 2u)), mix(0.5, 1.4, hashuf(hq ^ 3u)), f32(hq & 0xffu), fp));
          }
          // The bearing shelf at the beam foot over each bent: a broad rust
          // wash (steel bearing plates, anchor bolts) in the bottom 0.5 m.
          let bw = 1.0 - smoothstep(0.5, 1.1, abs(ux - j * 12.0));
          rb = max(rb, 0.75 * bw * smoothstep(0.85, 1.35, uy) * (0.6 + 0.4 * valueNoise(vec2f(ux * 3.0, uy * 4.0) + f32(hr & 0xffu))));
          a = mix(a, vec3f(0.34, 0.16, 0.065), 0.8 * rb);
        }
        if (roadside) {
          // Clearance mark: a hazard band along the beam's bottom 0.3 m.
          // (uv.y is down from the top; the beam is about 1.4 m deep.)
          let band = bandF(uy, 1.1, 1.38, fu.y);
          let y = hazardStripe(ux, uy, fp);
          a = mix(a, mix(vec3f(0.04), vec3f(0.85, 0.62, 0.05), y), band);
          s.rough = mix(s.rough, 0.6, band);
        }
      }
    }
    case RC_COLUMN: {
      if (vert) {
        // Box UV: uv.y - 1 = metres above ground; u runs on round the four
        // faces, 2 hw per face (hw 0.6 with RC_WIDE), the last 2 CH (CH =
        // 0.1) of each face being the chamfer.
        let h = uy - 1.0;
        let fwc = select(1.0, 1.2, (param & RC_WIDE) != 0u);
        // Columns a touch cooler and greyer than the deck (round 8: in
        // golden light the whole structure went one cream).
        a = mix(vec3f(dot(a, vec3f(0.3, 0.59, 0.11))), a, 0.4) * vec3f(0.92, 0.97, 1.05);
        let lu = ux - floor(ux / fwc) * fwc;
        // Splash / grime band with a ragged top edge.
        let sdf = f32(seed & 0xffu);
        // Grime from above: the top of a pier is darker (beam run-off), with
        // streaks starting at bracket / bolt heights 3.5-7 m up.
        a *= mix(1.0, 0.8, smoothstep(3.0, 8.0, h) * (0.5 + 0.5 * blot));
        var cs = 0.0;
        for (var q = 0u; q < 2u; q++) {
          let hq = hashu((seed * 0x7feb352du) ^ (q * 0x9e37u + 3u));
          cs = max(cs, mix(0.4, 0.8, hashuf(hq ^ 1u)) * fanStreak(ux, -h, mix(0.15, 0.85, hashuf(hq)), -mix(3.5, 7.5, hashuf(hq ^ 2u)), mix(0.12, 0.3, hashuf(hq ^ 3u)), mix(1.5, 4.0, hashuf(hq ^ 4u)), f32(hq & 0xffu), fp));
        }
        stain = max(stain, cs);
        // Leak from the deck drain / joint above on about half the piers: a
        // long dark wet streak down the shaft with a lime fringe, fading
        // out above the splash band.
        {
          let hlk = hashu(seed * 0x2f6b1c35u + 9u);
          if (hashuf(hlk) < 0.55) {
            let xq = floor(hashuf(hlk ^ 1u) * 4.0) * fwc + mix(0.25, fwc - 0.35, hashuf(hlk ^ 2u));
            let lk = leakStreak(ux, -h, xq, mix(0.07, 0.16, hashuf(hlk ^ 3u)), f32(hlk & 0xffu) + 13.0, fp);
            let vf = smoothstep(1.2, 3.5, h);
            a *= 1.0 - 0.4 * lk.x * vf;
            a = mix(a, vec3f(0.6, 0.6, 0.57), 0.45 * lk.y * vf);
          }
        }
        // Cast in 1.5 m lifts in steel forms: a dark lift line with a pale
        // grout fin under it, each lift (per face) its own tone, two tie-hole
        // plugs per face per lift, and white lime leaching out of some lift
        // joints and running down the face below.
        {
          let face = floor(ux / fwc);
          let lv = h - 0.3;
          let lift = floor(lv / 1.5);
          let hl = hash21(vec2f(lift, sdf + face * 3.1));
          a *= mix(0.9, 1.07, hl);
          let lj = jointCov(lv / 1.5, fu.y / 1.5, 0.022 / 1.5);
          let lf = jointCov((lv + 0.035) / 1.5, fu.y / 1.5, 0.015 / 1.5);
          a *= (1.0 - 0.42 * lj) * (1.0 + 0.12 * lf * (1.0 - lj));
          s.rough = mix(s.rough, 0.95, lj);
          let tq = vec2f((fract(lu / (fwc * 0.5)) - 0.5) * fwc * 0.5, (fract(lv / 1.5) - 0.5) * 1.5);
          let tr = length(tq);
          let tw = max(fp, 1e-3);
          let hole = (1.0 - smoothstep(0.02 - tw * 0.5, 0.02 + tw * 0.5, tr)) * min(1.0, (0.02 * 0.02) / (tw * tw) * 1.6);
          let plug = (1.0 - smoothstep(0.035 - tw * 0.5, 0.035 + tw * 0.5, tr)) * min(1.0, (0.035 * 0.035) / (tw * tw));
          a *= (1.0 + 0.12 * plug) * (1.0 - 0.7 * hole);
          // Lime from the joint above this fragment.
          let jn = lift + 1.0;
          let jy = jn * 1.5 + 0.3;
          let hq = hashu((u32(i32(jn) + 4096) * 0x9e37u) ^ (seed * 0x85ebca6bu) ^ u32(i32(face) + 77));
          if (hashuf(hq) < 0.45 && jy > 2.0) {
            let xq = face * fwc + mix(0.15, fwc - 0.35, hashuf(hq ^ 1u));
            let ef = fanStreak(ux, jy - h, xq, 0.0, mix(0.12, 0.35, hashuf(hq ^ 2u)), mix(0.4, 1.3, hashuf(hq ^ 3u)), f32(hq & 0xffu) + 90.0, fp);
            let crust = mix(1.0, smoothstep(0.3, 0.6, valueNoise(vec2f(ux, h) * 12.0)), 1.0 - smoothstep(0.01, 0.03, fp));
            a = mix(a, vec3f(0.64, 0.635, 0.6), 0.8 * ef * mix(0.6, 1.0, crust));
            a = mix(a, vec3f(0.6, 0.595, 0.56), 0.5 * lj * step(abs(ux - xq), 0.3));
          }
        }
        // Splash / grime band (~1.2 m): its top a soft 0.2 m fade at a
        // height that wanders smoothly round the pier (three octaves of
        // smooth noise in metres, no fine ripple, no tide line: a fine
        // octave under a hard edge read as a sawtooth), dirt fingers
        // splashed up above it, darker toward the ground, and contact AO
        // over the bottom 0.3 m.
        let pa = ux + sdf * 2.3;
        let top = 1.15 + 0.2 * (valueNoise(vec2f(pa * 0.9, sdf)) - 0.5) + 0.12 * (valueNoise(vec2f(pa * 2.1, sdf + 4.0)) - 0.5) + 0.05 * (valueNoise(vec2f(pa * 4.7, sdf + 9.0)) - 0.5);
        var g = 1.0 - smoothstep(top - 0.2 - fp, top + fp, h);
        {
          // Splash fingers: a few per face, 3-8 cm wide, 0.15-0.5 m above
          // the band, fading upward; averaged to a faint lift at range.
          let fcw = 0.11;
          let fc = floor(pa / fcw);
          let hf = hash21(vec2f(fc, sdf + 2.0));
          let fx = (fc + 0.5 + (fract(hf * 7.0) - 0.5) * 0.5) * fcw;
          let fhw = mix(0.015, 0.04, fract(hf * 13.0));
          let fl = mix(0.15, 0.5, fract(hf * 31.0));
          let fk = clamp((h - top + 0.1) / fl, 0.0, 1.0);
          let fw = max(fp, 1e-3);
          let fing = step(0.55, hf) * (1.0 - smoothstep(fhw * (1.0 - 0.5 * fk) - fw * 0.5, fhw * (1.0 - 0.5 * fk) + fw * 0.5, abs(pa - fx))) * (1.0 - fk) * step(top - 0.1, h);
          let fv = 1.0 - smoothstep(0.02, 0.06, fp);
          g = max(g, fing * mix(0.25, 0.75, fv));
        }
        // Darker toward the ground (spray, soil, mop water), greenish at
        // the foot; always darker than the shaft (no pale salty sock).
        let gd = mix(0.7, 0.48, 1.0 - smoothstep(0.0, 0.9, h));
        a = mix(a, min(a * gd, vec3f(0.19, 0.18, 0.16)) * mix(0.88, 1.08, fbm2(vec2f(pa * 1.5, h * 2.0 + sdf))), g);
        a = mix(a, vec3f(0.12, 0.13, 0.1), 0.45 * (1.0 - smoothstep(0.0, 0.4, h)) * (0.6 + 0.4 * valueNoise(vec2f(pa * 4.0, h * 3.0 + sdf))));
        s.ao *= mix(0.55, 1.0, smoothstep(0.0, 0.3, h));
        if (roadside) {
          let band = bandF(h, 0.2, 1.8, fu.y);
          let y = hazardStripe(ux, h, fp);
          // Chipped paint showing concrete.
          let chip = smoothstep(0.72, 0.78, valueNoise(vec2f(ux, h) * 22.0)) * fine;
          let paint = mix(vec3f(0.035), vec3f(0.85, 0.62, 0.05), y) * mix(0.85, 1.0, d.a);
          a = mix(a, paint, band * (1.0 - chip));
          s.rough = mix(s.rough, 0.6, band);
        }
        // White ID plate on one face (picked by the seed), 2.2 m up.
        let ang = atan2(n.z, n.x);
        let rel = fract((ang / 6.2831853) - hashuf(seed ^ 0x3c6eu));
        if (rel < 0.25) {
          let q = vec2f(lu - fwc * 0.5, h - 2.2);
          let pk = 1.0 - smoothstep(0.03, 0.08, fp);
          let plate = bandF(q.x, -0.15, 0.15, fu.x) * bandF(q.y, -0.1, 0.1, fu.y);
          var pc = vec3f(0.78, 0.78, 0.75);
          let glyph = step(0.55, valueNoise(q * vec2f(28.0, 18.0) + f32(seed & 0xffu))) * step(abs(q.x), 0.11) * step(abs(q.y), 0.06);
          pc = mix(pc, vec3f(0.06), glyph * fine);
          a = mix(a, pc, plate * pk);
        }
        // Bills and spray paint at street level, on other faces of some
        // piers (never over the hazard stripes).
        if (!roadside && h < 2.6) {
          let hb = hashu(seed * 0x2545f491u + 77u);
          var kind = 0u;
          if (rel >= 0.5 && rel < 0.75 && hashuf(hb) < 0.75) { kind = 1u; }
          if (rel >= 0.25 && rel < 0.5 && hashuf(hb ^ 3u) < 0.55) { kind = 2u; }
          if (kind != 0u) {
            let bl = pierBill(vec2f(lu, h), fwc - 0.2, kind, hashu(hb ^ kind), fu, fp);
            a = mix(a, bl.rgb * mix(1.0, 0.85, g), bl.a);
            s.rough = mix(s.rough, select(0.8, 0.55, kind == 2u), bl.a);
            porous = mix(porous, 0.3, bl.a);
          }
        }
        // Chamfered arris: a worn, paler line (knocked by vans and bikes
        // low down, chipped through the hazard paint) on a flat diagonal
        // facet, so the corners read as lines at 30-60 m.
        {
          let arris = bandF(lu, fwc - 0.2, fwc + 0.05, fu.x);
          if (arris > 0.0) {
            var tu: vec3f;
            var tv: vec3f;
            uvDirs(&tu, &tv);
            var dg = normalize(cross(vec3f(0.0, 1.0, 0.0), tu));
            dg = select(dg, -dg, dot(dg, n) < 0.0);
            s.normal = normalize(mix(s.normal, dg, 0.85 * arris));
            let worn = mix(1.35, 1.5, smoothstep(1.8, 0.3, h));
            a = mix(a, min(a * worn + vec3f(0.025), vec3f(0.6)), arris);
          }
        }
        // Rain: water sheets down the column in a few structure-aligned runs.
        if (wet > 0.0) {
          let c = floor(ux / 0.18);
          let hc = hash21(vec2f(c, f32(seed & 0xffu)));
          let run = step(hc, 0.4) * (1.0 - smoothstep(0.03, 0.09, abs(fract(ux / 0.18) - 0.5) * 0.18))
            * smoothstep(0.25, 0.55, valueNoise(vec2f(c * 3.1, world.y * 0.35)));
          stain = max(stain, run * 0.5 * wet);
          s.rough = mix(s.rough, 0.07, run * wet);
          // The splash band soaks first and stays dark and glossy.
          a *= 1.0 - 0.4 * g * wet;
          s.rough = mix(s.rough, 0.18, g * wet);
        }
      }
    }
    case RC_PARAPET: {
      // Precast coping: ~15 % paler than the cast fascia (the pale line
      // that carries the deck edge at range), on the cap and the top
      // 0.2 m of each face (the 19 cm drip lip's whole outer face). The lip
      // carries its span's accent (RC_ACCENT_SHIFT) like the fascia.
      let capK = select(1.0, 1.0 - smoothstep(0.18, 0.24, uy), vert);
      // (Round 8: +15 % over round 7, so the coping line separates from
      // the fascia in golden light.)
      a *= 1.15 * (1.0 + 0.17 * capK);
      let acc = railAccent(param);
      if (vert && acc != 0u) {
        a *= select(select(vec3f(1.2, 1.21, 1.22), vec3f(1.15, 1.08, 0.98), acc == 2u), vec3f(0.8, 0.79, 0.77), acc == 3u);
      }
      if (vert) {
        // Brake-dust rust tint along the inner face's lower 0.6 m.
        let low = smoothstep(0.55, 0.85, uy);
        a = mix(a, vec3f(0.36, 0.27, 0.21) * tone, 0.4 * low);
        a *= 1.0 - 0.45 * jointCov(ux / 12.0, fu.x / 12.0, 0.02 / 12.0);
        // Dirt streaks running down from the coping, one per ~3 m cell.
        let c3 = floor(ux / 3.0);
        var ps = 0.0;
        for (var q = -1; q <= 1; q++) {
          let hc = hashu((seed * 0x68e31da4u) ^ u32(i32(c3) + q + 65536));
          ps = max(ps, step(0.35, hashuf(hc ^ 5u)) * mix(0.4, 0.85, hashuf(hc ^ 1u)) * fanStreak(ux, uy, (c3 + f32(q)) * 3.0 + hashuf(hc) * 3.0, 0.0, mix(0.15, 0.5, hashuf(hc ^ 2u)), mix(0.5, 1.1, hashuf(hc ^ 3u)), f32(hc & 0xffu), fp));
        }
        stain = max(stain, ps);
      } else if (n.y > 0.5) {
        // Moss / dirt spots on the coping top.
        let sp = smoothstep(0.6, 0.85, valueNoise(world.xz * 1.6 + 5.0));
        a = mix(a, vec3f(0.17, 0.19, 0.13), 0.55 * sp);
        flat = 0.3;
      }
    }
    case RC_TROUGH: {
      // 1 m precast lids, darker and greener than the rims (damp, mossy),
      // each rocked a little (its own tone), one in 15 a newer one; the
      // joints are 2.5 cm dark gaps (prefiltered, they hold to ~30 m),
      // and through 1 in 40 the black cable bundle shows.
      let lid = floor(ux);
      let hl = hashuf((seed * 0x1b873593u) ^ u32(i32(lid) + 65536));
      if (n.y > 0.5) { a = vec3f(0.27, 0.278, 0.258) * tex * mix(0.88, 1.06, blot); }
      a *= select(1.0, select(1.25, 0.8, hl < 0.033), hl < 0.066) * mix(0.84, 1.08, fract(hl * 37.0));
      let lj = jointCov(ux, fu.x, 0.025);
      a *= 1.0 - 0.7 * lj;
      if (fract(hl * 53.0) < 0.025) { a = mix(a, vec3f(0.02), bandF(fract(ux + 0.5) - 0.5, -0.03, 0.03, fu.x)); }
      if (n.y > 0.5) {
        // Walkway lids: boot-worn dark centre line, and they pond in rain.
        a *= 1.0 - 0.15 * smoothstep(0.6, 0.85, valueNoise(world.xz * 0.9 + 3.0));
        flat = 0.85;
      }
    }
    case RC_PLATFORM: {
      // uv.x = metres from the platform's track edge, uv.y = along.
      let x = ux;
      // 0.6 m precast slabs (grid in both directions), each its own tone,
      // with dark sealed joints that read from the far end of the platform.
      let slab = vec2f(floor(x / 0.6), floor(uy / 0.6));
      let hsl = hash21(slab + f32(seed & 0xffu) * 0.13);
      a = vec3f(0.42, 0.41, 0.39) * tex * mix(0.9, 1.07, hsl) * select(1.0, 0.86, fract(hsl * 17.0) < 0.1);
      let jx = jointCov(x / 0.6, fu.x / 0.6, 0.016 / 0.6);
      let jy = jointCov(uy / 0.6, fu.y / 0.6, 0.016 / 0.6);
      a *= 1.0 - 0.58 * max(jx, jy);
      // Grout dirt: a soft dark halo 2-4 cm either side of every joint
      // (mopped grime settles there), falling to its mean at range.
      {
        let gq = abs(fract(vec2f(x, uy) / 0.6 + 0.5) - 0.5) * 0.6;
        let gd = min(gq.x, gq.y);
        let gk = 1.0 - smoothstep(0.03, 0.09, fp);
        a *= 1.0 - mix(0.05, 0.16 * (1.0 - smoothstep(0.008, 0.045, gd)), gk);
      }
      // Worn centre lane behind the tactile strip: polished darker and
      // smoother where the crowds walk, its edges ragged by low noise.
      let lane = smoothstep(1.2, 1.7, x + 0.3 * (fbm2(vec2f(x * 0.5, uy * 0.15)) - 0.5)) * (1.0 - smoothstep(3.0, 3.8, x + 0.4 * (fbm2(vec2f(x * 0.4 + 5.0, uy * 0.12)) - 0.5)));
      a *= 1.0 - 0.1 * lane * (0.7 + 0.3 * valueNoise(vec2f(x * 2.0, uy * 0.3)));
      s.rough = mix(s.rough, 0.55, lane);
      // Grime along the back fence foot and soft dirt shadows round the
      // benches / vending slots (0.3, 0.5, 0.62 of each bay).
      a *= 1.0 - 0.18 * smoothstep(5.0, 5.75, x) * (0.6 + 0.4 * valueNoise(vec2f(uy * 0.8, x)));
      {
        let bf = fract(uy / 12.0) * 12.0;
        let bd = min(min(abs(bf - 3.6), abs(bf - 6.0)), abs(bf - 7.44));
        let under = (1.0 - smoothstep(0.7, 1.3, bd)) * smoothstep(4.4, 4.9, x);
        a *= 1.0 - 0.2 * under * (0.55 + 0.45 * fbm2(vec2f(x * 1.5, uy * 1.5)));
      }
      // Chewing gum: small soft grey-black discs (1-3 cm) flattened into
      // the slab, scattered on a jittered 0.2 m grid by an fbm density mask
      // (thick in the walking lane, by the doors), low contrast; they
      // average into a faint mottle at range.
      {
        let dens = smoothstep(0.35, 0.75, fbm2(vec2f(x, uy) * 0.35 + 3.0)) * (0.4 + 0.6 * lane);
        let gc = floor(vec2f(x, uy) / 0.2);
        let hg = hash21(gc + 17.0);
        let gp = (gc + 0.2 + 0.6 * vec2f(hg, fract(hg * 47.0))) * 0.2;
        let gr = mix(0.008, 0.02, fract(hg * 91.0));
        let gw = max(fp, 1e-3);
        let dot0 = (1.0 - smoothstep(gr - gw * 0.5, gr + gw, length(vec2f(x, uy) - gp))) * min(1.0, gr * gr / (gw * gw) * 2.0);
        let on = step(hg, 0.12 + dens * 0.6);
        a = mix(a, a * vec3f(0.5, 0.49, 0.47), 0.7 * dot0 * on);
        a *= 1.0 - 0.04 * dens;
        // Soft spill / mop marks: fbm-thresholded with a wide ramp, so
        // they are faint clouds, never hard-edged blobs.
        a *= 1.0 - 0.1 * smoothstep(0.52, 0.78, fbm2(vec2f(x, uy) * 0.9 + 21.0));
      }
      // (Round 8) Where the queues stand, just behind the yellow line
      // (x 1.1-1.9): a grimy band of gum and black sole scuffs, scuff
      // streaks drawn along the platform; and dirt rings in the corners
      // round each canopy column foot (lateral 6.8: x ~3.05, every bent).
      {
        let qb = smoothstep(1.05, 1.25, x) * (1.0 - smoothstep(1.7, 2.1, x + 0.3 * (valueNoise(vec2f(uy * 0.4, 7.0)) - 0.5)));
        a *= 1.0 - 0.12 * qb * (0.6 + 0.4 * fbm2(vec2f(x * 2.0, uy * 0.6) + 9.0));
        let sc = floor(vec2f(x / 0.12, uy / 0.5));
        let hsk = hash21(sc + 31.0);
        let sq = fract(vec2f(x / 0.12, uy / 0.5));
        let skl = mix(0.2, 0.9, fract(hsk * 13.0));
        let scuff = step(hsk, 0.25) * (1.0 - smoothstep(0.05, 0.2, abs(sq.x - 0.5) - 0.0)) * step(abs(sq.y - 0.5), skl * 0.5) * (1.0 - smoothstep(0.02, 0.05, fp));
        a = mix(a, a * 0.55, 0.6 * scuff * max(qb, 0.35 * lane) + 0.08 * max(qb, 0.3 * lane) * smoothstep(0.02, 0.05, fp));
        let cf = vec2f(x - 3.05, (fract(uy / 12.0 + 0.5) - 0.5) * 12.0);
        let cr = length(max(abs(cf) - vec2f(0.12), vec2f(0.0)));
        a *= 1.0 - 0.32 * (1.0 - smoothstep(0.02, 0.35 + 0.1 * valueNoise(cf * 9.0), cr));
      }
      // Coping stone along the edge: a paler 0.5 m precast strip with 1 m
      // joints, and the white edge line painted on it.
      let cope = bandF(x, -0.2, 0.4, fu.x);
      let cj = jointCov(uy, fu.y, 0.01);
      // (A mid-grey precast stone, so the white line on it reads: 0.9 vs
      // ~0.36, not the old 0.8 on 0.5.)
      a = mix(a, vec3f(0.37, 0.365, 0.35) * tex * (1.0 - 0.5 * cj) * (1.0 - 0.15 * smoothstep(0.5, 0.8, valueNoise(vec2f(x * 3.0, uy * 0.7)))), cope);
      a *= 1.0 - 0.45 * bandF(x, 0.39, 0.42, fu.x);
      // White edge line, 15 cm, fresh paint (a little worn at the joints).
      let wl = bandF(x, 0.05, 0.2, fu.x);
      a = mix(a, vec3f(0.9, 0.9, 0.87) * mix(0.9, 1.0, d.a) * (1.0 - 0.25 * cj), wl);
      s.rough = mix(s.rough, 0.5, wl);
      // Yellow tactile warning strip (0.3 m blocks of domed dots on a 75 mm
      // grid). The dots are drawn into the albedo too (dark gaps, lit caps)
      // so they read in canopy shade, and keep a speckled mean tone and the
      // block joints out to the far end.
      let tk = bandF(x, 0.8, 1.1, fu.x);
      if (tk > 0.0) {
        var tu: vec3f;
        var tv: vec3f;
        uvDirs(&tu, &tv);
        let q = fract(vec2f(x - 0.8, uy) / 0.075) - 0.5;
        let r = length(q);
        let vis = 1.0 - smoothstep(0.03, 0.065, fp);
        let w = min(fp / 0.075 * 0.6, 0.3);
        let dome = 1.0 - smoothstep(0.26 - w, 0.33 + w, r);
        let slope = smoothstep(0.1, 0.3, r) * dome;
        s.normal = normalize(mix(s.normal, normalize(n + (tu * q.x + tv * q.y) / max(r, 1e-3) * slope * 1.6), vis * tk));
        let ring = smoothstep(0.28, 0.33, r) * (1.0 - smoothstep(0.36, 0.46, r));
        let cap = 1.0 - smoothstep(0.0, 0.16, r);
        let tb = vec2f(floor((x - 0.8) / 0.3), floor(uy / 0.3));
        let ht = hash21(tb + 3.7);
        // Blocks: most a faded ochre, a few fresh replacements.
        var ya = select(vec3f(0.8, 0.6, 0.06), vec3f(0.92, 0.72, 0.04), ht < 0.15) * mix(0.88, 1.05, d.a);
        ya *= mix(0.78, 1.0 - 0.65 * ring - 0.5 * (1.0 - dome) + 0.25 * cap, vis);
        ya *= 1.0 - 0.6 * max(jointCov(uy / 0.3, fu.y / 0.3, 0.012 / 0.3), jointCov((x - 0.8) / 0.3, fu.x / 0.3, 0.012 / 0.3));
        // Boot-scuffed grey wear on the dots, black tyre / sole marks.
        ya = mix(ya, vec3f(0.4, 0.38, 0.33), 0.4 * smoothstep(0.55, 0.8, valueNoise(vec2f(x * 4.0, uy * 0.6))));
        a = mix(a, ya, tk);
        s.ao = mix(s.ao, mix(0.9, 1.0 - 0.4 * ring, vis), tk);
        s.rough = mix(s.rough, 0.55, tk);
      }
      // Car-stop marks every 20 m: a white triangle and a numeral plate.
      let ay = (fract(uy / 20.0) - 0.5) * 20.0;
      let tri = step(0.25, x) * step(x, 0.6) * step(abs(ay), 0.15 * (x - 0.25) / 0.35);
      let num = bandF(x, 0.65, 0.8, fu.x) * bandF(ay, -0.08, 0.08, fu.y);
      a = mix(a, vec3f(0.82, 0.82, 0.8), max(tri * fine, num * (1.0 - smoothstep(0.03, 0.06, fp))));
      // The slab is laid nearly flat: it ponds in the rain.
      flat = 0.75;
      porous = 0.4;
    }
    case RC_PLATFORM_FACE: {
      a = vec3f(0.12, 0.12, 0.115) * tex * (1.0 - 0.3 * smoothstep(0.5, 0.8, valueNoise(vec2f(ux * 3.0, uy * 0.5))));
    }
    case RC_STATION: {
      if (n.y > 0.5) {
        // Box / tower roofs (seen from the train and the air): the building
        // roof shader's urethane membrane, grey or the green Tokyo coat by
        // seed: laps, repair patches, drains with silt rings, ponding.
        let rm = roofMat(world, n, uv, select(9u, 6u, (seed & 1u) == 1u));
        a = rm.albedo;
        s.normal = rm.normal;
        flat = 0.3;
      } else if (n.y < -0.5) {
        // Concourse / platform-slab undersides.
        let sp = soffitPattern(soffitUV(uv, world, n), seed, fp, fu);
        a *= 0.6 * sp.rgb;
        a = mix(a, vec3f(0.5, 0.5, 0.47), 0.6 * sp.a);
      } else if (vert && glazed) {
        // Glazed concourse under the deck (box UV: uv.y = metres above the
        // box bottom, 0.3 m below the ground): a full-height curtain wall,
        // mullions every 1.5 m, a transom at 2.4 m, a dark kick plate, and
        // the lit hall behind it (stairs up to the platforms, signs).
        let h = uy - 0.3;
        let mull = max(jointCov(ux / 1.5, fu.x / 1.5, 0.07 / 1.5), bandF(h, 2.36, 2.44, fu.y));
        let kick = 1.0 - smoothstep(0.25 - fu.y, 0.25, h);
        var tu: vec3f;
        var tv: vec3f;
        uvDirs(&tu, &tv);
        let V = normalize(world - frame.camPos.xyz);
        let hall = stationHall(vec2f(ux, h - 1.1), 2.8, n, tu, V, seed, fp);
        let frameC = vec3f(0.32, 0.33, 0.34);
        a = mix(mix(vec3f(0.03, 0.04, 0.045), frameC, mull), vec3f(0.08), kick);
        s.rough = mix(mix(0.05, 0.4, mull), 0.5, kick);
        s.metal = mull * 0.6;
        // Each pane sits a touch out of plane (a real curtain wall's panes
        // never mirror the street as one sheet), so the reflection steps
        // from pane to pane.
        let pane = vec2f(floor(ux / 1.5), step(2.4, h));
        let hp = hash21(pane + f32(seed & 0xffu) * 0.31);
        let hp2 = hash21(pane.yx + 11.0 + f32(seed & 0xffu) * 0.17);
        s.normal = normalize(n + (tu * (hp - 0.5) * 0.07 + vec3f(0.0, 1.0, 0.0) * (hp2 - 0.5) * 0.06) * (1.0 - mull));
        // Lit by day too (a station hall is never dark), brighter at night,
        // but at room level (walls ~0.35, tubes ~1.1 at night), not a
        // blown-out lightbox; a few panes carry a frosted privacy film.
        let film = select(1.0, 0.55, hp < 0.12 && h < 1.6);
        // Mullions and the transom shade the room just behind them (and
        // their deep reveals cut the light at a grazing view).
        let dm = min(abs(fract(ux / 1.5 + 0.5) - 0.5) * 1.5, abs(h - 2.4));
        let msh = mix(0.45, 1.0, smoothstep(0.03, 0.3, dm));
        // Capped at room level: ~2.5x the lit facade, not a light box.
        // (Round 8: 0.13 at night left the ground floor a grey, unlit
        // band under the glowing clerestory; the hall now glows cool white.)
        s.emissive = min(hall, vec3f(1.2)) * film * msh * mix(0.45, 1.0, step(0.18, hp2)) * (1.0 - mull) * (1.0 - kick) * mix(0.26, 0.45, nightLight());
        porous = 0.0;
        // --- Clerestory band (rail geometry round 5, RC_CLERESTORY 0x80 on
        // the concourse upper-storey ribbon, uv.y 1.2 .. 2.2): a warm lit
        // band between the mullions, dim by day, bright at night, so the
        // station box's upper storey reads as lit from the street. ---
        if ((param & 0x80u) != 0u) {
          // (Brighter than the hall below: it is a thin ribbon seen from
          // 30-300 m, and must read as a lit line at night.) Ceiling tube
          // rows show as brighter bars every 3 m behind the glass.
          let tube = 1.0 + 0.6 * (1.0 - smoothstep(0.1, 0.35, abs(fract(ux / 3.0) - 0.5) * 3.0));
          let band = vec3f(1.0, 0.88, 0.68) * (0.8 + 0.2 * hp) * tube;
          s.emissive = max(s.emissive, band * (1.0 - mull) * mix(0.3, 3.0, nightLight()));
        }
        // --- end clerestory band ---
      } else if (vert) {
        // Box UV: uv.y = metres above the tower base. Pale precast panels
        // (1.2 x 3 m), a dark granite plinth, a glazing band per landing.
        let pid = vec2f(floor(ux / 1.2), floor(uy / 3.0));
        a = vec3f(0.56, 0.55, 0.52) * tex * mix(0.94, 1.04, hash21(pid + f32(seed & 0xffu)));
        a *= 1.0 - 0.45 * max(jointCov(ux / 1.2, fu.x / 1.2, 0.012 / 1.2), jointCov(uy / 3.0, fu.y / 3.0, 0.012 / 3.0));
        a *= 1.0 - 0.18 * smoothstep(1.8, 1.0, uy);
        let base = 1.0 - smoothstep(1.0 - fu.y, 1.0, uy);
        a = mix(a, vec3f(0.15, 0.15, 0.16) * mix(0.8, 1.1, d.b * 2.0 - 0.5), base);
        s.rough = mix(s.rough, 0.35, base);
        let ly = uy - floor((uy - 2.5) / 4.5) * 4.5;
        let gl = bandF(ly, 2.5, 3.3, fu.y) * step(2.0, uy);
        if (gl > 0.0) {
          let mull = jointCov(ux / 1.2, fu.x / 1.2, 0.05 / 1.2);
          let glass = vec3f(0.035, 0.045, 0.055);
          a = mix(a, mix(glass, vec3f(0.3, 0.31, 0.32), mull), gl);
          s.rough = mix(s.rough, mix(0.05, 0.4, mull), gl);
          // The stair hall behind the band, parallax-mapped.
          var tu: vec3f;
          var tv: vec3f;
          uvDirs(&tu, &tv);
          let V = normalize(world - frame.camPos.xyz);
          let hall = stationHall(vec2f(ux, ly - 2.5), 0.8, n, tu, V, seed, fp);
          s.emissive = min(hall, vec3f(1.2)) * (1.0 - mull) * gl * mix(0.24, 0.13, nightLight());
        }
        porous = 0.3;
      }
    }
    case RC_SOUNDWALL: {
      if (vert) {
        var tu: vec3f;
        var tv: vec3f;
        uvDirs(&tu, &tv);
        // Ribbed pressed-steel / GRC panels between H-posts every 2 m, each
        // panel its own tone (replacements are fresher, some sun-yellowed).
        let pid = floor(ux / 2.0 + 0.5);
        let hpn = hashu((seed * 0x1b56c4e9u) ^ u32(i32(pid) + 65536));
        // (Tone per panel between two posts; hpn's cells straddle a post.)
        let hpp = hashu((seed * 0x3c6ef372u) ^ u32(i32(floor(ux / 2.0)) + 65536));
        // Panel type by hash: most the ribbed grey original, ~18 % a later
        // replacement in another tone with a finer, shallower rib, and (off
        // ~16 % clear polycarbonate (full height).
        // The stretch's mix is a geometry param ((param >> 7) & 3: bit 0
        // clear panels ~1 in 4, bit 1 replaced panels ~1 in 6).
        let pmix = (param >> 7u) & 3u;
        let ptype = hashuf(hpp ^ 0x7au);
        let clear = (pmix & 1u) != 0u && ptype < 0.25;
        let repl = (pmix & 2u) != 0u && ptype >= 0.25 && ptype < 0.25 + 1.0 / 6.0;
        let ptone = mix(0.92, 1.08, hashuf(hpp)) * select(vec3f(1.0), vec3f(1.05, 1.02, 0.9), hashuf(hpp ^ 2u) < 0.25)
          * select(vec3f(1.0), select(vec3f(1.22, 1.19, 1.08), vec3f(0.78, 0.86, 0.96), hashuf(hpp ^ 3u) < 0.5), repl);
        // Trapezoid rib profile, 0.2 m pitch: a lit upper chamfer, a flat
        // crest, a shadowed lower chamfer and a flat valley. Normals while the
        // ribs resolve, their mean shading after.
        let ribK = 1.0 - smoothstep(0.012, 0.04, fu.y);
        let rp = select(0.2, 0.1, repl);
        let rf = fract(uy / rp);
        let up = bandF(rf, 0.0, 0.14, fu.y / rp);
        let dn = bandF(rf, 0.5, 0.64, fu.y / rp);
        let rd = select(1.0, 0.55, repl);
        // (Each 12 m span of wall its own batch too, so the run reads as
        // spans at range.)
        let hsw = hashu((seed * 0x7f4a7c15u) ^ u32(i32(bent) + 65536));
        let stn = mix(0.9, 1.09, hashuf(hsw)) * mix(vec3f(1.04, 1.0, 0.93), vec3f(0.95, 0.99, 1.05), hashuf(hsw ^ 1u));
        a = vec3f(0.44, 0.45, 0.43) * ptone * stn * mix(1.0, d.b * 2.0, 0.25) * mix(0.95, 1.0 + (0.1 * up - 0.22 * dn) * rd, ribK);
        s.normal = normalize(n + tv * (dn - up) * 0.9 * rd * ribK);
        s.rough = 0.6;
        // Top-down grime: dust settles on the cap and washes down the panel
        // face; darker under the cap, streaked per panel.
        let px = (fract(ux / 2.0 + 0.5) - 0.5) * 2.0;
        let ptop = select(0.0, 0.62, glazed);
        // (Its depth and strength per panel: a replaced panel is cleaner.)
        let tg = mix(0.25, 0.9, hashuf(hpp ^ 0x41u));
        a *= mix(mix(0.62, 0.85, hashuf(hpp ^ 0x42u) * 0.6 + select(0.0, 0.4, repl)), 1.0, smoothstep(ptop, ptop + tg, uy) * (0.75 + 0.25 * blot));
        var gs = 0.0;
        for (var q = 0u; q < 3u; q++) {
          let hq = hashu(hpn ^ (0x77u + q * 0x13u));
          gs = max(gs, mix(0.35, 0.85, hashuf(hq ^ 1u)) * fanStreak(px, uy, mix(-0.8, 0.8, hashuf(hq)), ptop, mix(0.12, 0.5, hashuf(hq ^ 2u)), mix(0.4, 1.4, hashuf(hq ^ 3u)), f32(hq & 0xffu), fp));
        }
        a = mix(a, vec3f(0.22, 0.21, 0.18), 0.6 * gs);
        if (glazed) {
          // Translucent polycarbonate upper 0.6 m in a dark frame: low albedo
          // so the sky and SSR carry it, wiper-like scratches and a grimy
          // bottom edge where water stands.
          let gk = bandF(uy, -1.0, 0.6, fu.y);
          let fr = max(bandF(uy, 0.56, 0.64, fu.y), bandF(uy, -1.0, 0.03, fu.y));
          // Dark smoke/teal-tinted sheet (~0.05): it reads by what it
          // reflects, so at night it stays dark unless a lamp is near. Each
          // panel its own tint and age; dust settles from the top frame,
          // grime stands along the bottom one, and the posts and top frame
          // shade the sheet beside them.
          let hgp = hashu((seed * 0x3c6ef372u) ^ u32(i32(floor(ux / 2.0)) + 65536));
          let tint = select(vec3f(0.04, 0.05, 0.055), vec3f(0.045, 0.06, 0.058), hashuf(hgp ^ 0x1du) < 0.4);
          var gc = tint * mix(0.75, 1.35, hashuf(hgp ^ 9u));
          gc = mix(gc, vec3f(0.17, 0.165, 0.15), mix(0.15, 0.4, hashuf(hgp ^ 0x2eu)) * (1.0 - smoothstep(0.03, 0.22, uy)) * (0.6 + 0.4 * valueNoise(vec2f(ux * 3.0, uy * 6.0))));
          gc = mix(gc, vec3f(0.2, 0.19, 0.17), 0.55 * smoothstep(0.38, 0.56, uy) * (0.6 + 0.4 * valueNoise(vec2f(ux * 5.0, uy * 3.0))));
          s.ao = mix(s.ao, mix(0.55, 1.0, smoothstep(0.08, 0.25, abs(px)) * smoothstep(0.03, 0.14, uy)), gk);
          let fine = 1.0 - smoothstep(0.004, 0.012, fp);
          if (fine > 0.0) {
            let sc = abs(fract(dot(vec2f(px, uy), vec2f(0.8, 0.6)) * 9.0 + valueNoise(vec2f(px, uy) * 2.0) * 3.0) - 0.5);
            let scr = (1.0 - smoothstep(0.0, 0.03, sc)) * smoothstep(0.55, 0.75, valueNoise(vec2f(px * 3.0, uy * 3.0) + f32(hpn & 0xffu)));
            gc += vec3f(0.12) * scr * fine;
          }
          gc = mix(gc, vec3f(0.18, 0.18, 0.19), fr);
          a = mix(a, gc, gk);
          s.rough = mix(s.rough, mix(0.07, 0.45, fr), gk);
          s.normal = normalize(mix(s.normal, n, gk));
        }
        // Clear polycarbonate panel: a dark smoked sheet that shows what is
        // behind it dimly (the sky and the catenary over the wall, from the
        // street; the city across, from the track), scuffed, grimy at the
        // foot, with a horizontal frame bar at mid-height.
        if (clear) {
          let V = normalize(world - frame.camPos.xyz);
          let behind = mix(frame.groundAmbient.rgb * 0.8 + frame.cityGlow.rgb, frame.skyAmbient.rgb, smoothstep(-0.4, 0.1, V.y));
          let bar = bandF(uy, 0.72, 0.8, fu.y);
          let cg = vec3f(0.045, 0.05, 0.05) * mix(0.85, 1.15, hashuf(hpp ^ 9u));
          let ck = 1.0 - bar;
          a = mix(a, cg, ck);
          s.rough = mix(s.rough, 0.08, ck);
          s.normal = normalize(mix(s.normal, n, ck));
          s.emissive += mix(behind, vec3f(dot(behind, vec3f(0.3, 0.5, 0.2))), 0.6) * 0.3 * ck * (1.0 - smoothstep(1.1, 1.5, uy) * 0.7);
          a = mix(a, vec3f(0.24, 0.24, 0.25), bar);
        }
        // Dirt toward the base (wall ~1.5 m high): splash grime rising a
        // ragged 0.2-0.5 m from the foot, per panel.
        let gh = mix(0.2, 0.5, hashuf(hpp ^ 0x51u));
        let foot = smoothstep(1.5 - gh, 1.5 - gh * 0.3, uy + 0.12 * (valueNoise(vec2f(ux * 6.0, uy * 3.0)) - 0.5));
        a *= mix(1.0, 0.72, smoothstep(1.0, 1.5, uy));
        a = mix(a, vec3f(0.16, 0.145, 0.12), 0.55 * foot);
        // H-posts, with edge normals while they resolve; rust streaks run
        // from the post tops and bolts down the post and the panel beside.
        let pc = jointCov(ux / 2.0, fu.x / 2.0, 0.15 / 2.0);
        let ek = (1.0 - smoothstep(0.01, 0.03, fu.x)) * smoothstep(0.045, 0.075, abs(px)) * step(abs(px), 0.075);
        s.normal = normalize(mix(s.normal, normalize(n + tu * sign(px) * 0.8), ek));
        let rs = fanStreak(px, uy, (hashuf(hpn ^ 5u) - 0.5) * 0.15, 0.0, 0.22, mix(0.4, 1.3, hashuf(hpn ^ 6u)), f32(hpn & 0xffu), fp);
        a = mix(a, vec3f(0.36, 0.19, 0.09), 0.55 * rs * (1.0 - pc));
        let post = vec3f(0.25, 0.25, 0.26) * mix(1.0, 0.7, smoothstep(1.1, 1.5, uy));
        a = mix(a, mix(post, vec3f(0.3, 0.16, 0.08), 0.6 * rs), pc);
        s.rough = mix(s.rough, 0.55, pc);
        // Rain sheets down the ribs as gloss.
        stain = max(stain, 0.25 * gs * wet);
      } else {
        a = vec3f(0.45, 0.45, 0.44) * tex;
        s.rough = 0.6;
      }
      porous = 0.1;
    }
    default: {}
  }
  // Rain-run stains: black-green, a touch rougher-looking dry, and the first
  // thing to go dark when it rains.
  a = mix(a, vec3f(0.13, 0.13, 0.11), 0.82 * stain);
  s.rough = mix(s.rough, 0.7, stain);
  s.albedo = a;
  if (wet > 0.0) {
    // The stains are where the water runs: wetter, darker and glossy first.
    s.albedo *= 1.0 - 0.4 * stain * wet;
    // (Not mirror-wet: a 0.1 gloss halved again by applyWetness turned
    // every drip into a bright tongue of reflected sky.)
    s.rough = mix(s.rough, 0.28, smoothstep(0.1, 0.6, stain) * wet);
    if (vert && role != RC_SOUNDWALL && !(role == RC_STATION && glazed)) {
      // One continuous wet field over the exposed faces, in world space
      // (no per-panel or per-span cells, no hard thresholds: those came out
      // as formwork-sized rectangles of gloss): broad run-off curtains
      // hanging from the deck edge (soft fbm, ~1-3 m wide, elongated down
      // the face), wetter right under the coping and toward the pier heads
      // (beam run-off), and a dark wet trail under every scupper.
      let hz = normalize(vec2f(-n.z, n.x) + vec2f(1e-4, 0.0));
      let hx = dot(world.xz, hz);
      let cf = fbm2(vec2f(hx * 0.45, world.y * 0.09) + 13.0);
      var wf = 0.35 + 0.65 * smoothstep(0.38, 0.72, cf);
      if (role == RC_FASCIA || role == RC_PARAPET || role == RC_BEAM) {
        wf = max(wf, 1.0 - smoothstep(0.15, 0.8, uy));
      }
      if (role == RC_COLUMN) {
        wf = max(wf, smoothstep(2.5, 7.0, uy - 1.0) * (0.55 + 0.45 * cf));
      }
      wf = max(wf, wetTrail);
      // Darker where the field is wetter; gloss follows the same field,
      // continuously (applyWetness then halves it on vertical faces:
      // ~0.37 damp .. 0.15 running).
      s.albedo *= 1.0 - wet * (0.12 + 0.3 * wf);
      s.rough = mix(s.rough, mix(0.75, 0.3, wf), wet);
    }
  }
  applyWetness(&s, world, flat, porous);
  // Night bounce: the street below (lamp pools, shop fronts, headlights)
  // and the under-deck fittings light the down- and outward-facing deck
  // faces softly, so the fascia and soffits are not black between lamps.
  // Warm from the sodium/LED-lit street, strongest at the fascia's foot;
  // on the soffits it peaks under each bay's fluorescent fitting.
  if (role == RC_FASCIA || role == RC_BEAM || (role == RC_STATION && n.y < -0.5)) {
    let nl = nightLight();
    if (nl > 0.0) {
      var bk = 0.0;
      if (n.y < -0.5) {
        let bay = abs(fract(ux / 12.0) - 0.5) * 2.0;
        bk = 0.06 + 0.05 * (1.0 - smoothstep(0.0, 0.7, bay));
      } else if (vert) {
        bk = select(0.03, mix(0.008, 0.04, smoothstep(0.1, 2.0, uy)), role == RC_FASCIA);
      }
      s.emissive += s.albedo * vec3f(1.0, 0.86, 0.68) * bk * nl;
    }
  }
  // Concourse spill: the lit glazed hall and entrance canopies wash the
  // station box's solid walls from below at night (strongest over the
  // first 1-4 m, a faint lift above), so the box isn't a black slab.
  if (role == RC_STATION && vert && !glazed) {
    let nl = nightLight();
    if (nl > 0.0) {
      s.emissive += s.albedo * vec3f(1.0, 0.92, 0.8) * nl * (0.025 + 0.09 * (1.0 - smoothstep(0.8, 4.5, uy)));
    }
  }
  return s;
}

// Track bed (M_RAIL): uv.x = signed lateral metres from the deck
// centreline, uv.y = along (bent units). Ballast zoned by distance from each
// track (rust band under the rails, oily centre, fresher shoulders), a
// drain channel between the tracks, and concrete sleepers with relief:
// bevelled edges, ballast AO and stones heaped over their ends.
fn railBed(world: vec3f, n: vec3f, uv: vec2f) -> Surf {
  var s = defaultSurf(n);
  let fp = railFoot();
  let fu = uvFoot();
  let wet = frame.weather.z;
  let x = uv.x;
  let d = detailXZ(world, 1.5, DETAIL_BALLAST);
  let c = select(-2.1, 2.1, x > 0.0);
  let atx = abs(x - c);
  // Grey crushed granite (neutral, ~0.2: day exposure lifts 0.25 close
  // to white), each 3 m of bed its own batch.
  var bal = vec3f(0.2, 0.198, 0.19) * mix(0.85, 1.1, valueNoise(world.xz * 0.35));
  // Brake dust: rust-brown only right under and beside each rail (+-0.25 m
  // of it), fading through a dusty brown-grey; the rest stays granite.
  let dr = abs(atx - 0.53);
  let rustK = (1.0 - smoothstep(0.1, 0.25 + 0.05 * (valueNoise(vec2f(x * 3.0, uv.y * 0.9)) - 0.5), dr));
  bal = mix(bal, vec3f(0.21, 0.13, 0.08), 0.8 * rustK);
  // An oily brown-black band down the four-foot centre, dripped from the
  // trains (patchy along the line).
  let oilEdge = 0.22 + 0.06 * (valueNoise(vec2f(x * 2.0, uv.y * 0.7)) - 0.5);
  let oil = (1.0 - smoothstep(oilEdge - 0.1, oilEdge + 0.05, atx)) * mix(0.45, 1.0, valueNoise(vec2f(x * 3.0, uv.y * 0.2)));
  bal = mix(bal, vec3f(0.055, 0.05, 0.045), 0.85 * oil);
  // Fresher, paler stone on the shoulders (topped up by the tamping train).
  bal = mix(bal, vec3f(0.26, 0.258, 0.25), smoothstep(1.35, 1.7, atx));
  // The shoulder slope (|x| > 3.3): fresh pale stone, a dark silty toe.
  bal = mix(bal, vec3f(0.3, 0.297, 0.288), smoothstep(3.25, 3.45, abs(x)) * (1.0 - smoothstep(3.7, 4.0, abs(x))));
  bal = mix(bal, vec3f(0.12, 0.115, 0.105), smoothstep(3.75, 4.05, abs(x)));
  let stoneA = d.b * 2.0 * mix(0.3, 1.0, d.a);
  var a = bal * stoneA;
  // One stone in ten rust-stained (the detail layer is grey only).
  let rs = smoothstep(0.8, 0.88, valueNoise(world.xz * 22.0)) * (1.0 - smoothstep(0.008, 0.025, fp));
  a = mix(a, a * vec3f(1.3, 0.85, 0.6), rs);
  s.normal = detailNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), d, 1.0);
  s.rough = 0.95;
  // Wet ballast: glossy stone tops (~0.3), water standing in the voids.
  var pool = 0.0;
  if (wet > 0.0) {
    s.rough = mix(0.95, mix(0.22, 0.4, d.a), wet);
    pool = (1.0 - smoothstep(0.25, 0.45, d.a)) * wet;
  }
  // Sleepers: 2.0 x 0.24 m every 0.6 m. Fade to the area-weighted mean once
  // the 0.6 m pitch is under ~6 px (the old painted stripes strobed).
  let sk = 1.0 - smoothstep(0.045, 0.1, fu.y);
  let inTrack = 1.0 - smoothstep(0.98, 1.02 + fp, atx);
  if (inTrack > 0.0) {
    let sid = floor(uv.y / 0.6 + 0.5);
    let hs = hash21(vec2f(sid, c));
    let hs2 = hash21(vec2f(sid * 1.37 + 5.0, c * 3.1));
    // Laid by hand-ish: each sleeper a few cm off pitch and a touch skewed.
    // (+-3.5 cm off pitch, +-1.5 degrees of yaw, so the rungs visibly wander.)
    let sy = uv.y - sid * 0.6 - (hs - 0.5) * 0.07 - (x - c) * (fract(hs * 31.0) - 0.5) * 0.052;
    let ds = abs(sy);
    // Stones heaped over the sleeper ends and spilling over its edges.
    let heap = smoothstep(0.6, 0.75, d.a) * smoothstep(0.9, 1.0, atx) + smoothstep(0.7, 0.85, d.a) * 0.6 * smoothstep(0.09, 0.12, ds);
    let onS = step(ds, 0.12) * step(atx, 1.0) * (1.0 - step(0.5, heap));
    let cd = detailUV(uv, 1.0, DETAIL_CONCRETE);
    // Prestressed concrete: mid grey (~0.5 on screen in sun, not the old
    // off-white), each sleeper +-10 % and its own age (one in eight a
    // fresher replacement, one in six weathered darker), with only a light
    // oil stain in the four-foot.
    // (Round 8: at 0.215 the sun put every sleeper on the tone curve's
    // shoulder, where +-15 % and the oil / rust terms compressed to nothing:
    // identical light bars. The base now sits in the mid-tones, ~0.16, so
    // the per-sleeper spread reads.)
    var sBase = vec3f(0.19, 0.188, 0.18);
    // (Spread widened in round 7, so neighbouring sleepers read apart in
    // the cab view: +-15 % each, one in eight a pale replacement, one in
    // ten coated in brown ballast / brake dust, one in five weathered dark.)
    if (hs2 < 0.1) {
      sBase = vec3f(0.26, 0.258, 0.25);
    } else if (hs2 < 0.2) {
      sBase = vec3f(0.17, 0.135, 0.1);
    } else if (hs2 > 0.9) {
      // A replaced sleeper of another make: dark, almost black-grey.
      sBase = vec3f(0.075, 0.073, 0.07);
    } else if (hs2 > 0.72) {
      sBase = vec3f(0.115, 0.11, 0.102);
    }
    sBase *= mix(0.88, 1.12, hs) * mix(0.92, 1.05, valueNoise(vec2f(x * 1.3, uv.y * 0.3)));
    var sa = sBase * mix(1.0, cd.b * 2.0, 0.45) * mix(0.8, 1.0, cd.a);
    // Oil soaked into the centre between the rails, ragged-edged, heavier on
    // some sleepers than others.
    let oe = 0.3 + 0.1 * (valueNoise(vec2f(x * 5.0, uv.y * 7.0)) - 0.5);
    sa = mix(sa, vec3f(0.05, 0.045, 0.04), mix(0.45, 0.9, fract(hs * 7.0)) * (1.0 - smoothstep(oe - 0.08, oe + 0.06, atx)) * mix(0.75, 1.0, valueNoise(vec2f(x * 6.0, uv.y * 4.0))));
    // A little rust bleeding from the rail seats.
    let rr = 0.14 + 0.05 * (valueNoise(vec2f(x * 9.0, uv.y * 9.0 + hs * 20.0)) - 0.5);
    sa = mix(sa, vec3f(0.24, 0.12, 0.05), 0.7 * (1.0 - smoothstep(rr * 0.5, rr, abs(atx - 0.53))));
    // Fastenings: a dark clip blob either side of each rail (e-clip, its
    // shoulder casting and insulator, ~10 x 8 cm), and the black seat pad
    // under the rail foot.
    let cq = vec2f((abs(atx - 0.53) - 0.1) / 0.055, sy / 0.045);
    let clip = 1.0 - smoothstep(0.75, 1.0 + fp / 0.05, length(cq));
    let cr = valueNoise(vec2f(x * 40.0, uv.y * 40.0) + hs * 9.0);
    sa = mix(sa, mix(vec3f(0.035, 0.032, 0.03), vec3f(0.2, 0.1, 0.05), 0.4 * cr), clip);
    // Rust run-off round each clip onto the sleeper top.
    sa = mix(sa, vec3f(0.24, 0.12, 0.05), 0.6 * (1.0 - clip) * (1.0 - smoothstep(0.0, 0.6, length(cq) - 1.0)));
    sa = mix(sa, vec3f(0.04), (1.0 - step(0.07, abs(atx - 0.53))) * step(ds, 0.1));
    // Rail seat: the shoulder casting's footprint, a darker greasy, dusty
    // pad zone round each rail (+-0.17 m), soft-edged.
    sa *= 1.0 - 0.3 * (1.0 - smoothstep(0.12, 0.18, abs(atx - 0.53)));
    // Chipped arrises and corners: spalls along the long edges and bitten
    // corners at the ends, paler fresh aggregate with a dark rim.
    {
      let ch = valueNoise(vec2f(x * 14.0, uv.y * 30.0) + hs * 17.0);
      let edge = smoothstep(0.085, 0.115, ds) * smoothstep(0.62, 0.72, ch);
      let cq2 = vec2f(1.0 - atx, 0.12 - ds);
      let corner = 1.0 - smoothstep(0.02, 0.05 + 0.04 * fract(hs * 13.0), length(max(cq2, vec2f(0.0))) + 0.02 * ch);
      let chip = max(edge, corner * step(0.4, fract(hs * 7.7))) * (1.0 - smoothstep(0.004, 0.012, fp));
      sa = mix(sa, sBase * 1.25, chip * 0.8);
    }
    // Bevel: 3 cm tilt at all four edges.
    var tu: vec3f;
    var tv: vec3f;
    uvDirs(&tu, &tv);
    let ey = smoothstep(0.09, 0.12, ds) * sign(sy);
    let ex = smoothstep(0.97, 1.0, atx) * sign(x - c);
    let sn = normalize(n + tv * ey * 0.9 + tu * ex * 0.9);
    // Ballast AO beside the sleeper sides and ends: the sleeper top sits
    // ~4 cm proud, so the stones right against it are in a deep contact
    // shadow (albedo too, so it holds in shade and at a distance).
    let gap = max(ds - 0.12, (atx - 1.0) * 0.6);
    let cs = 1.0 - smoothstep(0.0, 0.07, max(gap, 0.0));
    let aoB = select(mix(1.0, 0.3, cs), 1.0, onS > 0.5);
    a *= select(1.0 - 0.45 * cs, 1.0, onS > 0.5);
    // The sleeper's top arris catches the light; its sides fall away.
    sa *= 1.0 + 0.12 * (1.0 - smoothstep(0.08, 0.1, ds)) * smoothstep(0.06, 0.09, ds);
    // The 4 cm side face showing past the top edge (darker, dirtier), so
    // the sleeper reads as a block sitting in the stone, not a painted bar.
    sa *= 1.0 - 0.45 * smoothstep(0.1, 0.115, ds);
    // Mean over a sleeper pitch: 40 % pale sleeper (its clips and oiled
    // centre in it), 60 % ballast with its contact shadow; the mean of a
    // run of 5 sleepers varies, so a distant track is not one even stripe.
    let hg = hash21(vec2f(floor(uv.y / 3.0), c));
    let meanS = mix(vec3f(0.18, 0.177, 0.17), vec3f(0.09, 0.083, 0.075), 0.45 * (1.0 - smoothstep(0.15, 0.3, atx))) * mix(0.88, 1.08, hg);
    let meanA = mix(a * 0.85, meanS, 0.4);
    let sharpA = mix(a, sa, onS);
    a = mix(meanA, sharpA, sk);
    s.ao = mix(mix(1.0, 0.75, inTrack), aoB, sk);
    s.normal = normalize(mix(s.normal, mix(s.normal, sn, onS), sk));
    s.rough = mix(s.rough, mix(s.rough, mix(0.85, 0.3, wet), onS), sk);
    pool *= 1.0 - onS * sk;
  }
  // Concrete drain channel between the tracks, with a dark slot.
  let ch = 1.0 - smoothstep(0.58, 0.6 + fp, abs(x));
  if (ch > 0.0) {
    let cd = detailUV(uv, 2.0, DETAIL_CONCRETE);
    var ca = vec3f(0.25, 0.24, 0.225) * mix(0.7, 1.0, valueNoise(uv * vec2f(2.0, 0.3))) * mix(1.0, cd.b * 2.0, 0.5) * mix(0.7, 1.0, cd.a);
    let slot = bandF(x, -0.15, 0.15, fu.x);
    ca = mix(ca, vec3f(0.06, 0.06, 0.055), slot);
    a = mix(a, ca, ch);
    s.normal = normalize(mix(s.normal, n, ch));
    s.rough = mix(s.rough, mix(0.85, 0.15, wet), ch);
    // In the rain the slot runs with water.
    pool = mix(pool, slot * wet, ch);
  }
  s.albedo = a;
  // The drain channel between the tracks ponds in the rain.
  applyWetness(&s, world, ch * 0.9, 0.5);
  // Standing water: dark and mirror-smooth, flat normal.
  s.rough = mix(s.rough, 0.04, pool);
  s.albedo *= 1.0 - 0.45 * pool;
  s.normal = normalize(mix(s.normal, n, pool));
  return s;
}

// Rail steel: the railhead tube (RAIL_STEEL) has a polished running band on
// top and rust-brown sides; the web/foot (RAIL_WEB) is all rust and oil.
fn railSteel(world: vec3f, n: vec3f, param: u32) -> Surf {
  var s = defaultSurf(n);
  let wet = frame.weather.z;
  let rust = vec3f(0.26, 0.13, 0.06) * mix(0.8, 1.15, valueNoise(world.xz * 7.0 + world.y));
  if (param == RAIL_STEEL) {
    // Wet, the water film spreads the mirror over the whole crown: a bright
    // line of sky down each rail.
    let head = smoothstep(mix(0.5, 0.2, wet), mix(0.75, 0.5, wet), n.y);
    let band = smoothstep(0.88, 0.95, n.y);
    // Only the running band is polished; the gauge-corner shoulders are a
    // duller, darker steel (a glossy shoulder mirrored a blue sky rim
    // down every rail at grazing angles by day).
    s.albedo = mix(rust, mix(vec3f(0.34, 0.33, 0.32), vec3f(0.62, 0.62, 0.60), band) * (1.0 + 0.5 * wet), head);
    s.metal = head * mix(0.55, 1.0, band);
    s.rough = mix(0.8, mix(0.42, 0.08, band), head);
    s.rough = mix(s.rough, mix(s.rough * 0.7, 0.05, head), wet);
    s.albedo *= 1.0 - 0.3 * wet * (1.0 - head);
  } else {
    s.albedo = rust * mix(0.65, 1.0, smoothstep(-0.6, 0.3, n.y));
    s.rough = mix(0.85, 0.45, wet);
    s.albedo *= 1.0 - 0.3 * wet;
  }
  return s;
}

// Hot-dip galvanised gantry steel: a dull mid grey (darker than the
// concrete), soft low-frequency mottle (~0.5 m, the zinc's uneven
// weathering) with a fine spangle close up, roughness 0.4-0.6 following the
// mottle. Drip streaks only run down tall vertical members (box faces taller
// than ~1.2 m, i.e. the masts, and vertical tubes): on the 0.8 m box girder
// a world-vertical streak field read as wood planks across the beam.
// Long horizontal box faces get a splice plate with bolt rows every 3 m
// instead, and rust only blooms at those bolts and on the up-facing tops
// where water stands.
fn galvSteel(world: vec3f, n: vec3f, uv: vec2f, aux: u32) -> Surf {
  var s = defaultSurf(n);
  let fp = railFoot();
  let fu = uvFoot();
  let fine = 1.0 - smoothstep(0.004, 0.015, fp);
  var tu: vec3f;
  var tv: vec3f;
  uvDirs(&tu, &tv);
  let horiz = normalize(vec2f(-n.z, n.x) + vec2f(1e-4, 0.0));
  let p = vec2f(dot(world.xz, horiz), world.y);
  let tube = (aux & 0xffffu) != 0u;
  let vface = abs(n.y) < 0.5;
  // ~0.5 m mottle (two octaves, world space so it runs across members).
  let mo = valueNoise(p * 2.0 + world.y * 0.3) * 0.65 + valueNoise(p * 4.3 + 7.0) * 0.35;
  var a = 0.4 * mix(0.82, 1.14, mo) * (1.0 + 0.05 * (2.0 * valueNoise(p * 40.0) - 1.0) * fine);
  // Tall vertical member? (box face: uv.y = metres above its bottom; tube:
  // its length axis u is vertical.)
  let tall = select(smoothstep(1.0, 1.6, uv.y) * step(0.7, abs(tv.y)), step(0.7, abs(tu.y)), tube) * select(0.0, 1.0, vface);
  if (tall > 0.0) {
    let f1 = 1.0 - smoothstep(0.03, 0.08, fp);
    let st = smoothstep(0.5, 0.85, valueNoise(vec2f(p.x * 5.0, p.y * 0.35))) * (0.6 + 0.4 * valueNoise(vec2f(p.x * 11.0, p.y * 0.8)));
    a *= 1.0 - 0.16 * tall * mix(0.35, st, f1);
  }
  // Splice plates on long horizontal box faces (the box girder, walkway
  // edge): a 0.3 m plate every 3 m along u, its bolt grid, and short rust
  // runs from a few bolts.
  var rust = 0.0;
  if (!tube && vface && abs(tu.y) < 0.3) {
    let sx = (fract(uv.x / 3.0 + 0.5) - 0.5) * 3.0;
    let plate = bandF(sx, -0.15, 0.15, fu.x);
    let edge = max(bandF(sx, -0.155, -0.14, fu.x), bandF(sx, 0.14, 0.155, fu.x));
    a *= (1.0 + 0.07 * plate) * (1.0 - 0.3 * edge * (1.0 - smoothstep(0.02, 0.05, fu.x)));
    let sp = round(uv.x / 3.0);
    let hs = hashu((u32(i32(sp) + 4096) * 0x9e3779b1u) ^ u32(i32(floor(dot(world.xz, n.xz) * 0.5)) + 65536));
    let bq = vec2f((fract(sx / 0.1) - 0.5) * 0.1, (fract(uv.y / 0.12) - 0.5) * 0.12);
    let bolt = (1.0 - smoothstep(0.012, 0.012 + fp, length(bq))) * step(abs(sx), 0.11) * step(0.06, uv.y);
    a *= 1.0 - 0.35 * bolt * (1.0 - smoothstep(0.006, 0.015, fp));
    rust = step(0.55, hashuf(hs)) * runStain(uv.x, -uv.y, sp * 3.0 + (hashuf(hs ^ 1u) - 0.5) * 0.2, -0.65, 0.05, mix(0.15, 0.4, hashuf(hs ^ 2u)), fp) * 0.6;
    rust = max(rust, 0.25 * plate * smoothstep(0.55, 0.8, valueNoise(vec2f(uv.x * 6.0, uv.y * 6.0) + f32(hs & 0xffu))));
  }
  // Up-facing tops and caps, where water stands: a faint rust bloom.
  rust = max(rust, smoothstep(0.6, 0.85, valueNoise(world.xz * 3.0 + world.y)) * smoothstep(0.5, 0.9, n.y) * 0.45);
  s.albedo = mix(vec3f(a, a, a * 0.98), vec3f(0.34, 0.18, 0.08), rust);
  s.metal = mix(0.55, 0.1, rust);
  s.rough = mix(mix(0.42, 0.6, mo), 0.8, rust);
  applyWetness(&s, world, 0.0, 0.0);
  return s;
}

// Plate-girder span over a road (paint RAIL_GIRDER | seed): grey-blue, JR
// grey-green or rust-brown paint with paintedSteel's wear, vertical web
// stiffeners every 1.5 m, rivet rows near the flanges and, on the flagged
// road-facing web (seed bit 0x80), a yellow clearance board.
fn railGirder(world: vec3f, n: vec3f, uv: vec2f, param: u32) -> Surf {
  let seed = param & 0x7fu;
  // Blue-grey, JR teal or rust-brown (oxide primer showing through).
  let pal = array<vec3f, 3>(vec3f(0.36, 0.42, 0.5), vec3f(0.2, 0.4, 0.37), vec3f(0.28, 0.13, 0.065));
  var s = paintedSteelC(world, n, seed, pal[seed % 3u] * mix(0.94, 1.06, hashuf(seed * 0x9e37u)));
  if (abs(n.y) > 0.5) { return s; }
  let fp = railFoot();
  let fu = uvFoot();
  let ux = uv.x;
  let uy = uv.y;
  var tu: vec3f;
  var tv: vec3f;
  uvDirs(&tu, &tv);
  // Each 12 m span repainted in its own year: +-10 % value and a slight
  // chalky fade on some, so a run of girders is not one flat colour.
  let hsp = hashu((seed * 0x9e3779b1u) ^ u32(i32(floor(ux / 12.0)) + 65536));
  s.albedo *= mix(0.86, 1.12, hashuf(hsp));
  s.albedo = mix(s.albedo, vec3f(luminance(s.albedo)) * 1.1, 0.35 * step(0.6, hashuf(hsp ^ 3u)));
  // Rust bleeding from the top-flange rivets and stiffener feet.
  {
    let st = round(ux / 1.5);
    let hr = hashu(hsp ^ u32(i32(st) + 4096));
    let rb = step(0.45, hashuf(hr)) * fanStreak(ux, uy, st * 1.5 + (hashuf(hr ^ 1u) - 0.5) * 0.3, 0.1, mix(0.05, 0.14, hashuf(hr ^ 2u)), mix(0.3, 1.2, hashuf(hr ^ 3u)), f32(hr & 0xffu), fp);
    s.albedo = mix(s.albedo, vec3f(0.33, 0.15, 0.06), 0.75 * rb);
    s.rough = mix(s.rough, 0.85, rb);
  }
  // Chalky fade on the sun-facing (south, -z) webs: the paint's binder
  // has weathered to a pale, flat bloom, patchy, strongest up top.
  {
    let sunF = smoothstep(-0.1, 0.8, dot(normalize(n.xz + vec2f(1e-4, 0.0)), vec2f(0.17, -0.985)));
    let ch = sunF * mix(0.55, 1.0, valueNoise(vec2f(ux * 0.4, uy * 0.8) + f32(seed))) * (1.0 - 0.4 * smoothstep(0.4, 1.6, uy));
    s.albedo = mix(s.albedo, vec3f(luminance(s.albedo)) * 1.35 + vec3f(0.06, 0.065, 0.065), 0.5 * ch);
    s.rough = mix(s.rough, 0.85, ch);
  }
  // Bottom flange: road grime and soot thrown up by traffic over the lower
  // 0.4 m, a rust tide line along the flange weld with short rust runs
  // from the bottom rivet row (every 0.15 m, ~1 in 4 bleeding).
  {
    let low = smoothstep(1.25, 1.7, uy) * (0.7 + 0.3 * valueNoise(vec2f(ux * 1.3, 4.0 + f32(seed))));
    s.albedo *= 1.0 - 0.32 * low;
    let tide = smoothstep(1.56, 1.66, uy) * (0.5 + 0.5 * valueNoise(vec2f(ux * 3.0, 9.0)));
    s.albedo = mix(s.albedo, vec3f(0.3, 0.14, 0.055), 0.6 * tide);
    let bc = round(ux / 0.6);
    let hb = hashu(hsp ^ u32(i32(bc) + 9000));
    let br = step(0.7, hashuf(hb)) * runStain(ux, uy, bc * 0.6 + (hashuf(hb ^ 1u) - 0.5) * 0.3, 1.6, 0.07, 0.12, fp);
    // (Hanging down from the top rivet row too, longer.)
    let tc = round(ux / 0.45);
    let ht = hashu(hsp ^ u32(i32(tc) + 19000));
    let tr = step(0.72, hashuf(ht)) * runStain(ux, uy, tc * 0.45 + (hashuf(ht ^ 1u) - 0.5) * 0.2, 0.08, 0.05, mix(0.3, 1.0, hashuf(ht ^ 2u)), fp);
    s.albedo = mix(s.albedo, vec3f(0.32, 0.14, 0.05), 0.7 * max(br, tr));
    s.rough = mix(s.rough, 0.85, max(low * 0.5, max(br, tr)));
  }
  // Round 8 paint value variation, all >= 0.5 m so it reads from the
  // street: broad chalked patches (pale, flat) anywhere on the web, a
  // darker painted-over lower flange band, and a rust wash over the
  // bearings at each girder end.
  {
    let cp = smoothstep(0.5, 0.78, valueNoise(vec2f(ux * 0.22, uy * 0.6) + f32(seed) * 1.7 + 20.0));
    s.albedo = mix(s.albedo, vec3f(luminance(s.albedo)) * 1.3 + vec3f(0.05, 0.055, 0.055), 0.45 * cp);
    s.rough = mix(s.rough, 0.85, cp * 0.6);
    s.albedo *= 1.0 - 0.38 * smoothstep(1.5, 1.56, uy);
    let ge = abs(ux - round(ux / 12.0) * 12.0);
    let bw = (1.0 - smoothstep(0.3, 1.2 + 0.4 * valueNoise(vec2f(uy * 2.0, ux)), ge)) * smoothstep(0.7, 1.4, uy);
    s.albedo = mix(s.albedo, vec3f(0.3, 0.14, 0.055), 0.7 * bw * (0.6 + 0.4 * valueNoise(vec2f(ux * 4.0, uy * 5.0))));
    s.rough = mix(s.rough, 0.85, bw);
  }
  // Stiffeners: a 4 cm lit edge and a 4 cm shadow edge per 1.5 m.
  let sx = (fract(ux / 1.5) - 0.5) * 1.5;
  let sk = 1.0 - smoothstep(0.02, 0.06, fu.x);
  let lit = bandF(sx, -0.04, 0.0, fu.x);
  let shd = bandF(sx, 0.0, 0.04, fu.x);
  s.albedo *= 1.0 + (0.25 * lit - 0.35 * shd) * mix(0.3, 1.0, sk);
  s.normal = normalize(n + tu * (shd - lit) * 0.8 * sk);
  // Rivet rows 8 cm inside each flange (web about 1.7 m deep).
  if (fp < 0.01) {
    let rk = 1.0 - smoothstep(0.004, 0.01, fp);
    let ry = min(abs(uy - 0.08), abs(uy - 1.62));
    let rv = length(vec2f((fract(ux / 0.15) - 0.5) * 0.15, ry));
    let dot0 = 1.0 - smoothstep(0.008, 0.012, rv);
    s.albedo *= 1.0 + 0.3 * dot0 * rk;
  }
  if ((param & 0x80u) != 0u) {
    let bx = ux - (floor(ux / 12.0) * 12.0 + 6.0);
    let by = uy - 1.15;
    let board = bandF(bx, -1.2, 1.2, fu.x) * bandF(by, -0.25, 0.25, fu.y);
    let inner = bandF(bx, -1.14, 1.14, fu.x) * bandF(by, -0.19, 0.19, fu.y);
    // The white insert fills the board inside a yellow frame; the
    // numeral is 0.26 m tall with 4 cm strokes (a real clearance board is
    // meant to be read from a lorry cab 50 m back), so it holds as a
    // numeral to ~2.5 cm a pixel (the side-day street view) and only then
    // averages into the panel.
    let panel = bandF(bx, -1.06, 1.06, fu.x) * bandF(by, -0.165, 0.165, fu.y);
    var bc = mix(vec3f(0.03), vec3f(0.9, 0.7, 0.05), inner);
    bc = mix(bc, vec3f(0.86, 0.86, 0.83), panel);
    // Clearance height "4.5m" in black on the white panel, laid out to read
    // left-to-right from the side the face is seen from.
    var tu: vec3f;
    var tv: vec3f;
    uvDirs(&tu, &tv);
    let rgt = cross(-n, vec3f(0.0, 1.0, 0.0));
    let gx = select(-bx, bx, dot(tu, rgt) >= 0.0);
    let k = 0.36;
    let th = 0.11;
    let gy = -by;
    var gd = rdDigit(vec2f(gx + 0.42, gy) / k, 4u, th) * k;
    gd = min(gd, length(vec2f(gx + 0.25, gy + 0.11)) - 0.035);
    gd = min(gd, rdDigit(vec2f(gx + 0.08, gy) / k, 5u, th) * k);
    // "m": three stems under a bar (sign-stencil style), x-height 0.17 m.
    let mx = gx - 0.27;
    let st = 0.038;
    var md = min(rdSeg(vec2f(mx, gy), vec2f(-0.1, -0.13), vec2f(-0.1, 0.03)), min(rdSeg(vec2f(mx, gy), vec2f(0.0, -0.13), vec2f(0.0, 0.0)), rdSeg(vec2f(mx, gy), vec2f(0.1, -0.13), vec2f(0.1, 0.0))));
    md = min(md, rdSeg(vec2f(mx, gy), vec2f(-0.1, 0.03), vec2f(0.1, 0.03)));
    gd = min(gd, md - st);
    let gw = max(fp, 0.002);
    let glyph = (1.0 - smoothstep(-gw * 0.6, gw * 0.6, gd)) * panel;
    // Past ~6 cm a pixel the numeral averages into the panel's grey.
    let gfine = 1.0 - smoothstep(0.06, 0.12, fp);
    bc = mix(bc, vec3f(0.04), mix(0.32 * panel, glyph, gfine));
    s.albedo = mix(s.albedo, bc, board);
    s.rough = mix(s.rough, 0.5, board);
    s.metal = mix(s.metal, 0.0, board);
    s.normal = normalize(mix(s.normal, n, board));
  }
  return s;
}

// Brown glazed porcelain insulator stack: ribs every 6 cm along the tube.
fn insulatorMat(n: vec3f, uv: vec2f) -> Surf {
  var s = defaultSurf(n);
  var tu: vec3f;
  var tv: vec3f;
  uvDirs(&tu, &tv);
  let k = 1.0 - smoothstep(0.006, 0.02, uvFoot().x);
  let ph = uv.x * 6.2831853 / 0.06;
  s.normal = normalize(n + tu * sin(ph) * 0.7 * k);
  s.albedo = vec3f(0.32, 0.14, 0.07) * (1.0 - 0.3 * k * (0.5 - 0.5 * cos(ph)));
  s.rough = mix(0.15, 0.08, frame.weather.z);
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
    case M_ASPHALT: { s = junctionMat(world, n, param, aux); }
    case M_SIDEWALK: { s = sidewalkMat(world, n, uv, param, aux); }
    case M_CURB: { s = curbMat(world, n, uv); }
    case M_ROADSIGN: { s = roadSignMat(world, n, uv, param); }
    case M_HEDGE: { s = hedgeMat(world, n, uv, param, aux); }
    case M_FACADE: {
      s = facadeMat(world, n, uv, param, aux);
      // Rain soaks the wall: porous render and granite darken more than
      // glazed tile; metal sashes and glass only get the water film.
      if (s.cls != CLASS_GLASS) {
        let fam = facadeStyle(param & 0xffffu, (param >> 16u) & 7u, ((param >> 20u) & 1u) == 1u).family;
        let porous = select(select(0.8, 0.35, fam <= 1u), 0.0, s.metal > 0.5 || fam == 3u);
        // (facadeRain already set the wall's wet gloss and streaks.)
        let r0 = s.rough;
        if (rainSrc < 0.0) { applyWetness(&s, world, 0.0, porous); }
        s.rough = r0;
      }
    }
    case M_GLASS: { s = curtainWall(world, n, uv, param, aux); }
    case M_ROOF: { s = roofMat(world, n, uv, param); }
    case M_CARPARK: { s = carParkMat(world, n, uv); }
    case M_METAL: {
      s.albedo = vec3f(0.42, 0.43, 0.45);
      s.metal = 0.8;
      s.rough = 0.45;
      if (param == RAIL_STEEL || param == RAIL_WEB) {
        s = railSteel(world, n, param);
      } else if (param == GALV) {
        s = galvSteel(world, n, uv, aux);
      } else if (param == POLE_METAL) {
        s = roadPole(world, n, uv, vec3f(0.42, 0.43, 0.45), 0.8);
      } else if (param == 0u && abs(n.y) < 0.5) {
        // Bare steel uprights: weathering runs down them in vertical
        // streaks (rough 0.35-0.5), a little tone along with it.
        let st = valueNoise(vec2f(dot(world.xz, vec2f(0.7, 0.7)) * 9.0, world.y * 0.25));
        s.rough = 0.36 + 0.14 * st;
        s.albedo *= 0.94 + 0.12 * st;
        applyWetness(&s, world, 0.0, 0.0);
      } else if (param == 0u && n.y < -0.9) {
        // Steel soffit seen from below (the station platform canopy: uv in
        // metres, u along, v across): the underside of the profiled roof
        // sheet, ribs every 0.25 m running down the slope, carried on
        // purlins every 1.45 m across (dark steel with a shadowed flank),
        // each sheet its own grime, dirtier toward the open track edge.
        let fu = uvFoot();
        let rib = jointCov(uv.x / 0.25, fu.x / 0.25, 0.4);
        let sheet = hash21(vec2f(floor(uv.x / 1.0), floor(uv.y / 2.9)) + 5.0);
        var c = vec3f(0.5, 0.5, 0.48) * mix(0.88, 1.05, sheet) * (1.0 - 0.22 * rib);
        let pv = uv.y - 0.4;
        let pur = jointCov(pv / 1.45, fu.y / 1.45, 0.1 / 1.45);
        let pfl = jointCov((pv - 0.09) / 1.45, fu.y / 1.45, 0.07 / 1.45);
        c *= mix(0.88, 1.0, smoothstep(0.0, 1.5, uv.y)) * (1.0 - 0.2 * smoothstep(0.55, 0.8, valueNoise(uv * vec2f(0.5, 1.5))));
        c = mix(c, vec3f(0.22, 0.23, 0.24), pur);
        c *= 1.0 - 0.45 * pfl;
        s.albedo = c;
        s.metal = 0.3;
        s.rough = mix(0.55, 0.45, pur);
        var tu: vec3f;
        var tv: vec3f;
        uvDirs(&tu, &tv);
        let rk = 1.0 - smoothstep(0.03, 0.08, fu.x);
        let rs = sin(uv.x / 0.25 * 6.2831853);
        s.normal = normalize(n + tu * rs * 0.35 * rk);
        applyWetness(&s, world, 0.0, 0.0);
      } else if ((param & METAL_TRIM) != 0u) {
        // Building trim (canopy fascia, flashing): packMat(CM.metal,
        // METAL_TRIM | (style & 0x1fff)) paints it in frameFinish's colour.
        let fin = frameFinish(param & 0x1fffu, vec3f(0.5));
        s.albedo = fin.rgb;
        s.metal = fin.w;
        s.rough = frameRough(fin);
        applyWetness(&s, world, 0.0, 0.0);
      }
    }
    case M_SIGN: { s = signMat(world, n, uv, param); }
    case M_FOLIAGE: {
      s.albedo = leafTint(param, hashuf(aux)) * (0.7 + 0.5 * valueNoise(world.xz * 2.0 + world.y));
      s.rough = 0.85;
      // The inner crown core sits in the shade of the leaf cards around it.
      s.ao = clamp(0.3 + 0.3 * n.y, 0.0, 1.0);
      s.albedo *= 0.6;
      s.cls = CLASS_FOLIAGE;
    }
    case M_LEAVES: {
      // Filtered at the same mip as the alpha test so leaf shading does not
      // sparkle at range.
      let dx = dUvX * 256.0;
      let dy = dUvY * 256.0;
      let lod = clamp(0.5 * log2(max(dot(dx, dx), dot(dy, dy))), 0.0, 8.0);
      let l = textureSampleLevel(leafTex, linearSampler, uv, lod);
      // Per-cluster tone shift (world cell) breaks up flat single-color crowns.
      let cell = hash31(floor(world * 0.8));
      // Per-tree hue: each tree a little bluer or yellower (second hash of
      // the tree's aux, independent of the tint pick).
      let th = hashuf(aux * 0x2c1b3c6du + 0x51u) - 0.5;
      let hue = vec3f(1.0 + 0.15 * th, 1.0 + 0.08 * th, 1.0 - 0.45 * th) * vec3f(0.88, 1.0, 0.95);
      // Crown interior: cards facing away from the eye are the far side of
      // the crown seen through gaps, in its own shade (~0.5x), as are the
      // downward-facing ones.
      let vdir = normalize(frame.camPos.xyz - world);
      let inner = 1.0 - smoothstep(-0.5, 0.35, dot(n, vdir));
      // Depth into the crown: the card normals are spherical about the
      // crown centre, so the lower half and the side turned from the sun
      // (and the far side seen through gaps, `inner`) are the interior,
      // in the crown's own shade.
      let sunSide = dot(n.xz, normalize(frame.sunDir.xz + 1e-4)) * (1.0 - nightLight());
      let deep = clamp((1.0 - smoothstep(-0.6, 0.35, n.y)) * 0.7 + (1.0 - smoothstep(-0.7, 0.2, sunSide)) * 0.35 + inner * 0.3, 0.0, 1.0);
      s.albedo = leafTint(param, hashuf(aux)) * hue * (0.6 + 0.8 * l.r) * (0.85 + 0.3 * cell) * (1.0 - 0.3 * inner) * (1.0 - 0.25 * deep);
      s.rough = 0.8;
      // Leaves are never fully occluded: light scatters through the crown.
      s.ao = clamp(0.6 + 0.4 * n.y, 0.4, 1.0) * (1.0 - 0.45 * inner) * (1.0 - 0.45 * deep);
      s.cls = CLASS_FOLIAGE;
    }
    case M_BARK: { s = barkMat(world, n, uv); }
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
      if (param == 1u) {
        // LED fittings seen side-on (the viaduct coping light line, fascia
        // up-lights, soffit tubes): a brighter side term that grows with
        // distance (none within 40 m) so a 10 cm strip stays a lit line at
        // far-night.
        s.emissive += col * night * 4.0 * clamp((length(world - frame.camPos.xyz) - 40.0) / 60.0, 0.0, 4.0) * select(1.0, 0.0, n.y < -0.5);
        // Platform clock face (gen-base clock(): a 24-gon fan, uv 0..1 round
        // the centre, ~0.515 m per uv unit both ways): an analytic round
        // dark bezel inside the 24-gon rim tube, so the rim reads as a
        // circle with a smooth edge, and twelve hour ticks.
        let jx = length(dWorldX) / max(length(dUvX), 1e-6);
        let jy = length(dWorldY) / max(length(dUvY), 1e-6);
        let cq = uv - 0.5;
        let cr = length(cq);
        if (abs(n.y) < 0.3 && abs(jx - 0.515) < 0.04 && abs(jy - 0.515) < 0.04 && cr < 0.52) {
          let fw = max(length(dUvX), length(dUvY)) + 1e-4;
          let bezel = smoothstep(0.425 - fw * 0.7, 0.425 + fw * 0.7, cr);
          let ta = atan2(cq.y, cq.x) * 12.0 / 6.2831853;
          let td = abs(fract(ta + 0.5) - 0.5) * 6.2831853 / 12.0 * cr;
          let tick = (1.0 - smoothstep(0.012 - fw * 0.5, 0.012 + fw * 0.5, td)) * smoothstep(0.33 - fw, 0.34, cr) * (1.0 - bezel);
          let ink = max(bezel, tick * 0.85);
          s.albedo = mix(vec3f(0.92, 0.92, 0.9), vec3f(0.06), ink);
          s.emissive *= 1.0 - ink;
          s.rough = mix(0.2, 0.4, bezel);
        }
      }
      if (param == 2u) {
        // Aviation obstruction light: slow red blink.
        let blink = step(0.55, fract(frame.time.x * 0.6 + hash21(floor(world.xz))));
        s.albedo = vec3f(0.5, 0.05, 0.05);
        s.emissive = vec3f(1.0, 0.05, 0.02) * blink * mix(3.0, 30.0, night);
      } else if (param >= 3u && param <= 5u) {
        // Rail signal aspect (3 red, 4 green, 5 yellow), steady. The lens
        // faces sideways; the hood dims the top and the underside.
        let cols = array<vec3f, 3>(vec3f(1.0, 0.05, 0.02), vec3f(0.1, 1.0, 0.6), vec3f(1.0, 0.7, 0.05));
        let hood = mix(1.0, 0.12, smoothstep(0.3, 0.7, abs(n.y)));
        s.albedo = vec3f(0.05);
        s.rough = 0.15;
        // Bright enough to bloom into a readable point from mid range (the
        // lens is only 15 cm), as the real LED heads do at night.
        s.emissive = cols[param - 3u] * mix(10.0, 110.0, night) * hood;
        // Distance-stable: a 15 cm lens keeps a bloom-sized point to ~500 m.
        s.emissive *= clamp(length(world - frame.camPos.xyz) / 60.0, 1.0, 6.0);
      } else if (param == 8u) {
        // Long linear fittings (station canopy light boxes and tube rows,
        // packMat(CM.lamp, 8)): diffuser panels, far dimmer per area than a
        // lamp head so a canopy-length strip doesn't blow out to a white bar.
        s.albedo = vec3f(0.85);
        s.emissive = vec3f(0.95, 0.97, 1.0) * night * select(0.35, 2.0, n.y < -0.5);
      } else if (param == 6u || param == 7u) {
        // Rail viaduct fittings (packMat(CM.lamp, 6): walkway lamp heads,
        // under-deck and LOD1 soffit fluorescent quads; 7: the LED strip
        // under the parapet coping). Cool white, and distance-boosted so a
        // fitting a few pixels across still blooms into a readable dot / a
        // continuous line at far-night instead of vanishing.
        let boost = clamp(length(world - frame.camPos.xyz) / 40.0, 1.0, 8.0);
        let led = vec3f(0.85, 0.93, 1.0);
        s.albedo = vec3f(0.85);
        if (param == 6u) {
          s.emissive = led * night * (select(5.0, 45.0, n.y < -0.5)) * boost;
        } else {
          // Discrete coping fittings (one 1.2 m tube per span side): a dim
          // warm or cool LED each, so the deck edge reads as a sparse dotted
          // line at night, not a continuous neon stripe.
          let tint = mix(vec3f(1.0, 0.86, 0.66), led, step(0.4, hash21(floor(world.xz * 0.5))));
          s.emissive = tint * night * 3.5 * min(boost, 2.5);
        }
      }
    }
    case M_CONCRETE: {
      if ((param & 0xfu) != 0u) {
        s = railConcrete(world, n, uv, param, aux);
        break;
      }
      var t: vec3f;
      var b: vec3f;
      var d: vec4f;
      if (abs(n.y) < 0.7) {
        // Vertical faces: map along the face itself. The axis-aligned
        // projection stretched the detail on diagonal viaduct decks into
        // smeared, blocky bars.
        t = normalize(vec3f(-n.z, 0.0, n.x));
        b = vec3f(0.0, 1.0, 0.0);
        d = detailAt(vec2f(dot(world, t), world.y), vec2f(dot(dWorldX, t), dWorldX.y), vec2f(dot(dWorldY, t), dWorldY.y), 2.0, DETAIL_CONCRETE);
      } else {
        d = detailTri(world, n, 2.0, DETAIL_CONCRETE, &t, &b);
      }
      s.normal = detailNormal(n, t, b, d, 0.8);
      // Each precast segment (10 m) gets its own pour tone; blotches stay
      // subtle so the surface reads as concrete, not noise.
      let along = dot(world, t);
      let seg = floor(along / 10.0);
      // (No height term in the tone hash: on a graded deck floor(y / 6)
      // flips along diagonal lines and stair-stepped the side faces.)
      s.albedo = vec3f(0.5, 0.49, 0.46) * mix(0.92, 1.03, hash21(vec2f(seg, 7.0))) * (0.9 + 0.1 * fbm2(world.xz * 0.3 + world.y * 0.2)) * mix(1.0, d.b * 2.0, 0.45) * mix(0.75, 1.0, d.a);
      let foot = max(length(dWorldX), length(dWorldY));
      // Segment joints (sealed, dark) and fine formwork tie lines.
      let sj = abs(fract(along / 10.0 + 0.5) - 0.5) * 10.0;
      s.albedo *= 1.0 - 0.45 * (1.0 - smoothstep(0.015, 0.04 + foot, sj)) * clamp(0.04 / max(foot, 1e-4), 0.0, 1.0);
      let fw = fract(along / 1.8);
      let fv = fract(world.y / 0.9);
      if ((min(fw, 1.0 - fw) < 0.006 || min(fv, 1.0 - fv) < 0.01) && foot < 0.03) { s.albedo *= 0.85; }
      if (abs(n.y) < 0.5) {
        // Rain run-off: dark vertical streaks hanging from the deck edge and
        // pale efflorescence below joints.
        // Each octave fades out (to its mean) before it drops below ~3 px,
        // or distant decks alias into blocky stripes.
        let f6 = smoothstep(0.08, 0.03, foot);
        let f17 = smoothstep(0.3, 0.12, foot);
        let col = mix(0.5, valueNoise(vec2f(along * 1.7, 3.0)), f17) * 0.7 + mix(0.5, valueNoise(vec2f(along * 6.0, 9.0)), f6) * 0.3;
        let len = valueNoise(vec2f(along * 0.9, world.y * 0.05));
        // Soft, low-contrast: hard thresholds on cell noise read as blocky
        // rectangles on a 2 m deck face.
        let streak = smoothstep(0.42, 0.9, col) * smoothstep(0.2, 0.85, len) * mix(0.35, 1.0, f17);
        s.albedo *= 1.0 - 0.22 * streak;
        s.albedo = mix(s.albedo, vec3f(0.62, 0.61, 0.58), 0.25 * (1.0 - smoothstep(0.0, 0.5, sj)) * smoothstep(0.4, 0.7, len));
      } else {
        s.albedo *= 1.0 - 0.2 * smoothstep(0.55, 0.8, valueNoise(world.xz * 0.15));
      }
      if (n.y < -0.5) { s.albedo *= 0.6; }
      s.rough = 0.85;
      applyWetness(&s, world, 0.0, 0.5);
    }
    case M_RAIL: { s = railBed(world, n, uv); }
    case M_SIGNAL: {
      let lamp = param & 3u;
      let group = (param >> 2u) & 1u;
      let phase = f32((param >> 3u) & 0xffu);
      let state = signalState(frame.time.x, phase, group);
      let cols = array<vec3f, 3>(vec3f(0.1, 1.0, 0.75), vec3f(1.0, 0.75, 0.05), vec3f(1.0, 0.08, 0.04));
      s.albedo = vec3f(0.05);
      s.rough = 0.2;
      if (lamp == 3u) {
        // Pedestrian head (same group/phase as the vehicle head it serves):
        // upper red man, lower green man, which flashes during amber.
        let upper = (param & 0x800u) != 0u;
        let blink = step(0.5, fract(frame.time.x * 2.0));
        let on = select(select(0.0, blink, state == 1u) + select(0.0, 1.0, state == 0u), select(0.0, 1.0, state != 0u), upper);
        let c = select(vec3f(0.1, 1.0, 0.6), vec3f(1.0, 0.12, 0.06), upper);
        s.emissive = c * mix(0.03, mix(5.0, 12.0, night), on);
      } else if (state == lamp) { s.emissive = cols[lamp] * mix(6.0, 14.0, night); } else { s.emissive = cols[lamp] * 0.03; }
    }
    case M_FRAME: { s.albedo = vec3f(0.08); s.metal = 0.6; s.rough = 0.4; }
    case M_PAINT: {
      s.albedo = paintColor(param);
      s.rough = 0.5;
      s.metal = 0.1;
      // Service fixtures (steel grey, black plates, meters, pipes, AC
      // units): weathered, matte paint. At 0.5 a grazing golden-hour sun lit
      // them up near-white against the wall.
      if (param == 0x90u || param == 0x91u || (param >= 0xd0u && param < 0xf0u)) { s.rough = 0.7; }
      if (param == POLE_PAINT) {
        s = roadPole(world, n, uv, paintColor(0x90u), 0.15);
      } else if ((param & ~0xffu) == PAINT_STEEL) {
        s = paintedSteel(world, n, param);
      } else if ((param & ~0xffu) == RAIL_GIRDER) {
        s = railGirder(world, n, uv, param);
      } else if (param == INSULATOR) {
        s = insulatorMat(n, uv);
      } else if (param == 0xd1u) {
        s = frpTank(world, n, uv);
      } else if ((param == 0xd0u || param == 0xd7u) && abs(n.y) < 0.5) {
        // Pale painted sheet steel (station canopy fascias: CANOPY_FASCIA
        // 0xd7; plant boxes, AC units, bins: 0xd0): 1.8 m panels with a lit / shadowed cover-strip
        // seam, each panel its own tone and sheen, faint rain streaks down
        // the face (world space) and a dark drip line along the uv.y = 0
        // edge (the canopy fascia's top lip; a box's foot).
        var tu: vec3f;
        var tv: vec3f;
        uvDirs(&tu, &tv);
        let fu = uvFoot();
        let fp = railFoot();
        let pi = floor(uv.x / 1.8);
        let hp = hash21(vec2f(pi, floor(world.y * 0.25)) + floor(world.xz * 0.02));
        let sq = (fract(uv.x / 1.8 + 0.5) - 0.5) * 1.8;
        let lit = bandF(sq, -0.025, 0.0, fu.x);
        let shd = bandF(sq, 0.0, 0.02, fu.x);
        let sk = 1.0 - smoothstep(0.02, 0.06, fu.x);
        let horiz = normalize(vec2f(-n.z, n.x) + vec2f(1e-4, 0.0));
        let hp2 = dot(world.xz, horiz);
        let streak = smoothstep(0.55, 0.85, valueNoise(vec2f(hp2 * 6.0, world.y * 0.9))) * (1.0 - smoothstep(0.02, 0.08, fp)) + 0.25 * smoothstep(0.5, 0.8, valueNoise(vec2f(hp2 * 0.8, world.y * 0.3)));
        // (Canopy fascia: panel value +-2.5 %, gone once a panel is
        // foreshortened, and one roughness: per-panel tone and sheen read as
        // a band of peach / grey / white tiles from the train at grazing.)
        let cf = param == 0xd7u;
        let pv = select(mix(0.93, 1.05, hp), mix(1.0, mix(0.975, 1.025, hp), 1.0 - smoothstep(0.05, 0.2, fu.x)), cf);
        var c = paintColor(0xd0u) * pv * (1.0 - 0.14 * streak);
        c *= 1.0 + (0.18 * lit - 0.3 * shd) * mix(0.4, 1.0, sk);
        c *= 1.0 - 0.45 * bandF(uv.y, -1.0, 0.025, fu.y);
        s.albedo = c;
        s.normal = normalize(n + tu * (shd - lit) * 0.6 * sk);
        s.rough = select(mix(0.45, 0.72, fract(hp * 13.0)), 0.62, cf) + 0.1 * streak;
      } else if (param == 0xd2u) {
        // SKYLIGHT: twin-wall polycarbonate strip on the canopy roof. Milky
        // pale and glossy, faint 0.1 m ribs along u, dust silting against
        // the low edge and in the ribs, and the canopy lights glowing
        // through it at night.
        var tu: vec3f;
        var tv: vec3f;
        uvDirs(&tu, &tv);
        let fu = uvFoot();
        let k = 1.0 - smoothstep(0.012, 0.035, fu.x);
        let rp = uv.x * 62.831853;
        s.normal = normalize(n + tu * cos(rp) * 0.2 * k);
        let dust = 0.6 + 0.4 * valueNoise(world.xz * 1.3);
        s.albedo = vec3f(0.6, 0.65, 0.66) * (1.0 - 0.12 * k * (0.5 - 0.5 * sin(rp))) * mix(1.0, 0.78, 0.4 * dust);
        s.albedo = mix(s.albedo, vec3f(0.32, 0.3, 0.26), 0.35 * smoothstep(0.6, 0.85, valueNoise(world.xz * 0.6 + 3.0)));
        s.rough = mix(0.12, 0.3, dust * 0.6);
        s.metal = 0.0;
        if (n.y > 0.5) {
          s.emissive = vec3f(0.9, 0.95, 1.0) * nightLight() * 0.6 * (0.8 + 0.2 * dust);
        }
      } else if (param == 0xf8u) {
        // Corrugated steel sheet (ribs every 20 cm along u), band-limited by
        // the footprint along u: the ribs are gone before their period
        // drops under ~3.5 px (the old 1/x falloff never reached zero and
        // the station canopy moired), and the lobe they would have spread
        // the highlight into comes back as roughness.
        var tu: vec3f;
        var tv: vec3f;
        uvDirs(&tu, &tv);
        let k = 1.0 - smoothstep(0.025, 0.06, uvFoot().x);
        let rib = sin(uv.x * 31.4159);
        s.normal = normalize(n + tu * cos(uv.x * 31.4159) * 0.45 * k);
        s.albedo = vec3f(0.5, 0.52, 0.53) * (0.9 + 0.1 * rib * k) * (0.85 + 0.15 * valueNoise(uv * vec2f(0.5, 2.0)));
        s.metal = 0.3;
        s.rough = mix(0.62, 0.5, k);
        if (n.y > 0.5) {
          // Roof top: 0.9 m sheets, each its own weathering, dark lap
          // lines between them, and grime silting along the low edge.
          // (Station canopy: u along the platform, v up the slope from the
          // low track-side edge.) Dust lies in the rib valleys, so the ribs
          // keep a fine stripe out to where they fade; dirt washes down the
          // slope in streaks from the high edge and from each purlin's
          // fixing row (rust blooms on the screw heads); the low edge is a
          // box gutter full of silt and moss with a bright folded lip.
          let fu = uvFoot();
          let fp = railFoot();
          // (Sheet and bay identity from the world position too: uv.x
          // restarts at every bay, so a pure uv hash repeats each 12 m.)
          let bayN = valueNoise(world.xz * 0.07 + 11.0);
          let sh = hash21(vec2f(floor(uv.x / 0.9), floor(bayN * 6.0) + 3.0));
          // (Per-sheet tone kept small: foreshortened from the train, +-14 %
          // sheets read as a checkerboard of tiles.)
          s.albedo *= mix(0.99, mix(0.97, 1.02, sh), (1.0 - smoothstep(0.08, 0.3, fu.x)) * (1.0 - smoothstep(0.05, 0.16, fu.y))) * mix(0.95, 1.05, bayN) * (1.0 - 0.4 * jointCov(uv.x / 0.9, fu.x / 0.9, 0.04 / 0.9));
          // Standing seams at each sheet lap: a raised rib that keeps a lit
          // crest and a shadow line out to where the corrugation has gone.
          {
            let sq = (fract(uv.x / 0.9 + 0.5) - 0.5) * 0.9;
            let sk = 1.0 - smoothstep(0.02, 0.08, fu.x);
            let crest = bandF(sq, -0.03, 0.0, fu.x);
            let shade = bandF(sq, 0.0, 0.035, fu.x);
            s.albedo *= 1.0 + (0.3 * crest - 0.3 * shade) * mix(0.35, 1.0, sk);
            s.normal = normalize(s.normal + tu * (shade - crest) * 0.7 * sk);
          }
          let ribV = 1.0 - smoothstep(0.03, 0.09, fu.x);
          s.albedo *= 1.0 - 0.18 * mix(0.5, smoothstep(0.2, 0.9, -rib), ribV);
          // Weathered coated steel, ~0.43 (it was ~0.5 and, glossy and
          // metallic at the train's grazing view, read near-white).
          s.albedo *= 0.86;
          // Cross ribs / sheet laps every 0.5 m down the slope: a step with a
          // lit up-slope crest and a shadowed foot, painted into the albedo
          // only (a normal tilt aliased into blocks of sky at grazing). Spaced
          // in v they run along the platform, so from the
          // train they are long lines toward the vanishing point, not
          // foreshortened ticks; they fade to a mean as they drop under
          // ~3 px.
          {
            let lv = uv.y / 0.5;
            let lq = (fract(lv) - 0.5) * 0.5;
            let lk = 1.0 - smoothstep(0.05, 0.16, fu.y);
            let lcrest = bandF(lq, 0.17, 0.25, fu.y);
            let lfoot = bandF(lq, -0.25, -0.15, fu.y);
            s.albedo *= 1.0 + (0.22 * lcrest - 0.3 * lfoot) * mix(0.25, 1.0, lk) - 0.04 * (1.0 - lk);
          }
          let cell = floor(uv.x / 0.9);
          var ds = 0.0;
          for (var j = 0u; j < 5u; j++) {
            let y0 = select(0.4 + f32(j - 1u) * 1.45, 5.75, j == 0u);
            let hq = hashu((u32(i32(cell) + 65536) * 0x9e37u) ^ (j * 0x51u + 0x77u));
            if (j > 0u && hashuf(hq) < 0.5) { continue; }
            let xq = (cell + mix(0.15, 0.85, hashuf(hq ^ 1u))) * 0.9;
            ds = max(ds, mix(0.5, 1.0, hashuf(hq ^ 2u)) * fanStreak(uv.x, y0 - uv.y, xq, 0.0, mix(0.15, 0.45, hashuf(hq ^ 3u)), mix(0.8, 3.5, hashuf(hq ^ 4u)), f32(hq & 0xffu), fp));
          }
          // Along u (the train's view direction) these per-sheet terms are
          // foreshortened to a few px per metre: past ~0.1 m of u a pixel
          // they fall to their mean, or they alias into staggered blocks.
          // (Round 8: and once v (up the slope) is foreshortened too: from
          // the train v is ~0.4 m a pixel, and the per-sheet streaks and
          // rust blooms collapsed into a band of peach / grey tiles.)
          let uk = (1.0 - smoothstep(0.08, 0.3, fu.x)) * (1.0 - smoothstep(0.05, 0.16, fu.y));
          // (Round 8: value only, <= ~25 %: the per-sheet streaks and rust
          // read as a band of peach / grey / white tiles along the canopy
          // from the train.)
          s.albedo *= 1.0 - 0.28 * mix(0.12, ds, uk);
          // Broad wash of grime toward the gutter (all the run-off from the
          // slope above drains over the low half), streaky along u, so it
          // holds when the streaks themselves are sub-pixel.
          s.albedo *= 1.0 - 0.22 * (1.0 - smoothstep(0.4, 3.6, uv.y)) * (0.6 + 0.4 * mix(0.5, valueNoise(vec2f(uv.x * 1.3, uv.y * 0.3) + bayN * 7.0), uk));
          let pv = uv.y - 0.4;
          let fix = jointCov(pv / 1.45, fu.y / 1.45, 0.05 / 1.45) * step(0.0, pv);
          let rs = mix(0.12, smoothstep(0.55, 0.8, valueNoise(vec2f(uv.x * 4.0, uv.y * 1.3) + 7.0)), uk);
          // (Round 8: the rust blooms only where the sheets resolve; at the
          // train's grazing view they were a band of peach / grey / white
          // tiles along the canopy edge. Value-only past that, +-5 %.)
          let rsk = 0.5 * max(rs * 0.6, fix * rs * 1.5);
          s.albedo = mix(s.albedo, s.albedo * vec3f(0.86, 0.8, 0.74), rsk);
          // Sheet-wise metal sheen: each sheet's coating weathered its own
          // way (rough 0.32-0.65), so the roof glints unevenly at grazing.
          // (0.4-0.78 and only 0.25 metal: a glossier, more metallic coat
          // mirrored the bright sky over the whole roof at grazing; now a
          // few sheets catch a soft sky highlight and the rest stay grey.)
          // (Mostly a smooth world-space field: a per-sheet roughness lit
          // up the roof as a checkerboard of reflected sky at grazing.)
          s.rough = mix(0.42, 0.78, valueNoise(world.xz * 0.22 + 5.0));
          s.metal = 0.25;
          // Bird droppings: white splats along the high edge (perches on
          // the ridge and the vents) and the purlin fixing rows, clustered,
          // averaging into a faint whitening at range.
          {
            let bc = floor(vec2f(uv.x, uv.y) / 0.16);
            let hb = hash21(bc + floor(bayN * 9.0) * 7.3);
            let perch = smoothstep(4.6, 5.5, uv.y) + 0.5 * (1.0 - smoothstep(0.0, 0.25, abs(fract((uv.y - 0.4) / 1.45 + 0.5) - 0.5) * 1.45));
            let dens = clamp(perch * smoothstep(0.3, 0.75, valueNoise(vec2f(uv.x * 0.6, uv.y * 0.4) + floor(bayN * 5.0))), 0.0, 1.0);
            let bp = (bc + 0.25 + 0.5 * vec2f(hb, fract(hb * 31.0))) * 0.16;
            let br = mix(0.012, 0.035, fract(hb * 57.0));
            let dd = length((vec2f(uv.x, uv.y) - bp) * vec2f(1.0, 0.8)) + 0.006 * (valueNoise(vec2f(uv.x, uv.y) * 90.0) - 0.5);
            let bw = max(fp, 1e-3);
            let splat = (1.0 - smoothstep(br - bw * 0.5, br + bw, dd)) * min(1.0, br * br / (bw * bw) * 2.0) * step(hb, dens * 0.6);
            s.albedo = mix(s.albedo, vec3f(0.78, 0.77, 0.72), 0.85 * splat);
            s.albedo = mix(s.albedo, vec3f(0.7, 0.69, 0.65), 0.06 * dens);
            s.rough = mix(s.rough, 0.9, splat);
          }
          // At the train's grazing view (round 8) the sheet / streak /
          // dropping detail stacks up into a band of light and dark tiles:
          // there the roof falls to its mean tone, with a soft long-wave
          // +-5 % along the platform.
          {
            let gz = smoothstep(0.03, 0.2, abs(dot(normalize(frame.camPos.xyz - world), n)));
            let mean = vec3f(0.35, 0.355, 0.355) * (0.95 + 0.1 * valueNoise(vec2f(world.x + world.z, 1.0) * 0.15));
            s.albedo = mix(mean, s.albedo, gz);
          }
          let silt = 1.0 - smoothstep(0.25, 1.0 + 0.6 * valueNoise(vec2f(uv.x * 1.5, 1.0)), uv.y);
          s.albedo = mix(s.albedo, vec3f(0.2, 0.19, 0.16), 0.5 * silt);
          // Gutter (bottom 0.22 m): dark silt and moss, a pale lip.
          let gut = 1.0 - smoothstep(0.2, 0.2 + fu.y, uv.y);
          let moss = smoothstep(0.4, 0.7, valueNoise(vec2f(uv.x * 2.0, 3.0)));
          s.albedo = mix(s.albedo, mix(vec3f(0.08, 0.075, 0.065), vec3f(0.1, 0.14, 0.06), moss), gut);
          s.albedo = mix(s.albedo, vec3f(0.55, 0.56, 0.56), bandF(uv.y, 0.0, 0.04, fu.y));
          s.normal = normalize(mix(s.normal, n, gut));
          s.rough = mix(s.rough, 0.85, max(gut, ds * 0.5));
          s.metal = mix(s.metal, 0.0, gut);
          // Standing-seam tents (geometry, 45-degree flanks every 0.9 m):
          // at the train's grazing view their eye-facing flanks fill the
          // roof, and each flank's own sun / sky-reflection shading made a
          // band of peach / grey / white tiles (round 8). Shade them close
          // to the roof plane, one roughness, so they keep their ridge
          // silhouette and only a +-5 % value step.
          if (n.y < 0.95) {
            s.normal = normalize(vec3f(n.x * 0.25, 1.0, n.z * 0.25));
            s.rough = 0.62;
            s.metal = 0.15;
          }
        }
      }
      applyWetness(&s, world, 0.0, 0.0);
      // Painted fixtures under a water film: a shade darker (and glossy).
      s.albedo *= 1.0 - 0.18 * frame.weather.z;
    }
    case M_SCREEN: { s = screenMat(n, uv, param); }
    case M_TILE: {
      let h = hashu(param * 13u + 1u);
      let cols = array<vec3f, 4>(vec3f(0.12, 0.13, 0.16), vec3f(0.35, 0.18, 0.12), vec3f(0.18, 0.22, 0.3), vec3f(0.3, 0.3, 0.3));
      s.albedo = cols[h % 4u] * (0.8 + 0.2 * step(0.5, fract(uv.y * 4.0)));
      s.rough = 0.55;
      applyWetness(&s, world, 0.0, 0.0);
    }
    case M_WIRE: {
      s.albedo = vec3f(0.02);
      s.rough = 0.6;
      // Overhead line: aged copper contact wire (glints at golden hour) and
      // galvanised steel messenger / feeders / droppers.
      if (param == 1u) {
        s.albedo = vec3f(0.30, 0.20, 0.14);
        s.metal = 0.9;
        s.rough = mix(0.35, 0.2, frame.weather.z);
      } else if (param == 2u) {
        s.albedo = vec3f(0.22);
        s.metal = 0.8;
        s.rough = mix(0.45, 0.25, frame.weather.z);
      }
    }
    case M_VENDING: {
      let body = array<vec3f, 3>(vec3f(0.75, 0.08, 0.06), vec3f(0.08, 0.2, 0.6), vec3f(0.85));
      let bc = body[(param & 0xffu) % 3u];
      s.albedo = bc;
      s.rough = 0.4;
      // The platform machines are boxes with metre UVs on every face; only
      // their display front quad (VENDING_FRONT 0x300) carries the window
      // (0x100 / 0x200 would mark a separate lower door / header box, uv.y
      // from its own bottom). The street machine's mesh is unflagged but
      // its display quad is not metre-scaled, so the isometry test keeps
      // its window and leaves the platform boxes' sides plain.
      let vf = param & 0x300u;
      var vuv = uv;
      if (vf == 0x200u) { vuv.y += 1.5; }
      let jx = length(dUvX) / max(length(dWorldX), 1e-6);
      let jy = length(dUvY) / max(length(dWorldY), 1e-6);
      let plain = vf == 0u && abs(jx - 1.0) < 0.03 && abs(jy - 1.0) < 0.03;
      let vside = abs(n.y) < 0.5 && !plain;
      if (plain && abs(n.y) < 0.5) {
        // Plain cabinet side: a pressed seam every 0.9 m (the face edges)
        // and a little dust toward the foot.
        let fu = uvFoot();
        let seam = jointCov(uv.x / 0.9, fu.x / 0.9, 0.012 / 0.9);
        s.albedo = bc * (1.0 - 0.25 * seam) * mix(0.9, 1.0, smoothstep(0.0, 0.4, uv.y));
        s.rough = 0.45;
      }
      // Plain box machines (the station platform's: box UV, v = metres up,
      // 0..1.8): the street machine's mesh carries its slot, coin panel and
      // header as geometry (its unlit parts keep v = 5), so they are
      // painted here for v under 0.7 and over 1.5 only.
      if (vside && vuv.y >= 1.5 && vuv.y < 1.78) {
        // Lit header: a white light box with the brand's colour blocks.
        let hb = bandF(vuv.y, 1.54, 1.74, 0.01) * step(0.04, fract(vuv.x / 0.9) * 0.9) * step(fract(vuv.x / 0.9) * 0.9, 0.86);
        // Brand light box: a colour field with a white wordmark (four
        // chunky glyphs) and a round logo at the left.
        let hu = fract(vuv.x / 0.9) * 0.9;
        let foot = max(length(dWorldX), length(dWorldY));
        let gk = 1.0 - smoothstep(0.006, 0.016, foot);
        let gx = (hu - 0.26) / 0.13;
        let gi = floor(gx);
        let wm = fauxKanji(vec2f(fract(gx) - 0.5, (vuv.y - 1.64) / 0.11) * vec2f(1.15, 1.0), hashu((param & 0xffu) * 0x9e37u + u32(gi + 2.0))) * step(0.0, gx) * step(gi, 3.0);
        let disc = 1.0 - smoothstep(0.045, 0.045 + foot, length(vec2f(hu - 0.15, vuv.y - 1.64)));
        let logo = mix(0.35 * step(0.0, gx) * step(gi, 3.0) * bandF(vuv.y, 1.59, 1.69, 0.01), wm, gk) + disc * 0.8;
        let bi = (param & 0xffu) % 3u;
        let field = select(vec3f(0.93), vec3f(0.85, 0.08, 0.06), bi == 2u);
        let ink = select(select(vec3f(0.85, 0.08, 0.06), vec3f(0.06, 0.2, 0.7), bi == 1u), vec3f(0.95), bi == 2u);
        var hc = mix(field, ink, clamp(logo, 0.0, 1.0));
        s.albedo = mix(s.albedo, hc * 0.8, hb);
        s.emissive = hc * hb * mix(0.5, 2.2, gloomLight());
      } else if (vside && vuv.y > 0.08 && vuv.y <= 0.7) {
        let lu = fract(vuv.x / 0.9) * 0.9;
        // Dispenser flap: a dark recessed slot with a grey flap and a
        // bright lower lip; the coin / bill / card panel on the right
        // with its small lit price display and a coin-return cup.
        let slot = bandF(vuv.y, 0.14, 0.34, 0.01) * bandF(lu, 0.08, 0.6, 0.01);
        var c = mix(s.albedo, vec3f(0.035), slot);
        c = mix(c, vec3f(0.22, 0.22, 0.23), bandF(vuv.y, 0.17, 0.31, 0.01) * bandF(lu, 0.1, 0.58, 0.01) * 0.85);
        c = mix(c, vec3f(0.65), bandF(vuv.y, 0.135, 0.15, 0.01) * bandF(lu, 0.08, 0.6, 0.01));
        let pan = bandF(vuv.y, 0.4, 0.68, 0.01) * bandF(lu, 0.64, 0.84, 0.01);
        c = mix(c, vec3f(0.16, 0.16, 0.17), pan);
        c = mix(c, vec3f(0.02), (bandF(vuv.y, 0.6, 0.64, 0.005) * bandF(lu, 0.7, 0.72, 0.005) + bandF(vuv.y, 0.5, 0.54, 0.005) * bandF(lu, 0.68, 0.8, 0.005)) * pan);
        c = mix(c, vec3f(0.05), bandF(vuv.y, 0.16, 0.26, 0.01) * bandF(lu, 0.68, 0.8, 0.01));
        let disp = bandF(vuv.y, 0.44, 0.48, 0.005) * bandF(lu, 0.67, 0.81, 0.005);
        c = mix(c, vec3f(0.05), disp);
        s.albedo = c;
        s.emissive = vec3f(1.0, 0.25, 0.05) * disp * step(0.5, fract(lu * 60.0)) * mix(0.6, 2.0, gloomLight());
        s.rough = mix(0.4, 0.6, slot + pan);
      }
      if (vside && vf == 0x300u && vuv.y > 0.7 && vuv.y < 1.5) {
        let vw = vendingWindow(n, vuv, select(vec3f(0.85, 0.08, 0.06), vec3f(0.06, 0.2, 0.7), (param & 0xffu) % 3u == 1u), param & 0xffu);
        s.albedo = vw.albedo;
        s.emissive = vw.emissive;
        s.rough = vw.rough;
      } else if (vside && vuv.y > 0.7 && vuv.y < 1.5 && fract(vuv.x * 4.0) > 0.1) {
        // Display window: four rows of sample drinks (cans and PET
        // bottles) silhouetted against the lit white backing, each row over
        // a dark strip of lit selection buttons.
        let foot = max(length(dWorldX), length(dWorldY));
        let ry = fract((vuv.y - 0.7) / 0.2) * 0.2;
        let row = floor((vuv.y - 0.7) / 0.2) + f32(param * 7u);
        var c: vec3f;
        if (ry < 0.035) {
          let btn = step(0.6, fract(vuv.x / 0.083 + 0.5)) * step(0.012, ry) * step(ry, 0.025);
          s.albedo = vec3f(0.05);
          c = mix(vec3f(0.02), vec3f(0.3, 1.0, 0.4), btn * (1.0 - smoothstep(0.004, 0.012, foot)));
        } else {
          let g = shelfGoods(vuv.x, ry + 0.005, 0.2, row, true, foot);
          // (The backing a softer white so the cans' colours carry the read
          // rather than a glaring white window grid.)
          s.albedo = mix(vec3f(0.7), g.rgb, min(g.w * 1.4, 1.0));
          c = mix(vec3f(0.45, 0.48, 0.52), g.rgb * 1.1, min(g.w * 1.4, 1.0));
        }
        s.emissive = c * mix(0.8, 3.0, gloomLight());
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
