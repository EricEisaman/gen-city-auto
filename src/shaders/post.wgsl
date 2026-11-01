// Post processing: TAA, Hi-Z pyramid, bloom chain, auto exposure, tonemap.

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var linearSampler: sampler;

// --- TAA ----------------------------------------------------------------------

@group(1) @binding(0) var taaCurrent: texture_2d<f32>;
@group(1) @binding(1) var taaHistory: texture_2d<f32>;
@group(1) @binding(2) var taaMotion: texture_2d<f32>;
@group(1) @binding(3) var taaDepth: texture_depth_2d;
@group(1) @binding(4) var taaOut: texture_storage_2d<rgba16float, write>;

fn rgb2ycocg(c: vec3f) -> vec3f {
  return vec3f(dot(c, vec3f(0.25, 0.5, 0.25)), dot(c, vec3f(0.5, 0.0, -0.5)), dot(c, vec3f(-0.25, 0.5, -0.25)));
}

fn ycocg2rgb(c: vec3f) -> vec3f {
  return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

fn tonemapWeight(c: vec3f) -> vec3f {
  return c / (1.0 + luminance(c));
}

fn sampleHistoryCatmull(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(taaHistory));
  let pos = uv * size;
  let c = floor(pos - 0.5) + 0.5;
  let f = pos - c;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let o12 = w2 / w12;
  let t0 = (c - 1.0) / size;
  let t3 = (c + 2.0) / size;
  let t12 = (c + o12) / size;
  var r = vec3f(0.0);
  r += textureSampleLevel(taaHistory, linearSampler, vec2f(t12.x, t0.y), 0.0).rgb * w12.x * w0.y;
  r += textureSampleLevel(taaHistory, linearSampler, vec2f(t0.x, t12.y), 0.0).rgb * w0.x * w12.y;
  r += textureSampleLevel(taaHistory, linearSampler, vec2f(t12.x, t12.y), 0.0).rgb * w12.x * w12.y;
  r += textureSampleLevel(taaHistory, linearSampler, vec2f(t3.x, t12.y), 0.0).rgb * w3.x * w12.y;
  r += textureSampleLevel(taaHistory, linearSampler, vec2f(t12.x, t3.y), 0.0).rgb * w12.x * w3.y;
  let wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / wsum, vec3f(0.0));
}

@compute @workgroup_size(8, 8)
fn taa(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(textureDimensions(taaCurrent));
  if (any(id.xy >= size)) { return; }
  let p = vec2i(id.xy);
  let cur = textureLoad(taaCurrent, p, 0).rgb;
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var closest = 0.0;
  var closestP = p;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = clamp(p + vec2i(x, y), vec2i(0), vec2i(size) - 1);
      let c = rgb2ycocg(tonemapWeight(textureLoad(taaCurrent, q, 0).rgb));
      m1 += c;
      m2 += c * c;
      let d = textureLoad(taaDepth, q, 0);
      if (d > closest) {
        closest = d;
        closestP = q;
      }
    }
  }
  let mean = m1 / 9.0;
  let sd = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
  let motion = textureLoad(taaMotion, closestP, 0).xy;
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let prevUv = uv - motion;
  var outC = cur;
  if (frame.time.z > 1.0 && all(prevUv > vec2f(0.0)) && all(prevUv < vec2f(1.0))) {
    let hist = sampleHistoryCatmull(prevUv);
    let hy = rgb2ycocg(tonemapWeight(hist));
    let speed = length(motion * vec2f(size));
    let gamma = mix(1.25, 0.75, clamp(speed / 8.0, 0.0, 1.0));
    let lo = mean - sd * gamma;
    let hi = mean + sd * gamma;
    // Clip toward the mean.
    let center = (hi + lo) * 0.5;
    let ext = max((hi - lo) * 0.5, vec3f(1e-4));
    let off = hy - center;
    let unit = abs(off / ext);
    let mx = max(unit.x, max(unit.y, unit.z));
    var clipped = hy;
    if (mx > 1.0) { clipped = center + off / mx; }
    let hc = ycocg2rgb(clipped);
    let histRgb = hc / max(1.0 - luminance(hc), 1e-4);
    let blend = mix(0.92, 0.8, clamp(speed / 20.0, 0.0, 1.0));
    let wc = 1.0 / (1.0 + luminance(cur));
    let wh = 1.0 / (1.0 + luminance(histRgb));
    outC = (cur * (1.0 - blend) * wc + histRgb * blend * wh) / ((1.0 - blend) * wc + blend * wh);
  }
  textureStore(taaOut, id.xy, vec4f(max(outC, vec3f(0.0)), 1.0));
}

