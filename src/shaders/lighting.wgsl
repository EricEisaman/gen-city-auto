// Tiled deferred lighting (compute). Each 16x16 tile culls the light list
// against its screen rectangle and depth range, then shades its pixels with:
// sun/moon + cascaded shadows, point lights, sky ambient, screen-space
// reflections for wet/glossy surfaces, aerial perspective and weather fog.

struct Light { pos: vec3f, radius: f32, color: vec3f, kind: f32 };
struct LightBuf { count: u32, pad0: u32, pad1: u32, pad2: u32, lights: array<Light> };

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormal: texture_2d<f32>;
@group(1) @binding(2) var gEmissive: texture_2d<f32>;
@group(1) @binding(3) var gDepth: texture_depth_2d;
@group(1) @binding(4) var shadowMap: texture_depth_2d_array;
@group(1) @binding(5) var shadowSampler: sampler_comparison;
@group(1) @binding(6) var skyView: texture_2d<f32>;
@group(1) @binding(7) var transmittanceTex: texture_2d<f32>;
@group(1) @binding(8) var apVolume: texture_3d<f32>;
@group(1) @binding(9) var linearSampler: sampler;
@group(1) @binding(10) var cloudTex: texture_2d<f32>;
@group(1) @binding(11) var prevColor: texture_2d<f32>;
@group(1) @binding(12) var outColor: texture_storage_2d<rgba16float, write>;
@group(1) @binding(13) var<storage, read> lightBuf: LightBuf;
@group(1) @binding(14) var aoTex: texture_2d<f32>;

// Vehicles for contact occlusion: [pos.xyz, unused], [right.xz, fwd.xz], [half x, y, z, 0].
struct Contact { a: vec4f, b: vec4f, c: vec4f };
struct ContactBuf { count: u32, pad0: u32, pad1: u32, pad2: u32, items: array<Contact> };
@group(1) @binding(15) var<storage, read> contacts: ContactBuf;
@group(1) @binding(16) var skyline: texture_2d<f32>;

// Fraction of the sky visible from a point, from a horizon search over the
// building/terrain height map (8 azimuths x 6 steps). Walls only count the
// half-space they face.
fn skyVisibility(world: vec3f, n: vec3f) -> f32 {
  let N = f32(textureDimensions(skyline).x);
  let size = frame.world.x;
  var occl = 0.0;
  var cnt = 0.0;
  for (var a = 0; a < 8; a++) {
    let ang = f32(a) * 0.785398 + 0.39;
    let dir = vec2f(cos(ang), sin(ang));
    if (n.y < 0.7 && dot(dir, n.xz) < -0.2) { continue; }
    var maxS = 0.0;
    var dist = 2.0;
    for (var k = 0; k < 6; k++) {
      let p = world.xz + dir * dist;
      let g = vec2i((p + size * 0.5) / size * N);
      if (all(g >= vec2i(0)) && all(g < vec2i(i32(N)))) {
        let h = textureLoad(skyline, g, 0).r;
        let s = (h - world.y) / length(vec2f(dist, h - world.y));
        maxS = max(maxS, s);
      }
      dist *= 2.0;
    }
    occl += maxS * maxS;
    cnt += 1.0;
  }
  return clamp(1.0 - occl / max(cnt, 1.0), 0.15, 1.0);
}

// Reflection of the city: march the reflected ray over the skyline height map.
// A hit returns an approximate facade (wall + window grid, lit windows at
// night) so glass, paint and wet streets reflect buildings beyond the screen.
fn skylineAt(p: vec3f, N: f32, size: f32) -> f32 {
  let g = vec2i((p.xz + size * 0.5) / size * N);
  if (any(g < vec2i(0)) || any(g >= vec2i(i32(N)))) { return -1e9; }
  return textureLoad(skyline, g, 0).r;
}

