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
  textureStore(bloomDst, id.xy, vec4f(base + c * 1.05, 1.0));
}

// --- Auto exposure ------------------------------------------------------------

struct Exposure { value: f32, avgLum: f32, pad0: f32, pad1: f32 };
@group(1) @binding(0) var expoSrc: texture_2d<f32>;
@group(1) @binding(1) var<storage, read_write> expo: Exposure;

var<workgroup> bins: array<atomic<u32>, 64>;

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
    for (var b = 0u; b < 64u; b++) {
      let n = f32(atomicLoad(&bins[b]));
      let take = max(0.0, min(acc + n, hi) - max(acc, lo));
      sum += take * ((f32(b) + 0.5) / 64.0 * 16.0 - 10.0);
      cnt += take;
      acc += n;
    }
    let avg = exp2(sum / max(cnt, 1.0));
    let key = mix(0.12, 0.045, frame.time.w);
    let base = max(frame.exposure.y, 1e-4);
    let spread = mix(2.0, 3.0, frame.time.w);
    let tgt = clamp(key / max(avg, 1e-5), base / spread, base * spread);
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
  let bloom = textureSampleLevel(tmBloom, linearSampler, uv, 0.0).rgb;
  let night = frame.time.w;
  c = mix(c, bloom, mix(0.03, 0.1, night) + frame.weather.y * 0.06);
  c *= tmExpo.value;
  // White balance + split tone by time of day and weather (before tonemapping).
  let golden = clamp(1.0 - abs(frame.exposure.z - 0.12) / 0.12, 0.0, 1.0) * (1.0 - night);
  var sh = vec3f(0.97, 1.0, 1.04);
  var hi = vec3f(1.02, 1.0, 0.97);
  sh = mix(sh, vec3f(0.88, 0.95, 1.12), golden);
  hi = mix(hi, vec3f(1.1, 1.0, 0.85), golden);
  sh = mix(sh, vec3f(0.85, 0.98, 1.1), night);
  hi = mix(hi, vec3f(1.0), night);
  let rainK = frame.weather.y;
  sh = mix(sh, vec3f(0.95, 1.0, 1.05), rainK);
  hi = mix(hi, vec3f(0.95, 1.0, 1.05), rainK);
  let lum = luminance(c);
  c *= mix(sh, hi, smoothstep(-6.0, 1.0, log2(max(lum, 1e-6))));
  var m = agx(c);
  // Punchy look in AgX space; saturation only at night, less in rain.
  m = pow(m, vec3f(1.12));
  let sat = mix(1.0, 1.15, night) * mix(1.0, 0.8, rainK);
  let ml = luminance(m);
  m = max(mix(vec3f(ml), m, sat), vec3f(0.0));
  // Soft vignette and highlight-safe grain.
  let v = length(i.uv - 0.5);
  m *= mix(1.0, 0.86, smoothstep(0.45, 0.95, v));
  let grain = (hash21(i.pos.xy + frame.time.z * 17.0) - 0.5) * 0.012 * (1.0 - m);
  m = m + grain;
  return vec4f(m, 1.0);
}
