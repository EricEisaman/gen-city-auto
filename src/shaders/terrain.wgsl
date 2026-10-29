// Heightfield terrain (instanced quadtree patches with skirts) and the sea.

struct Patch { origin: vec2f, size: f32, pad: f32 };

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var heightTex: texture_2d<f32>;
@group(1) @binding(1) var landTex: texture_2d<f32>;
@group(1) @binding(2) var<storage, read> patches: array<Patch>;

const GRID = 32u;

fn heightAt(xz: vec2f) -> f32 {
  let n = i32(frame.world.z);
  let g = (xz + frame.world.x * 0.5) / frame.world.y;
  let i = vec2i(floor(g));
  let f = g - vec2f(i);
  let c = vec2i(n - 1);
  let a = textureLoad(heightTex, clamp(i, vec2i(0), c), 0).r;
  let b = textureLoad(heightTex, clamp(i + vec2i(1, 0), vec2i(0), c), 0).r;
  let d = textureLoad(heightTex, clamp(i + vec2i(0, 1), vec2i(0), c), 0).r;
  let e = textureLoad(heightTex, clamp(i + vec2i(1, 1), vec2i(0), c), 0).r;
  var h = mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
  // Outside the generated world: land continues as a gentle plain, sea stays sea.
  let edge = max(abs(xz.x), abs(xz.y)) - frame.world.x * 0.5;
  if (edge > 0.0) {
    if (h < 1.0) { h = mix(h, -20.0, clamp(edge / 400.0, 0.0, 1.0)); }
    else { h = h + (valueNoise(xz * 0.002) - 0.5) * 20.0 * clamp(edge / 1500.0, 0.0, 1.0); }
  }
  return h;
}

fn landAt(xz: vec2f) -> u32 {
  let n = i32(frame.world.z);
  let g = vec2i(round((xz + frame.world.x * 0.5) / frame.world.y));
  if (any(g < vec2i(0)) || any(g >= vec2i(n))) { return 1u; }
  return u32(textureLoad(landTex, g, 0).r * 255.0 + 0.5);
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = patches[ii];
  let side = GRID + 3u;
  let i = vi % side;
  let j = vi / side;
  let gi = clamp(i32(i) - 1, 0, i32(GRID));
  let gj = clamp(i32(j) - 1, 0, i32(GRID));
  let skirt = i == 0u || j == 0u || i == side - 1u || j == side - 1u;
  let xz = p.origin + vec2f(f32(gi), f32(gj)) / f32(GRID) * p.size;
  var h = heightAt(xz);
  if (skirt) { h -= p.size * 0.04 + 2.0; }
  var o: VOut;
  o.world = vec3f(xz.x, h, xz.y);
  o.pos = frame.viewProj * vec4f(o.world, 1.0);
  return o;
}

@fragment fn fs(i: VOut) -> GOut {
  let xz = i.world.xz;
  let e = frame.world.y;
  let hx = heightAt(xz + vec2f(e, 0.0)) - heightAt(xz - vec2f(e, 0.0));
  let hz = heightAt(xz + vec2f(0.0, e)) - heightAt(xz - vec2f(0.0, e));
  let n = normalize(vec3f(-hx, 2.0 * e, -hz));
  var s = defaultSurf(n);
  let land = landAt(xz);
  let h = i.world.y;
  let slope = 1.0 - n.y;
  let nz = fbm2(xz * 0.05);
  let grass = mix(vec3f(0.1, 0.17, 0.05), vec3f(0.2, 0.24, 0.09), nz);
  let dirt = vec3f(0.24, 0.19, 0.14) * (0.8 + 0.4 * valueNoise(xz * 0.3));
  let rock = vec3f(0.33, 0.31, 0.29) * (0.8 + 0.3 * valueNoise(xz * 0.2 + h));
  s.albedo = mix(grass, dirt, smoothstep(0.55, 0.75, nz + slope));
  s.albedo = mix(s.albedo, rock, smoothstep(0.35, 0.6, slope));
  s.rough = 0.95;
  if (land == 1u) {
    s.albedo = vec3f(0.3, 0.29, 0.27) * (0.8 + 0.3 * valueNoise(xz * 0.5));
    s.cls = CLASS_GROUND;
  } else if (land == 2u) {
    s.albedo = grass;
  } else if (land == 3u) {
    s.albedo = vec3f(0.07) * (0.8 + 0.4 * valueNoise(xz * 2.0));
    s.cls = CLASS_GROUND;
  }
  // Beaches and river banks: concrete embankment in the city, sand elsewhere.
  if (h < 2.2 && land != 3u) {
    let sand = vec3f(0.5, 0.45, 0.36) * (0.85 + 0.15 * valueNoise(xz));
    s.albedo = mix(s.albedo, sand, smoothstep(2.2, 1.0, h));
  }
  if (h < frame.world.w) {
    s.albedo = mix(vec3f(0.18, 0.17, 0.14), vec3f(0.08, 0.1, 0.09), clamp(-h / 8.0, 0.0, 1.0));
  }
  if (land == 2u || land == 0u) {
    s.albedo *= 1.0 - frame.weather.z * 0.35;
  } else {
    applyWetness(&s, i.world, n.y, 0.5);
  }
  return writeG(s, i.world, i.pos);
}