// --- TAAU: temporal upsampling from the internal render resolution -----------
// (Render scale < 100%.) The current frame and its depth / motion are at the
// internal resolution, the history and the output at the display resolution.
// Internal pixel i shaded the scene at uv (i + 0.5) / internalSize shifted by
// the jitter, so each output pixel reconstructs the current frame from the
// 3x3 internal samples around that point, and trusts it in proportion to how
// close the nearest sample landed: over the jitter sequence every output pixel
// gets samples near its centre and the history converges to output-res detail.

@compute @workgroup_size(8, 8)
fn taau(@builtin(global_invocation_id) id: vec3u) {
  let osize = vec2u(textureDimensions(taaOut));
  if (any(id.xy >= osize)) { return; }
  let isize = vec2i(textureDimensions(taaCurrent));
  let isf = vec2f(isize);
  // Output pixels per internal pixel (1 / render scale).
  let ratio = vec2f(osize) / isf;
  let uv = (vec2f(id.xy) + 0.5) / vec2f(osize);
  // The jitter is in NDC (y up): geometry moved by +jitter, so the sample of
  // internal pixel i sits at (i + 0.5) / isize - jUv.
  let jUv = vec2f(frame.jitter.x, -frame.jitter.y) * 0.5;
  let q = (uv + jUv) * isf - 0.5;
  let base = vec2i(floor(q + 0.5));
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var closest = 0.0;
  var closestP = clamp(base, vec2i(0), isize - 1);
  // Two reconstructions of the current frame: `wide` (a Gaussian over internal
  // pixels: smooth, for pixels without history) and `sharp` (a Gaussian over
  // display pixels: only samples that landed near this pixel count).
  var wideSum = vec3f(0.0);
  var wideW = 0.0;
  var sharpSum = vec3f(0.0);
  var sharpW = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let k = base + vec2i(x, y);
      let kc = clamp(k, vec2i(0), isize - 1);
      let tw = tonemapWeight(textureLoad(taaCurrent, kc, 0).rgb);
      let c = rgb2ycocg(tw);
      m1 += c;
      m2 += c * c;
      let d = textureLoad(taaDepth, kc, 0);
      if (d > closest) {
        closest = d;
        closestP = kc;
      }
      // Blackman-Harris-like Gaussians.
      let di = vec2f(k) - q;
      let w = exp(-2.29 * dot(di, di));
      wideSum += tw * w;
      wideW += w;
      let dd = di * ratio;
      let ws = exp(-2.29 * dot(dd, dd));
      sharpSum += tw * ws;
      sharpW += ws;
    }
  }
  let wideT = wideSum / max(wideW, 1e-5);
  let wide = wideT / max(1.0 - luminance(wideT), 1e-4);
  let sharpT = select(wideT, sharpSum / max(sharpW, 1e-5), sharpW > 1e-3);
  let sharp = sharpT / max(1.0 - luminance(sharpT), 1e-4);
  // Confidence: the sample weight that landed near this display pixel.
  let conf = clamp(sharpW, 0.0, 1.0);
  let mean = m1 / 9.0;
  let sd = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
  let motion = textureLoad(taaMotion, closestP, 0).xy;
  let prevUv = uv - motion;
  var outC = wide;
  if (frame.time.z > 1.0 && all(prevUv > vec2f(0.0)) && all(prevUv < vec2f(1.0))) {
    let hist = sampleHistoryCatmull(prevUv);
    let hy = rgb2ycocg(tonemapWeight(hist));
    let speed = length(motion * vec2f(osize));
    // Moving pixels lean on the smooth reconstruction (the history is
    // resampled and clipped there anyway).
    let mv = clamp(speed / 6.0, 0.0, 1.0);
    let cur = mix(sharp, wide, mv * (1.0 - conf));
    let gamma = mix(1.25, 0.75, clamp(speed / 8.0, 0.0, 1.0));
    let lo = mean - sd * gamma;
    let hi = mean + sd * gamma;
    let center = (hi + lo) * 0.5;
    let ext = max((hi - lo) * 0.5, vec3f(1e-4));
    let off = hy - center;
    let unit = abs(off / ext);
    let mx = max(unit.x, max(unit.y, unit.z));
    var clipped = hy;
    if (mx > 1.0) { clipped = center + off / mx; }
    let hc = ycocg2rgb(clipped);
    let histRgb = hc / max(1.0 - luminance(hc), 1e-4);
    // The current frame's weight: the usual TAA rate scaled by the sample's
    // confidence (a floor keeps moving content from going stale).
    let a = (1.0 - mix(0.92, 0.8, clamp(speed / 20.0, 0.0, 1.0))) * max(conf, mix(0.08, 0.5, mv));
    let wc = 1.0 / (1.0 + luminance(cur));
    let wh = 1.0 / (1.0 + luminance(histRgb));
    outC = (cur * a * wc + histRgb * (1.0 - a) * wh) / (a * wc + (1.0 - a) * wh);
  }
  textureStore(taaOut, id.xy, vec4f(max(outC, vec3f(0.0)), 1.0));
}

