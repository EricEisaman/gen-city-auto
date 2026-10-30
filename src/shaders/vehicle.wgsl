// Instanced vehicles (NURBS-tessellated meshes). Opaque parts go to the
// G-buffer; glass is drawn in a forward pass with reflections.

struct Instance {
  model: mat4x4f,
  prevModel: mat4x4f,
  color: vec4f,
  color2: vec4f,
  params: vec4f,  // x = headlights, y = brake, z = indicator (-1 left, 1 right), w = dirt
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> instances: array<Instance>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) prevClip: vec4f,
  @location(4) @interpolate(flat) mat: u32,
  @location(5) @interpolate(flat) inst: u32,
  @location(6) lnormal: vec3f,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) m: u32, @builtin(instance_index) ii: u32) -> VOut {
  let I = instances[ii];
  let w = I.model * vec4f(p, 1.0);
  var o: VOut;
  o.pos = frame.viewProj * w;
  o.world = w.xyz;
  o.normal = (I.model * vec4f(n, 0.0)).xyz;
  o.local = p;
  o.prevClip = frame.prevViewProj * (I.prevModel * vec4f(p, 1.0));
  o.mat = m;
  o.inst = ii;
  o.lnormal = n;
  return o;
}

// Fine interior grain (leather, soft-touch plastic). Tri-planar value noise in
// the vehicle frame that fades to its mean once a cell shrinks towards a
// pixel (fw = pixel footprint in meters), so it never aliases or crawls.
fn interiorGrain(p: vec3f, ln: vec3f, freq: f32, fw: f32) -> f32 {
  let fade = 1.0 - smoothstep(0.2, 0.6, fw * freq);
  if (fade <= 0.0) { return 0.0; }
  let a = abs(ln) + vec3f(1e-3);
  let w = a / (a.x + a.y + a.z);
  let q = p * freq;
  let g = valueNoise(q.yz) * w.x + valueNoise(q.xz + 17.3) * w.y + valueNoise(q.xy + 31.7) * w.z;
  return (g - 0.5) * 2.0 * fade;
}

// Per-car trim colour: mostly charcoal, some mid grey, a few beige cabins.
fn trimTone(I: Instance) -> vec3f {
  let h = hashuf(u32(I.color.r * 2111.0 + I.color.g * 977.0 + I.color.b * 5333.0 + I.color2.r * 313.0));
  if (h < 0.62) { return vec3f(0.035, 0.034, 0.033); }
  if (h < 0.85) { return vec3f(0.11, 0.105, 0.1); }
  return vec3f(0.36, 0.29, 0.21);
}