fn cityReflection(world: vec3f, r: vec3f) -> vec4f {
  let N = f32(textureDimensions(skyline).x);
  let size = frame.world.x;
  var t = 1.5;
  var prevT = 0.0;
  for (var i = 0; i < 28; i++) {
    let p = world + r * t;
    let h = skylineAt(p, N, size);
    if (h < -1e8) { break; }
    if (p.y < h) {
      // Refine onto the facade surface so the window pattern is coherent
      // (an overshoot inside the building slices it into shards).
      var lo = prevT;
      var hi = t;
      for (var k = 0; k < 6; k++) {
        let m = (lo + hi) * 0.5;
        let q = world + r * m;
        if (q.y < skylineAt(q, N, size)) { hi = m; } else { lo = m; }
      }
      let tq = hi;
      let q = world + r * tq;
      // Facade normal approximated as facing back along the ray.
      let fn_ = normalize(vec3f(-r.x, 0.0, -r.z));
      let along = dot(q.xz, vec2f(-fn_.z, fn_.x));
      let cell = vec2f(floor(along / 3.0), floor(q.y / 3.4));
      let win = step(0.35, fract(along / 3.0)) * step(0.3, fract(q.y / 3.4));
      let wall = mix(vec3f(0.35, 0.34, 0.32), vec3f(0.05, 0.06, 0.07), win * 0.8);
      var c = wall * (frame.skyAmbient.rgb * 0.9 + frame.sunColor.rgb * max(dot(fn_, frame.sunDir.xyz), 0.0) * 0.25);
      let lit = step(1.0 - mix(0.05, 0.35, frame.time.w), hash21(cell + floor(q.xz / 40.0)));
      c += win * lit * vec3f(1.0, 0.75, 0.45) * mix(0.1, 0.6, frame.time.w);
      // Haze with distance.
      c = mix(c, frame.skyAmbient.rgb + frame.cityGlow.rgb, clamp(tq / 1500.0, 0.0, 0.8));
      return vec4f(c, 1.0);
    }
    if (p.y > 260.0 && r.y > 0.0) { break; }
    prevT = t;
    t *= 1.22;
  }
  return vec4f(0.0);
}

// Sky irradiance (as reflected radiance for albedo 1) from the sky-view LUT,
// cosine-weighted around the normal, blended toward overcast grey by clouds.
fn skyIrradiance(n: vec3f) -> vec3f {
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.y) < 0.95);
  let t = normalize(cross(up, n));
  let b = cross(n, t);
  var sum = vec3f(0.0);
  for (var k = 0; k < 5; k++) {
    var d = n;
    if (k > 0) {
      let a = f32(k) * 1.5708;
      d = normalize(n + (t * cos(a) + b * sin(a)) * 0.75);
    }
    sum += skyRadiance(normalize(vec3f(d.x, max(d.y, 0.03), d.z)));
  }
  var clear = sum / 5.0 * smoothstep(-0.6, 0.4, n.y);
  // Skylight saturation tamed: a camera white-balances most of the blue cast away.
  clear = mix(vec3f(luminance(clear)), clear, mix(0.7, 0.45, smoothstep(0.35, 0.05, frame.sunDir.y)));
  return mix(clear * 0.8, frame.skyAmbient.rgb, clamp(frame.weather.x * 1.2 - 0.2, 0.0, 1.0)) + frame.cityGlow.rgb * 0.25;
}

fn contactOcclusion(world: vec3f) -> f32 {
  var occ = 0.0;
  for (var i = 0u; i < contacts.count; i++) {
    let C = contacts.items[i];
    let d = world - C.a.xyz;
    if (abs(d.x) > 8.0 || abs(d.z) > 8.0) { continue; }
    let q = vec3f(dot(d.xz, C.b.xy), d.y, dot(d.xz, C.b.zw));
    let h = C.c.xyz;
    var o = (1.0 - smoothstep(0.6, 1.0, length(q.xz / (h.xz + 0.4)))) * clamp(1.0 - q.y / 1.0, 0.0, 1.0) * 0.8;
    for (var w = 0; w < 4; w++) {
      let wp = vec2f(select(-1.0, 1.0, (w & 1) == 1) * h.x * 0.85, select(-1.0, 1.0, (w & 2) == 2) * h.z * 0.68);
      let dd = q.xz - wp;
      o = max(o, 0.9 * exp(-dot(dd, dd) / 0.08) * clamp(1.0 - q.y / 0.6, 0.0, 1.0));
    }
    occ = max(occ, o);
  }
  return occ;
}

const R_GROUND = 6360.0;
const R_TOP = 6460.0;
const SUN_ILLUMINANCE = 12.0;
const TILE = 16u;
const MAX_TILE_LIGHTS = 256u;

var<workgroup> tileMinZ: atomic<u32>;
var<workgroup> tileMaxZ: atomic<u32>;
var<workgroup> tileCount: atomic<u32>;
var<workgroup> tileLights: array<u32, 256>;