// --- Motion blur + depth of field (cinematic cameras) -------------------------

@group(1) @binding(0) var mbSrc: texture_2d<f32>;
@group(1) @binding(1) var mbMotion: texture_2d<f32>;
@group(1) @binding(2) var mbDepth: texture_depth_2d;
@group(1) @binding(3) var mbOut: texture_storage_2d<rgba16float, write>;

// An image pixel's depth / motion pixel (the same pixel at 100% render scale).
fn mbI(p: vec2i, toI: vec2f, isize: vec2i) -> vec2i {
  return min(vec2i((vec2f(p) + 0.5) * toI), isize - 1);
}

@compute @workgroup_size(8, 8)
fn motionDof(@builtin(global_invocation_id) id: vec3u) {
  _ = linearSampler;
  let size = vec2u(textureDimensions(mbSrc));
  if (any(id.xy >= size)) { return; }
  let p = vec2i(id.xy);
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  // Depth and motion may be at a lower (internal) resolution than the image.
  let isize = vec2i(textureDimensions(mbDepth));
  let toI = vec2f(isize) / vec2f(size);
  var c = textureLoad(mbSrc, p, 0).rgb;
  let d = textureLoad(mbDepth, mbI(p, toI, isize), 0);
  let z = frame.camPos.w / max(d, 1e-7);
  // Depth of field: gather on a golden-angle disc, radius from circle of confusion.
  let aperture = frame.wind.z;
  let focus = frame.exposure.w;
  if (aperture > 0.0 && focus > 0.0) {
    let coc = clamp(aperture * abs(z - focus) / max(z, 0.1) * 10.0, 0.0, 5.0);
    if (coc > 0.7) {
      var sum = c;
      var wsum = 1.0;
      for (var k = 1; k < 20; k++) {
        let r = sqrt(f32(k) / 20.0) * coc;
        let a = f32(k) * 2.39996;
        let q = clamp(p + vec2i(vec2f(cos(a), sin(a)) * r), vec2i(0), vec2i(size) - 1);
        let qd = textureLoad(mbDepth, mbI(q, toI, isize), 0);
        let qz = frame.camPos.w / max(qd, 1e-7);
        let qcoc = clamp(aperture * abs(qz - focus) / max(qz, 0.1) * 10.0, 0.0, 5.0);
        // Sharp foreground must not bleed onto a blurred background.
        let w = select(1.0, smoothstep(0.0, 1.0, qcoc / max(r, 0.5)), qz < z);
        sum += textureLoad(mbSrc, q, 0).rgb * w;
        wsum += w;
      }
      c = sum / wsum;
    }
  }
  // Motion blur along this pixel's velocity (180-degree shutter).
  let amount = frame.exposure.x;
  if (amount > 0.0) {
    var v = textureLoad(mbMotion, mbI(p, toI, isize), 0).xy * vec2f(size) * 0.5 * amount;
    let l = length(v);
    if (l > 1.0) {
      v = v * min(l, 8.0) / l;
      var sum = c;
      var wsum = 1.0;
      for (var k = 1; k <= 10; k++) {
        let t = f32(k) / 10.0 - 0.55;
        let q = clamp(vec2i(vec2f(p) + v * t), vec2i(0), vec2i(size) - 1);
        let qd = textureLoad(mbDepth, mbI(q, toI, isize), 0);
        // Don't smear a static background over a sharp foreground object.
        let w = select(1.0, 0.2, qd > d * 1.05);
        sum += textureLoad(mbSrc, q, 0).rgb * w;
        wsum += w;
      }
      c = sum / wsum;
    }
  }
  _ = uv;
  textureStore(mbOut, id.xy, vec4f(c, 1.0));
}

