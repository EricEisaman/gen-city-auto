// GPU cluster culling: frustum, per-tile LOD selection, distance-based detail
// culling, and Hi-Z occlusion against the previous frame's depth pyramid.
// Visible clusters are appended to a list (opaque or alpha-tested) and that
// list's indirect draw instance count is incremented.

struct Cluster {
  cx: f32, cy: f32, cz: f32, radius: f32,
  vertOffset: u32,
  triOffset: u32,
  packed: u32,
  tile: u32,
};

struct CullView {
  viewProj: mat4x4f,
  // Shadow views add the planes of their receivers (camera frustum slice)
  // swept toward the light: a caster outside them shades no visible pixel.
  planes: array<vec4f, 12>,
  camPos: vec4f,       // xyz, detail cull factor (min radius/distance)
  params: vec4u,       // cluster count, use occlusion, plane count, count triangles
  hiz: vec4f,          // hiz width, height, mip count, fine-detail distance scale (0 = off)
  far: vec4f,          // far-shading view depth (0 = off), -, -, -
};

struct DrawArgs {
  vertexCount: u32,
  instanceCount: atomic<u32>,
  firstVertex: u32,
  firstInstance: u32,
  // Stats only (params.w != 0): triangles in the visible clusters.
  tris: atomic<u32>,
};

@group(0) @binding(0) var<uniform> view: CullView;
@group(0) @binding(1) var<storage, read> clusters: array<Cluster>;
@group(0) @binding(2) var<storage, read> tileLod: array<u32>;
@group(0) @binding(3) var<storage, read_write> visible: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: DrawArgs;
@group(0) @binding(5) var hizTex: texture_2d<f32>;
// Alpha-tested clusters (flags bit 1) go to their own list and draw.
@group(0) @binding(6) var<storage, read_write> visibleAlpha: array<u32>;
@group(0) @binding(7) var<storage, read_write> argsAlpha: DrawArgs;
// Opaque clusters wholly past far.x view depth (every pixel's footprint
// over FAR_FOOT, city-materials.wgsl) go to their own draw with the
// far-specialised material pipeline; they fill `visible` from its end.
@group(0) @binding(8) var<storage, read_write> argsFar: DrawArgs;

fn hizTest(center: vec3f, radius: f32) -> bool {
  // Project the bounding box corners; reverse-Z so larger depth = closer.
  var mn = vec2f(1e9);
  var mx = vec2f(-1e9);
  var nearest = 0.0;
  for (var k = 0u; k < 8u; k++) {
    let o = vec3f(select(-radius, radius, (k & 1u) != 0u), select(-radius, radius, (k & 2u) != 0u), select(-radius, radius, (k & 4u) != 0u));
    let clip = view.viewProj * vec4f(center + o, 1.0);
    if (clip.w <= 0.05) { return false; }
    let ndc = clip.xyz / clip.w;
    mn = min(mn, ndc.xy);
    mx = max(mx, ndc.xy);
    nearest = max(nearest, ndc.z);
  }
  let uv0 = clamp(vec2f(mn.x, -mx.y) * 0.5 + 0.5, vec2f(0), vec2f(1));
  let uv1 = clamp(vec2f(mx.x, -mn.y) * 0.5 + 0.5, vec2f(0), vec2f(1));
  let sizePx = (uv1 - uv0) * view.hiz.xy;
  let mip = clamp(ceil(log2(max(max(sizePx.x, sizePx.y), 1.0))), 0.0, view.hiz.z - 1.0);
  let dims = vec2f(textureDimensions(hizTex, i32(mip)));
  let p0 = vec2i(uv0 * dims);
  let p1 = vec2i(min(uv1 * dims, dims - 1.0));
  // The pyramid stores the farthest (minimum reverse-Z) depth of each texel.
  var far = 1.0;
  far = min(far, textureLoad(hizTex, p0, i32(mip)).r);
  far = min(far, textureLoad(hizTex, vec2i(p1.x, p0.y), i32(mip)).r);
  far = min(far, textureLoad(hizTex, vec2i(p0.x, p1.y), i32(mip)).r);
  far = min(far, textureLoad(hizTex, p1, i32(mip)).r);
  return nearest < far;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= view.params.x) { return; }
  let c = clusters[i];
  let triCount = c.packed & 0xffu;
  if (triCount == 0u) { return; }
  let lod = (c.packed >> 8u) & 0xfu;
  let flags = (c.packed >> 12u) & 0xfu;
  if (c.tile != 0xffffffffu) {
    if (tileLod[c.tile] != lod) { return; }
  }
  let center = vec3f(c.cx, c.cy, c.cz);
  for (var p = 0u; p < view.params.z; p++) {
    let pl = view.planes[p];
    if (dot(pl.xyz, center) + pl.w < -c.radius) { return; }
  }
  // Small details vanish at distance (flags bit 0 = detail).
  let dist = distance(center, view.camPos.xyz);
  if ((flags & 1u) != 0u && c.radius < dist * view.camPos.w) { return; }
  // Fine detail with a cull distance (cmesh.ts CLUSTER_FAR_SHIFT), jittered
  // per cluster (+-20 %, hashed from its centre) so it thins out over a band.
  let farD = f32(c.packed >> 16u) * view.hiz.w;
  if (farD > 0.0) {
    var k = (bitcast<u32>(c.cx) * 747796405u) ^ (bitcast<u32>(c.cz) * 2891336453u);
    k = (k ^ (k >> 16u)) * 2246822519u;
    let h = f32(k >> 8u) / 16777216.0;
    if (dist - c.radius > farD * (0.8 + 0.4 * h)) { return; }
  }
  if (view.params.y != 0u && dist > c.radius * 1.5 && hizTest(center, c.radius)) { return; }
  if ((flags & 2u) != 0u) {
    let slot = atomicAdd(&argsAlpha.instanceCount, 1u);
    visibleAlpha[slot] = i;
    if (view.params.w != 0u) { atomicAdd(&argsAlpha.tris, triCount); }
  } else if (view.far.x > 0.0 && (view.viewProj * vec4f(center, 1.0)).w - c.radius > view.far.x) {
    let slot = atomicAdd(&argsFar.instanceCount, 1u);
    visible[arrayLength(&visible) - 1u - slot] = i;
    if (view.params.w != 0u) { atomicAdd(&argsFar.tris, triCount); }
  } else {
    let slot = atomicAdd(&args.instanceCount, 1u);
    visible[slot] = i;
    if (view.params.w != 0u) { atomicAdd(&args.tris, triCount); }
  }
}
