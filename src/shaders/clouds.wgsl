// Volumetric clouds: raymarched at reduced resolution with temporal
// reprojection (after Schneider's Nubis / Horizon Zero Dawn approach).
// Texels whose whole neighbourhood is covered by geometry (Hi-Z of this
// frame's depth) only carry their history forward; frame.extra.x = 2 marches
// one texel of each 2x2 block per frame and reprojects the other three.

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var linearRepeat: sampler;

// --- Noise volume generation --------------------------------------------------

@group(1) @binding(0) var noiseOut: texture_storage_3d<rgba8unorm, write>;

fn whash(p: vec3f) -> vec3f {
  let q = vec3f(dot(p, vec3f(127.1, 311.7, 74.7)), dot(p, vec3f(269.5, 183.3, 246.1)), dot(p, vec3f(113.5, 271.9, 124.6)));
  return fract(sin(q) * 43758.5453);
}

// Tileable Worley noise with period `period` cells.
fn worley(p: vec3f, period: f32) -> f32 {
  let id = floor(p);
  let f = fract(p);
  var d = 1.0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let o = vec3f(f32(x), f32(y), f32(z));
        let c = (id + o) - floor((id + o) / period) * period;
        let r = o + whash(c) - f;
        d = min(d, dot(r, r));
      }
    }
  }
  return 1.0 - sqrt(d);
}

fn gnoise(p: vec3f, period: f32) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  var v = 0.0;
  for (var k = 0u; k < 8u; k++) {
    let o = vec3f(f32(k & 1u), f32((k >> 1u) & 1u), f32((k >> 2u) & 1u));
    let c = (i + o) - floor((i + o) / period) * period;
    let g = whash(c) * 2.0 - 1.0;
    let w = mix(1.0 - u, u, o);
    v += dot(g, f - o) * w.x * w.y * w.z;
  }
  return v * 0.5 + 0.5;
}

@compute @workgroup_size(4, 4, 4)
fn genNoise(@builtin(global_invocation_id) id: vec3u) {
  _ = frame.time.x;
  _ = linearRepeat;
  let size = textureDimensions(noiseOut);
  if (any(id >= size)) { return; }
  let p = (vec3f(id) + 0.5) / vec3f(size);
  var perlin = 0.0;
  var amp = 0.5;
  for (var o = 0; o < 4; o++) {
    let per = 4.0 * pow(2.0, f32(o));
    perlin += gnoise(p * per, per) * amp;
    amp *= 0.5;
  }
  perlin = perlin / 0.9375;
  let w1 = worley(p * 4.0, 4.0);
  let w2 = worley(p * 8.0, 8.0);
  let w3 = worley(p * 16.0, 16.0);
  let wfbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
  // Perlin-Worley: perlin remapped by worley.
  let pw = clamp((perlin - (1.0 - wfbm)) / (1.0 - (1.0 - wfbm)) * 0.5 + perlin * 0.5, 0.0, 1.0);
  let d1 = worley(p * 12.0, 12.0) * 0.625 + worley(p * 24.0, 24.0) * 0.25 + worley(p * 48.0, 48.0) * 0.125;
  textureStore(noiseOut, id, vec4f(pw, wfbm, d1, 1.0));
}

// --- Raymarch ----------------------------------------------------------------

@group(1) @binding(0) var noiseTex: texture_3d<f32>;
@group(1) @binding(1) var historyTex: texture_2d<f32>;
@group(1) @binding(2) var cloudOut: texture_storage_2d<rgba16float, write>;
// Farthest (reverse-Z: minimum) depth pyramid of this frame; mip 0 = half res.
@group(1) @binding(3) var hizTex: texture_2d<f32>;

const CLOUD_BOTTOM = 1500.0;
const CLOUD_TOP = 4200.0;

fn remap(v: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
  return c + (v - a) / (b - a) * (d - c);
}

