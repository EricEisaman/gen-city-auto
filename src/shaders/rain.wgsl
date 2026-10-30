// Rain streaks around the camera (forward pass, additive over the lit image).

@group(0) @binding(0) var<uniform> frame: Frame;

struct ROut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) fade: f32,
};

const BOX = 36.0;

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ROut {
  let h = vec3f(hashuf(ii * 3u + 1u), hashuf(ii * 3u + 2u), hashuf(ii * 3u + 3u));
  let speed = 9.0 + h.x * 3.0;
  let wind = vec3f(frame.wind.x, 0.0, frame.wind.y) * 2.5;
  let vel = vec3f(wind.x, -speed, wind.z);
  let cam = frame.camPos.xyz;
  // Drops wrap inside a box that follows the camera.
  var p = h * BOX + vel * frame.time.x;
  p = p - floor((p - cam + BOX * 0.5) / BOX) * BOX;
  // Motion-blurred streak (~1/50 s exposure), thin, varying per drop.
  let len = speed * mix(0.03, 0.055, h.y);
  let dir = normalize(vel);
  let toCam = normalize(cam - p);
  // At least ~0.7 px wide so streaks survive TAA instead of averaging away.
  let pxW = distance(p, cam) * 1.4 / frame.resolution.y;
  let side = normalize(cross(dir, toCam)) * max(mix(0.004, 0.008, h.z), pxW);
  let corner = array<vec2f, 6>(vec2f(-1, 0), vec2f(1, 0), vec2f(1, 1), vec2f(-1, 0), vec2f(1, 1), vec2f(-1, 1))[vi];
  let w = p + side * corner.x + dir * len * corner.y;
  var o: ROut;
  o.pos = frame.viewProj * vec4f(w, 1.0);
  o.uv = corner;
  o.fade = smoothstep(BOX * 0.5, BOX * 0.2, distance(p, cam)) * smoothstep(0.3, 2.0, distance(p, cam));
  return o;
}

// Premultiplied "over" blend: each streak partly replaces what is behind it
// with the bright refracted sky, so it reads against dark facades and, being
// brighter than the sky's own average, against an overcast sky as well.
@fragment fn fs(i: ROut) -> @location(0) vec4f {
  let a = (1.0 - abs(i.uv.x)) * pow(sin(i.uv.y * PI), 0.7) * i.fade * 0.42;
  let c = frame.skyAmbient.rgb * 1.9 + frame.cityGlow.rgb * 6.0 + frame.sunColor.rgb * 0.05 + vec3f(1.5) * frame.wind.w;
  return vec4f(c * a, a);
}
