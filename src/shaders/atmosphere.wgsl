// Physically based sky (Hillaire 2020, "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique"). Distances in kilometers.

const R_GROUND = 6360.0;
const R_TOP = 6460.0;
const RAYLEIGH_SCAT = vec3f(5.802, 13.558, 33.1) * 1e-3;
const MIE_SCAT = 3.996e-3;
const MIE_EXT = 4.44e-3;
const OZONE_ABS = vec3f(0.650, 1.881, 0.085) * 1e-3;
const SUN_ILLUMINANCE = 12.0;
const MOON_ILLUMINANCE = 0.018;

struct AtmoParams {
  mieScale: f32,      // haze multiplier (weather / city smog)
  rayleighScale: f32,
  groundAlbedo: f32,
  apMaxDist: f32,     // km covered by the aerial perspective volume
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> atmo: AtmoParams;
@group(0) @binding(2) var lutSampler: sampler;

fn mieScale() -> f32 { return atmo.mieScale; }

struct Medium { scat: vec3f, ext: vec3f, mie: f32, ray: vec3f };

fn medium(h: f32) -> Medium {
  let rd = exp(-h / 8.0) * atmo.rayleighScale;
  // Haze lives low, with an extra boundary layer near the ground.
  let md = (exp(-h / 1.2) + 2.5 * exp(-h / 0.35) * (atmo.mieScale - 1.0) / max(atmo.mieScale, 1.0)) * atmo.mieScale;
  let od = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  var m: Medium;
  m.ray = RAYLEIGH_SCAT * rd;
  m.mie = MIE_SCAT * md;
  m.scat = m.ray + vec3f(m.mie);
  m.ext = m.ray + vec3f(MIE_EXT * md) + OZONE_ABS * od;
  return m;
}

fn raySphere(ro: vec3f, rd: vec3f, r: f32) -> vec2f {
  let b = dot(ro, rd);
  let c = dot(ro, ro) - r * r;
  let d = b * b - c;
  if (d < 0.0) { return vec2f(-1.0); }
  let s = sqrt(d);
  return vec2f(-b - s, -b + s);
}

fn rayleighPhase(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }

fn miePhase(c: f32) -> f32 {
  let g = 0.8;
  let k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
}

// --- Transmittance LUT ------------------------------------------------------

fn transmittanceUv(r: f32, mu: f32) -> vec2f {
  let H = sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND);
  let rho = sqrt(max(0.0, r * r - R_GROUND * R_GROUND));
  let disc = r * r * (mu * mu - 1.0) + R_TOP * R_TOP;
  let d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  let dMin = R_TOP - r;
  let dMax = rho + H;
  return vec2f((d - dMin) / (dMax - dMin), rho / H);
}

fn transmittanceParams(uv: vec2f) -> vec2f {
  let H = sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND);
  let rho = H * uv.y;
  let r = sqrt(rho * rho + R_GROUND * R_GROUND);
  let dMin = R_TOP - r;
  let dMax = rho + H;
  let d = dMin + uv.x * (dMax - dMin);
  var mu = 1.0;
  if (d > 0.0) { mu = (H * H - rho * rho - d * d) / (2.0 * r * d); }
  return vec2f(r, clamp(mu, -1.0, 1.0));
}

@group(1) @binding(0) var transmittanceOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn transmittanceLut(@builtin(global_invocation_id) id: vec3u) {
  _ = frame.time.x;
  _ = lutSampler;
  _ = atmo.mieScale;
  let size = textureDimensions(transmittanceOut);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let p = transmittanceParams(uv);
  let ro = vec3f(0.0, p.x, 0.0);
  let rd = vec3f(sqrt(1.0 - p.y * p.y), p.y, 0.0);
  let t = raySphere(ro, rd, R_TOP).y;
  let steps = 40;
  var od = vec3f(0.0);
  let dt = t / f32(steps);
  for (var i = 0; i < steps; i++) {
    let pos = ro + rd * (f32(i) + 0.5) * dt;
    od += medium(length(pos) - R_GROUND).ext * dt;
  }
  textureStore(transmittanceOut, id.xy, vec4f(exp(-od), 1.0));
}

// --- Shared sampling --------------------------------------------------------

@group(1) @binding(1) var transmittanceTex: texture_2d<f32>;
@group(1) @binding(2) var multiScatTex: texture_2d<f32>;

