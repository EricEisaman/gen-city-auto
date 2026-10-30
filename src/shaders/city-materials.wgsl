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
  let night = nightLight();
  var lit: bool;
  if (office) {
    let sectionLit = hashuf(section ^ 0xbeefu) < mix(0.1, 0.6, night);
    lit = hashuf(seed ^ 0x1234567u) < select(0.08, 0.72, sectionLit);
  } else {
    lit = hashuf(seed ^ 0x1234567u) < mix(0.04, 0.6, night);
  }
  if (!lit) { return vec3f(0.0); }
  let r2 = hashuf(seed ^ 0x5bd1u);
  let k = mix(0.12, 1.0, night);
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
  var light = vec3f(luminance(frame.skyAmbient.rgb)) * vec3f(1.0, 0.95, 0.88) * 0.14;
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
  let amb = vec3f(luminance(frame.skyAmbient.rgb)) * vec3f(1.0, 0.96, 0.9) * 0.13;
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
      let open = mix(0.06, 0.55, h3);
      let fs = 1.0 - smoothstep(0.012, 0.035, foot);
      let slat = mix(1.0 - open, step(open, fract(p.y / 0.05)), fs);
      let col = select(vec3f(0.8, 0.8, 0.78), vec3f(0.75, 0.68, 0.55), hashuf(seed ^ 0x3a3u) < 0.3);
      let rad = col * (amb + back * 0.5) * mix(0.9, 0.75 + 0.25 * fract(p.y / 0.05), fs);
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

// Ground-floor tenancy behind the base's big lights: a small restaurant or
// shop (warm light, a counter with staff, menu boards and pendant lamps), a
// cool-lit office, or a dark, closed unit. Returns radiance.
fn shopInterior(local0: vec2f, size: vec2f, N: vec3f, T: vec3f, V: vec3f, seed: u32, foot: f32) -> vec3f {
  // Heights below are from the shop floor, 0.6 m under the glass.
  let local = local0 + vec2f(0.0, 0.6);
  let night = nightLight();
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

// Per-building window sash: anodised aluminium, silver (55 %), bronze (30 %)
// or white (15 %). Dark walls always get a light sash so the window grid
// still reads.
fn sashColor(style: u32, wall: vec3f) -> vec3f {
  let k = hashuf(hashu(style * 2654435761u + 9u));
  var c = select(select(vec3f(0.75, 0.75, 0.73), vec3f(0.34, 0.27, 0.2), k < 0.85), vec3f(0.55, 0.56, 0.57), k < 0.55);
  if (luminance(wall) < 0.2 && k >= 0.55 && k < 0.85) { c = vec3f(0.55, 0.56, 0.57); }
  return c;
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
// bright lobby (stone back wall, mailbox bank, downlights).
fn facadeLobby(uv: vec2f, n: vec3f, T: vec3f, V: vec3f) -> Surf {
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
    s.albedo = vec3f(0.55, 0.56, 0.57);
    s.metal = 0.8;
    s.rough = 0.3;
    return s;
  }
  let night = nightLight();
  let ndv = max(-dot(V, n), 0.05);
  let q = vec2f(lx, ly) + vec2f(dot(V, T), V.y) / ndv * 4.0;
  var c = vec3f(0.72, 0.68, 0.62);
  if (q.y < 0.0) { c = vec3f(0.32, 0.3, 0.28); }
  if (q.y > top) {
    c = vec3f(0.8);
    if (length(vec2f(fract(q.x / 1.2) - 0.5, q.y - top - 0.6)) < 0.12) { c = vec3f(6.0); }
  }
  if (q.y > 0.9 && q.y < 1.8 && fract(q.x / 4.0) < 0.35) {
    c = vec3f(0.5, 0.52, 0.55) * (0.75 + 0.25 * step(0.08, fract(q.y / 0.3)));
  }
  let light = vec3f(1.0, 0.92, 0.8) * (luminance(frame.skyAmbient.rgb) * 0.3 + night * 0.7);
  let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(V, n)), 5.0);
  s.albedo = vec3f(0.02);
  s.rough = 0.05;
  s.emissive = c * light * (1.0 - fres);
  s.cls = CLASS_GLASS;
  return s;
}