fn worldFromDepth(px: vec2f, depth: f32) -> vec3f {
  let uv = px * frame.resolution.zw;
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let w = frame.invViewProj * ndc;
  return w.xyz / w.w;
}

fn viewDepth(depth: f32) -> f32 {
  // Reverse-Z infinite projection: depth = near / z.
  return frame.camPos.w / max(depth, 1e-7);
}

fn skyViewUv(d: vec3f) -> vec2f {
  let lat = asin(clamp(d.y, -1.0, 1.0));
  let vc = sign(lat) * sqrt(abs(lat) / (PI * 0.5));
  let az = atan2(d.z, d.x);
  return vec2f(az / PI * 0.5 + 0.5, vc * 0.5 + 0.5);
}

fn skyRadiance(d: vec3f) -> vec3f {
  return textureSampleLevel(skyView, linearSampler, skyViewUv(d), 0.0).rgb;
}

fn transmittanceUv(r: f32, mu: f32) -> vec2f {
  let H = sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND);
  let rho = sqrt(max(0.0, r * r - R_GROUND * R_GROUND));
  let disc = r * r * (mu * mu - 1.0) + R_TOP * R_TOP;
  let d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  return vec2f((d - (R_TOP - r)) / (rho + H - (R_TOP - r)), rho / H);
}

fn starLayer(d: vec3f, scale: f32, density: f32, gain: f32) -> vec3f {
  let p = d * scale;
  let c = floor(p);
  let h = hash31(c);
  if (h < 1.0 - density) { return vec3f(0.0); }
  // Jittered position inside the cell, magnitude from a steep power law.
  let o = hash33(c + 7.0) * 0.6 + 0.2;
  let f = fract(p) - o;
  let mag = pow((h - (1.0 - density)) / density, 6.0);
  let s = exp(-dot(f, f) * scale * 0.5) * mag * gain;
  let tw = 0.75 + 0.25 * sin(frame.time.x * (2.0 + h * 5.0) + h * 100.0);
  let temp = hash31(c + 3.0);
  return vec3f(s * tw) * mix(vec3f(1.0, 0.8, 0.6), vec3f(0.75, 0.85, 1.0), temp);
}

fn stars(d: vec3f) -> vec3f {
  // A few bright stars plus a field of faint ones, fading out in the
  // thick air near the horizon where the city glow drowns them.
  let alt = smoothstep(0.02, 0.35, d.y);
  return (starLayer(d, 220.0, 0.012, 60.0) + starLayer(d, 520.0, 0.02, 8.0)) * alt;
}

// Thin high-altitude cirrus on a plane at ~9 km: streaky fbm stretched along the wind.
fn cirrus(d: vec3f) -> f32 {
  if (d.y < 0.01) { return 0.0; }
  let p = d.xz / d.y * 9.0 + vec2f(frame.wind.x, frame.wind.y) * frame.time.x * 0.004;
  let w = normalize(vec2f(frame.wind.x, frame.wind.y) + vec2f(0.3, 0.1));
  let q = vec2f(dot(p, w), dot(p, vec2f(-w.y, w.x)) * 4.0);
  let n = fbm2(q * 0.35 + fbm2(q * 0.9) * 1.5);
  let amount = mix(0.18, 0.5, clamp(frame.weather.x * 2.0, 0.0, 1.0));
  // Large-scale patches so cirrus comes in bands rather than covering the sky.
  let bands = smoothstep(0.42, 0.7, fbm2(p * 0.05 + vec2f(3.1, 7.7)) + frame.weather.x * 0.3);
  return smoothstep(1.0 - amount, 1.05 - amount * 0.5, n) * bands * smoothstep(0.01, 0.12, d.y) * 0.55;
}

const CLOUD_BASE = 1500.0;

// The colour everything converges to at the horizon: clear-sky haze, greyed by
// cloud cover, plus night light pollution. Distant clouds, the far edge of the
// world and the sky below the horizon all blend to this so they meet seamlessly.
fn horizonColor(d: vec3f) -> vec3f {
  let s = skyRadiance(normalize(vec3f(d.x, max(d.y, 0.012), d.z)));
  let grey = vec3f(luminance(s)) * vec3f(0.93, 0.96, 1.0) * mix(1.0, 0.75, frame.weather.y);
  var c = mix(s, grey, clamp(frame.weather.x * 1.1 - 0.15, 0.0, 0.9));
  c += (vec3f(0.0012, 0.0018, 0.004) + frame.cityGlow.rgb * (0.6 + frame.weather.x * 1.5)) * frame.time.w;
  return c;
}