fn vehicleSurf(i: VOut, n: vec3f, fw: f32) -> Surf {
  let I = instances[i.inst];
  var s = defaultSurf(n);
  if (i.mat <= 1u) { s.cls = CLASS_VEHICLE; }
  let lightsOn = I.params.x;
  switch (i.mat) {
    case 0u: {
      s.albedo = I.color.rgb;
      let metallic = I.color.a > 0.2;
      s.rough = select(0.55, 0.32, metallic);
      s.metal = select(0.0, 0.45, metallic);

      s.albedo *= 1.0 - I.params.w * 0.3 * smoothstep(0.6, 0.0, i.local.y);
    }
    case 1u: { s.albedo = I.color2.rgb; s.rough = 0.4; s.metal = I.color2.a * 0.5; }
    case 3u: { s.albedo = vec3f(0.95); s.rough = 0.08; s.metal = 1.0; }
    case 4u: { s.albedo = vec3f(0.025); s.rough = 0.85; }
    case 5u: { s.albedo = vec3f(0.045); s.rough = 0.55; }
    case 6u: {
      s.albedo = vec3f(0.8);
      s.rough = 0.05;
      s.metal = 0.5;
      s.emissive = vec3f(1.0, 0.97, 0.9) * lightsOn * 25.0;
    }
    case 7u: {
      s.albedo = vec3f(0.45, 0.02, 0.02);
      s.rough = 0.1;
      let brake = I.params.y;
      s.emissive = vec3f(1.0, 0.04, 0.02) * (lightsOn * 3.0 + brake * 8.0);
    }
    case 8u: {
      // Moulded trim plastic (lower door cards, floor, kick panels).
      let gr = interiorGrain(i.local, i.lnormal, 260.0, fw);
      s.albedo = vec3f(0.05, 0.049, 0.047) * (1.0 + 0.06 * gr);
      s.rough = 0.72 + 0.06 * gr;
      s.ao = mix(0.5, 0.8, smoothstep(0.35, 1.0, i.local.y));
    }
    case 9u: {
      // Seats: leather-like, ribbed centre panels with anti-aliased seams.
      let tone = trimTone(I);
      let f = 14.0;
      let rib = fract(i.local.y * f + i.local.z * 3.0);
      let px = fw * f;
      let seamW = 0.05 + px;
      let seam = (1.0 - smoothstep(0.0, seamW, min(rib, 1.0 - rib))) * (1.0 - smoothstep(0.3, 0.8, px));
      let gr = interiorGrain(i.local, i.lnormal, 330.0, fw);
      s.albedo = tone * (1.0 - 0.4 * seam) * (1.0 + 0.08 * gr);
      s.rough = 0.62 + 0.08 * gr + 0.2 * seam;
      s.ao = 0.7;
    }
    case 10u: {
      s.albedo = vec3f(0.03);
      s.rough = 0.5;
      s.emissive = vec3f(0.25, 0.7, 1.0) * (0.03 + lightsOn * 0.12);
    }
    case 19u: {
      // Headliner: clean matte fabric of constant albedo.
      s.albedo = vec3f(0.05, 0.049, 0.048);
      s.rough = 0.95;
      s.ao = 0.75;
    }
    case 20u: {
      // Soft-touch plastic: dashboard and upper door cards, a fine grain.
      let gr = interiorGrain(i.local, i.lnormal, 300.0, fw);
      s.albedo = vec3f(0.042, 0.041, 0.04) * (1.0 + 0.05 * gr);
      s.rough = 0.68 + 0.07 * gr;
      s.ao = mix(0.6, 0.9, smoothstep(0.5, 1.1, i.local.y));
    }
    case 21u: {
      // Satin trim (brushed-look aluminium inserts, vent surrounds).
      // Rough enough (>= 0.5) to skip the sharp city/screen-space reflections,
      // which sparkle on small curved trim inside a dark cabin.
      s.albedo = vec3f(0.55, 0.55, 0.56);
      s.metal = 0.85;
      s.rough = 0.5;
      s.ao = 0.85;
    }
    case 22u: {
      // Leather (steering wheel rim, armrests, gear knob, seat inserts).
      let gr = interiorGrain(i.local, i.lnormal, 420.0, fw);
      s.albedo = trimTone(I) * 0.8 * (1.0 + 0.1 * gr);
      s.rough = 0.56 + 0.05 * gr;
      s.ao = 0.85;
    }
    case 23u: {
      // Centre touch screen: glossy black glass with a dim UI (map panel and
      // a side bar), brighter at night.
      s.albedo = vec3f(0.01);
      s.rough = 0.1;
      let p = i.local.xy;
      let bar = smoothstep(0.035 - fw, 0.035 + fw, p.x);
      // Map: a sparse street grid and a highlighted route (anti-aliased).
      let g = abs(fract(p * vec2f(28.0, 22.0) + vec2f(0.3, 0.1)) - 0.5) / vec2f(28.0, 22.0);
      let roads = 1.0 - smoothstep(0.0012, 0.0012 + fw, min(g.x, g.y));
      let route = 1.0 - smoothstep(0.0018, 0.0018 + fw, abs(p.x + 0.045));
      let map = vec3f(0.035, 0.05, 0.07) + vec3f(0.06, 0.07, 0.08) * roads + vec3f(0.2, 0.12, 0.02) * route;
      // Side bar: tiles separated by thin rules.
      let rows = abs(fract(p.y * 30.0) - 0.5) / 30.0;
      let rule = 1.0 - smoothstep(0.0008, 0.0008 + fw, rows);
      let side = vec3f(0.03, 0.04, 0.06) + vec3f(0.05, 0.08, 0.11) * rule;
      s.emissive = mix(map, side, bar) * (0.45 + lightsOn * 0.5);
    }
    case 11u: { s.albedo = vec3f(0.05); s.rough = 0.5; s.metal = 0.6; }
    case 12u: { s.albedo = vec3f(0.65); s.rough = 0.25; s.metal = 1.0; }
    case 13u: {
      s.albedo = vec3f(0.8, 0.4, 0.0);
      s.rough = 0.15;
      let side = sign(i.local.x);
      let blink = step(0.5, fract(frame.time.x * 1.5));
      s.emissive = vec3f(1.0, 0.45, 0.0) * blink * 12.0 * step(0.5, I.params.z * side);
    }
    case 14u: {
      s.albedo = vec3f(0.02);
      s.emissive = vec3f(1.0, 0.6, 0.1) * 2.5;
    }
    case 16u: { s.albedo = I.color.rgb; s.rough = 0.9; }
    case 17u: { s.albedo = I.color2.rgb; s.rough = 0.85; }
    case 18u: { s.albedo = vec3f(0.5, 0.04, 0.03); s.rough = 0.4; }
    case 15u: { s.albedo = mix(vec3f(0.62, 0.46, 0.36), vec3f(0.42, 0.28, 0.2), hashuf(u32(I.color.r * 1000.0 + I.color2.g * 7777.0)) * 0.6); s.rough = 0.55; }
    default: { s.albedo = vec3f(1.0, 0.0, 1.0); }
  }
  // Wet bodywork gets glossier (the cabin stays dry).
  let cabin = (i.mat >= 8u && i.mat <= 10u) || (i.mat >= 19u && i.mat <= 23u);
  if (!cabin) { s.rough = mix(s.rough, s.rough * 0.5, frame.weather.z); }
  return s;
}