fn weatherAt(xz: vec2f) -> f32 {
  let w = frame.wind.xy * frame.time.x * 6.0;
  let n = fbm2((xz + w) * 0.00011) * 0.7 + fbm2((xz - w * 0.5) * 0.0004) * 0.3;
  var cov = frame.weather.x * 1.15 + (n - 0.47) * 1.6 - 0.12;
  // Breakup: even a rain deck has thinner lanes and gaps (only a full storm
  // closes them), so an overcast sky is never one flat sheet.
  let brk = fbm2((xz + w * 1.3) * 0.0007 + vec2f(17.3, 5.1));
  cov -= smoothstep(0.42, 0.72, brk) * 0.5 * (1.0 - smoothstep(0.94, 1.0, frame.weather.x));
  return clamp(cov, 0.0, 1.0);
}

fn cloudDensity(p: vec3f, cheap: bool) -> f32 {
  let h = (p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
  if (h < 0.0 || h > 1.0) { return 0.0; }
  let cov = weatherAt(p.xz);
  if (cov <= 0.02) { return 0.0; }
  // Cumulus height profile; stormy weather towers higher, overcast is a thick deck.
  let topH = mix(0.45, 1.0, clamp(frame.weather.x * 1.4 - 0.4, 0.0, 1.0));
  let grad = smoothstep(0.0, 0.1, h) * smoothstep(topH, topH * 0.45, h);
  let wind = vec3f(frame.wind.x, 0.0, frame.wind.y) * frame.time.x * 12.0;
  let s = textureSampleLevel(noiseTex, linearRepeat, (p + wind) * 0.00016, 0.0);
  let shape = remap(s.r, s.g * 0.35 - 0.35, 1.0, 0.0, 1.0);
  var d = clamp(remap(shape * grad, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (d <= 0.0 || cheap) { return d; }
  let dt = textureSampleLevel(noiseTex, linearRepeat, (p + wind * 1.6) * 0.001, 0.0).b;
  d = clamp(remap(d, dt * 0.3, 1.0, 0.0, 1.0), 0.0, 1.0);
  return d;
}

fn hg(c: f32, g: f32) -> f32 {
  return (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * c, 1.5));
}

// Whether any sky shows within a texel of this cloud texel: the lighting
// pass samples the clouds bilinearly at sky pixels only.
fn skyNear(uv: vec2f, size: vec2u) -> bool {
  let h0 = vec2f(textureDimensions(hizTex, 0));
  let levels = i32(textureNumLevels(hizTex));
  // The first mip whose texels are at least a cloud texel wide.
  let lv = clamp(i32(ceil(log2(max(h0.x / f32(size.x), 1.0)))), 0, levels - 1);
  let dims = vec2i(textureDimensions(hizTex, lv));
  let c = vec2i(uv * vec2f(dims));
  var far = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = clamp(c + vec2i(x, y), vec2i(0), dims - 1);
      far = min(far, textureLoad(hizTex, q, lv).r);
    }
  }
  return far <= 0.0;
}