// What reflections see below the horizon: sunlit pavement and facades
// (groundAmbient is the radiance bounced up from the street).
fn groundRadiance() -> vec3f {
  return frame.groundAmbient.rgb * 1.1 + frame.cityGlow.rgb;
}

fn skyPixel(d: vec3f, uv: vec2f) -> vec3f {
  var c = skyRadiance(normalize(vec3f(d.x, max(d.y, 0.012), d.z)));
  let night = frame.time.w;
  let r = R_GROUND + frame.camPos.y * 0.001;
  let T = textureSampleLevel(transmittanceTex, linearSampler, transmittanceUv(r, d.y), 0.0).rgb;
  // Sun disk.
  let cs = dot(d, frame.sunDir.xyz);
  let sunDisk = smoothstep(0.99996, 0.99999, cs);
  c += T * sunDisk * 2500.0;
  // Moon disk with phase shading.
  let cm = dot(d, frame.moonDir.xyz);
  if (cm > 0.99985) {
    let tangent = normalize(cross(frame.moonDir.xyz, vec3f(0.0, 1.0, 0.0)));
    let off = dot(d - frame.moonDir.xyz * cm, tangent) / 0.0173;
    let lit = smoothstep(-0.2, 0.2, off * 2.0 - (frame.misc.w * 2.0 - 1.0));
    c += T * vec3f(1.0, 0.97, 0.9) * mix(0.03, 1.2, lit) * smoothstep(0.99985, 0.9999, cm);
  }
  c += stars(d) * night * T * (1.0 - frame.weather.x);
  // Cirrus: lit by the sun (forward scattering) or by moon and city glow at night.
  {
    let ci = cirrus(d);
    let fwd = 1.0 + 2.5 * pow(max(dot(d, frame.sunDir.xyz), 0.0), 6.0);
    let lit = frame.sunColor.rgb * 0.06 * fwd + frame.skyAmbient.rgb * 0.35 + frame.cityGlow.rgb * 1.2 * night;
    c = mix(c, lit + c * 0.4, ci);
  }
  // Night sky: deep blue plus orange light pollution near the horizon.
  let horizon = exp(-max(d.y, 0.0) * 6.0);
  c += (vec3f(0.0012, 0.0018, 0.004) + frame.cityGlow.rgb * (0.1 + 0.9 * horizon) * (0.6 + frame.weather.x * 1.5)) * night;
  // Under cloud cover the low sky turns to grey haze.
  let hz = horizonColor(d);
  c = mix(c, hz, frame.weather.x * smoothstep(0.25, 0.0, d.y));
  // Clouds; distant ones take on the horizon colour (aerial perspective).
  {
    let cl = textureSampleLevel(cloudTex, linearSampler, uv, 0.0);
    let tc = max(CLOUD_BASE - frame.camPos.y, 100.0) / max(d.y, 0.003);
    let haze = 1.0 - exp(-tc / 14000.0);
    c = c * cl.a + mix(cl.rgb, hz * (1.0 - cl.a), haze);
  }
  // Below the horizon (beyond the world) continue the horizon haze.
  c = mix(c, hz, smoothstep(0.004, -0.004, d.y));
  // Lightning flash lights the whole sky.
  c += vec3f(0.6, 0.65, 0.9) * frame.wind.w * 3.0 * frame.weather.x;
  return c;
}

// Depth-aware 4x4 blur + upsample of the half-resolution AO (removes the
// interleaved sampling pattern without dark halos at edges).
fn bilateralAo(pxf: vec2f, vd: f32) -> f32 {
  let half = vec2i(textureDimensions(aoTex)) - 1;
  let hp = (pxf - 1.0) * 0.5;
  let c = vec2i(floor(hp));
  var sum = 0.0;
  var wsum = 0.0;
  for (var y = -1; y <= 2; y++) {
    for (var x = -1; x <= 2; x++) {
      let q = clamp(c + vec2i(x, y), vec2i(0), half);
      let d = textureLoad(gDepth, min(q * 2, vec2i(frame.resolution.xy) - 1), 0);
      let z = viewDepth(d);
      let w = exp(-abs(z - vd) / (0.02 * vd + 0.03)) + 1e-4;
      sum += textureLoad(aoTex, q, 0).r * w;
      wsum += w;
    }
  }
  return sum / max(wsum, 1e-4);
}