// Party wall on the lot line: exposed concrete block or a skim-coated
// render, dark waterproofing patches over cracks, steel tie-rod plates at the
// slabs with rust bleeding below, at most one vent, and often the ghost of a
// demolished shorter neighbour: the wall it covered is cleaner and lighter
// below its stepped roof profile, edged by the old dark flashing line.
fn partyWall(s: ptr<function, Surf>, uv: vec2f, aux: u32) {
  let foot = max(length(dWorldX), length(dWorldY));
  let fFine = 1.0 - smoothstep(0.02, 0.06, foot);
  var a = (*s).albedo;
  (*s).sunVis = 1.0;
  if (hashuf(aux ^ 0x9a1u) < 0.5) {
    // 390 x 190 mm blocks in running bond.
    let row = floor(uv.y / 0.2);
    let g = vec2f(uv.x / 0.4 + 0.5 * (row - 2.0 * floor(row * 0.5)), uv.y / 0.2);
    let f = abs(fract(g) - 0.5) * vec2f(0.4, 0.2);
    let d = min(0.2 - f.x, 0.1 - f.y);
    let joint = (1.0 - smoothstep(0.004, 0.004 + foot * 1.5, d)) * clamp(0.008 / max(foot, 1e-4), 0.0, 1.0);
    a *= mix(1.0, 0.9 + 0.2 * hash21(floor(g) + f32(aux & 255u)), fFine) * (1.0 - 0.3 * joint);
    (*s).rough = 0.92;
  } else {
    // Skim coat: trowel patches.
    a *= 0.93 + 0.14 * valueNoise(uv * vec2f(0.9, 1.6) + 5.0);
    (*s).rough = 0.85;
  }
  let gh = hashuf(aux ^ 0x6057u);
  if (gh < 0.7) {
    let h0 = mix(4.5, 8.5, hashuf(aux ^ 0x6058u));
    let segW = mix(2.5, 5.5, hashuf(aux ^ 0x6059u));
    var top = h0 + floor(hash21(vec2f(floor(uv.x / segW), f32(aux & 255u))) * 3.0) * 0.9 - 0.9;
    if (gh < 0.25) {
      // A pitched-roof house: a gable.
      top = h0 + max(0.0, 2.2 - abs(uv.x - segW * 1.6) * 0.55);
    }
    let d = top - uv.y;
    if (d > 0.0) {
      // Sheltered for decades: cleaner, lighter, the old room's paint.
      let paint = array<vec3f, 4>(vec3f(0.66, 0.63, 0.55), vec3f(0.55, 0.6, 0.58), vec3f(0.62, 0.58, 0.6), vec3f(0.6, 0.6, 0.6))[hashu(aux ^ 0x605au) % 4u];
      a = mix(a * 1.12, paint, 0.45);
      // Old floor and wall lines of the vanished rooms.
      let rl = abs(fract(uv.y / 2.7) - 0.5) * 2.7;
      a *= 1.0 - 0.15 * (1.0 - smoothstep(0.02, 0.05 + foot, 1.35 - rl)) * fFine;
    } else {
      // Dirt washed down onto the step from above.
      a *= 1.0 - 0.25 * smoothstep(1.5, 0.0, -d) * (0.6 + 0.4 * valueNoise(vec2f(uv.x * 4.0, 0.0)));
    }
    a *= 1.0 - 0.5 * (1.0 - smoothstep(0.08, 0.14 + foot, abs(d)));
  }
  // Repairs: ragged patches of fresh render or dark waterproofing coat over
  // cracks, low in contrast so they never read as openings.
  let pc = floor(uv / vec2f(3.1, 2.3));
  let ph = hash21(pc + f32(aux & 511u) + 31.0);
  let pf = fract(uv / vec2f(3.1, 2.3)) - vec2f(0.2 + 0.4 * fract(ph * 7.0), 0.3 + 0.3 * fract(ph * 3.0));
  let rag = 0.06 * (valueNoise(uv * 5.0) - 0.5);
  let ext = vec2f(0.15 + 0.2 * fract(ph * 13.0), 0.1 + 0.25 * fract(ph * 17.0));
  if (ph > 0.86 && all(abs(pf) + rag < ext)) {
    let dark = fract(ph * 29.0) < 0.5;
    a = mix(a, select(a * 1.15 + 0.03, vec3f(0.24, 0.245, 0.24), dark), select(0.6, 0.45, dark));
    if (dark) { (*s).rough = 0.5; }
  }
  // Vertical crack sealant line now and then.
  let cx = abs(fract(uv.x / 4.3 + hashuf(aux ^ 0x5c1u)) - 0.5) * 4.3 + 0.02 * sin(uv.y * 3.0);
  if (hash21(vec2f(floor(uv.x / 4.3), f32(aux & 63u))) > 0.6) {
    a *= 1.0 - 0.5 * (1.0 - smoothstep(0.008, 0.008 + foot, cx)) * clamp(0.016 / max(foot, 1e-4), 0.0, 1.0);
  }
  // Tie-rod plates (200 mm, rusty) at each slab line every ~3.6 m; rust
  // bleeds 1-2 m down below each.
  let tp = vec2f(uv.x - (floor(uv.x / 3.6) + 0.5) * 3.6, uv.y - (floor(uv.y / 3.3 + 0.5)) * 3.3 - 0.1);
  let plate = max(abs(tp.x), abs(tp.y));
  if (hashuf(aux ^ 0x7e1u) < 0.6) {
    let bleed = (1.0 - smoothstep(0.03, 0.09, abs(tp.x) - max(-tp.y, 0.0) * 0.03)) * smoothstep(-1.6, 0.0, tp.y) * step(tp.y, 0.0);
    a = mix(a, vec3f(0.3, 0.17, 0.08), bleed * 0.35 * mix(0.5, 1.0, fFine));
    if (plate < 0.1) {
      a = mix(vec3f(0.22, 0.17, 0.13), vec3f(0.35, 0.18, 0.08), smoothstep(0.05, 0.1, plate));
      (*s).metal = 0.3;
      (*s).rough = 0.6;
      if (length(tp) < 0.025) { a = vec3f(0.12); }
    }
  }
  // At most one vent: a small louvred grille.
  let vh = hashuf(aux ^ 0x7e7u);
  let vp = uv - vec2f(mix(1.2, 4.0, vh), mix(3.0, 7.0, fract(vh * 7.0)));
  if (vh < 0.6 && max(abs(vp.x), abs(vp.y)) < 0.16) {
    a = vec3f(0.55, 0.55, 0.53) * mix(0.9, select(0.55, 1.0, fract(vp.y / 0.04) > 0.4), fFine);
    (*s).metal = 0.5;
    (*s).rough = 0.5;
  }
  (*s).albedo = a;
}

