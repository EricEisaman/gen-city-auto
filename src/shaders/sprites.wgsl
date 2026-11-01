// Distant night lights as point sprites: street lamps and streams of head and
// tail lights on roads and expressways beyond the simulated traffic radius.

@group(0) @binding(0) var<uniform> frame: Frame;
// Lane segment in travel direction: a.xyz, a.w = lateral offset to the left;
// b.xyz, b.w = lane seed; c = (distance along the lane at a, speed, car gap).
struct Seg { a: vec4f, b: vec4f, c: vec4f };
@group(0) @binding(1) var<storage, read> segs: array<Seg>;
// Lamp head: xyz, w = 1 for sodium.
@group(0) @binding(2) var<storage, read> lamps: array<vec4f>;

const CARS_PER_SEG = 4u;
// Real cars are simulated out to ~360 m; sprites take over beyond that.
const NEAR_FADE = vec2f(300.0, 420.0);

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
};

fn lightsOn() -> f32 {
  return max(smoothstep(0.25, 0.6, frame.time.w), smoothstep(0.3, 0.7, frame.weather.y));
}

fn corner(vi: u32) -> vec2f {
  return array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1))[vi];
}

// A screen-space sprite of `px` pixels at world point p.
fn sprite(p: vec3f, vi: u32, px: f32, color: vec3f) -> SOut {
  var o: SOut;
  let c = corner(vi);
  let clip = frame.viewProj * vec4f(p, 1.0);
  // (Display pixels: the same size on screen at any render scale.)
  o.pos = clip + vec4f(c * px / frame.upscale.xy * 2.0 * clip.w, 0.0, 0.0);
  o.uv = c;
  o.color = color;
  return o;
}

fn culled() -> SOut {
  var o: SOut;
  o.pos = vec4f(0.0, 0.0, -1.0, 1.0);
  return o;
}

@vertex fn vsCars(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SOut {
  _ = lamps[0];
  let on = lightsOn();
  if (on <= 0.0) { return culled(); }
  let si = ii / CARS_PER_SEG;
  let k = ii % CARS_PER_SEG;
  let s = segs[si];
  let ab = s.b.xyz - s.a.xyz;
  let len = length(ab);
  // Cars sit on a lattice moving along the whole lane at the lane's speed;
  // this segment draws the ones currently inside it.
  let base = frame.time.x * s.c.y;
  let gap = s.c.z;
  let j = floor((s.c.x - base) / gap) - 1.0 + f32(k);
  let seed = s.b.w + j * 1.3717;
  if (hash11(seed + 5.0) < 0.3) { return culled(); }
  let local = j * gap + base + hash11(seed) * gap * 0.6 - s.c.x;
  if (local < 0.0 || local >= len) { return culled(); }
  let t = local / len;
  let dir = ab / max(len, 1e-3);
  let left = normalize(vec3f(dir.z, 0.0, -dir.x));
  let p = s.a.xyz + ab * t + left * s.a.w + vec3f(0.0, 0.75, 0.0);
  let dist = distance(p, frame.camPos.xyz);
  let fade = smoothstep(NEAR_FADE.x, NEAR_FADE.y, dist) * on;
  if (fade <= 0.0) { return culled(); }
  let toCam = (frame.camPos.xyz - p) / dist;
  let facing = dot(dir, toCam);
  // Headlights face the viewer, tail lights face away; seen side-on both dim.
  let head = vec3f(1.0, 0.9, 0.75) * 40.0 * smoothstep(0.0, 0.4, facing);
  let tail = vec3f(1.0, 0.05, 0.02) * 14.0 * smoothstep(0.0, -0.4, facing);
  let atten = clamp(600.0 / dist, 0.25, 1.0);
  return sprite(p, vi, 1.6, (head + tail) * fade * atten);
}

@vertex fn vsLamps(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SOut {
  _ = segs[0];
  let on = lightsOn();
  if (on <= 0.0) { return culled(); }
  let l = lamps[ii];
  let dist = distance(l.xyz, frame.camPos.xyz);
  let fade = smoothstep(180.0, 320.0, dist) * on;
  if (fade <= 0.0) { return culled(); }
  let col = select(vec3f(1.0, 0.92, 0.8), vec3f(1.0, 0.55, 0.18), l.w > 0.5);
  let atten = clamp(700.0 / dist, 0.2, 1.0);
  return sprite(l.xyz, vi, 1.8, col * 30.0 * fade * atten);
}

@fragment fn fs(i: SOut) -> @location(0) vec4f {
  let g = exp(-dot(i.uv, i.uv) * 3.0);
  return vec4f(i.color * g, 0.0);
}