fn D_GGX(nh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn V_SmithJoint(nv: f32, nl: f32, a: f32) -> f32 {
  let gv = nl * sqrt(nv * nv * (1.0 - a * a) + a * a);
  let gl = nv * sqrt(nl * nl * (1.0 - a * a) + a * a);
  return 0.5 / max(gv + gl, 1e-5);
}

fn F_Schlick(f0: vec3f, vh: f32) -> vec3f {
  return f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
}

fn brdf(n: vec3f, v: vec3f, l: vec3f, albedo: vec3f, f0: vec3f, rough: f32, metal: f32) -> vec3f {
  let h = normalize(v + l);
  let nl = max(dot(n, l), 0.0);
  let nv = max(dot(n, v), 1e-4);
  let nh = max(dot(n, h), 0.0);
  let vh = max(dot(v, h), 0.0);
  let a = max(rough * rough, 0.002);
  let F = F_Schlick(f0, vh);
  let spec = D_GGX(nh, a) * V_SmithJoint(nv, nl, a) * F;
  let diff = albedo * (1.0 - metal) * (1.0 - F) / PI;
  return (diff + spec) * nl;
}

fn shadow(world: vec3f, n: vec3f, vdepth: f32) -> f32 {
  var cascade = 0u;
  for (var k = 0u; k < 3u; k++) {
    if (vdepth > frame.cascadeSplits[k]) { cascade = k + 1u; }
  }
  if (cascade >= 4u) { return 1.0; }
  let texel = frame.cascadeSplits[cascade] / 1024.0;
  let p = world + n * texel * 1.5;
  let lp = frame.cascades[cascade] * vec4f(p, 1.0);
  let uv = lp.xy * vec2f(0.5, -0.5) + 0.5;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  let z = lp.z - 0.0005;
  let size = vec2f(textureDimensions(shadowMap));
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) / size, i32(cascade), z);
    }
  }
  var s = sum / 9.0;
  // Fade out the last cascade.
  if (cascade == 3u) { s = mix(s, 1.0, smoothstep(0.8, 1.0, vdepth / frame.cascadeSplits[3])); }
  return s;
}

fn cloudShadow(world: vec3f) -> f32 {
  let p = world.xz + frame.sunDir.xz / max(frame.sunDir.y, 0.1) * 2000.0 + frame.wind.xy * frame.time.x * 8.0;
  let n = fbm2(p * 0.0004);
  return mix(1.0, 0.35, smoothstep(1.0 - frame.weather.x, 1.15 - frame.weather.x, n) * frame.weather.x);
}

fn ssr(world: vec3f, n: vec3f, v: vec3f, px: vec2f, rough: f32, aniso: bool) -> vec4f {
  var r = reflect(-v, n);
  // Roughness jitter (resolved by TAA). Wet streets stretch reflections into
  // vertical streaks toward the camera.
  let j = hash22(px + frame.time.z * 0.618) - 0.5;
  if (aniso) {
    let side = normalize(cross(n, v));
    let fwd = cross(side, n);
    r = normalize(r + side * j.x * rough * 0.08 + fwd * j.y * rough * 0.7);
  } else {
    r = normalize(r + vec3f(j.x, 0.0, j.y) * rough * 0.6);
  }
  if (dot(r, n) < 0.0) { return vec4f(0.0); }
  var t = 0.4 + hash21(px + frame.time.z) * 0.6;
  var prevT = 0.0;
  for (var i = 0; i < 40; i++) {
    let p = world + r * t;
    let clip = frame.viewProj * vec4f(p, 1.0);
    if (clip.w <= 0.0) { break; }
    let ndc = clip.xyz / clip.w;
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { break; }
    let sceneDepth = textureLoad(gDepth, vec2i(uv * frame.resolution.xy), 0);
    let rayView = clip.w;
    let sceneView = viewDepth(sceneDepth);
    let diff = rayView - sceneView;
    if (diff > 0.0 && diff < max(0.6, (t - prevT) * 1.5) && sceneDepth > 0.0) {
      // Reproject into the previous frame's lit image.
      let prev = frame.prevViewProj * vec4f(p, 1.0);
      let puv = prev.xy / prev.w * vec2f(0.5, -0.5) + 0.5;
      let edge = min(min(puv.x, 1.0 - puv.x), min(puv.y, 1.0 - puv.y));
      let fade = smoothstep(0.0, 0.08, edge) * (1.0 - f32(i) / 40.0);
      var c = textureSampleLevel(prevColor, linearSampler, puv, 0.0).rgb;
      // Clamp fireflies (headlights, sun glints) that sparkle in noisy reflections.
      c = c / (1.0 + luminance(c) * 0.08);
      return vec4f(c, fade);
    }
    prevT = t;
    t = t * 1.18 + 0.3;
  }
  return vec4f(0.0);
}

