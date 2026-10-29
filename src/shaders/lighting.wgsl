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

fn stars(d: vec3f) -> vec3f {
  let p = d * 300.0;
  let c = floor(p);
  let h = hash31(c);
  if (h < 0.996) { return vec3f(0.0); }
  let f = fract(p) - 0.5;
  let s = exp(-dot(f, f) * 40.0) * (h - 0.996) * 250.0;
  let tw = 0.7 + 0.3 * sin(frame.time.x * 3.0 + h * 100.0);
  return vec3f(s * tw) * mix(vec3f(1.0, 0.85, 0.7), vec3f(0.7, 0.8, 1.0), hash31(c + 3.0));
}

fn skyPixel(d: vec3f, uv: vec2f) -> vec3f {
  var c = skyRadiance(d);
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
  // Clouds.
  if (d.y > -0.02) {
    let cl = textureSampleLevel(cloudTex, linearSampler, uv, 0.0);
    c = c * cl.a + cl.rgb;
  }
  // Lightning flash lights the whole sky.
  c += vec3f(0.6, 0.65, 0.9) * frame.wind.w * 3.0 * frame.weather.x;
  return c;
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

fn ssr(world: vec3f, n: vec3f, v: vec3f, px: vec2f, rough: f32) -> vec4f {
  var r = reflect(-v, n);
  // Roughness jitter (resolved by TAA).
  let j = hash22(px + frame.time.z * 0.618) - 0.5;
  r = normalize(r + vec3f(j.x, 0.0, j.y) * rough * 0.6);
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
      let c = textureSampleLevel(prevColor, linearSampler, puv, 0.0).rgb;
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
    let fogCol = frame.skyAmbient.rgb * 0.9 + frame.cityGlow.rgb * 1.5 + frame.sunColor.rgb * 0.08 * pow(max(dot(rd, frame.sunDir.xyz), 0.0), 8.0);
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
  let ao = a.a * textureSampleLevel(aoTex, linearSampler, uv, 0.0).r;
  let dist = length(world - frame.camPos.xyz);

  var color = vec3f(0.0);
  // Sun.
  if (frame.sunDir.w > 0.0) {
    let sh = shadow(world, n, vd) * cloudShadow(world);
    color += brdf(n, v, frame.sunDir.xyz, albedo, f0, rough, metal) * frame.sunColor.rgb * sh;
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
    if (L.kind < 0.5) {
      // Street lights point down.
      lc *= mix(0.15, 1.0, smoothstep(-0.2, 0.3, l.y));
    }
    color += brdf(n, v, l, albedo, f0, max(rough, 0.08), metal) * lc * atten * 60.0;
  }
  // Ambient: hemisphere sky + ground bounce.
  let skyAmb = mix(frame.groundAmbient.rgb, frame.skyAmbient.rgb, n.y * 0.5 + 0.5);
  let diffAmb = albedo * (1.0 - metal) * skyAmb * ao;
  color += diffAmb;
  // Specular ambient: sky reflection, replaced by SSR where available.
  let nv = max(dot(n, v), 1e-3);
  let Fa = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  var refl = reflect(-v, n);
  var env = skyRadiance(normalize(vec3f(refl.x, max(refl.y, 0.02), refl.z)));
  // Below the horizon reflections see the city: darken toward ground ambient.
  env = mix(frame.groundAmbient.rgb * 0.5 + frame.cityGlow.rgb, env, smoothstep(-0.05, 0.15, refl.y));
  env *= mix(1.0, 0.25, rough);
  if (rough < 0.35 && frame.misc.y > 0.5) {
    let r = ssr(world, n, v, pxf, rough);
    env = mix(env, r.rgb, r.a);
  }
  var specOcc = mix(ao, 1.0, 0.5);
  color += env * Fa * specOcc;
  color += em.rgb;
  color = applyFog(color, world, uv, dist, rd);
  // Debug views.
  let dbg = u32(frame.misc.x);
  if (dbg == 1u) { color = albedo; }
  if (dbg == 2u) { color = n * 0.5 + 0.5; }
  if (dbg == 3u) { color = vec3f(rough); }
  if (dbg == 5u) { color = vec3f(shadow(world, n, vd)); }
  if (dbg == 6u) { color = vec3f(f32(min(u32(max(0.0, 0.0)), 3u))); }
  if (dbg == 4u) { color = vec3f(f32(count) / 32.0, 0.0, 0.0) + albedo * 0.2; }
  textureStore(outColor, px, vec4f(color, 1.0));
}