@compute @workgroup_size(8, 8)
fn march(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(cloudOut);
  if (any(id.xy >= size)) { return; }
  let mode = u32(frame.extra.x);
  if (mode == 0u) {
    textureStore(cloudOut, id.xy, vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let wp = frame.invViewProj * ndc;
  let rd = normalize(wp.xyz / wp.w - frame.camPos.xyz);
  let ro = frame.camPos.xyz;
  // Temporal reprojection (clouds are far: reproject by direction).
  let prev = frame.prevViewProj * vec4f(ro + rd * 20000.0, 1.0);
  let puv = prev.xy / prev.w * vec2f(0.5, -0.5) + 0.5;
  let histOk = frame.extra.z > 2.0 && all(puv > vec2f(0.0)) && all(puv < vec2f(1.0));
  if (histOk) {
    // Hidden behind geometry, or not this texel's turn: carry the history.
    let order = array<u32, 4>(0u, 3u, 1u, 2u);
    let turn = mode == 2u && (id.x & 1u) + 2u * (id.y & 1u) != order[u32(frame.time.z) & 3u];
    if (turn || !skyNear(uv, size)) {
      textureStore(cloudOut, id.xy, textureSampleLevel(historyTex, linearRepeat, puv, 0.0));
      return;
    }
  }
  var result = vec4f(0.0, 0.0, 0.0, 1.0);
  if (frame.weather.x > 0.01 && rd.y > 0.005) {
    let t0 = max((CLOUD_BOTTOM - ro.y) / rd.y, 0.0);
    let t1 = min((CLOUD_TOP - ro.y) / rd.y, 70000.0);
    if (t1 > t0) {
      // Grazing rays toward the horizon cross tens of kilometres of the
      // layer: give them more steps so distant clouds keep defined edges.
      let baseSteps = select(24.0, 56.0, frame.misc.y > 0.5) * frame.extra.y;
      let steps = i32(baseSteps * mix(1.0, 1.75, smoothstep(6000.0, 30000.0, t1 - t0)));
      let dt = (t1 - t0) / f32(steps);
      let jitter = fract(hash21(vec2f(id.xy)) + frame.time.z * 0.618034);
      var t = t0 + dt * jitter;
      var T = 1.0;
      var L = vec3f(0.0);
      let sun = frame.sunDir.xyz;
      let lightDir = select(frame.moonDir.xyz, sun, frame.sunDir.w > 0.0);
      let lightCol = select(vec3f(0.5, 0.6, 0.8) * frame.moonDir.w * 0.08, frame.sunColor.rgb, frame.sunDir.w > 0.0);
      let cosT = dot(rd, lightDir);
      let phase = mix(hg(cosT, 0.65), hg(cosT, -0.25), 0.3) * 4.0 * PI * 0.25 + 0.15;
      let storm = clamp(frame.weather.x * 1.3 - 0.4, 0.0, 1.0);
      let sigma = mix(0.035, 0.07, storm);
      for (var i = 0; i < steps; i++) {
        let p = ro + rd * t;
        let d = cloudDensity(p, false);
        if (d > 0.002) {
          // Light march toward the light source.
          var od = 0.0;
          var lt = 60.0;
          for (var k = 0; k < 5; k++) {
            od += cloudDensity(p + lightDir * lt, true) * lt;
            lt *= 2.0;
          }
          let beer = exp(-od * sigma * 0.6);
          let powder = 1.0 - exp(-d * 6.0);
          let h = (p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
          // Night: the base is lit by the city below, warm orange/magenta
          // toward the horizon, dimmer and violet overhead.
          let up = smoothstep(0.08, 0.6, rd.y);
          let glowTint = mix(vec3f(1.45, 0.62, 0.55), vec3f(0.5, 0.62, 1.75), up) * mix(1.0, 0.5, up);
          let glow = luminance(frame.cityGlow.rgb) * glowTint * 2.5 * (1.0 - h) * mix(0.75, 1.25, d);
          let amb = frame.skyAmbient.rgb * mix(0.5, 0.95, h) + glow + vec3f(0.7, 0.75, 1.0) * frame.wind.w * 4.0;
          let S = (lightCol * beer * phase * mix(1.0, powder * 2.0, 0.5) + amb) * (1.0 - storm * 0.55);
          let ext = d * sigma;
          let stepT = exp(-ext * dt);
          L += T * S * (1.0 - stepT);
          T *= stepT;
          if (T < 0.01) { break; }
        }
        t += dt;
      }
      // Sharpen coverage: faint, isolated wisps (which upsample to a soft
      // grey smudge) drop out and cloud edges get a crisper falloff.
      let a = 1.0 - T;
      let a2 = smoothstep(0.06, 0.65, a);
      L *= a2 / max(a, 1e-4);
      // Aerial perspective toward the horizon is applied when compositing.
      result = vec4f(L, 1.0 - a2);
    }
  }
  // Temporal accumulation (a texel marched every 4th frame keeps less history).
  if (histOk) {
    let h = textureSampleLevel(historyTex, linearRepeat, puv, 0.0);
    result = mix(result, h, select(0.85, 0.7, mode == 2u));
  }
  textureStore(cloudOut, id.xy, result);
}
