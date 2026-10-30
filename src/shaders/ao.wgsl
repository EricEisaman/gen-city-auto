// Ground-truth ambient occlusion (GTAO, Jimenez et al. 2016) at half
// resolution: per pixel, 2 screen-space slices x 2 sides x 6 steps find the
// horizon angles around the view vector, and the cosine-weighted visible arc
// between them (against the normal projected into the slice) is integrated
// analytically. Slices rotate with a 4x4 interleave plus a per-frame offset,
// resolved by the bilateral 4x4 in lighting and by TAA.
//
// Why not point-sampled SSAO (the previous kernel): it tests sample points
// in the hemisphere against the depth buffer, so the air under a canopy or a
// ledge (which the camera sees from below) counts as open, and the samples
// inside the slab were thrown away by the range test. Horizon search sees
// the slab's underside as a raised horizon instead.

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var aoDepth: texture_depth_2d;
@group(1) @binding(1) var aoNormal: texture_2d<f32>;
@group(1) @binding(2) var aoOut: texture_storage_2d<rgba16float, write>;

fn worldAt(uv: vec2f, d: f32) -> vec3f {
  let w = frame.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  return w.xyz / w.w;
}

fn fastAcos(x: f32) -> f32 {
  let ax = abs(x);
  var r = -0.156583 * ax + PI * 0.5;
  r *= sqrt(max(1.0 - ax, 0.0));
  return select(PI - r, r, x >= 0.0);
}