fn applyFog(c: vec3f, world: vec3f, uv: vec2f, dist: f32, rd: vec3f) -> vec3f {
  let dKm = dist * 0.001;
  let slice = sqrt(clamp(dKm / 24.0, 0.0, 1.0)) * 32.0;
  let w = clamp((slice - 0.5) / 32.0, 0.0, 1.0);
  let ap = textureSampleLevel(apVolume, linearSampler, vec3f(uv, w), 0.0);
  var col = c * ap.a + ap.rgb;
  // Weather fog: height-based mist that thickens with rain.
  let fogD = frame.weather.w;
  if (fogD > 0.0) {
    let heightFalloff = 0.012;
    let camH = frame.camPos.y;
    let dh = rd.y * dist;
    var integral = dist;
    if (abs(dh) > 0.01) { integral = (1.0 - exp(-heightFalloff * dh)) / (heightFalloff * rd.y); }
    let amount = 1.0 - exp(-fogD * 0.004 * exp(-heightFalloff * camH) * integral);
    let ambL = luminance(frame.skyAmbient.rgb * 0.9 + frame.cityGlow.rgb);
    let fogCol = vec3f(ambL) * vec3f(0.86, 0.92, 1.0) + frame.cityGlow.rgb * 0.4 + frame.sunColor.rgb * 0.08 * pow(max(dot(rd, frame.sunDir.xyz), 0.0), 8.0);
    col = mix(col, fogCol, clamp(amount, 0.0, 1.0));
  }
  return col;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wid: vec3u) {
  let size = vec2u(frame.resolution.xy);
  let px = min(gid.xy, size - 1u);
  let depth = textureLoad(gDepth, vec2i(px), 0);
  if (li == 0u) {
    atomicStore(&tileMinZ, 0x7f7fffffu);
    atomicStore(&tileMaxZ, 0u);
    atomicStore(&tileCount, 0u);
  }
  workgroupBarrier();
  let vd = viewDepth(depth);
  if (depth > 0.0) {
    atomicMin(&tileMinZ, bitcast<u32>(vd));
    atomicMax(&tileMaxZ, bitcast<u32>(vd));
  }
  workgroupBarrier();
  let zMin = bitcast<f32>(atomicLoad(&tileMinZ));
  let zMax = bitcast<f32>(atomicLoad(&tileMaxZ));
  // Cull lights against the tile (screen rect + depth range), 256 threads in parallel.
  let tileMin = vec2f(wid.xy * TILE);
  let tileMax = tileMin + f32(TILE);
  for (var i = li; i < lightBuf.count; i += 256u) {
    let L = lightBuf.lights[i];
    let vp = frame.view * vec4f(L.pos, 1.0);
    let lz = -vp.z;
    if (lz + L.radius < zMin || lz - L.radius > zMax) { continue; }
    // Conservative screen-space bounds of the light sphere.
    let clip = frame.viewProj * vec4f(L.pos, 1.0);
    var inside = true;
    if (lz > L.radius) {
      let c = clip.xy / clip.w;
      let spx = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5) * frame.resolution.xy;
      let rpx = L.radius * frame.proj[1][1] * 0.5 * frame.resolution.y / (lz - L.radius * 0.9);
      inside = all(spx + rpx >= tileMin) && all(spx - rpx <= tileMax);
    }
    if (!inside) { continue; }
    let slot = atomicAdd(&tileCount, 1u);
    if (slot < MAX_TILE_LIGHTS) { tileLights[slot] = i; }
  }
  workgroupBarrier();
  if (any(gid.xy >= size)) { return; }

  let pxf = vec2f(px) + 0.5;
  let uv = pxf * frame.resolution.zw;
  let world = worldFromDepth(pxf, max(depth, 1e-7));
  let rd = normalize(world - frame.camPos.xyz);
  if (u32(frame.misc.x) == 7u) {
    let cl = textureSampleLevel(cloudTex, linearSampler, uv, 0.0);
    textureStore(outColor, px, vec4f(cl.rgb + vec3f(0.0, 0.0, 1.0 - cl.a), 1.0));
    return;
  }
  if (depth <= 0.0) {
    let sky = skyPixel(rd, uv);
    textureStore(outColor, px, vec4f(sky, 1.0));
    return;
  }
  let a = textureLoad(gAlbedo, px, 0);
  let nr = textureLoad(gNormal, px, 0);
  let em = textureLoad(gEmissive, px, 0);
  let n = decodeNormal(nr.xy);
  let rough = nr.z;
  let metal = nr.w;
  let cls = u32(em.a * 8.0 + 0.5);
  var albedo = a.rgb;
  let v = -rd;
  var f0 = mix(vec3f(0.04), albedo, metal);
  if (cls == CLASS_GLASS) { f0 = vec3f(0.06) + albedo * 0.5; }
  if (cls == CLASS_WATER) { f0 = vec3f(0.02); }
  let dist = length(world - frame.camPos.xyz);
  var ao = a.a * bilateralAo(pxf, vd);
  var contactOcc = 0.0;
  if (n.y > 0.6 && dist < 150.0 && cls != CLASS_VEHICLE) {
    contactOcc = contactOcclusion(world);
    ao *= 1.0 - contactOcc;
  }

  let dbg = u32(frame.misc.x);
  var color = vec3f(0.0);
  // Sun.
  if (frame.sunDir.w > 0.0) {
    let sh = shadow(world, n, vd) * cloudShadow(world);
    color += brdf(n, v, frame.sunDir.xyz, albedo, f0, rough, metal) * frame.sunColor.rgb * sh * 1.35;
    if (cls == CLASS_FOLIAGE) {
      // Cheap translucency for leaves.
      color += albedo * frame.sunColor.rgb * 0.25 * max(dot(-n, frame.sunDir.xyz), 0.0) * sh;
    }
  }
  // Moon.
  if (frame.moonDir.w > 0.0) {
    let moonCol = vec3f(0.5, 0.6, 0.8) * frame.moonDir.w * 0.06;
    color += brdf(n, v, frame.moonDir.xyz, albedo, f0, rough, metal) * moonCol * shadow(world, n, vd);
  }
  // Point lights.
  let count = min(atomicLoad(&tileCount), MAX_TILE_LIGHTS);
  for (var k = 0u; k < count; k++) {
    let L = lightBuf.lights[tileLights[k]];
    let dl = L.pos - world;
    let d2 = dot(dl, dl);
    if (d2 > L.radius * L.radius) { continue; }
    let d = sqrt(d2);
    let l = dl / d;
    let win = pow(clamp(1.0 - pow(d / L.radius, 4.0), 0.0, 1.0), 2.0);
    let atten = win / (d2 + 1.0);
    var lc = L.color;
    if (L.kind >= 5.0) {
      // Vehicle headlight: forward cone, slightly downward.
      let a = fract(L.kind) * 6.2831853;
      let dir = normalize(vec3f(sin(a), -0.12, cos(a)));
      lc *= smoothstep(0.9, 0.97, dot(-l, dir));
    } else if (L.kind < 0.5) {
      // Street lights point down.
      lc *= mix(0.03, 1.0, smoothstep(0.45, 0.85, l.y)) * (140.0 / 60.0);
    }
    let foliageK = select(1.0, 0.4, cls == CLASS_FOLIAGE);
    // Point lights cast no shadows: the vehicle contact term stands in under cars.
    color += brdf(n, v, l, albedo, f0, max(rough, 0.08), metal) * lc * atten * 60.0 * foliageK * (1.0 - contactOcc * 0.85);
  }
  // Ambient: hemisphere sky + ground bounce.
  var skyVis = 1.0;
  if (dist < 1500.0 && frame.misc.y > 0.5) { skyVis = mix(skyVisibility(world, n), 1.0, smoothstep(900.0, 1500.0, dist)); }
  let hemi = n.y * 0.5 + 0.5;
  // Bounce light from sunlit facades and pavement, stronger deep in canyons.
  let bounce = frame.sunColor.rgb * vec3f(1.0, 0.92, 0.82) * max(frame.sunDir.y, 0.0) * 0.06 * (1.3 - skyVis * 0.6);
  // Light bounced up from sunlit pavement onto downward-facing surfaces.
  let groundBounce = frame.groundAmbient.rgb + frame.sunColor.rgb * max(frame.sunDir.y, 0.0) * 0.07 * mix(0.6, 1.0, skyVis);
  let skyAmb = groundBounce * (1.0 - hemi) + skyIrradiance(n) * hemi * skyVis + bounce;
  let diffAmb = albedo * (1.0 - metal) * skyAmb * ao;
  color += diffAmb;
  // Specular ambient: sky reflection, replaced by SSR where available.
  let nv = max(dot(n, v), 1e-3);
  let Fa = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  var refl = reflect(-v, n);
  // Wave facets tilted past the horizon still see the sky (the far shore is
  // handled by the city reflection), never the dark ground term.
  if (cls == CLASS_WATER) { refl = normalize(vec3f(refl.x, max(refl.y, 0.015), refl.z)); }
  var env = skyRadiance(normalize(vec3f(refl.x, max(refl.y, 0.02), refl.z)));
  // Overcast skies reflect grey cloud, not the clear-sky LUT.
  env = mix(env, frame.skyAmbient.rgb * 1.3 + frame.cityGlow.rgb, clamp(frame.weather.x * 1.3 - 0.3, 0.0, 1.0));
  // Below the horizon reflections see the city: darken toward ground ambient.
  // Open water reflects the sky down to the horizon.
  let reflLo = select(0.15, 0.01, cls == CLASS_WATER);
  env = mix(groundRadiance(), env, smoothstep(-0.08, reflLo, refl.y));
  if (rough < 0.5 && dist < 800.0 && frame.misc.y > 0.5 && cls != CLASS_VEHICLE) {
    let cr = cityReflection(world + n * 0.3, refl);
    env = mix(env, cr.rgb, cr.a);
  }
  env *= mix(1.0, 0.25, rough) * mix(0.35, 1.0, skyVis);
  // Screen-space reflections only nearby: far away the depth tolerance grows
  // to kilometres and grazing rays report false hits.
  if (rough < 0.35 && frame.misc.y > 0.5 && dist < 1200.0 && cls != CLASS_GLASS) {
    let r = ssr(world, n, v, pxf, rough, cls == CLASS_GROUND && frame.weather.z > 0.3);
    env = mix(env, r.rgb, r.a * smoothstep(1200.0, 700.0, dist));
  }
  var specOcc = ao * ao;
  color += min(env * Fa * specOcc * (1.0 - contactOcc), vec3f(6.0));
  if (cls == CLASS_VEHICLE && metal < 0.95) {
    // Clear coat: a sharp dielectric layer over the paint.
    let fc = min(0.04 + 0.96 * pow(1.0 - nv, 5.0), 0.45);
    let envSharp = skyRadiance(normalize(vec3f(refl.x, max(refl.y, 0.02), refl.z)));
    var coatEnv = mix(groundRadiance(), envSharp, smoothstep(-0.08, 0.15, refl.y));
    color += coatEnv * fc * specOcc;
    if (frame.sunDir.w > 0.0) {
      let hc = normalize(v + frame.sunDir.xyz);
      color += frame.sunColor.rgb * D_GGX(max(dot(n, hc), 0.0), 0.05 * 0.05) * 1.0 * fc * max(dot(n, frame.sunDir.xyz), 0.0) * shadow(world, n, vd);
    }
  }
  if (dbg == 8u) { color = vec3f(ao); }
  color += em.rgb;
  color = applyFog(color, world, uv, dist, rd);
  // Distant geometry and the sea dissolve into the horizon colour, fully by
  // the far edge of the outskirts so the world never ends in a hard line.
  let beyond = max(abs(world.x), abs(world.z)) - frame.world.x * 0.5;
  let far = max(smoothstep(9000.0, 30000.0, dist), smoothstep(800.0, 3600.0, beyond) * smoothstep(1500.0, 5000.0, dist));
  color = mix(color, horizonColor(rd), far);
  // Debug views.
  if (dbg == 1u) { color = albedo; }
  if (dbg == 2u) { color = n * 0.5 + 0.5; }
  if (dbg == 3u) { color = vec3f(rough); }
  if (dbg == 5u) { color = vec3f(shadow(world, n, vd)); }
  if (dbg == 6u) { color = vec3f(f32(min(u32(max(0.0, 0.0)), 3u))); }
  if (dbg == 4u) { color = vec3f(f32(count) / 32.0, 0.0, 0.0) + albedo * 0.2; }
  textureStore(outColor, px, vec4f(color, 1.0));
}