// --- Sea --------------------------------------------------------------------

struct WOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
};

@vertex fn vsWater(@builtin(vertex_index) vi: u32) -> WOut {
  // A 64x64 grid of quads centered on the camera, growing with distance.
  let quad = vi / 6u;
  let corner = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1))[vi % 6u];
  let gx = f32(quad % 64u) + corner.x;
  let gz = f32(quad / 64u) + corner.y;
  let g = (vec2f(gx, gz) / 64.0) * 2.0 - 1.0;
  let warped = sign(g) * g * g * 40000.0;
  let snap = floor(frame.camPos.xz / 64.0) * 64.0;
  var o: WOut;
  o.world = vec3f(warped.x + snap.x, frame.world.w, warped.y + snap.y);
  o.pos = frame.viewProj * vec4f(o.world, 1.0);
  return o;
}

fn waveNormal(p: vec2f, t: f32, dist: f32) -> vec3f {
  var g = vec2f(0.0);
  let fade = clamp(1.0 - dist / 3000.0, 0.15, 1.0);
  for (var k = 0; k < 6; k++) {
    let fk = f32(k);
    let ang = fk * 1.7 + 0.3;
    let dir = vec2f(cos(ang), sin(ang));
    let freq = 0.06 * pow(1.85, fk);
    let amp = 0.6 / pow(1.9, fk);
    let ph = dot(dir, p) * freq + t * sqrt(9.8 * freq) * 1.2;
    g += dir * cos(ph) * amp * freq;
  }
  g += (vec2f(valueNoise(p * 0.8 + t * 0.3), valueNoise(p * 0.8 - t * 0.27 + 7.0)) - 0.5) * 0.25;
  // Rain roughens the surface.
  g += (hash22(floor(p * 6.0) + floor(t * 8.0)) - 0.5) * frame.weather.y * 0.3;
  return normalize(vec3f(-g.x * fade, 1.0, -g.y * fade));
}

@fragment fn fsWater(i: WOut) -> GOut {
  let dist = distance(i.world, frame.camPos.xyz);
  let n = waveNormal(i.world.xz, frame.time.x, dist);
  var s = defaultSurf(n);
  let depth = frame.world.w - heightAt(i.world.xz);
  let shallow = clamp(depth / 6.0, 0.0, 1.0);
  s.albedo = mix(vec3f(0.06, 0.12, 0.1), vec3f(0.01, 0.035, 0.05), shallow);
  s.rough = 0.04 + frame.weather.y * 0.1;
  s.cls = CLASS_WATER;
  // Shore foam.
  let foam = smoothstep(0.6, 0.0, depth) * (0.5 + 0.5 * valueNoise(i.world.xz * 2.0 + frame.time.x * 0.5));
  s.albedo = mix(s.albedo, vec3f(0.7), foam * 0.6);
  s.rough = mix(s.rough, 0.7, foam);
  return writeG(s, i.world, i.pos);
}