const SLICES = 2;
const STEPS = 6;
// World radius of the horizon search (m) and its on-screen clamp (full-res px).
const RADIUS = 2.5;
const MIN_PX = 6.0;
const MAX_PX = 64.0;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(aoOut);
  if (any(id.xy >= size)) { return; }
  let full = vec2f(textureDimensions(aoDepth));
  let fp = min(vec2i(id.xy) * 2, vec2i(full) - 1);
  let d = textureLoad(aoDepth, fp, 0);
  if (d <= 0.0 || frame.misc.y < 0.5) {
    textureStore(aoOut, id.xy, vec4f(1.0));
    return;
  }
  let uv = (vec2f(fp) + 0.5) / full;
  let p = worldAt(uv, d);
  // Geometric normal from the depth buffer (the nearer neighbour on each
  // axis, so silhouettes don't bend it). The G-buffer normal carries normal
  // maps and smoothed vertex normals that disagree with the depth surface:
  // GTAO then sees the surface's own plane as a raised horizon, and grazing
  // ground came out striped. The G-buffer normal is the fallback.
  var n = decodeNormal(textureLoad(aoNormal, fp, 0).xy);
  {
    let ip = vec2i(full) - 1;
    let px1 = worldAt((vec2f(min(fp + vec2i(1, 0), ip)) + 0.5) / full, textureLoad(aoDepth, min(fp + vec2i(1, 0), ip), 0)) - p;
    let px0 = p - worldAt((vec2f(max(fp - vec2i(1, 0), vec2i(0))) + 0.5) / full, textureLoad(aoDepth, max(fp - vec2i(1, 0), vec2i(0)), 0));
    let py1 = worldAt((vec2f(min(fp + vec2i(0, 1), ip)) + 0.5) / full, textureLoad(aoDepth, min(fp + vec2i(0, 1), ip), 0)) - p;
    let py0 = p - worldAt((vec2f(max(fp - vec2i(0, 1), vec2i(0))) + 0.5) / full, textureLoad(aoDepth, max(fp - vec2i(0, 1), vec2i(0)), 0));
    let dx = select(px0, px1, dot(px1, px1) < dot(px0, px0));
    let dy = select(py0, py1, dot(py1, py1) < dot(py0, py0));
    let gn = cross(dy, dx);
    if (dot(gn, gn) > 1e-12) {
      var g = normalize(gn);
      if (dot(g, frame.camPos.xyz - p) < 0.0) { g = -g; }
      n = g;
    }
  }
  let toCam = frame.camPos.xyz - p;
  let dist = length(toCam);
  let V = toCam / dist;
  let vz = frame.camPos.w / max(d, 1e-7);
  // Camera basis (screen x right, screen y down = -up).
  let right = vec3f(frame.view[0][0], frame.view[1][0], frame.view[2][0]);
  let up = vec3f(frame.view[0][1], frame.view[1][1], frame.view[2][1]);
  // Screen radius: 1.5 m, kept between 6 and 64 px. Close-up pixels (car
  // interiors) are capped so the search never spans half the screen and
  // shimmers; the world radius used by the falloff follows the clamp.
  let pxPerM = frame.proj[1][1] * 0.5 * frame.resolution.y / vz;
  let rPx = clamp(RADIUS * pxPerM, MIN_PX, MAX_PX);
  let R = rPx / pxPerM;
  let R2 = R * R;
  // Interleaved 4x4 rotation and step offset (matched by the 4x4 resolve).
  let cell = f32((id.x & 3u) * 4u + (id.y & 3u));
  let jit = fract(frame.time.z * 0.618034);
  let rot = fract(cell / 16.0 + jit * 0.0625);
  let stepJit = fract(f32(((id.x + 2u) & 3u) * 4u + ((id.y + 1u) & 3u)) / 16.0 + jit * 0.37 + 0.03);
  var vis = 0.0;
  var openVis = 0.0;
  for (var s = 0; s < SLICES; s++) {
    let phi = (rot + f32(s) / f32(SLICES)) * PI;
    let dir = vec2f(cos(phi), sin(phi));
    // World direction of a +dir screen offset, made orthogonal to V.
    let w = right * dir.x - up * dir.y;
    let t = normalize(w - V * dot(w, V));
    let axis = cross(t, V);
    let pn = n - axis * dot(n, axis);
    let pnLen = length(pn);
    if (pnLen < 1e-4) { continue; }
    let cosN = clamp(dot(pn, V) / pnLen, -1.0, 1.0);
    let nAng = sign(dot(pn, t)) * fastAcos(cosN);
    let low0 = cos(nAng + PI * 0.5);
    let low1 = cos(nAng - PI * 0.5);
    var hc0 = low0;
    var hc1 = low1;
    for (var k = 0; k < STEPS; k++) {
      var f = (f32(k) + stepJit) / f32(STEPS);
      f = f * f;
      // At least ~1.5 full-res px out, so a pixel never samples itself.
      let off = dir * max(f * rPx, 1.5 + f32(k)) / full;
      let uv0 = uv + off;
      let uv1 = uv - off;
      if (all(uv0 > vec2f(0.0)) && all(uv0 < vec2f(1.0))) {
        let sd = textureLoad(aoDepth, vec2i(uv0 * full), 0);
        if (sd > 0.0) {
          let dl = worldAt(uv0, sd) - p;
          let l2 = dot(dl, dl);
          let wgt = clamp((R2 - l2) / (0.4 * R2), 0.0, 1.0);
          let c = dot(dl, V) * inverseSqrt(max(l2, 1e-8));
          hc0 = max(hc0, mix(low0, c, wgt));
        }
      }
      if (all(uv1 > vec2f(0.0)) && all(uv1 < vec2f(1.0))) {
        let sd = textureLoad(aoDepth, vec2i(uv1 * full), 0);
        if (sd > 0.0) {
          let dl = worldAt(uv1, sd) - p;
          let l2 = dot(dl, dl);
          let wgt = clamp((R2 - l2) / (0.4 * R2), 0.0, 1.0);
          let c = dot(dl, V) * inverseSqrt(max(l2, 1e-8));
          hc1 = max(hc1, mix(low1, c, wgt));
        }
      }
    }
    // Horizon angles relative to V (side 0 positive), clamped to the
    // hemisphere around the projected normal, then the analytic arc integral.
    let h1 = nAng + clamp(fastAcos(hc0) - nAng, -PI * 0.5, PI * 0.5);
    let h0 = nAng + clamp(-fastAcos(hc1) - nAng, -PI * 0.5, PI * 0.5);
    let sinN = sin(nAng);
    let a0 = (cosN + 2.0 * h0 * sinN - cos(2.0 * h0 - nAng)) * 0.25;
    let a1 = (cosN + 2.0 * h1 * sinN - cos(2.0 * h1 - nAng)) * 0.25;
    vis += pnLen * (a0 + a1);
    // The same integral with nothing occluding. A single slice of open
    // ground is not 1 (only the average over all slice angles is), so with 2
    // slices per pixel a flat plane at a grazing angle came out in 4x4
    // interleave stripes that the depth-aware resolve can't average away.
    // Normalising per pixel makes every open surface exactly 1.
    openVis += pnLen * (cosN + nAng * sinN);
  }
  var ao = select(1.0, clamp(vis / max(openVis, 1e-4), 0.0, 1.0), openVis > 1e-4);
  // A touch steeper than the cosine-weighted integral: the search only sees
  // 2.5 m, so larger-scale occlusion (the rest of a canyon wall) is missing.
  ao = pow(ao, 1.5);
  // Fade toward 1 far away, where 6 px span many metres and every street
  // would otherwise fill with canyon-scale grey (the sky term covers that).
  ao = mix(ao, 1.0, smoothstep(250.0, 700.0, dist));
  textureStore(aoOut, id.xy, vec4f(ao, ao, ao, 1.0));
}