// --- God rays (screen-space radial blur of visible sky around the sun) -----------

@group(1) @binding(0) var grDepth: texture_depth_2d;
@group(1) @binding(1) var grOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn godRays(@builtin(global_invocation_id) id: vec3u) {
  _ = linearSampler;
  let size = textureDimensions(grOut);
  if (any(id.xy >= size)) { return; }
  let full = vec2f(textureDimensions(grDepth));
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let sun = frame.sunDir.xyz;
  let clip = frame.viewProj * vec4f(frame.camPos.xyz + sun * 10000.0, 1.0);
  var acc = vec3f(0.0);
  if (clip.w > 0.0 && frame.sunDir.w > 0.0 && frame.misc.z < 1.5) {
    let sp = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
    let delta = (sp - uv) / 40.0;
    var p = uv;
    var decay = 1.0;
    var sum = 0.0;
    let jitter = hash21(vec2f(id.xy) + frame.time.z);
    p += delta * jitter;
    for (var i = 0; i < 40; i++) {
      if (all(p > vec2f(0.0)) && all(p < vec2f(1.0))) {
        let d = textureLoad(grDepth, vec2i(p * full), 0);
        // Sky pixels near the sun emit.
        let dist = length((p - sp) * vec2f(full.x / full.y, 1.0));
        sum += select(0.0, 1.0, d <= 0.0) * decay * exp(-dist * 3.0);
      }
      decay *= 0.965;
      p += delta;
    }
    let lowSun = 1.0 - smoothstep(0.05, 0.6, sun.y);
    acc = frame.sunColor.rgb * sum / 40.0 * mix(0.08, 0.35, lowSun) * (1.0 - frame.weather.x * 0.6);
  }
  textureStore(grOut, id.xy, vec4f(acc, 1.0));
}

// --- Hi-Z pyramid (farthest reverse-Z depth = minimum) -----------------------

@group(1) @binding(0) var hizSrcDepth: texture_depth_2d;
@group(1) @binding(1) var hizSrc: texture_2d<f32>;
@group(1) @binding(2) var hizDst: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn hizFromDepth(@builtin(global_invocation_id) id: vec3u) {
  _ = frame.time.x;
  _ = linearSampler;
  let size = textureDimensions(hizDst);
  if (any(id.xy >= size)) { return; }
  let src = vec2i(textureDimensions(hizSrcDepth)) - 1;
  let b = vec2i(id.xy) * 2;
  let d = min(min(textureLoad(hizSrcDepth, min(b, src), 0), textureLoad(hizSrcDepth, min(b + vec2i(1, 0), src), 0)),
              min(textureLoad(hizSrcDepth, min(b + vec2i(0, 1), src), 0), textureLoad(hizSrcDepth, min(b + vec2i(1, 1), src), 0)));
  textureStore(hizDst, id.xy, vec4f(d));
}

