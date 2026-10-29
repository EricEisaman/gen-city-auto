// Procedural materials for city geometry (see src/city/cmesh.ts for ids).

@group(2) @binding(0) var signAtlas: texture_2d<f32>;
@group(2) @binding(1) var linearSampler: sampler;
@group(2) @binding(2) var leafTex: texture_2d<f32>;

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
fn interior(local: vec2f, size: vec2f, depth: f32, N: vec3f, T: vec3f, V: vec3f, seed: u32, office: bool) -> vec3f {
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
      c = vec3f(0.85);
      // Ceiling light panels.
      if (office && fract(hit.z * 0.4) < 0.25 && abs(hit.x - size.x * 0.5) < 0.4) { c = vec3f(3.0); }
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
  // Lighting: lit rooms glow at night, everything gets some daylight.
  let night = nightLight();
  let litChance = select(mix(0.04, 0.36, night), mix(0.06, 0.42, night), office);
  let lit = hashuf(seed ^ 0x1234567u) < litChance;
  let warm = select(vec3f(1.0, 0.72, 0.42), vec3f(0.92, 0.96, 1.0), office && r0 > 0.25);
  var light = frame.skyAmbient.rgb * 0.35;
  if (lit) {
    let flicker = 1.0;
    light += warm * mix(0.35, 1.5, r2 * r2) * flicker * mix(0.12, 1.0, night);
  }
  return c * light;
}

struct FacadeStyle {
  floorH: f32,
  bay: f32,
  winW: f32,
  winH: f32,
  wall: vec3f,
  strip: bool,
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
  // Below the street-level ground floor (downhill sides) the window grid
  // simply continues with lower floors.
  let floorIdx = floor(uv.y / st.floorH);
  let ly = uv.y - floorIdx * st.floorH;
  let bayIdx = floor(uv.x / st.bay);
  let lx = uv.x - bayIdx * st.bay;
  let cellSeed = hashu(aux ^ hashu((u32(bayIdx + 1000.0) * 73856093u) ^ (u32(floorIdx + 1000.0) * 19349663u)));
  // Wall: small tiles with grime streaks.
  let tileLine = step(0.92, fract(uv.x * 10.0)) + step(0.9, fract(uv.y * 20.0));
  let streak = valueNoise(vec2f(uv.x * 3.0, uv.y * 0.15)) * 0.25;
  var wall = st.wall * (0.88 + 0.12 * valueNoise(uv * 0.7)) * (1.0 - streak * 0.5) * (1.0 - 0.06 * min(tileLine, 1.0));
  s.albedo = wall;
  s.rough = 0.75;
  // Tile grout grooves and the floor-slab bevel as normal detail.
  let wfade = bumpFade(world);
  if (wfade > 0.05) {
    let gu = fract(uv.x * 10.0);
    let gv = fract(uv.y * 20.0);
    let du = select(0.0, select(1.0, -1.0, gu < 0.5), min(gu, 1.0 - gu) < 0.06);
    let dv = select(0.0, select(1.0, -1.0, gv < 0.5), min(gv, 1.0 - gv) < 0.08);
    var bump = T * du * 0.25 + vec3f(0.0, dv * 0.25, 0.0);
    let lyw = uv.y - floor(uv.y / st.floorH) * st.floorH;
    if (lyw < 0.21 && lyw > 0.18) { bump += vec3f(0.0, 0.9, 0.0); }
    s.normal = normalize(n + bump * wfade);
  }
  // Floor slab line.
  if (ly < 0.18) { s.albedo = wall * 0.8; }