// Surface overrides once the wall material is done: the granite finish on
// the base, the lobby, and solid walls (no windows). True: `s` is final.
fn facadeZoneSurf(s: ptr<function, Surf>, z: FacadeZone, uv: vec2f, wall: vec3f, n: vec3f, T: vec3f, V: vec3f, aux: u32) -> bool {
  if (z.zone == FZ_LOBBY) {
    *s = facadeLobby(uv, n, T, V);
    return true;
  }
  if (z.zone == FZ_BASE && z.role <= 1u) {
    // 900 x 600 mm granite slabs, slab-to-slab tone, 4 mm joints that fade
    // out by pixel footprint.
    let foot = max(length(dWorldX), length(dWorldY));
    let g = uv / vec2f(0.9, 0.6);
    let f = abs(fract(g) - 0.5) * vec2f(0.9, 0.6);
    let d = min(0.45 - f.x, 0.3 - f.y);
    let joint = (1.0 - smoothstep(0.002, 0.002 + foot * 1.5, d)) * clamp(0.006 / max(foot, 1e-4), 0.0, 1.0);
    let ly = uv.y - floor(uv.y / FACADE_GROUND) * FACADE_GROUND;
    var a = wall * (0.88 + 0.24 * hash21(floor(g) + f32(aux & 255u)));
    if (ly < 0.18) { a *= 0.8; }
    (*s).albedo = a * (1.0 - 0.6 * joint);
    (*s).rough = 0.35;
    (*s).normal = n;
  }
  if (z.role == 2u && z.zone != FZ_CROWN) { partyWall(s, uv, aux); }
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
  (*s).albedo *= mix(1.0, 0.6, wet * porous);
  (*s).rough = mix((*s).rough, 0.32, wet * 0.6);
  let rv = rivulets(uv, clamp(0.25 + underSill * 0.6 + washAmt * 0.5, 0.0, 0.9), foot);
  let film = clamp(rv.x + washAmt * 0.6, 0.0, 1.0) * wet;
  (*s).rough = mix((*s).rough, 0.07, film);
  (*s).albedo *= 1.0 - 0.4 * film;
  (*s).normal = normalize((*s).normal + T * rv.y * 0.5 * wet);
  // Pooled water at grade: the wall wicks it up 20-50 cm.
  let pool = (1.0 - smoothstep(0.15, 0.35 + 0.2 * valueNoise(vec2f(uv.x * 1.7, 2.0)), uv.y)) * wet;
  (*s).albedo *= 1.0 - 0.4 * pool;
  (*s).rough = mix((*s).rough, 0.12, pool);
  let up = smoothstep(0.3, 0.7, (*s).normal.y) * wet;
  (*s).rough = mix((*s).rough, 0.05, up);
  (*s).albedo *= 1.0 - 0.3 * up;
}