@compute @workgroup_size(8, 8)
fn hizDown(@builtin(global_invocation_id) id: vec3u) {
  _ = frame.time.x;
  _ = linearSampler;
  let size = textureDimensions(hizDst);
  if (any(id.xy >= size)) { return; }
  let src = vec2i(textureDimensions(hizSrc)) - 1;
  let b = vec2i(id.xy) * 2;
  var d = min(min(textureLoad(hizSrc, min(b, src), 0).r, textureLoad(hizSrc, min(b + vec2i(1, 0), src), 0).r),
              min(textureLoad(hizSrc, min(b + vec2i(0, 1), src), 0).r, textureLoad(hizSrc, min(b + vec2i(1, 1), src), 0).r));
  // Odd sizes: include the extra row/column.
  if ((src.x & 1) == 0 && b.x + 2 == src.x) { d = min(d, textureLoad(hizSrc, vec2i(src.x, min(b.y, src.y)), 0).r); }
  if ((src.y & 1) == 0 && b.y + 2 == src.y) { d = min(d, textureLoad(hizSrc, vec2i(min(b.x, src.x), src.y), 0).r); }
  textureStore(hizDst, id.xy, vec4f(d));
}

// --- Bloom -------------------------------------------------------------------

@group(1) @binding(0) var bloomSrc: texture_2d<f32>;
@group(1) @binding(1) var bloomDst: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var bloomAdd: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn bloomDown(@builtin(global_invocation_id) id: vec3u) {
  _ = frame.time.x;
  _ = linearSampler;
  let size = textureDimensions(bloomDst);
  if (any(id.xy >= size)) { return; }
  let ts = 1.0 / vec2f(textureDimensions(bloomSrc));
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let a = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(-2, -2), 0.0).rgb;
  let b = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(0, -2), 0.0).rgb;
  let c = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(2, -2), 0.0).rgb;
  let d = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(-2, 0), 0.0).rgb;
  let e = textureSampleLevel(bloomSrc, linearSampler, uv, 0.0).rgb;
  let f = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(2, 0), 0.0).rgb;
  let g = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(-2, 2), 0.0).rgb;
  let h = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(0, 2), 0.0).rgb;
  let i = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(2, 2), 0.0).rgb;
  let j = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(-1, -1), 0.0).rgb;
  let k = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(1, -1), 0.0).rgb;
  let l = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(-1, 1), 0.0).rgb;
  let m = textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(1, 1), 0.0).rgb;
  var o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  // Karis-style firefly suppression.
  o = o / (1.0 + luminance(o) * 0.02);
  textureStore(bloomDst, id.xy, vec4f(min(o, vec3f(6e4)), 1.0));
}

@compute @workgroup_size(8, 8)
fn bloomUp(@builtin(global_invocation_id) id: vec3u) {
  _ = frame.time.x;
  _ = linearSampler;
  let size = textureDimensions(bloomDst);
  if (any(id.xy >= size)) { return; }
  let ts = 1.0 / vec2f(textureDimensions(bloomSrc));
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  var c = vec3f(0.0);
  c += textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(-1, -1), 0.0).rgb * 1.0;
  c += textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(0, -1), 0.0).rgb * 2.0;
  c += textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(1, -1), 0.0).rgb * 1.0;
  c += textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(-1, 0), 0.0).rgb * 2.0;
  c += textureSampleLevel(bloomSrc, linearSampler, uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(1, 0), 0.0).rgb * 2.0;
  c += textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(-1, 1), 0.0).rgb * 1.0;
  c += textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(0, 1), 0.0).rgb * 2.0;
  c += textureSampleLevel(bloomSrc, linearSampler, uv + ts * vec2f(1, 1), 0.0).rgb * 1.0;
  c /= 16.0;
  let base = textureLoad(bloomAdd, vec2i(id.xy), 0).rgb;
  // Coarser levels fade so the glow stays tight around bright sources.
  textureStore(bloomDst, id.xy, vec4f(base + c * 0.6, 1.0));
}

// --- Auto exposure ------------------------------------------------------------

struct Exposure { value: f32, avgLum: f32, pad0: f32, pad1: f32 };
@group(1) @binding(0) var expoSrc: texture_2d<f32>;
@group(1) @binding(1) var<storage, read_write> expo: Exposure;

