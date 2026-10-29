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
  textureStore(bloomDst, id.xy, vec4f(base + c * 0.85, 1.0));
}

// --- Auto exposure ------------------------------------------------------------

struct Exposure { value: f32, avgLum: f32, pad0: f32, pad1: f32 };
@group(1) @binding(0) var expoSrc: texture_2d<f32>;
@group(1) @binding(1) var<storage, read_write> expo: Exposure;

var<workgroup> lumSum: array<f32, 256>;

@compute @workgroup_size(16, 16)
fn exposure(@builtin(local_invocation_index) li: u32, @builtin(local_invocation_id) lid: vec3u) {
  _ = frame.time.x;
  _ = linearSampler;
  let size = textureDimensions(expoSrc);
  var s = 0.0;
  var n = 0.0;
  for (var y = lid.y; y < size.y; y += 16u) {
    for (var x = lid.x; x < size.x; x += 16u) {
      let c = textureLoad(expoSrc, vec2u(x, y), 0).rgb;
      // Center-weighted metering.
      let uv = (vec2f(f32(x), f32(y)) + 0.5) / vec2f(size);
      let w = 1.0 - 0.6 * length(uv - 0.5);
      s += log2(max(luminance(c), 1e-4)) * w;
      n += w;
    }
  }
  lumSum[li] = s / max(n, 1e-4);
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride >>= 1u) {
    if (li < stride) { lumSum[li] += lumSum[li + stride]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    let avg = exp2(lumSum[0] / 256.0);
    // Darker key at night keeps the city moody instead of washed out.
    let key = mix(0.16, 0.06, frame.time.w);
    let tgt = clamp(key / max(avg, 1e-4), 0.08, 40.0);
    var cur = expo.value;
    if (cur <= 0.0 || frame.time.z < 2.0) { cur = tgt; }
    let rate = select(1.2, 2.5, tgt < cur);
    cur = mix(cur, tgt, 1.0 - exp(-frame.time.y * rate));
    expo.value = cur;
    expo.avgLum = avg;
  }
}

// --- Tonemap (fullscreen) --------------------------------------------------------

@group(1) @binding(0) var tmColor: texture_2d<f32>;
@group(1) @binding(1) var tmBloom: texture_2d<f32>;
@group(1) @binding(2) var<storage, read> tmExpo: Exposure;

struct FsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> FsOut {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3))[vi];
  var o: FsOut;
  o.pos = vec4f(p, 0, 1);
  o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}

fn acesFitted(x: vec3f) -> vec3f {
  let m1 = mat3x3f(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  let m2 = mat3x3f(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  let v = m1 * x;
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(m2 * (a / b), vec3f(0), vec3f(1));
}

fn lensDrops(uv: vec2f) -> vec2f {
  // Rain drops on the camera lens refract the image.
  let rain = frame.weather.y;
  if (rain < 0.05) { return vec2f(0.0); }
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
  let bloom = textureSampleLevel(tmBloom, linearSampler, uv, 0.0).rgb;
  c = mix(c, bloom, 0.06 + frame.weather.y * 0.05);
  c *= tmExpo.value;
  // Grade: slightly warm highlights, cool shadows, more contrast at night.
  let lum = luminance(c);
  c = mix(c, c * vec3f(0.92, 0.97, 1.08), smoothstep(0.4, 0.0, lum) * 0.4);
  let sat = mix(1.12, 1.25, frame.time.w) - frame.weather.y * 0.2;
  c = max(mix(vec3f(lum), c, sat), vec3f(0.0));
  var m = acesFitted(c * 1.1);
  // Vignette.
  let v = length(i.uv - 0.5);
  m *= mix(1.0, 0.72, smoothstep(0.35, 0.85, v));
  // Film grain.
  let grain = (hash21(i.pos.xy + frame.time.z * 17.0) - 0.5) * 0.02;
  m = pow(m, vec3f(1.0 / 2.2)) + grain;
  return vec4f(m, 1.0);
}