// Instance matrices from modelMatrix() are mirrored (det < 0), which flips the
// winding: the outside of the body is then the back face.
fn outwardFacing(inst: u32, ff: bool) -> bool {
  let m = instances[inst].model;
  let det = dot(cross(m[0].xyz, m[1].xyz), m[2].xyz);
  return ff != (det < 0.0);
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> GOut {
  // Pixel footprint for filtered interior detail (derivatives in uniform flow).
  let fw = length(fwidth(i.local));
  if (i.mat == 2u) { discard; }
  var n = normalize(i.normal);
  if (!outwardFacing(i.inst, ff)) { n = -n; }
  let s = vehicleSurf(i, n, fw);
  var o = writeG(s, i.world, i.pos);
  // Moving objects: motion from the previous model matrix.
  let prevUv = i.prevClip.xy / i.prevClip.w * vec2f(0.5, -0.5) + 0.5;
  let curUv = i.pos.xy * frame.resolution.zw;
  let jit = (frame.jitter.xy - frame.jitter.zw) * vec2f(0.5, -0.5);
  o.motion = vec4f(curUv - prevUv - jit, 0.0, 0.0);
  return o;
}

// Glass: forward, alpha blended over the lit image.
@fragment fn fsGlass(i: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  if (i.mat != 2u) { discard; }
  var n = normalize(i.normal);
  if (!outwardFacing(i.inst, ff)) { n = -n; }
  let v = normalize(frame.camPos.xyz - i.world);
  let nv = abs(dot(n, v));
  let fres = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  let r = reflect(-v, n);
  let sky = mix(frame.groundAmbient.rgb + frame.cityGlow.rgb, frame.skyAmbient.rgb * 1.3, smoothstep(-0.2, 0.3, r.y));
  let h = normalize(v + frame.sunDir.xyz);
  let spec = pow(max(dot(n, h), 0.0), 400.0) * frame.sunColor.rgb * 4.0 * frame.sunDir.w;
  // Rain beads on glass.
  var beads = 0.0;
  if (frame.weather.y > 0.0) {
    let q = i.local * 40.0;
    beads = step(0.93, hash31(floor(q))) * frame.weather.y;
  }
  let col = sky * fres + spec + vec3f(beads * 0.05);
  let alpha = clamp(0.3 + fres * 0.6 + beads * 0.3, 0.0, 0.95);
  return vec4f(col, alpha);
}

struct ShadowView { viewProj: mat4x4f };
@group(0) @binding(1) var<uniform> shadowView: ShadowView;

@vertex fn vsShadow(@location(0) p: vec3f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return shadowView.viewProj * (instances[ii].model * vec4f(p, 1.0));
}
