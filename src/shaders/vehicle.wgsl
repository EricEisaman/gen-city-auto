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
  return o;
}

fn vehicleSurf(i: VOut, n: vec3f) -> Surf {
  let I = instances[i.inst];
  var s = defaultSurf(n);
  if (i.mat <= 1u) { s.cls = CLASS_VEHICLE; }
  let lightsOn = I.params.x;
  switch (i.mat) {
    case 0u: {
      s.albedo = I.color.rgb;
      s.rough = 0.4;
      s.metal = I.color.a * 0.5;
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
      s.emissive = vec3f(1.0, 0.04, 0.02) * (lightsOn * 4.0 + brake * 14.0);
    }
    case 8u: { s.albedo = vec3f(0.09, 0.085, 0.08); s.rough = 0.85; }
    case 9u: { s.albedo = vec3f(0.14, 0.13, 0.12); s.rough = 0.9; }
    case 10u: {
      s.albedo = vec3f(0.03);
      s.rough = 0.5;
      s.emissive = vec3f(0.25, 0.7, 1.0) * (0.15 + lightsOn * 0.6);
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
    case 15u: { s.albedo = vec3f(0.62, 0.46, 0.36); s.rough = 0.6; }
    default: { s.albedo = vec3f(1.0, 0.0, 1.0); }
  }
  // Wet bodywork gets glossier.
  s.rough = mix(s.rough, s.rough * 0.5, frame.weather.z);
  return s;
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> GOut {
  if (i.mat == 2u) { discard; }
  var n = normalize(i.normal);
  if (!ff) { n = -n; }
  let s = vehicleSurf(i, n);
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
  if (!ff) { n = -n; }
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
  let alpha = clamp(0.35 + fres * 0.6 + beads * 0.3, 0.0, 0.95);
  return vec4f(col, alpha);
}

struct ShadowView { viewProj: mat4x4f };
@group(0) @binding(1) var<uniform> shadowView: ShadowView;

@vertex fn vsShadow(@location(0) p: vec3f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  return shadowView.viewProj * (instances[ii].model * vec4f(p, 1.0));
}