  // Ground floor shopfront.
  if (shop && abs(floorIdx) < 0.5) {
    let shutter = hashuf(cellSeed ^ 77u) < 0.12;
    let fr = min(lx, st.bay - lx);
    if (ly > 0.15 && ly < st.floorH * 0.78 && fr > 0.08) {
      if (shutter) {
        s.albedo = vec3f(0.5, 0.52, 0.55) * (0.8 + 0.2 * step(0.5, fract(ly * 12.0)));
        s.metal = 0.6;
        s.rough = 0.45;
        return s;
      }
      // Shop type per pair of bays: convenience store, restaurant (noren),
      // boutique, or dark office lobby.
      let shopSeed = hashu(aux ^ u32(floor(bayIdx / 2.0) + 3000.0));
      let shopType = shopSeed % 4u;
      let night = nightLight();
      let fres = 0.04 + 0.96 * pow(1.0 - abs(dot(V, n)), 5.0);
      var inside = interior(vec2f(lx, ly), vec2f(st.bay, st.floorH), 6.0, n, T, V, cellSeed, false);
      var glow = vec3f(1.0, 0.85, 0.6) * 0.2;
      if (shopType == 0u) {
        // Konbini: bright cool interior, colored band across the top.
        inside = inside * 0.4 + vec3f(1.6, 1.7, 1.8) * mix(0.5, 1.0, night);
        if (ly > st.floorH * 0.66) {
          let bandC = array<vec3f, 3>(vec3f(0.1, 0.5, 0.25), vec3f(0.9, 0.3, 0.05), vec3f(0.1, 0.3, 0.8))[shopSeed % 3u];
          s.albedo = bandC;
          s.rough = 0.3;
          s.emissive = bandC * mix(0.8, 4.0, night);
          return s;
        }
      } else if (shopType == 1u) {
        // Restaurant: warm light, noren curtain over the top of the door.
        inside *= 1.4;
        glow = vec3f(1.0, 0.6, 0.3) * 0.5;
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
    // Window reveal parallax: the glass sits 22 cm behind the wall plane.
    let ndv = max(-dot(V, n), 0.05);
    let vT = vec2f(dot(V, T), V.y) / ndv;
    let g = vec2f(lx, ly) + vT * 0.22;
    if (g.x < wx0 || g.x > wx1 || g.y < sill || g.y > wy1) {
      s.albedo = wall * 0.8;
      s.rough = 0.8;
      if (g.y < sill) { s.normal = vec3f(0.0, 1.0, 0.0); }
      else if (g.y > wy1) { s.normal = vec3f(0.0, -1.0, 0.0); }
      else if (g.x < wx0) { s.normal = T; }
      else { s.normal = -T; }
      return s;
    }
    let lxg = g.x;
    let lyg = g.y;
    let fx = min(lxg - wx0, wx1 - lxg);
    let fy = min(lyg - sill, wy1 - lyg);
    let mull = st.strip && abs(fract(uv.x / 1.6) - 0.5) > 0.47;
    if (fx < 0.07 || fy < 0.07 || mull) {
      s.albedo = vec3f(0.08, 0.08, 0.09);
      s.metal = 0.7;
      s.rough = 0.35;
      return s;
    }
    let office = kind <= 2u && !(kind == 2u && hashuf(style) < 0.4);
    let roomSize = vec2f(wx1 - wx0, wy1 - sill);
    var inside = interior(vec2f(lxg - wx0, lyg - sill), roomSize, mix(3.5, 7.0, hashuf(cellSeed)), n, T, V, cellSeed, office);
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
  if (lx < 0.06 || lx > bay - 0.06) {
    s.albedo = vec3f(0.45, 0.47, 0.5);
    s.metal = 0.9;
    s.rough = 0.3;
    return s;
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
  let inside = interior(vec2f(rx, ly - 0.95), vec2f(roomW, floorH - 0.95), 9.0, n, T, V, roomSeed, true);
  s.albedo = tint * 0.18;
  s.rough = 0.04;
  s.emissive = inside * (1.0 - fres) * 0.8 * (1.0 - 0.6 * tint.b);
  s.cls = CLASS_GLASS;
  _ = seed;
  return s;
}

fn asphaltH(p: vec2f) -> f32 {
  var h = valueNoise(p * 40.0) * 0.25 + valueNoise(p * 6.0) * 0.5;
  // Cracks as grooves.
  h -= (1.0 - smoothstep(0.0, 0.012, abs(valueNoise(p * 0.7) - 0.5))) * 0.6;
  return h * 0.01;
}

fn roadMat(world: vec3f, n: vec3f, uv: vec2f, param: u32, lanes: u32) -> Surf {
  var s = defaultSurf(n);
  let grain = valueNoise(world.xz * 3.0) * 0.5 + valueNoise(world.xz * 0.35) * 0.5;
  s.albedo = vec3f(0.075, 0.075, 0.08) * (0.75 + 0.5 * grain);
  s.rough = 0.88;
  s.cls = CLASS_GROUND;
  // Patches (rectangular repairs), oil stains and manholes.
  let pc = floor(world.xz / 9.0);
  let ph = hash21(pc);
  let pf = fract(world.xz / 9.0);
  if (ph > 0.82 && all(pf > vec2f(0.15)) && all(pf < vec2f(0.15 + ph * 0.7))) { s.albedo *= 0.72; s.rough -= 0.05; }
  let oil = smoothstep(0.75, 0.9, valueNoise(world.xz * 0.6)) * valueNoise(world.xz * 3.0);
  s.albedo *= 1.0 - oil * 0.35;
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
    let wear = smoothstep(0.2, 0.7, valueNoise(world.xz * 4.0));
    let c = select(vec3f(0.65), vec3f(0.62, 0.42, 0.06), yellow);
    s.albedo = mix(s.albedo, c, 0.65 + 0.35 * wear * (0.6 + 0.4 * valueNoise(world.xz * 1.5)));
    s.rough = 0.7;
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
  // Aggregate micro-relief, patches and cracks.
  let fade = bumpFade(world);
  if (fade > 0.05) {
    let e = 0.02;
    let h0 = asphaltH(world.xz);
    let hx = asphaltH(world.xz + vec2f(e, 0.0));
    let hz = asphaltH(world.xz + vec2f(0.0, e));
    s.normal = bumpNormal(n, vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), h0, hx, hz, e, 0.15 * fade);
  }
  applyWetness(&s, world, 1.0, 0.6);
  return s;
}

fn sidewalkMat(world: vec3f, n: vec3f) -> Surf {
  var s = defaultSurf(n);
  let p = world.xz / 0.3;
  let cell = floor(p);
  let f = fract(p);
  let grout = step(f.x, 0.05) + step(f.y, 0.05);
  let tint = hash21(cell);
  s.albedo = mix(vec3f(0.3, 0.29, 0.27), vec3f(0.4, 0.39, 0.36), tint) * (1.0 - 0.35 * min(grout, 1.0));
  s.albedo *= 0.85 + 0.15 * valueNoise(world.xz * 0.5);
  s.rough = 0.8;
  s.cls = CLASS_GROUND;
  let fade = bumpFade(world);
  if (fade > 0.05) {
    let tilt = (hash22(cell) - 0.5) * 0.04;
    let gx = smoothstep(0.0, 0.06, f.x) * smoothstep(1.0, 0.94, f.x);
    let gz = smoothstep(0.0, 0.06, f.y) * smoothstep(1.0, 0.94, f.y);
    let gradX = (smoothstep(0.0, 0.06, f.x) - smoothstep(1.0, 0.94, f.x)) * 0.0;
    _ = gradX;
    // Grout grooves: slope toward the gaps.
    let sx = select(0.0, select(-1.0, 1.0, f.x < 0.5), gx < 0.99);
    let sz = select(0.0, select(-1.0, 1.0, f.y < 0.5), gz < 0.99);
    s.normal = normalize(n + vec3f(tilt.x + sx * 0.35, 0.0, tilt.y + sz * 0.35) * fade);
  }
  applyWetness(&s, world, n.y, 0.7);
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
  s.emissive = c * c * 1.5 * mix(0.25, 8.0, nightLight());
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
      s.albedo = vec3f(0.55, 0.54, 0.52) * (0.85 + 0.15 * valueNoise(world.xz * 2.0));
      s.rough = 0.8;
    }
    case M_FACADE: { s = facadeMat(world, n, uv, param, aux); }
    case M_GLASS: { s = curtainWall(world, n, uv, param, aux); }
    case M_ROOF: {
      let h = hashu(param * 31u + 5u);
      let g = hashuf(h) < 0.12;
      let gravel = 0.85 + 0.15 * hash21(floor(world.xz * 20.0));
      let seams = 1.0 - 0.15 * step(0.96, fract(world.x * 0.5)) - 0.15 * step(0.96, fract(world.z * 0.5));
      let stain = 1.0 - 0.3 * smoothstep(0.55, 0.8, fbm2(world.xz * 0.15));
      let membrane = hashuf(h ^ 3u) < 0.4;
      var base = select(mix(vec3f(0.30, 0.29, 0.27), vec3f(0.22, 0.25, 0.27), hashuf(h ^ 21u)), vec3f(0.16, 0.25, 0.1), g);
      if (membrane) { base = vec3f(0.34, 0.35, 0.34); }
      s.albedo = base * select(gravel, seams, membrane) * stain;
      s.albedo *= mix(0.75, 1.1, hashuf(h ^ 9u));
      s.rough = 0.9;
      applyWetness(&s, world, n.y, 0.4);
    }
    case M_METAL: { s.albedo = vec3f(0.42, 0.43, 0.45); s.metal = 0.8; s.rough = 0.45; }
    case M_SIGN: { s = signMat(n, uv, param); }
    case M_FOLIAGE: {
      let h = hashuf(aux);
      s.albedo = mix(vec3f(0.08, 0.16, 0.04), vec3f(0.16, 0.24, 0.06), h) * (0.7 + 0.5 * valueNoise(world.xz * 2.0 + world.y));
      s.rough = 0.85;
      s.ao = clamp(0.55 + 0.45 * n.y, 0.0, 1.0);
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
      s.albedo = vec3f(0.55, 0.54, 0.51) * (0.75 + 0.25 * fbm2(world.xz * 0.3 + world.y * 0.2));
      s.rough = 0.85;
      applyWetness(&s, world, max(n.y, 0.0), 0.5);
    }
    case M_RAIL: {
      let x = uv.x;
      let ballast = 0.25 + 0.15 * hash21(floor(world.xz * 12.0));
      s.albedo = vec3f(ballast * 0.95, ballast * 0.9, ballast * 0.85);
      for (var k = -1.0; k <= 1.0; k += 2.0) {
        if (abs(x - k * 2.1) < 1.25 && fract(uv.y / 0.62) < 0.35) { s.albedo = vec3f(0.48, 0.46, 0.43); }
      }
      s.rough = 0.95;
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
    case M_PAINT: { s.albedo = paintColor(param); s.rough = 0.5; s.metal = 0.1; applyWetness(&s, world, max(n.y, 0.0), 0.0); }
    case M_SCREEN: { s = screenMat(n, uv, param); }
    case M_TILE: {
      let h = hashu(param * 13u + 1u);
      let cols = array<vec3f, 4>(vec3f(0.12, 0.13, 0.16), vec3f(0.35, 0.18, 0.12), vec3f(0.18, 0.22, 0.3), vec3f(0.3, 0.3, 0.3));
      s.albedo = cols[h % 4u] * (0.8 + 0.2 * step(0.5, fract(uv.y * 4.0)));
      s.rough = 0.55;
      applyWetness(&s, world, 0.5, 0.0);
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