var<workgroup> bins: array<atomic<u32>, 64>;

// Exposure drop (EV) for bad weather: ~0.75 stop in daytime rain, ~0.9 in a storm,
// less at night where the key is already low.
fn weatherGloomEv() -> f32 {
  let rain = frame.weather.y;
  let overcast = clamp(frame.weather.x * 1.6 - 0.75, 0.0, 1.0);
  return (min(rain * 1.2, 1.0) * 0.75 + overcast * 0.2) * (1.0 - frame.time.w * 0.6);
}

// Highlight shoulder: identity below k, rolls smoothly up to 1 above it.
fn shoulder(x: vec3f, k: f32) -> vec3f {
  let over = max(x - k, vec3f(0.0)) / (1.0 - k);
  return select(x, k + (1.0 - k) * (1.0 - exp(-over)), x > vec3f(k));
}

// Histogram metering: 64 bins of log2 luminance over [-10, 6], averaging only
// the 40th..95th percentile so dark asphalt and sun glints don't drive it.
// The result is clamped to +-1 stop around a physical baseline from the CPU.
@compute @workgroup_size(16, 16)
fn exposure(@builtin(local_invocation_index) li: u32, @builtin(local_invocation_id) lid: vec3u) {
  _ = frame.time.x;
  _ = linearSampler;
  if (li < 64u) { atomicStore(&bins[li], 0u); }
  workgroupBarrier();
  let size = textureDimensions(expoSrc);
  for (var y = lid.y; y < size.y; y += 16u) {
    for (var x = lid.x; x < size.x; x += 16u) {
      let c = textureLoad(expoSrc, vec2u(x, y), 0).rgb;
      let uv = (vec2f(f32(x), f32(y)) + 0.5) / vec2f(size);
      let w = u32(round((1.0 - 0.6 * length(uv - 0.5)) * 8.0));
      let l = clamp((log2(max(luminance(c), 1e-6)) + 10.0) / 16.0, 0.0, 0.9999);
      atomicAdd(&bins[u32(l * 64.0)], w);
    }
  }
  workgroupBarrier();
  if (li == 0u) {
    var total = 0.0;
    for (var b = 0u; b < 64u; b++) { total += f32(atomicLoad(&bins[b])); }
    let lo = total * 0.4;
    let hi = total * 0.95;
    var acc = 0.0;
    var sum = 0.0;
    var cnt = 0.0;
    // Black and white points (1st and 99.5th percentile, EV) for the levels
    // stretch in fsTonemap.
    var evLo = -10.0;
    var evHi = 6.0;
    var gotLo = false;
    var gotHi = false;
    for (var b = 0u; b < 64u; b++) {
      let n = f32(atomicLoad(&bins[b]));
      let ev = (f32(b) + 0.5) / 64.0 * 16.0 - 10.0;
      let take = max(0.0, min(acc + n, hi) - max(acc, lo));
      sum += take * ev;
      cnt += take;
      acc += n;
      if (!gotLo && acc >= total * 0.01) { evLo = ev; gotLo = true; }
      if (!gotHi && acc >= total * 0.995) { evHi = ev; gotHi = true; }
    }
    let avg = exp2(sum / max(cnt, 1.0));
    // Rain and storm grade about a stop darker than a sunny key (the meter
    // would otherwise lift an overcast street back to sunny brightness).
    let gloom = exp2(-weatherGloomEv());
    let key = mix(0.17, 0.05, frame.time.w) * gloom;
    let base = max(frame.exposure.y, 1e-4) * gloom;
    let spread = mix(2.0, 3.0, frame.time.w);
    let tgt = clamp(key / max(avg, 1e-5), base / spread, base * spread);
    var cur = expo.value;
    var pts = vec2f(expo.pad0, expo.pad1);
    if (cur <= 0.0 || frame.time.z < 2.0) { cur = tgt; pts = vec2f(evLo, evHi); }
    let rate = select(1.2, 2.5, tgt < cur);
    let k = 1.0 - exp(-frame.time.y * rate);
    cur = mix(cur, tgt, k);
    pts = mix(pts, vec2f(evLo, evHi), k);
    expo.value = cur;
    expo.pad0 = pts.x;
    expo.pad1 = pts.y;
    expo.avgLum = avg;
  }
}