fn facadeMat(world: vec3f, n: vec3f, uv: vec2f, param: u32, aux: u32) -> Surf {
  var s = defaultSurf(n);
  let style = param & 0x1fffu;
  let kind = (param >> 16u) & 7u;
  let shop = ((param >> 19u) & 1u) == 1u;
  let podium = ((param >> 20u) & 1u) == 1u;
  var st = facadeStyle(style, kind, podium);
  var fz = facadeZone(param);
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
  let wd = select(detailUV(uv, 2.4, DETAIL_CONCRETE), detailUV(uv, 0.96, DETAIL_TILE), tiled);
  // Pixel footprint: every pattern below fades to its mean before it gets
  // smaller than a few pixels, and each fine pattern is backed by a 1-10 m
  // one carrying the same idea to a distance.
  let foot = max(length(dWorldX), length(dWorldY));
  let fFine = 1.0 - smoothstep(0.03, 0.1, foot);
  let fMid = 1.0 - smoothstep(0.25, 0.7, foot);
  let wet = frame.weather.z;
  let streak = mix(0.125, valueNoise(vec2f(uv.x * 3.0, uv.y * 0.15)) * 0.25, fFine);
  var wall = st.wall * (0.88 + 0.12 * valueNoise(uv * 0.7)) * (1.0 - streak * 0.5) * mix(1.0, wd.b * 2.0, select(0.6, 1.0, tiled)) * mix(0.6, 1.0, wd.a);
  // Each face of the building has its own tone (sun bleach, a different
  // batch), so corners read even in flat light.
  let faceH = hashu(aux ^ (u32(round(atan2(n.z, n.x) * 2.546) + 64.0) * 0x9e3779b1u));
  wall *= mix(0.93, 1.07, hashuf(faceH));
  // Tile batches: 2 x 2 tile patches of slightly different kiln tone, the
  // speckled mosaic a tiled facade shows at 30-80 m.
  if (tiled) {
    wall *= mix(1.0, 0.94 + 0.12 * hash21(floor(uv / vec2f(1.92, 1.38)) + f32(aux & 511u)), fMid);
  }
  // Street grime: a dark band along the bottom metre, and the 0-40 cm splash
  // zone where rain throws pavement dirt back up the wall (ragged top edge,
  // speckled up close).
  wall *= mix(0.78, 1.0, smoothstep(0.0, 1.2, uv.y));
  {
    let top = 0.32 + 0.12 * valueNoise(vec2f(uv.x * 2.5, 1.0));
    let speck = mix(0.6, step(0.45, hash21(floor(uv * 60.0))), 1.0 - smoothstep(0.005, 0.015, foot));
    let splash = (1.0 - smoothstep(top - 0.1, top, uv.y)) + (1.0 - smoothstep(top, top + 0.15, uv.y)) * speck * 0.5;
    wall = mix(wall, wall * vec3f(0.62, 0.58, 0.52), clamp(splash, 0.0, 1.0) * 0.8);
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
    let dirtAmt = mix(0.45, 0.9, hashuf(aux ^ 0x5151u)) * (1.0 + 0.6 * wet);
    // Sill ends: a 0.15 m streak under each end of the sill, 1.5 m long;
    // between them thinner drips of varying length off the sill's drip
    // edge. At a distance, their average darkening over the window width.
    let inX = step(wx0e - 0.1, lx) * step(lx, st.bay - wx0e + 0.1);
    let endD = min(abs(lx - wx0e), abs(lx - (st.bay - wx0e)));
    let endLen = 1.8 * mix(0.6, 1.0, hashuf(cellSeed ^ 0x3131u));
    let dripCol = valueNoise(vec2f(uv.x * 9.0, floorIdx * 3.1));
    let dripLen = mix(0.4, 1.6, valueNoise(vec2f(uv.x * 3.1, floorIdx * 1.7 + 4.0)));
    let near = max(smoothstep(0.1, 0.02, endD) * (0.7 + 0.3 * valueNoise(vec2f(uv.x * 23.0, uv.y * 0.4))) * smoothstep(endLen, 0.0, below),
      smoothstep(0.5, 0.8, dripCol) * smoothstep(dripLen, 0.0, below) * 0.7 * inX);
    let far = 0.4 * inX * smoothstep(endLen, 0.0, below);
    if (below > 0.0 && !st.strip && !fz.solid) {
      washAmt = max(washAmt, mix(far, near, fFine));
      underSill = inX * smoothstep(1.5, 0.0, below);
    }
    // Slab and ledge wash: 0.7-1.4 m wide streaks of varying length below
    // every floor line (deep in the top part of the floor below it).
    let col = valueNoise(vec2f(uv.x * 0.9, floorIdx * 5.3 + 7.0));
    let len = mix(0.6, 2.6, valueNoise(vec2f(uv.x * 0.6 + 3.0, floorIdx * 2.7)));
    washAmt = max(washAmt, smoothstep(0.42, 0.8, col) * smoothstep(len, 0.0, slabBelow) * 0.8);
    // Fine drips inside the wash fade out at a distance.
    washAmt *= mix(1.0, 0.75 + 0.5 * valueNoise(vec2f(uv.x * 14.0, floorIdx * 7.7)), fFine);
    // Wash is grime, not shadow: a brownish grey.
    wall = mix(wall, wall * vec3f(0.6, 0.57, 0.53), clamp(dirtAmt * washAmt * select(1.0, 0.75, tiled), 0.0, 0.75));
    let patchC = floor(uv / vec2f(2.4, st.floorH));
    wall *= mix(1.0, 0.95 + 0.1 * hash21(patchC + f32(aux & 255u)), select(0.5, 1.0, !tiled));
    // Mortar darkens where water and dirt collect: near the ground, under
    // sills and ledges, and on the corner piers.
    if (tiled) {
      let edgeDirt = clamp(washAmt + select(0.0, 0.5, fz.solid) + smoothstep(2.0, 0.0, uv.y), 0.0, 1.0);
      wall *= mix(1.0, mix(0.6, 1.0, wd.a), edgeDirt * mix(0.5, 1.0, fFine));
      // Efflorescence: white salt bloom in the joints below each slab line,
      // in patches.
      let eff = smoothstep(0.55, 0.8, valueNoise(uv * vec2f(0.8, 1.5) + 13.0)) * smoothstep(1.1, 0.1, slabBelow);
      wall = mix(wall, vec3f(0.78, 0.77, 0.72), eff * mix(0.18, 0.55 * (1.0 - wd.a) + 0.1, fFine) * mix(0.5, 1.0, fMid));
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
    if (fz.solid && fz.role <= 1u && fz.zone == FZ_BODY && hashuf(cellSeed ^ 0x51a1u) < 0.35) {
      rx = abs(uv.x - (floor(uv.x / 2.0) + 0.5) * 2.0);
      ry = st.floorH * 0.7 - ly;
    }
    if (ry > 0.0 && rx < 0.2) {
      let rw = 0.025 + ry * 0.03;
      let rust = (1.0 - smoothstep(rw * 0.5, rw, rx)) * smoothstep(1.4, 0.0, ry) * (0.6 + 0.4 * valueNoise(vec2f(uv.x * 30.0, uv.y * 2.0)));
      wall = mix(wall, vec3f(0.34, 0.18, 0.08), rust * 0.55 * mix(0.3, 1.0, fFine));
    }
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

  let zoneDone = facadeZoneSurf(&s, fz, uv, wall, n, T, V, aux);
  if (fz.zone != FZ_LOBBY) { facadeRain(&s, uv, n, T, washAmt, underSill, select(0.6, 0.3, tiled)); }
  if (zoneDone) { return s; }

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
            let cloth = mix(mix(vec3f(0.08), 0.35 + 0.35 * cos(6.2831 * (gh * 0.25 + vec3f(0.0, 0.25, 0.55) + f32(shopSeed % 7u) * 0.13)), 0.45), vec3f(0.3, 0.28, 0.27), cf);
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
            let pack = mix(mix(vec3f(0.85, 0.82, 0.75), 0.5 + 0.5 * cos(6.2831 * (ph + vec3f(0.0, 0.33, 0.67))), mix(0.25, 0.6, step(0.8, ph))), vec3f(0.5, 0.48, 0.45), pf);
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
  let office = kind <= 2u && !(kind == 2u && hashuf(style) < 0.4);
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
    let sx = abs(lx - st.bay * 0.5);
    let sy = ly - st.floorH * 0.3;
    if (sx < hw && sy > 0.0 && sy < 1.2) {
      let e = min(hw - sx, min(sy, 1.2 - sy));
      if (e < 0.045) {
        s.albedo = sashColor(style, st.wall);
        s.metal = 0.8;
        s.rough = 0.42;
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
      s.emissive = vec3f(0.7, 0.9, 1.0) * mix(0.02, 0.2, nightLight()) * (1.0 - 0.7 * joint) * cellG * flight;
      return s;
    }
  }
  if (!stairBay && lx >= wx0 && lx <= wx1 && ly >= sill && ly <= wy1) {
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
      // The inner sill holds water in the rain.
      if (g.y < sill) {
        s.rough = mix(s.rough, 0.08, wet);
        s.albedo *= 1.0 - 0.35 * wet;
      }
      // Light from a lit room spills onto the reveal.
      s.emissive = roomL * wall * 0.2;
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
    let roomSize = vec2f(wx1 - wx0, wy1 - sill);
    // Sash, mullions (ribbon windows) and the meeting rail of sliding sashes,
    // as a distance to the nearest bar so thin bars antialias instead of
    // crawling.
    var barD = min(fx, fy) - 0.045;
    if (st.strip) { barD = min(barD, (0.5 - abs(fract(uv.x / 1.6) - 0.5)) * 1.6 - 0.048); }
    if (!st.strip && roomSize.x > 1.2) { barD = min(barD, abs(lxg - (wx0 + wx1) * 0.5) - 0.022); }
    let barCov = 1.0 - smoothstep(-0.5 * foot, 0.5 * foot, barD);
    let sash = sashColor(style, st.wall);
    if (barCov > 0.999) {
      // Anodised aluminium sash: silver, bronze or white, never black.
      s.albedo = sash;
      s.metal = 0.8;
      s.rough = mix(0.42, 0.15, wet);
      return s;
    }
    // Each pane sits slightly out of plane and bows a little, so neighbours
    // (and the two sashes of one window) reflect different sky and city.
    // Glass gets no wall tile relief.
    let paneSeed = hash22(vec2f(bayIdx, floorIdx) + f32(aux & 1023u) + select(0.0, 0.5, lxg > (wx0 + wx1) * 0.5));
    let wob = (paneSeed - 0.5) * 0.05;
    let pc = (vec2f(lxg - wx0, lyg - sill) / roomSize - 0.5) * 2.0;
    let bow = select(-1.0, 1.0, paneSeed.x > 0.5) * 0.02;
    s.normal = normalize(n + T * (wob.x + pc.x * bow) + vec3f(0.0, wob.y + pc.y * bow, 0.0));
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
      let rv = rivulets(vec2f(lxg + f32(cellSeed & 15u) * 0.37, lyg), 0.45 + 0.3 * smoothstep(0.6, 0.0, wy1 - lyg), foot);
      s.normal = normalize(s.normal + T * rv.y * 0.8 * wet);
      glassRough = mix(glassRough, 0.12, rv.x * wet * 0.5);
      rivulet = rv.x * wet;
    }
    var inside: vec3f;
    if (baseShop) {
      inside = shopInterior(vec2f(lxg - wx0, lyg - sill), roomSize, n, T, V, cellSeed, foot);
    } else {
      inside = interior(vec2f(lxg - wx0, lyg - sill), roomSize, mix(3.5, 7.0, hashuf(cellSeed)), n, T, V, cellSeed, office, section);
      inside = windowCover(inside, vec2f(lxg - wx0, lyg - sill), roomSize, cellSeed, office, roomL, foot);
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
    s.albedo = mix(gl + vec3f(0.06) * wet, sash, barCov);
    s.rough = mix(glassRough, 0.42, barCov);
    s.metal = 0.8 * barCov;
    // Water trails on the glass refract the room: it breaks up behind them.
    s.emissive = inside * (1.0 - fres) * see * (1.0 - 0.2 * wet) * (1.0 - 0.45 * rivulet) * (1.0 - barCov);
    s.ao = mix(0.55, 1.0, smoothstep(0.0, 0.15, min(fx, fy)));
    s.cls = select(CLASS_GLASS, CLASS_DEFAULT, barCov > 0.5);
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

// Sign atlas (src/city/signs.ts): 2048x2560. param = id | flags << 8:
// 0x100 fabric (unlit cloth), 0x200 striped awning canvas.
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
  let lod = clamp(0.5 * log2(max(dot(dx, dx), dot(dy, dy))), 0.0, 3.0);
  let inset = 2.0 * exp2(lod);
  let px = rect.xy + vec2f(mix(inset, rect.z - inset, f.x), mix(inset, rect.w - inset, f.y));
  let c = textureSampleLevel(signAtlas, linearSampler, px / vec2f(2048.0, 2560.0), lod).rgb;
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
  s.emissive = c * c * 1.2 * mix(0.25, 4.5, nightLight());
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
  s.emissive = c * mix(1.2, 2.6, nightLight());
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
        applyWetness(&s, world, 0.0, porous);
      }
    }
    case M_GLASS: { s = curtainWall(world, n, uv, param, aux); }
    case M_ROOF: { s = roofMat(world, n, uv, param); }
    case M_CARPARK: { s = carParkMat(world, n, uv); }
    case M_METAL: { s.albedo = vec3f(0.42, 0.43, 0.45); s.metal = 0.8; s.rough = 0.45; }
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
      if (param == 0xf8u) {
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