fn sampleTransmittance(r: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transmittanceTex, lutSampler, transmittanceUv(r, mu), 0.0).rgb;
}

fn sampleMultiScat(r: f32, mu: f32) -> vec3f {
  let uv = vec2f(mu * 0.5 + 0.5, clamp((r - R_GROUND) / (R_TOP - R_GROUND), 0.0, 1.0));
  return textureSampleLevel(multiScatTex, lutSampler, uv, 0.0).rgb;
}

// --- Multiple scattering LUT ------------------------------------------------

@group(1) @binding(3) var multiScatOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn multiScatLut(@builtin(global_invocation_id) id: vec3u) {
  _ = frame.time.x;
  _ = lutSampler;
  _ = atmo.mieScale;
  let size = textureDimensions(multiScatOut);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let muS = uv.x * 2.0 - 1.0;
  let r = R_GROUND + uv.y * (R_TOP - R_GROUND);
  let ro = vec3f(0.0, r, 0.0);
  let sun = vec3f(sqrt(1.0 - muS * muS), muS, 0.0);
  var lum = vec3f(0.0);
  var fms = vec3f(0.0);
  let n = 8;
  for (var a = 0; a < n; a++) {
    for (var b = 0; b < n; b++) {
      let theta = PI * (f32(a) + 0.5) / f32(n);
      let phi = 2.0 * PI * (f32(b) + 0.5) / f32(n);
      let rd = vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
      let tg = raySphere(ro, rd, R_GROUND);
      var tmax = raySphere(ro, rd, R_TOP).y;
      if (tg.x > 0.0) { tmax = tg.x; }
      let steps = 20;
      let dt = tmax / f32(steps);
      var T = vec3f(1.0);
      var L = vec3f(0.0);
      var F = vec3f(0.0);
      for (var i = 0; i < steps; i++) {
        let pos = ro + rd * (f32(i) + 0.5) * dt;
        let h = length(pos);
        let m = medium(h - R_GROUND);
        let up = pos / h;
        let sunT = sampleTransmittance(h, dot(up, sun));
        let stepT = exp(-m.ext * dt);
        let S = m.scat * sunT / (4.0 * PI);
        let Sint = (S - S * stepT) / max(m.ext, vec3f(1e-6));
        L += T * Sint;
        let Fint = (m.scat - m.scat * stepT) / max(m.ext, vec3f(1e-6));
        F += T * Fint;
        T *= stepT;
      }
      if (tg.x > 0.0) {
        let pos = ro + rd * tg.x;
        let up = normalize(pos);
        L += T * sampleTransmittance(R_GROUND, dot(up, sun)) * max(dot(up, sun), 0.0) * atmo.groundAlbedo / PI;
      }
      let w = sin(theta) * PI / f32(n) * 2.0 * PI / f32(n) / (4.0 * PI);
      lum += L * w;
      fms += F * w / (4.0 * PI) * 4.0 * PI;
    }
  }
  let psi = lum / max(vec3f(1.0) - fms, vec3f(1e-3));
  textureStore(multiScatOut, id.xy, vec4f(psi, 1.0));
}

// --- Sky view LUT ----------------------------------------------------------

fn camR() -> f32 {
  return R_GROUND + max(frame.camPos.y, 0.0) * 0.001 + 0.002;
}

fn integrateScattering(ro: vec3f, rd: vec3f, tmax: f32, steps: i32, lightDir: vec3f, illum: f32, T_out: ptr<function, vec3f>) -> vec3f {
  let cosT = dot(rd, lightDir);
  let pr = rayleighPhase(cosT);
  let pm = miePhase(cosT);
  var T = vec3f(1.0);
  var L = vec3f(0.0);
  var tPrev = 0.0;
  for (var i = 0; i < steps; i++) {
    // Quadratic step distribution: denser near the camera.
    let s = (f32(i) + 0.3) / f32(steps);
    let t = tmax * s * s;
    let dt = t - tPrev;
    tPrev = t;
    let pos = ro + rd * t;
    let h = length(pos);
    let up = pos / h;
    let m = medium(h - R_GROUND);
    let mu = dot(up, lightDir);
    let sunT = sampleTransmittance(h, mu);
    // Earth shadow.
    let shadow = select(1.0, 0.0, raySphere(pos, lightDir, R_GROUND).x > 0.0);
    let ms = sampleMultiScat(h, mu);
    let S = (m.ray * pr + vec3f(m.mie * pm)) * sunT * shadow + m.scat * ms;
    let stepT = exp(-m.ext * dt);
    L += T * (S - S * stepT) / max(m.ext, vec3f(1e-6));
    T *= stepT;
  }
  *T_out = T;
  return L * illum;
}

