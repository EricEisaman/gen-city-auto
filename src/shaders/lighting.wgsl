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
// building/terrain height map (8 azimuths x 8 doubling steps, 0.5 m .. 64 m).
// Walls only count the half-space they face. Height-map texels are several
// metres wide, so near the point each step also takes the next texel along
// the ray (the conservative edge): pavement half a metre from a 17 m wall
// must see that wall. On a wall, samples still inside its own plane (within
// a texel of it) are skipped, or the wall would occlude itself sideways.
fn skyVisibility(world: vec3f, n: vec3f, pxf: vec2f) -> f32 {
  let N = f32(textureDimensions(skyline).x);
  let size = frame.world.x;
  let cell = size / N;
  let wall = n.y < 0.7;
  let nh = normalize(n.xz + vec2f(1e-5));
  // Per-pixel jitter of the azimuths and step lengths (resolved by TAA), so
  // the height map's texel edges don't print as steps on the pavement.
  let jit = fract(52.9829189 * fract(dot(pxf, vec2f(0.06711056, 0.00583715))) + frame.time.z * 0.618034);
  var occl = 0.0;
  var cnt = 0.0;
  for (var a = 0; a < 8; a++) {
    let ang = (f32(a) + jit) * 0.785398;
    let dir = vec2f(cos(ang), sin(ang));
    if (wall && dot(dir, n.xz) < -0.2) { continue; }
    var maxS = 0.0;
    var dist = 0.5 * (0.75 + 0.5 * fract(jit * 7.0 + f32(a) * 0.618));
    for (var k = 0; k < 8; k++) {
      let p = world.xz + dir * dist;
      let off = select(1e9, dot(dir, nh) * dist, wall);
      if (off > cell * 0.75) {
        let g = vec2i((p + size * 0.5) / size * N);
        if (all(g >= vec2i(0)) && all(g < vec2i(i32(N)))) {
          var h = textureLoad(skyline, g, 0).r;
          if (dist < cell * 2.0) {
            let g2 = clamp(vec2i((p + dir * cell + size * 0.5) / size * N), vec2i(0), vec2i(i32(N) - 1));
            h = max(h, textureLoad(skyline, g2, 0).r);
          }
          // (Less half a texel of rise: on sloping terrain the texel itself
          // stands above the point, and the near steps turned dunes and
          // hillsides into grey blocks.)
          let dh = h - world.y - cell * 0.5;
          let s = max(dh, 0.0) / length(vec2f(dist, dh));
          maxS = max(maxS, s);
        }
      }
      dist *= 2.0;
    }
    occl += maxS * maxS;
    cnt += 1.0;
  }
  return clamp(1.0 - occl / max(cnt, 1.0), 0.15, 1.0);
}