// --- Tonemap (fullscreen) --------------------------------------------------------

@group(1) @binding(0) var tmColor: texture_2d<f32>;
@group(1) @binding(1) var tmBloom: texture_2d<f32>;
@group(1) @binding(2) var<storage, read> tmExpo: Exposure;
@group(1) @binding(3) var tmRays: texture_2d<f32>;

struct FsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> FsOut {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3))[vi];
  var o: FsOut;
  o.pos = vec4f(p, 0, 1);
  o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}

// AgX tonemapper (Troy Sobotka; polynomial fit by Benjamin Wrensch).
fn agx(c: vec3f) -> vec3f {
  let inset = mat3x3f(0.842479, 0.042328, 0.042376, 0.078434, 0.878469, 0.078434, 0.079224, 0.079166, 0.879143);
  let outset = mat3x3f(1.196879, -0.052897, -0.052972, -0.098021, 1.151903, -0.098043, -0.099030, -0.098961, 1.151074);
  var x = inset * max(c, vec3f(1e-10));
  x = clamp(log2(x), vec3f(-12.47393), vec3f(4.026069));
  x = (x + 12.47393) / 16.5;
  let x2 = x * x;
  let x4 = x2 * x2;
  x = 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  return clamp(outset * x, vec3f(0.0), vec3f(1.0));
}

fn lensDrops(uv: vec2f) -> vec2f {
  // Rain drops on the camera lens refract the image.
  let rain = frame.weather.y;
  if (rain < 0.05 || frame.misc.z < 0.5) { return vec2f(0.0); }
  var off = vec2f(0.0);
  let aspect = frame.resolution.x / frame.resolution.y;
  for (var layer = 0; layer < 2; layer++) {
    let scale = select(9.0, 18.0, layer == 1);
    let t = frame.time.x * select(0.05, 0.09, layer == 1);
    var q = uv * vec2f(aspect, 1.0) * scale + vec2f(0.0, t * scale);
    let cell = floor(q);
    let f = fract(q) - 0.5;
    let h = hash21(cell + f32(layer) * 13.0);
    if (h < rain * 0.5) {
      let c = (hash22(cell) - 0.5) * 0.6;
      let d = f - c;
      let r = mix(0.12, 0.3, hash21(cell + 7.0));
      let life = fract(frame.time.x * 0.15 + h * 10.0);
      if (length(d) < r * (1.0 - life * 0.5)) { off += d * 0.04 * (1.0 - life); }
    }
  }
  return off;
}

