// Surface description written to the G-buffer.

// Material classes (stored in emissive.a as class / 8).
const CLASS_DEFAULT = 0u;
const CLASS_GLASS = 1u;
const CLASS_WATER = 2u;
const CLASS_FOLIAGE = 3u;
const CLASS_GROUND = 4u;   // receives puddles / wetness strongly
const CLASS_VEHICLE = 5u;

struct Surf {
  albedo: vec3f,
  normal: vec3f,
  rough: f32,
  metal: f32,
  emissive: vec3f,
  ao: f32,
  cls: u32,
};

fn defaultSurf(n: vec3f) -> Surf {
  return Surf(vec3f(0.5), n, 0.8, 0.0, vec3f(0.0), 1.0, CLASS_DEFAULT);
}

struct GOut {
  @location(0) albedo: vec4f,
  @location(1) normal: vec4f,
  @location(2) emissive: vec4f,
  @location(3) motion: vec4f,
};

fn writeG(s: Surf, world: vec3f, fragPos: vec4f) -> GOut {
  var o: GOut;
  o.albedo = vec4f(clamp(s.albedo, vec3f(0), vec3f(1)), s.ao);
  o.normal = vec4f(encodeNormal(normalize(s.normal)), clamp(s.rough, 0.02, 1.0), s.metal);
  o.emissive = vec4f(s.emissive, f32(s.cls) / 8.0);
  // Motion vector in UV units: current - previous (static geometry).
  let prev = frame.prevViewProj * vec4f(world, 1.0);
  let prevUv = prev.xy / prev.w * vec2f(0.5, -0.5) + 0.5;
  let curUv = fragPos.xy * frame.resolution.zw;
  // Remove jitter difference so static scenes produce zero motion.
  let jit = (frame.jitter.xy - frame.jitter.zw) * vec2f(0.5, -0.5);
  o.motion = vec4f(curUv - prevUv - jit, 0, 0);
  return o;
}

// Rain wetness on a surface: darken albedo, smooth roughness, add puddles on
// flat ground.
fn applyWetness(s: ptr<function, Surf>, world: vec3f, flatness: f32, porous: f32) {
  let wet = frame.weather.z;
  if (wet <= 0.001) { return; }
  let puddleNoise = fbm2(world.xz * 0.12) * 0.7 + valueNoise(world.xz * 0.9) * 0.3;
  let puddle = smoothstep(0.58 - wet * 0.3, 0.7 - wet * 0.3, puddleNoise) * flatness * wet;
  let damp = wet * mix(0.6, 1.0, porous);
  (*s).albedo *= mix(1.0, 0.45, damp * porous);
  (*s).rough = mix((*s).rough, 0.25, damp * 0.7);
  (*s).rough = mix((*s).rough, 0.03, puddle);
  (*s).albedo = mix((*s).albedo, (*s).albedo * 0.35, puddle);
  // Rain ripples in puddles.
  if (puddle > 0.01 && frame.weather.y > 0.01) {
    let cell = floor(world.xz * 3.0);
    let f = fract(world.xz * 3.0) - 0.5;
    let rnd = hash21(cell);
    let t = fract(frame.time.x * 1.3 + rnd);
    let r = length(f + (hash22(cell) - 0.5) * 0.4);
    let ring = sin((r - t * 0.5) * 60.0) * exp(-r * 8.0) * (1.0 - t);
    let g = normalize(f + 1e-4) * ring * 0.25 * frame.weather.y;
    (*s).normal = normalize((*s).normal + vec3f(g.x, 0.0, g.y) * puddle);
  }
}
