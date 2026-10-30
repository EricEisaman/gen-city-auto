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
  s.albedo = mix(s.albedo, vec3f(0.045), tar * 0.6);
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
fn signMat(n: vec3f, uv: vec2f, param: u32) -> Surf {
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

// Shop signs: the atlas cell holds masks (R lettering, G frame ring and
// letter outlines, B bevel height; src/render/sign-atlas.ts), painted in one
// of the SIGN_WAYS colourways (src/city/signs.ts) picked by the id and the
// building's offset in param bits 10-13.
fn shopSign(
  s0: Surf, n: vec3f, m: vec3f, px: vec2f, dx: vec2f, dy: vec2f, lod: f32,
  rect: vec4f, id: u32, param: u32, fabric: bool,
) -> Surf {
  var s = s0;
  let w = SIGN_WAYS[(id * 5u + ((param >> 10u) & 15u)) & 15u];
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
  s.emissive = c * mix(1.2, 2.6, gloomLight());
  return s;
}

// Street tree species (src/city/gen-tile.ts TREE): 0 zelkova (green),
// 1 ginkgo (yellow-green, some trees turned gold), 2 columnar (dark
// blue-green). h varies the tone per tree.
fn leafTint(species: u32, h: f32) -> vec3f {
  switch (species) {
    case 1u: {
      let gold = step(0.6, h);
      return mix(mix(vec3f(0.16, 0.2, 0.035), vec3f(0.26, 0.27, 0.04), h / 0.6),
                 mix(vec3f(0.42, 0.32, 0.03), vec3f(0.5, 0.38, 0.05), (h - 0.6) / 0.4), gold);
    }
    case 2u: { return mix(vec3f(0.045, 0.1, 0.045), vec3f(0.08, 0.15, 0.06), h); }
    default: { return mix(vec3f(0.07, 0.15, 0.035), vec3f(0.17, 0.24, 0.06), h); }
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
const METAL_TRIM = 0x2000u;
fn paintedSteel(world: vec3f, n: vec3f, param: u32) -> Surf {
  var s = defaultSurf(n);
  let seed = param & 0xffu;
  let cols = array<vec3f, 4>(vec3f(0.11, 0.065, 0.045), vec3f(0.3, 0.31, 0.31), vec3f(0.6, 0.56, 0.46), vec3f(0.07, 0.14, 0.1));
  let paint = cols[seed & 3u] * mix(0.9, 1.1, hashuf(seed * 0x9e37u));
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
      if ((param & METAL_TRIM) != 0u) {
        // Building trim (canopy fascia, flashing): packMat(CM.metal,
        // METAL_TRIM | (style & 0x1fff)) paints it in frameFinish's colour.
        let fin = frameFinish(param & 0x1fffu, vec3f(0.5));
        s.albedo = fin.rgb;
        s.metal = fin.w;
        s.rough = frameRough(fin);
        applyWetness(&s, world, 0.0, 0.0);
      }
    }
    case M_SIGN: { s = signMat(n, uv, param); }
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
      s.albedo = leafTint(param, hashuf(aux)) * (0.6 + 0.8 * l.r) * (0.85 + 0.3 * cell);
      s.rough = 0.8;
      // Leaves are never fully occluded: light scatters through the crown.
      s.ao = clamp(0.6 + 0.4 * n.y, 0.45, 1.0);
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
    case M_PAINT: {
      s.albedo = paintColor(param);
      s.rough = 0.5;
      s.metal = 0.1;
      // Service fixtures (steel grey, black plates, meters, pipes, AC
      // units): weathered, matte paint. At 0.5 a grazing golden-hour sun lit
      // them up near-white against the wall.
      if (param == 0x90u || param == 0x91u || (param >= 0xd0u && param < 0xf0u)) { s.rough = 0.7; }
      if ((param & ~0xffu) == PAINT_STEEL) {
        s = paintedSteel(world, n, param);
      } else if (param == 0xd1u) {
        s = frpTank(world, n, uv);
      } else if (param == 0xf8u) {
        // Corrugated steel sheet (ribs every 20 cm along u), faded to flat
        // once a rib is smaller than a pixel.
        let T = normalize(dWorldX * dUvY.y - dWorldY * dUvX.y + vec3f(1e-6));
        let k = clamp(0.08 / max(length(dUvX) + length(dUvY), 1e-4), 0.0, 1.0);
        let rib = sin(uv.x * 31.4159);
        s.normal = normalize(n + T * cos(uv.x * 31.4159) * 0.45 * k);
        s.albedo = vec3f(0.5, 0.52, 0.53) * (0.9 + 0.1 * rib * k) * (0.85 + 0.15 * valueNoise(uv * vec2f(0.5, 2.0)));
        s.metal = 0.3;
        s.rough = 0.5;
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
    case M_WIRE: { s.albedo = vec3f(0.02); s.rough = 0.6; }
    case M_VENDING: {
      let body = array<vec3f, 3>(vec3f(0.75, 0.08, 0.06), vec3f(0.08, 0.2, 0.6), vec3f(0.85));
      s.albedo = body[param % 3u];
      s.rough = 0.4;
      if (uv.y > 0.7 && uv.y < 1.5 && fract(uv.x * 4.0) > 0.1) {
        // Display window: four rows of sample drinks (cans and PET
        // bottles) silhouetted against the lit white backing, each row over
        // a dark strip of lit selection buttons.
        let foot = max(length(dWorldX), length(dWorldY));
        let ry = fract((uv.y - 0.7) / 0.2) * 0.2;
        let row = floor((uv.y - 0.7) / 0.2) + f32(param * 7u);
        var c: vec3f;
        if (ry < 0.035) {
          let btn = step(0.6, fract(uv.x / 0.083 + 0.5)) * step(0.012, ry) * step(ry, 0.025);
          s.albedo = vec3f(0.05);
          c = mix(vec3f(0.02), vec3f(0.3, 1.0, 0.4), btn * (1.0 - smoothstep(0.004, 0.012, foot)));
        } else {
          let g = shelfGoods(uv.x, ry + 0.005, 0.2, row, true, foot);
          s.albedo = mix(vec3f(0.85), g.rgb, g.w);
          c = mix(vec3f(0.9, 0.95, 1.0), g.rgb * 0.7, g.w);
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