@fragment fn fsTonemap(i: FsOut) -> @location(0) vec4f {
  var uv = i.uv;
  uv += lensDrops(uv);
  var c = textureSampleLevel(tmColor, linearSampler, uv, 0.0).rgb;
  // AO (8) and sky-visibility (10) debug views: raw values (PNG value / 255 = AO), no exposure or grade.
  if (u32(frame.misc.x) == 8u || u32(frame.misc.x) == 10u) { return vec4f(c, 1.0); }
  // Contrast-adaptive sharpening: restores the detail TAA softens, limited to
  // the local min/max so edges don't ring. Weaker on bright highlights.
  {
    let px = 1.0 / vec2f(textureDimensions(tmColor));
    let n = textureSampleLevel(tmColor, linearSampler, uv + vec2f(0.0, -px.y), 0.0).rgb;
    let s = textureSampleLevel(tmColor, linearSampler, uv + vec2f(0.0, px.y), 0.0).rgb;
    let e = textureSampleLevel(tmColor, linearSampler, uv + vec2f(px.x, 0.0), 0.0).rgb;
    let w = textureSampleLevel(tmColor, linearSampler, uv + vec2f(-px.x, 0.0), 0.0).rgb;
    let mn = min(c, min(min(n, s), min(e, w)));
    let mx = max(c, max(max(n, s), max(e, w)));
    // Headroom measured on HDR-compressed values (x / (1 + x)).
    let cmn = mn / (1.0 + mn);
    let cmx = mx / (1.0 + mx);
    let amp = sqrt(clamp(min(cmn, 1.0 - cmx) / max(cmx, vec3f(1e-4)), vec3f(0.0), vec3f(1.0)));
    let k = amp * frame.upscale.z * (1.0 - frame.exposure.x * 0.5);
    c = clamp(c + (4.0 * c - (n + s + e + w)) * k / (1.0 + 4.0 * k), mn, mx);
  }
  let bloom = textureSampleLevel(tmBloom, linearSampler, uv, 0.0).rgb;
  let night = frame.time.w;
  // Six levels weighted 0.6^k sum to ~2.4.
  c = mix(c, bloom / 2.4, (mix(0.05, 0.12, night) + frame.weather.y * 0.06) * frame.extra.w);
  c += textureSampleLevel(tmRays, linearSampler, uv, 0.0).rgb;
  c *= tmExpo.value;
  // White balance + split tone by time of day and weather (before tonemapping).
  let golden = clamp(1.0 - abs(frame.exposure.z - 0.12) / 0.12, 0.0, 1.0) * (1.0 - night);
  var sh = vec3f(0.97, 1.0, 1.04);
  var hi = vec3f(1.02, 1.0, 0.97);
  sh = mix(sh, vec3f(0.94, 0.97, 1.05), golden);
  hi = mix(hi, vec3f(1.1, 1.0, 0.85), golden);
  sh = mix(sh, vec3f(0.85, 0.98, 1.1), night);
  hi = mix(hi, vec3f(1.0), night);
  let rainK = frame.weather.y;
  sh = mix(sh, vec3f(0.95, 1.0, 1.05), rainK);
  hi = mix(hi, vec3f(0.95, 1.0, 1.05), rainK);
  let lum = luminance(c);
  c *= mix(sh, hi, smoothstep(-6.0, 1.0, log2(max(lum, 1e-6))));
  var m = agx(c);
  // Levels: stretch the frame's 1st..99.5th percentile to the display range
  // (capped gain, blacks never lifted) so hazy days don't sit in mid-grey.
  let E = tmExpo.value;
  let dLo = agx(vec3f(exp2(tmExpo.pad0) * E)).g;
  let dHi = agx(vec3f(exp2(tmExpo.pad1) * E)).g;
  // Rain keeps its low-key, flat grade: the stretch must not undo the
  // exposure drop.
  let wetGrade = clamp(rainK * 1.5, 0.0, 1.0) * (1.0 - night);
  // (Golden hour: a low sun's sunlit walls already fill the top of the
  // range; stretching further clips them.)
  let gain = clamp(0.94 / max(dHi - dLo, 0.05), 1.0, mix(mix(mix(1.45, 1.15, golden), 1.12, night), 1.06, wetGrade));
  let lo = min(dLo, 0.09);
  m = max((m - lo) * gain + 0.015, vec3f(0.0));
  // Whites roll off instead of clipping (overcast skies and wet roofs sit at
  // the top of the range); a clear day keeps its full-strength highlights.
  let soft = clamp(frame.weather.x * 1.5 - 0.5, 0.0, 1.0);
  // A low golden sun square on a pale wall (metered off the long-shadowed
  // street) rolls off too, instead of clipping to peach-white.
  m = min(mix(m, shoulder(m, 0.72), max(soft, golden * 0.8)), vec3f(1.0));
  // Punchy look in AgX space; less saturation in rain.
  m = pow(m, vec3f(mix(1.22, 1.12, night)));
  let sat = mix(1.12, 1.15, night) * mix(1.0, 0.72, rainK) * mix(1.0, 0.9, soft * (1.0 - night));
  let ml = luminance(m);
  m = max(mix(vec3f(ml), m, sat), vec3f(0.0));
  // Soft vignette and highlight-safe grain.
  let v = length(i.uv - 0.5);
  m *= mix(1.0, 0.86, smoothstep(0.45, 0.95, v));
  let grain = (hash21(i.pos.xy + frame.time.z * 17.0) - 0.5) * 0.012 * (1.0 - m);
  m = m + grain;
  return vec4f(m, 1.0);
}
