// Shared definitions included at the top of every shader.

struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  prevViewProj: mat4x4f,
  view: mat4x4f,
  proj: mat4x4f,
  camPos: vec4f,        // xyz, near plane
  sunDir: vec4f,        // toward the sun, w = sun above horizon factor
  sunColor: vec4f,      // rgb radiance at ground (with transmittance), w = sun disk intensity
  moonDir: vec4f,       // toward the moon, w = moon light strength
  resolution: vec4f,    // w, h, 1/w, 1/h
  jitter: vec4f,        // current xy, previous zw (NDC units)
  time: vec4f,          // seconds, dt, frame index, night factor (0 day .. 1 night)
  weather: vec4f,       // cloud cover, rain, wetness, fog
  wind: vec4f,          // dir x, dir z, speed, lightning flash
  world: vec4f,         // world size, heightmap cell, heightmap n, sea level
  cascadeSplits: vec4f, // view depth of each cascade end
  cascades: array<mat4x4f, 4>,
  exposure: vec4f,      // x = exposure multiplier
  skyAmbient: vec4f,    // sky irradiance (rgb) from above
  groundAmbient: vec4f, // irradiance from below (bounce + city glow)
  cityGlow: vec4f,      // rgb night light pollution
  misc: vec4f,          // x = debug view, y = quality, z = sun disk size, w = moon phase
  off: vec4u,           // x = ablation bits, y = material ids drawn flat, z = ablation bits 32+ (?off=..., render/ablation.ts); 0 normally; w = sign locale (city/signs.ts SIGN_LOCALES: 0 Tokyo, 1 New York)
  upscale: vec4f,       // output (display) w, h, sharpening strength, render scale (internal / output)
  extra: vec4f,         // x = cloud mode (0 off, 1 every texel, 2 one 8x4 block in each 2x2 of blocks per frame), y = cloud step scale, z = frames of cloud history, w = bloom strength
};

const PI = 3.14159265359;

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x *= x + 33.33;
  x *= x + x;
  return fract(x);
}

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2f) -> vec2f {
  var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

fn hash31(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

fn hashu(x: u32) -> u32 {
  var v = x;
  v = (v ^ 61u) ^ (v >> 16u);
  v *= 9u;
  v = v ^ (v >> 4u);
  v *= 0x27d4eb2du;
  v = v ^ (v >> 15u);
  return v;
}

fn hashuf(x: u32) -> f32 {
  return f32(hashu(x) & 0xffffffu) / 16777216.0;
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1, 0));
  let c = hash21(i + vec2f(0, 1));
  let d = hash21(i + vec2f(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm2(p: vec2f) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    s += a * valueNoise(q);
    q = q * 2.03 + vec2f(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn octDecode(v: u32) -> vec3f {
  let e = vec2f(f32(v & 0xffffu), f32(v >> 16u)) / 65535.0 * 2.0 - 1.0;
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

// Octahedral encode/decode into [-1,1]^2 for G-buffer normals.
fn octWrap(v: vec2f) -> vec2f {
  return (1.0 - abs(v.yx)) * select(vec2f(-1.0), vec2f(1.0), v.xy >= vec2f(0.0));
}

fn encodeNormal(n: vec3f) -> vec2f {
  var p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) { p = octWrap(p); }
  return p;
}

fn decodeNormal(e: vec2f) -> vec3f {
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

fn srgbToLinear(c: vec3f) -> vec3f {
  return pow(c, vec3f(2.2));
}

// Traffic signal state shared with the CPU traffic simulation (see traffic.ts):
// returns 0 = go (blue/green), 1 = yellow, 2 = red for a signal group.
fn signalState(t: f32, phase: f32, group: u32) -> u32 {
  let cycle = 44.0;
  var x = fract((t + phase * 0.17) / cycle) * cycle;
  if (group == 1u) { x = fract((x + 22.0) / cycle) * cycle; }
  if (x < 17.0) { return 0u; }
  if (x < 20.0) { return 1u; }
  return 2u;
}

fn hash33(p: vec3f) -> vec3f {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

// Normal from three samples of a height field (tangent-space finite difference).
fn bumpNormal(n: vec3f, t: vec3f, b: vec3f, h0: f32, ht: f32, hb: f32, eps: f32, strength: f32) -> vec3f {
  return normalize(n - (t * (ht - h0) + b * (hb - h0)) * (strength / eps));
}

fn bumpFade(world: vec3f) -> f32 {
  return 1.0 / (1.0 + distance(world, frame.camPos.xyz) / 60.0);
}