@group(1) @binding(4) var skyViewOut: texture_storage_2d<rgba16float, write>;

fn skyViewDir(uv: vec2f) -> vec3f {
  // v: non-linear latitude concentrated at the horizon; u: azimuth.
  let vc = uv.y * 2.0 - 1.0;
  let lat = sign(vc) * vc * vc * PI * 0.5;
  let az = (uv.x * 2.0 - 1.0) * PI;
  return vec3f(cos(lat) * cos(az), sin(lat), cos(lat) * sin(az));
}

@compute @workgroup_size(8, 8)
fn skyViewLut(@builtin(global_invocation_id) id: vec3u) {
  _ = frame.time.x;
  _ = lutSampler;
  _ = atmo.mieScale;
  let size = textureDimensions(skyViewOut);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let rd = skyViewDir(uv);
  let ro = vec3f(0.0, camR(), 0.0);
  var tmax = raySphere(ro, rd, R_TOP).y;
  let tg = raySphere(ro, rd, R_GROUND);
  if (tg.x > 0.0) { tmax = tg.x; }
  var T = vec3f(1.0);
  var L = integrateScattering(ro, rd, tmax, 32, frame.sunDir.xyz, SUN_ILLUMINANCE, &T);
  var T2 = vec3f(1.0);
  L += integrateScattering(ro, rd, tmax, 16, frame.moonDir.xyz, MOON_ILLUMINANCE * frame.moonDir.w, &T2) * vec3f(0.85, 0.9, 1.0);
  textureStore(skyViewOut, id.xy, vec4f(L, 1.0));
}

// --- Aerial perspective volume -----------------------------------------------

@group(1) @binding(5) var apOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn aerialPerspective(@builtin(global_invocation_id) id: vec3u) {
  _ = frame.time.x;
  _ = lutSampler;
  _ = atmo.mieScale;
  let size = textureDimensions(apOut);
  if (any(id.xy >= size.xy)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size.xy);
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let wp = frame.invViewProj * ndc;
  let rd = normalize(wp.xyz / wp.w - frame.camPos.xyz);
  let ro = vec3f(0.0, camR(), 0.0);
  let slices = size.z;
  var T = vec3f(1.0);
  var L = vec3f(0.0);
  var tPrev = 0.0;
  let sun = frame.sunDir.xyz;
  let moon = frame.moonDir.xyz;
  let prS = rayleighPhase(dot(rd, sun));
  let pmS = miePhase(dot(rd, sun));
  let prM = rayleighPhase(dot(rd, moon));
  let pmM = miePhase(dot(rd, moon));
  for (var z = 0u; z < slices; z++) {
    let s = (f32(z) + 1.0) / f32(slices);
    let t = atmo.apMaxDist * s * s;
    // Two sub-steps per slice.
    for (var k = 0; k < 2; k++) {
      let tt = mix(tPrev, t, (f32(k) + 0.5) / 2.0);
      let dt = (t - tPrev) * 0.5;
      let pos = ro + rd * tt;
      let h = length(pos);
      let up = pos / h;
      let m = medium(h - R_GROUND);
      let sunT = sampleTransmittance(h, dot(up, sun));
      let moonT = sampleTransmittance(h, dot(up, moon));
      let msS = sampleMultiScat(h, dot(up, sun));
      let msM = sampleMultiScat(h, dot(up, moon));
      var S = ((m.ray * prS + vec3f(m.mie * pmS)) * sunT + m.scat * msS) * SUN_ILLUMINANCE;
      S += ((m.ray * prM + vec3f(m.mie * pmM)) * moonT + m.scat * msM) * MOON_ILLUMINANCE * frame.moonDir.w;
      // City light pollution scattering at night.
      S += m.scat * frame.cityGlow.rgb * exp(-max(h - R_GROUND, 0.0) / 0.6) * 4.0;
      let stepT = exp(-m.ext * dt);
      L += T * (S - S * stepT) / max(m.ext, vec3f(1e-6));
      T *= stepT;
    }
    tPrev = t;
    textureStore(apOut, vec3u(id.xy, z), vec4f(L, dot(T, vec3f(1.0 / 3.0))));
  }
}
