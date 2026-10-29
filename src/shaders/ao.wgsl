// Screen-space ambient occlusion at half resolution, two radii (contact detail
// and street-canyon scale). Noise rotates every frame and is resolved by TAA.

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var aoDepth: texture_depth_2d;
@group(1) @binding(1) var aoNormal: texture_2d<f32>;
@group(1) @binding(2) var aoOut: texture_storage_2d<rgba16float, write>;

fn viewZ(d: f32) -> f32 { return frame.camPos.w / max(d, 1e-7); }

fn worldAt(uv: vec2f, d: f32) -> vec3f {
  let w = frame.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  return w.xyz / w.w;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(aoOut);
  if (any(id.xy >= size)) { return; }
  let full = vec2f(textureDimensions(aoDepth));
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let fp = vec2i(uv * full);
  let d = textureLoad(aoDepth, fp, 0);
  if (d <= 0.0) {
    textureStore(aoOut, id.xy, vec4f(1.0));
    return;
  }
  let p = worldAt(uv, d);
  let n = decodeNormal(textureLoad(aoNormal, fp, 0).xy);
  let dist = distance(p, frame.camPos.xyz);
  // Tangent frame.
  let up = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let t = normalize(cross(up, n));
  let b = cross(n, t);
  let rot = hash21(vec2f(id.xy) + frame.time.z * 7.13) * 6.2831;
  var occ = 0.0;
  var total = 0.0;
  for (var scale = 0; scale < 2; scale++) {
    let R = select(1.0, 7.0, scale == 1) * clamp(dist / 30.0, 1.0, 4.0);
    let count = select(8, 6, scale == 1);
    for (var i = 0; i < count; i++) {
      let fi = f32(i);
      let a = rot + fi * 2.399963;
      let r = sqrt((fi + 0.5) / f32(count));
      let h = sqrt(1.0 - r * r);
      let dir = t * cos(a) * r + b * sin(a) * r + n * h;
      let k = mix(0.15, 1.0, fract(fi * 0.618 + rot));
      let q = p + dir * R * k + n * 0.03;
      let clip = frame.viewProj * vec4f(q, 1.0);
      if (clip.w <= 0.0) { continue; }
      let quv = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
      if (any(quv < vec2f(0.0)) || any(quv > vec2f(1.0))) { continue; }
      let sd = textureLoad(aoDepth, vec2i(quv * full), 0);
      let sceneZ = viewZ(sd);
      let diff = clip.w - sceneZ;
      let w = select(1.0, 0.7, scale == 1);
      if (diff > 0.02 && sd > 0.0) {
        occ += w * smoothstep(R * 1.5, R * 0.5, diff);
      }
      total += w;
    }
  }
  let ao = clamp(1.0 - occ / max(total, 1.0) * 1.35, 0.0, 1.0);
  textureStore(aoOut, id.xy, vec4f(ao, ao, ao, 1.0));
}