// Screen-space contact shadow toward the sun: a short march through the
// depth buffer for the small casters (sign brackets, AC units, sills,
// mailboxes, vending machines) that the shadow cascades blur away.
// Returns the fraction of light blocked.
fn contactShadow(world: vec3f, n: vec3f, dist: f32, pxf: vec2f) -> f32 {
  let len = min(0.6 * max(dist / 30.0, 1.0), 2.0);
  let stepLen = len / 12.0;
  let start = world + n * (0.015 + dist * 0.0004);
  let jit = fract(52.9829189 * fract(dot(pxf, vec2f(0.06711056, 0.00583715))) + frame.time.z * 0.618034);
  let bias = 0.02 + dist * 0.001;
  for (var i = 0; i < 12; i++) {
    let t = (f32(i) + jit) * stepLen;
    let q = start + frame.sunDir.xyz * t;
    let clip = frame.viewProj * vec4f(q, 1.0);
    if (clip.w <= 0.0) { break; }
    let suv = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
    if (any(suv <= vec2f(0.0)) || any(suv >= vec2f(1.0))) { break; }
    let sd = textureLoad(gDepth, vec2i(suv * frame.resolution.xy), 0);
    if (sd <= 0.0) { continue; }
    let diff = clip.w - viewDepth(sd);
    if (diff > bias && diff < 0.15 + bias) {
      // Fade the last steps so the shadow tip is soft, not a hard cut.
      return 1.0 - smoothstep(8.0, 12.0, f32(i) + jit);
    }
  }
  return 0.0;
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
  // A facade point sits inside its own building's height-map texel (several
  // metres wide), so the ray only counts hits once it has left it. Otherwise
  // walls reflect themselves: a sharp sunlit or lit-window "facade" a metre
  // away, which drew warm stripes and barcode lines on windows.
  var outside = false;
  for (var i = 0; i < 28; i++) {
    let p = world + r * t;
    let h = skylineAt(p, N, size);
    if (h < -1e8) { break; }
    if (p.y >= h) { outside = true; }
    if (p.y < h && outside) {
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
      // The window grid is only resolvable nearby; further away (where
      // neighbouring pixels land on different cells) use its average, or
      // it aliases into barcode stripes.
      let far = smoothstep(6.0, 40.0, tq);
      let winH = step(0.35, fract(along / 3.0)) * step(0.3, fract(q.y / 3.4));
      let win = mix(winH, 0.45, far);
      let wall = mix(vec3f(0.35, 0.34, 0.32), vec3f(0.05, 0.06, 0.07), win * 0.5);
      var c = wall * (frame.skyAmbient.rgb * 0.9 + frame.sunColor.rgb * max(dot(fn_, frame.sunDir.xyz), 0.0) * 0.25);
      let litP = mix(0.05, 0.35, frame.time.w);
      let lit = mix(step(1.0 - litP, hash21(cell + floor(q.xz / 40.0))), litP, far);
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

// Night sky light pollution: deep blue overhead grading to a warm city glow
// (sodium orange, then magenta from the neon) toward the horizon. Overcast
// skies reflect more of it back down.
fn nightGlow(d: vec3f) -> vec3f {
  let y = max(d.y, 0.0);
  let g = luminance(frame.cityGlow.rgb) * (0.6 + frame.weather.x * 1.5);
  let orange = vec3f(1.0, 0.5, 0.22) / 0.586;
  let magenta = vec3f(0.95, 0.32, 0.62) / 0.47;
  let blue = vec3f(0.32, 0.45, 1.0) / 0.44;
  let warm = mix(orange, magenta, smoothstep(0.015, 0.16, y));
  let low = exp(-y * 6.0);
  let col = mix(blue * 0.12, warm, low) * g + vec3f(0.0012, 0.0018, 0.0045);
  return col;
}

// The colour everything converges to at the horizon: clear-sky haze, greyed by
// cloud cover, plus night light pollution. Distant clouds, the far edge of the
// world and the sky below the horizon all blend to this so they meet seamlessly.
fn horizonColor(d: vec3f) -> vec3f {
  let s = skyRadiance(normalize(vec3f(d.x, max(d.y, 0.012), d.z)));
  let grey = vec3f(luminance(s)) * vec3f(0.93, 0.96, 1.0) * mix(1.0, 0.75, frame.weather.y);
  var c = mix(s, grey, clamp(frame.weather.x * 1.1 - 0.15, 0.0, 0.9));
  // The clear-sky LUT knows nothing of the cloud deck: under overcast the
  // horizon is far dimmer than a clear one (sun cut by the clouds).
  c *= mix(1.0, 0.5, clamp(frame.weather.x * 1.6 - 0.75, 0.0, 1.0));
  c += nightGlow(vec3f(d.x, 0.0, d.z)) * frame.time.w;
  return c;
}

// What reflections see below the horizon: sunlit pavement and facades
// (groundAmbient is the radiance bounced up from the street).
fn groundRadiance() -> vec3f {
  return frame.groundAmbient.rgb * 1.1 + frame.cityGlow.rgb;
}

// What a window pane reflects when the skyline march misses: the sky with a
// deck of fair-weather cumulus (so each pane, tilted its own way, shows its
// own bright cloud or blue gap), the haze band at the horizon, and below it
// the sunlit street and the buildings across it, a lit mid value. With only
// the clear-sky LUT and the dark ground term, upper floors read as opaque
// navy and windows seen from above as black slots.
fn glassEnv(r: vec3f) -> vec3f {
  let y = max(r.y, 0.02);
  var c = skyRadiance(normalize(vec3f(r.x, y, r.z)));
  let night = frame.time.w;
  let day = 1.0 - night;
  if (r.y > 0.0) {
    let p = r.xz / (r.y + 0.12) * 1.3 + frame.wind.xy * frame.time.x * 0.003;
    let n = fbm2(p + valueNoise(p * 1.7 + 4.0) * 0.6);
    let cover = mix(0.28, 0.7, clamp(frame.weather.x, 0.0, 1.0));
    let cl = smoothstep(1.0 - cover - 0.1, 1.0 - cover + 0.15, n) * smoothstep(0.0, 0.12, r.y);
    let fwd = 1.0 + 1.5 * pow(max(dot(r, frame.sunDir.xyz), 0.0), 4.0);
    let lit = frame.sunColor.rgb * max(frame.sunDir.y, 0.05) * 0.5 * fwd + frame.skyAmbient.rgb * 0.9 + frame.cityGlow.rgb * 1.5 * night;
    c = mix(c, lit * (0.85 + 0.3 * n), cl * 0.85 * day + cl * 0.3 * night);
    // Under overcast the deck is one grey, mottled by its darker bases.
    let oc = clamp(frame.weather.x * 1.3 - 0.3, 0.0, 1.0);
    c = mix(c, (frame.skyAmbient.rgb * 0.85 + frame.cityGlow.rgb) * (0.7 + 0.45 * n), oc);
  }
  // Across the street: pavement and facades, lit by sun and sky.
  let street = vec3f(0.45, 0.43, 0.4) * (frame.sunColor.rgb * max(frame.sunDir.y, 0.0) * 1.35 / PI + frame.skyAmbient.rgb) + frame.cityGlow.rgb * 1.5;
  let hz = horizonColor(vec3f(r.x, 0.0, r.z));
  c = mix(hz, c, smoothstep(0.0, 0.12, r.y));
  c = mix(street, c, smoothstep(-0.25, 0.0, r.y));
  return c;
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
  // Night sky: deep blue overhead, city glow near the horizon.
  c += nightGlow(d) * night;
  // Twilight afterglow: an orange band low in the sun's direction that fades
  // to violet above, strongest just around sunset.
  {
    let sy = frame.sunDir.y;
    let tw = smoothstep(-0.14, -0.01, sy) * smoothstep(0.2, 0.0, sy) * (1.0 - frame.weather.x * 0.8);
    if (tw > 0.0) {
      let az = max(dot(normalize(d.xz + vec2f(1e-5)), normalize(frame.sunDir.xz + vec2f(1e-5))), 0.0);
      let band = exp(-max(d.y, 0.0) * 9.0) * (0.25 + 0.75 * pow(az, 3.0));
      let violet = exp(-abs(d.y - 0.25) * 5.0) * 0.25;
      let base = luminance(skyRadiance(normalize(vec3f(d.x, 0.05, d.z)))) + 0.002;
      c += (vec3f(1.0, 0.42, 0.12) * band + vec3f(0.45, 0.3, 0.6) * violet) * base * 1.6 * tw;
    }
  }
  // Under cloud cover the low sky turns to grey haze.
  let hz = horizonColor(d);
  c = mix(c, hz, frame.weather.x * smoothstep(0.25, 0.0, d.y));
  // Clouds; distant ones take on the horizon colour (aerial perspective).
  {
    let cl = textureSampleLevel(cloudTex, linearSampler, uv, 0.0);
    let tc = max(CLOUD_BASE - frame.camPos.y, 100.0) / max(d.y, 0.003);
    // Far clouds dissolve into the sky behind them (which already carries
    // the horizon haze), not into a flat grey silhouette.
    let haze = 1.0 - exp(-tc / 12000.0);
    let behind = mix(c, hz, clamp(frame.weather.x * 1.3 - 0.3, 0.0, 1.0));
    c = mix(c * cl.a + cl.rgb, behind, haze);
  }
  // Below the horizon (beyond the world) continue the horizon haze.
  c = mix(c, hz, smoothstep(0.004, -0.004, d.y));
  // Lightning flash lights the whole sky.
  c += vec3f(0.6, 0.65, 0.9) * frame.wind.w * 3.0 * frame.weather.x;
  return c;
}

// Depth-aware 4x4 blur + upsample of the half-resolution AO (removes the
// interleaved sampling pattern without dark halos at edges). Taps are
// weighted by their distance from the centre pixel's tangent plane, not by
// view depth: on ground seen at a grazing angle neighbouring rows differ in
// depth by metres yet lie on one plane, and a depth test kept the 4-row
// interleave pattern as stripes. Across a silhouette (a balcony against the
// sky, a pole in front of a wall) the plane distance is large, so the AO
// doesn't bleed into a soft halo.
fn bilateralAo(pxf: vec2f, vd: f32, world: vec3f, n: vec3f) -> f32 {
  let half = vec2i(textureDimensions(aoTex)) - 1;
  let hp = (pxf - 1.0) * 0.5;
  let c = vec2i(floor(hp));
  let tol = 0.004 * vd + 0.02;
  var sum = 0.0;
  var wsum = 0.0;
  for (var y = -1; y <= 2; y++) {
    for (var x = -1; x <= 2; x++) {
      let q = clamp(c + vec2i(x, y), vec2i(0), half);
      let fq = min(q * 2, vec2i(frame.resolution.xy) - 1);
      let d = textureLoad(gDepth, fq, 0);
      let wq = worldFromDepth(vec2f(fq) + 0.5, max(d, 1e-7));
      let pd = abs(dot(wq - world, n));
      let w = select(exp(-pd / tol), 0.0, d <= 0.0) + 1e-4;
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

// How far (x the light radius) street-light streaks reach on wet ground.
const STREAK_REACH = 2.5;

// A lamp mirrored in a wet road's water film (film normal nF): GGX with
// the half vector's component along the view squashed, so the highlight
// stretches ~5x toward the eye (vertical on screen) and stays narrow
// across. Returns the BRDF x cos term (scaled), capped.
fn wetStreak(nF: vec3f, v: vec3f, l: vec3f, fwdV: vec3f) -> f32 {
  let hv = normalize(l + v);
  let hs = normalize(hv - fwdV * dot(hv, fwdV) * 0.8);
  let nlF = max(dot(nF, l), 0.0);
  let nvF = max(dot(nF, v), 0.05);
  let aF = 0.022;
  let Fw = 0.02 + 0.98 * pow(1.0 - max(dot(v, hv), 0.0), 5.0);
  let sp = D_GGX(max(dot(nF, hs), 0.0), aF) * V_SmithJoint(nvF, nlF, aF) * Fw * nlF;
  return min(sp, 60.0) * 0.2;
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

fn ssr(world: vec3f, n: vec3f, v: vec3f, px: vec2f, rough: f32, aniso: bool, thinReject: bool) -> vec4f {
  var r = reflect(-v, n);
  // Roughness jitter (resolved by TAA). Wet streets stretch reflections into
  // vertical streaks toward the camera.
  let j = hash22(px + frame.time.z * 0.618) - 0.5;
  if (aniso) {
    let side = normalize(cross(n, v));
    let fwd = cross(side, n);
    // (A floor on the stretch: a glossy film still smears a lamp into a
    // streak several times longer than wide.)
    let sr = max(rough, 0.2);
    r = normalize(r + side * j.x * sr * 0.06 + fwd * j.y * sr * 0.9);
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
      // On glass: refine the crossing (bisection between the last miss and
      // this step), then require the ray to really meet the surface. A ray
      // passing a metre behind a lamp pole or sign edge used to count as a
      // hit and drew a dithered ghost of it in every pane. (Wet streets
      // keep the loose test: their long neon streaks rely on it.)
      var pHit = p;
      var conf = 1.0;
      if (thinReject) {
        var lo = prevT;
        var hi = t;
        var dHit = diff;
        for (var k = 0; k < 5; k++) {
          let tm = 0.5 * (lo + hi);
          let pm = world + r * tm;
          let cm = frame.viewProj * vec4f(pm, 1.0);
          let um = vec2f(cm.x / cm.w * 0.5 + 0.5, 0.5 - cm.y / cm.w * 0.5);
          let dm = cm.w - viewDepth(textureLoad(gDepth, vec2i(clamp(um, vec2f(0.0), vec2f(0.9999)) * frame.resolution.xy), 0));
          if (dm > 0.0) { hi = tm; dHit = dm; pHit = pm; } else { lo = tm; }
        }
        let thick = 0.25 + 0.01 * t;
        if (dHit > thick) {
          prevT = t;
          t = t * 1.18 + 0.3;
          continue;
        }
        conf = 1.0 - smoothstep(thick * 0.5, thick, dHit);
        // Thin occluders (poles, wires, sign edges) are hit only when a
        // step happens to land inside them: one step further the ray is in
        // front of the scene again. Call it a miss (the env takes over).
        let pn = world + r * (t * 1.18 + 0.3);
        let cn = frame.viewProj * vec4f(pn, 1.0);
        let un = vec2f(cn.x / cn.w * 0.5 + 0.5, 0.5 - cn.y / cn.w * 0.5);
        if (cn.w > 0.0 && all(un > vec2f(0.0)) && all(un < vec2f(1.0))) {
          let dn = textureLoad(gDepth, vec2i(un * frame.resolution.xy), 0);
          if (dn <= 0.0 || cn.w - viewDepth(dn) < 0.0) { return vec4f(0.0); }
        }
      }
      // Reproject into the previous frame's lit image.
      let p = pHit;
      let prev = frame.prevViewProj * vec4f(p, 1.0);
      let puv = prev.xy / prev.w * vec2f(0.5, -0.5) + 0.5;
      let edge = min(min(puv.x, 1.0 - puv.x), min(puv.y, 1.0 - puv.y));
      let fade = smoothstep(0.0, 0.08, edge) * (1.0 - f32(i) / 40.0) * conf;
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

// Transmittance of the last applyFog() call (how much of the surface's own
// radiance got through): emitters use it to punch through the haze.
var<private> fogTrans: f32 = 1.0;

fn applyFog(c: vec3f, world: vec3f, uv: vec2f, dist: f32, rd: vec3f) -> vec3f {
  let dKm = dist * 0.001;
  let slice = sqrt(clamp(dKm / 24.0, 0.0, 1.0)) * 32.0;
  let w = clamp((slice - 0.5) / 32.0, 0.0, 1.0);
  let ap = textureSampleLevel(apVolume, linearSampler, vec3f(uv, w), 0.0);
  var col = c * ap.a + ap.rgb;
  fogTrans = ap.a;
  // City haze: a low aerosol layer (450 m scale height) that the thin
  // physical atmosphere underestimates. It fades distant blocks toward the
  // horizon colour, which already carries the sun-angle tint (warm toward a
  // low sun, blue-grey away from it), so towers 1-2 km out lose ~40% of
  // their contrast on a clear day and fog, sky and outskirts still converge.
  {
    let fall = 1.0 / 450.0;
    let dh = rd.y * dist;
    var integral = dist;
    if (abs(dh) > 0.5) { integral = (1.0 - exp(-fall * dh)) / (fall * rd.y); }
    let sigma = (0.3 + frame.weather.x * 0.12 + frame.weather.w * 0.25) * 1e-3;
    // Nearby blocks stay crisp; the haze builds up over the first kilometre.
    let od = sigma * exp(-fall * max(frame.camPos.y, 0.0)) * max(integral, 0.0) * smoothstep(80.0, 900.0, dist);
    // Its brightness is capped near that of a white surface in the current
    // light: the horizon toward a low sun (Mie peak) or a clear sky above an
    // overcast deck would otherwise turn the whole view milky.
    var hz = horizonColor(rd);
    let lit = luminance(frame.sunColor.rgb) * max(frame.sunDir.y, 0.1) / PI + luminance(frame.skyAmbient.rgb) + luminance(frame.cityGlow.rgb) * 2.0;
    hz *= min(1.0, lit * 0.9 / max(luminance(hz), 1e-5));
    col = mix(col, hz, 1.0 - exp(-od));
    fogTrans *= exp(-od);
  }
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
    fogTrans *= 1.0 - clamp(amount, 0.0, 1.0);
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
    // In the wet, street lights reach 2.5x further: their streaks on the
    // film (and only those) carry well beyond the pool.
    let R = L.radius * select(1.0, STREAK_REACH, frame.weather.z > 0.3 && L.kind < 0.5);
    let vp = frame.view * vec4f(L.pos, 1.0);
    let lz = -vp.z;
    if (lz + R < zMin || lz - R > zMax) { continue; }
    // Conservative screen-space bounds of the light sphere.
    let clip = frame.viewProj * vec4f(L.pos, 1.0);
    var inside = true;
    if (lz > R) {
      let c = clip.xy / clip.w;
      let spx = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5) * frame.resolution.xy;
      let rpx = R * frame.proj[1][1] * 0.5 * frame.resolution.y / (lz - R * 0.9);
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
  let cls = u32(floor(em.a + 1e-3));
  let sunVis = clamp((em.a - f32(cls)) / 0.75, 0.0, 1.0);
  var albedo = a.rgb;
  let v = -rd;
  var f0 = mix(vec3f(0.04), albedo, metal);
  // Double glazing: four faces, ~12 % at normal incidence.
  if (cls == CLASS_GLASS) { f0 = vec3f(0.12) + albedo * 0.6; }
  if (cls == CLASS_WATER) { f0 = vec3f(0.02); }
  let dist = length(world - frame.camPos.xyz);
  // Screen-space GTAO times the material's own analytic occlusion (reveals,
  // ledges, wall foot, tile cavity), floored so nothing goes black.
  var ao = max(a.a * bilateralAo(pxf, vd, world, n), 0.3);
  var contactOcc = 0.0;
  if (n.y > 0.6 && dist < 150.0 && cls != CLASS_VEHICLE) {
    contactOcc = contactOcclusion(world);
    ao *= 1.0 - contactOcc;
  }

  let dbg = u32(frame.misc.x);
  if (dbg == 8u) {
    textureStore(outColor, px, vec4f(vec3f(ao), 1.0));
    return;
  }
  // Multi-bounce (Jimenez 2016): light inter-reflected inside a crease lifts
  // its occlusion with albedo, so pale walls stay clean in corners.
  let mbA = 2.0404 * albedo - 0.3324;
  let mbB = -4.7951 * albedo + 0.6417;
  let mbC = 2.7552 * albedo + 0.6903;
  let aoMB = max(vec3f(ao), ((vec3f(ao) * mbA + mbB) * ao + mbC) * ao);
  var color = vec3f(0.0);
  // Sun.
  if (frame.sunDir.w > 0.0) {
    var sh = shadow(world, n, vd) * cloudShadow(world) * sunVis;
    // Contact shadow where the cascade is too coarse (its 3x3 PCF footprint
    // wider than ~5 cm) to resolve small casters.
    if (sh > 0.01 && dist < 120.0 && frame.misc.y > 0.5 && cls != CLASS_VEHICLE && dot(n, frame.sunDir.xyz) > 0.0) {
      var c = 0u;
      for (var k = 0u; k < 3u; k++) {
        if (vd > frame.cascadeSplits[k]) { c = k + 1u; }
      }
      let pcf = frame.cascadeSplits[min(c, 3u)] * 3.0 / 1024.0;
      let k = smoothstep(0.03, 0.08, pcf) * smoothstep(120.0, 80.0, dist);
      if (k > 0.0) { sh *= 1.0 - contactShadow(world, n, dist, pxf) * k; }
    }
    color += brdf(n, v, frame.sunDir.xyz, albedo, f0, rough, metal) * frame.sunColor.rgb * sh * 1.35;
    if (cls == CLASS_FOLIAGE) {
      // Cheap translucency for leaves.
      color += albedo * frame.sunColor.rgb * 0.25 * max(dot(-n, frame.sunDir.xyz), 0.0) * sh;
    }
  }
  // Moon.
  if (frame.moonDir.w > 0.0) {
    let moonCol = vec3f(0.5, 0.6, 0.8) * frame.moonDir.w * 0.06;
    color += brdf(n, v, frame.moonDir.xyz, albedo, f0, rough, metal) * moonCol * shadow(world, n, vd) * sunVis;
  }
  // Point lights.
  // (Not on the signs themselves: anything already emitting is skipped.)
  let wetWall = frame.weather.z * (1.0 - smoothstep(0.3, 0.6, abs(n.y))) * select(0.0, 1.0, cls == CLASS_DEFAULT)
    * (1.0 - smoothstep(0.02, 0.1, luminance(em.rgb)));
  // How glossy a wet wall is (its rain streaks and run-off sheets).
  let wetGloss = 1.0 - smoothstep(0.06, 0.22, rough);
  // Wet ground (carriageway, pavement): the water film mirrors every lamp
  // as a long streak running toward the eye (Forza / GTA rain nights). Only
  // where the film is glossy (paint and dry patches stay satin).
  let wetGround = select(0.0, frame.weather.z, cls == CLASS_GROUND) * smoothstep(0.8, 0.95, n.y)
    * (1.0 - smoothstep(0.1, 0.22, rough));
  // The film's normal: the aggregate's bump drowned (a streak, not glitter).
  let nFilm = normalize(n + vec3f(0.0, 3.0, 0.0));
  let fwdV = normalize(vec3f(v.x, 0.0, v.z) + vec3f(1e-5, 0.0, 0.0));
  let count = min(atomicLoad(&tileCount), MAX_TILE_LIGHTS);
  for (var k = 0u; k < count; k++) {
    let L = lightBuf.lights[tileLights[k]];
    let dl = L.pos - world;
    let d2 = dot(dl, dl);
    // Beyond the pool, on the wet film, only the lamp's streak (the head
    // glaring at a low angle; plain inverse square, faded out by 2.5 R).
    let outR = d2 > L.radius * L.radius;
    if (outR && !(wetGround > 0.0 && L.kind < 0.5 && d2 < L.radius * L.radius * STREAK_REACH * STREAK_REACH)) { continue; }
    let d = sqrt(d2);
    let l = dl / d;
    // What the film mirrors (one wetStreak call site per light: two
    // inlined copies in this loop stalled the Metal compile).
    var streakC = vec3f(0.0);
    if (outR) {
      let fade = 1.0 - smoothstep(L.radius * (STREAK_REACH - 0.6), L.radius * STREAK_REACH, d);
      streakC = L.color * 0.4 * select(1.0, 2.0, abs(L.kind) <= 0.01 && L.radius >= 19.0) * fade / (d2 + 1.0);
    } else {
      let win = pow(clamp(1.0 - pow(d / L.radius, 4.0), 0.0, 1.0), 2.0);
      let atten = win / (d2 + 1.0);
      var lc = L.color;
      // What the film mirrors: the luminaire as seen from the reflection
      // point. A cut-off head still glares at low angles (its lens and
      // reflector), so the streak keeps a floor where the pool has gone.
      var lcS = vec3f(-1.0);
      if (L.kind >= 5.0) {
        // Vehicle headlight: forward cone, slightly downward.
        let a = fract(L.kind) * 6.2831853;
        let dir = normalize(vec3f(sin(a), -0.12, cos(a)));
        lc *= smoothstep(0.9, 0.97, dot(-l, dir));
      } else if (L.kind < 0.5) {
        // Street lights: a hotspot under the head falling off fast to a dim,
        // wide tail (mid-grey asphalt between poles, not overlapping discs),
        // in direction space (horizontal offset over drop, so it scales with
        // pole height).
        // - Road luminaires, undirected (kind 0.05 .. 0.45 = 0.05 + 0.4 *
        //   road angle / pi): elongated 1.5 x 0.9 pole heights along/across.
        // - Road luminaires, directed (kind -0.05 .. -0.95 = -(0.05 + 0.9 *
        //   arm angle / 2 pi), the arm pointing from the pole over the road):
        //   the same ellipse thrown forward 0.35 pole heights onto the
        //   carriageway (Type II/III), cut off behind the pole.
        // - Junction luminaires (kind exactly 0): round, 1.25 pole heights.
        // Colour temperature varies per street (by its axis), warm to cool.
        let lyc = max(l.y, 0.02);
        // Fragment offset from under the head, in pole heights.
        let q = -l.xz / lyc;
        var e2 = 0.0;
        var back = 1.0;
        var ht = hash21(floor(L.pos.xz * 0.37));
        // Junction pools (kind exactly 0, not the rail viaduct's radius-18
        // under-deck LEDs): twice the road luminaires' output.
        let junctionLum = abs(L.kind) <= 0.01 && L.radius >= 19.0;
        if (abs(L.kind) > 0.01) {
          var ra: vec2f;
          var fwd = vec2f(0.0);
          if (L.kind > 0.0) {
            let axis = (L.kind - 0.05) / 0.4 * PI;
            ra = vec2f(cos(axis), sin(axis));
            ht = hash11(floor(fract(axis / PI) * 24.0) + 0.5);
          } else {
            let arm = (-L.kind - 0.05) / 0.9 * 2.0 * PI;
            let ad = vec2f(cos(arm), sin(arm));
            ra = vec2f(-ad.y, ad.x);
            fwd = ad;
            ht = hash11(floor(fract(arm / PI) * 24.0) + 0.5);
            // House side of the pole: the luminaire's cut-off (back-throw
            // 40 % of the forward lobe, gone a third of a pole height back).
            let fq = dot(q, ad);
            back = mix(0.4, 1.0, smoothstep(-0.15, 0.25, fq)) * smoothstep(-0.6, -0.3, fq);
          }
          // Asymmetric Type II/III lobe: thrown forward half a pole height,
          // reaching further forward than back.
          let qq = q - fwd * 0.5;
          let fa = dot(qq, fwd);
          let pa = dot(qq, ra) / 1.5;
          let pc = dot(qq, vec2f(-ra.y, ra.x)) / select(0.9, select(0.6, 1.0, fa > 0.0), L.kind < 0.0);
          e2 = pa * pa + pc * pc;
        } else if (L.radius < 19.0) {
          // Kind exactly 0 with a short reach: the rail viaduct's under-deck
          // LED (gen-base, radius 18). A tight pool (0.75 drop) so the
          // ground under the deck reads as a run of pools, not one floodlit
          // floor.
          e2 = dot(q, q) / (0.75 * 0.75);
        } else {
          // Junction luminaires: a wide round pool (1.7 pole heights) so the
          // four corners' overlap carries the middle of the box: the
          // junction is the best-lit place on the road.
          e2 = dot(q, q) / (1.7 * 1.7);
        }
        let w1 = clamp(1.0 - e2, 0.0, 1.0);
        var pool = select(0.0, (0.65 * exp(-e2 * 7.0) + 0.35 * w1 * w1 * w1) * back, l.y > 0.0);
        // Road luminaires: peak 25 % lower (pools, not floodlit discs).
        if (abs(L.kind) <= 0.01) { pool = select(0.0, 0.45 * exp(-e2 * 9.0) + 0.55 * w1 * w1, l.y > 0.0); }
        if (L.kind < -0.01) { pool *= 0.75; }
        // Arterial heads (the long-reach 20 m lights on avenues and
        // boulevards) are cool 4000-5000 K LED; side-street ones warmer.
        let arterial = L.radius > 17.0;
        let temp = select(mix(vec3f(1.1, 0.95, 0.78), vec3f(1.04, 0.97, 0.88), ht), mix(vec3f(0.95, 0.98, 1.06), vec3f(0.99, 0.99, 1.0), ht), arterial);
        // Foliage scatters what reaches its outer leaves: a softer cut-off.
        let spill = select(0.02, 0.15, cls == CLASS_FOLIAGE);
        // Junction luminaires stay the strongest: the box is the best-lit
        // place on the road. Road luminaires 30 % below the old peak.
        let deckLed = L.kind == 0.0 && L.radius < 19.0;
        lc *= temp * mix(spill, 1.0, pool) * select(select(1.0, 2.0, junctionLum), 50.0 / 60.0, deckLed);
        lcS = L.color * temp * max(pool, 0.4) * select(select(1.0, 2.0, junctionLum), 50.0 / 60.0, deckLed);
      } else if (L.kind > 2.5 && L.kind < 3.5) {
        // Fittings (soffit fluorescents, bracket and bulkhead lamps) hang under
        // a slab or hood and cast no shadow here: nothing much above the
        // fitting sees it. Without this the under-deck lights shone up
        // through the viaduct deck and lit the soundwall and parapet inner
        // faces evenly all night.
        lc *= smoothstep(0.8, 0.1, world.y - L.pos.y);
        // High fittings (under-deck soffit tubes, trough lamps: more than
        // 3.5 m over the floor they light) throw a pool, not a flood: on
        // the ground the light falls off with the angle from straight down
        // (a batwing-free diffuser's cos^n), so the ground under the viaduct
        // is a sequence of pools with darker ground between bents.
        let drop = L.pos.y - world.y;
        if (drop > 3.5 && n.y > 0.6) {
          let cone = pow(clamp(l.y, 0.0, 1.0), 6.0);
          lc *= mix(1.0, mix(0.08, 3.0, cone), smoothstep(3.5, 5.0, drop));
        }
      }
      let foliageK = select(1.0, 0.4, cls == CLASS_FOLIAGE);
      // Point lights cast no shadows: the vehicle contact term stands in under cars.
      color += brdf(n, v, l, albedo, f0, max(rough, 0.08), metal) * lc * atten * 60.0 * foliageK * (1.0 - contactOcc * 0.85);
      streakC = select(lc, lcS, lcS.x >= 0.0) * atten;
      if (L.kind > 0.5 && L.kind < 1.5 && wetWall > 0.0) {
        // Neon on a soaked wall: the water film spreads each sign's colour
        // over the wall around it (a soft, view-independent sheen; the GGX
        // lobe alone is a pin-prick at this roughness).
        color += lc * atten * 60.0 * 0.04 * wetWall * smoothstep(4.5, 2.2, d) * smoothstep(1.5, 2.0, d);
        // And a coloured specular smear: the sign mirrored in the film, a
        // broad lobe stretched down the wall (run-off ripples are vertical),
        // moving with the eye. Only where the wall is glossy-wet.
        let hv = normalize(l + v);
        let nh = max(dot(n, normalize(vec3f(hv.x, hv.y * 0.35, hv.z))), 0.0);
        color += lc * atten * 60.0 * D_GGX(nh, 0.14) * 0.2 * max(dot(n, l), 0.15) * wetWall * wetGloss;
      }
      if (cls == CLASS_FOLIAGE) {
        // Two-sided leaves: street and sign light scatters through the crown
        // (a soft non-directional fill) and transmits through back-lit cards,
        // so canopies glow at night instead of going black on the far side.
        // A wrap term on the lit side as well: clipped hedges and crown
        // sides facing a lamp across the pavement read green, not black.
        let wrap = max((dot(n, l) + 0.5) / 1.5, 0.0);
        color += albedo * (0.25 + 0.6 * max(dot(-n, l), 0.0) + 0.5 * wrap) * lc * atten * (60.0 / PI) * 0.4;
      }
    }
    if (wetGround > 0.0) {
      color += streakC * 60.0 * wetStreak(nFilm, v, l, fwdV) * wetGround;
    }
  }
  // Ambient: hemisphere sky + ground bounce.
  var skyVis = 1.0;
  if (dist < 1500.0 && frame.misc.y > 0.5) { skyVis = mix(skyVisibility(world, n, pxf), 1.0, smoothstep(900.0, 1500.0, dist)); }
  let hemi = n.y * 0.5 + 0.5;
  // Bounce light from sunlit facades and pavement, stronger deep in canyons.
  let bounce = frame.sunColor.rgb * vec3f(1.0, 0.92, 0.82) * max(frame.sunDir.y, 0.0) * 0.06 * (1.3 - skyVis * 0.6);
  // Light bounced up from sunlit pavement onto downward-facing surfaces.
  let groundBounce = frame.groundAmbient.rgb + frame.sunColor.rgb * max(frame.sunDir.y, 0.0) * 0.07 * mix(0.6, 1.0, skyVis);
  let skyAmb = groundBounce * (1.0 - hemi) + skyIrradiance(n) * hemi * skyVis + bounce;
  // In full sun the fill is weaker relative to the key (about 4:1 on open
  // streets), so shade reads as shade instead of a uniform grey.
  let fill = mix(1.0, 0.75, smoothstep(0.05, 0.3, frame.sunDir.y) * (1.0 - frame.weather.x));
  let diffAmb = albedo * (1.0 - metal) * skyAmb * aoMB * fill;
  color += diffAmb;
  // Specular ambient: sky reflection, replaced by SSR where available.
  let nv = max(dot(n, v), 1e-3);
  var Fa = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  // A water film on a wall: rain-blurred, its sheen spreads well beyond the
  // grazing-angle Fresnel rim, so wet streaks read from across the street.
  Fa = mix(Fa, max(Fa, vec3f(0.25 + 0.5 * pow(1.0 - nv, 1.5))), wetWall * wetGloss);
  var refl = reflect(-v, n);
  // Wave facets tilted past the horizon still see the sky (the far shore is
  // handled by the city reflection), never the dark ground term.
  if (cls == CLASS_WATER) { refl = normalize(vec3f(refl.x, max(refl.y, 0.015), refl.z)); }
  var env = skyRadiance(normalize(vec3f(refl.x, max(refl.y, 0.02), refl.z)));
  // Overcast skies reflect grey cloud, not the clear-sky LUT.
  env = mix(env, frame.skyAmbient.rgb * 0.85 + frame.cityGlow.rgb, clamp(frame.weather.x * 1.3 - 0.3, 0.0, 1.0));
  // Below the horizon reflections see the city: darken toward ground ambient.
  // Open water reflects the sky down to the horizon.
  let reflLo = select(0.15, 0.01, cls == CLASS_WATER);
  env = mix(groundRadiance(), env, smoothstep(-0.08, reflLo, refl.y));
  if (cls == CLASS_GLASS) { env = glassEnv(refl); }
  if (rough < 0.5 && dist < 800.0 && frame.misc.y > 0.5 && cls != CLASS_VEHICLE) {
    let cr = cityReflection(world + n * 0.3, refl);
    // The skyline hit is a sharp mirror image: only near-specular surfaces
    // (glass, water, wet film) may show it. On glazed tile and paint it drew
    // a hard warm stripe (a lone sunlit tower) at golden hour and per-tile
    // lit-window speckle at night. A pane looking down sees the street,
    // which the height map can't tell from a wall: glassEnv's lit street,
    // not a dark "facade" at the window's own foot.
    let crK = select(1.0, smoothstep(-0.2, -0.04, refl.y), cls == CLASS_GLASS);
    env = mix(env, cr.rgb, cr.a * crK * (1.0 - smoothstep(0.1, 0.3, rough)));
  }
  env *= mix(1.0, 0.25, rough) * mix(0.35, 1.0, skyVis);
  // Screen-space reflections only nearby: far away the depth tolerance grows
  // to kilometres and grazing rays report false hits.
  if (rough < 0.35 && frame.misc.y > 0.5 && dist < 1200.0 && (cls != CLASS_GLASS || dist < 150.0)) {
    // Car paint reflects through its clear coat: a sharp, unjittered ray.
    // Jittered rays on a moving car hit and miss leaves frame to frame and
    // sparkle in a way TAA can't resolve.
    // So does window glass: its roughness is grime and haze, which the
    // env lobe already blurs; jittered rays dithered a noisy ghost of
    // every pole and sign in front of a pane.
    let r = ssr(world, n, v, pxf, select(rough, 0.0, cls == CLASS_VEHICLE || cls == CLASS_GLASS), cls == CLASS_GROUND && frame.weather.z > 0.3, cls == CLASS_GLASS);
    env = mix(env, r.rgb, r.a * smoothstep(1200.0, 700.0, dist));
  }
  // Glass deep in a window recess sees less sky.
  // A water film on wet glass makes it more of a mirror.
  if (cls == CLASS_GLASS) { env *= mix(0.5, 1.0, a.a) * (1.0 + 0.5 * frame.weather.z) * 1.3; }
  // Specular occlusion (Lagarde 2014): rough surfaces follow the AO, smooth
  // ones keep their grazing reflection unless deeply occluded.
  var specOcc = clamp(pow(nv + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
  color += min(env * Fa * specOcc * (1.0 - contactOcc), vec3f(6.0));
  if (cls == CLASS_VEHICLE && metal < 0.95) {
    // Clear coat: a sharp dielectric layer over the paint.
    let fc = min(0.04 + 0.96 * pow(1.0 - nv, 5.0), 0.45);
    let envSharp = skyRadiance(normalize(vec3f(refl.x, max(refl.y, 0.02), refl.z)));
    var coatEnv = mix(groundRadiance(), envSharp, smoothstep(-0.08, 0.15, refl.y));
    color += coatEnv * fc * specOcc;
    if (frame.sunDir.w > 0.0) {
      let hc = normalize(v + frame.sunDir.xyz);
      color += frame.sunColor.rgb * D_GGX(max(dot(n, hc), 0.0), 0.05 * 0.05) * 1.0 * fc * max(dot(n, frame.sunDir.xyz), 0.0) * shadow(world, n, vd) * sunVis;
    }
  }
  color += em.rgb;
  color = applyFog(color, world, uv, dist, rd);
  // Signs and lit windows carry through haze and rain mist: light scattered
  // forward around a bright source still reaches the eye as its glow, so an
  // emitter keeps transmittance^0.45 instead of fading with the walls.
  // (Real lights only: daylit rooms behind glass fade like the walls.)
  color += em.rgb * max(pow(fogTrans, 0.45) - fogTrans, 0.0) * smoothstep(0.15, 0.8, luminance(em.rgb));
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
  if (dbg == 9u) { color = vec3f(shadow(world, n, vd) * sunVis); }
  if (dbg == 10u) { textureStore(outColor, px, vec4f(vec3f(skyVis), 1.0)); return; }
  if (dbg == 6u) { color = vec3f(f32(min(u32(max(0.0, 0.0)), 3u))); }
  if (dbg == 4u) { color = vec3f(f32(count) / 32.0, 0.0, 0.0) + albedo * 0.2; }
  textureStore(outColor, px, vec4f(color, 1.0));
}
