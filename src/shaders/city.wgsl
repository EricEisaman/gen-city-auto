// City geometry: GPU-driven cluster rendering with vertex pulling. One indirect
// draw renders every visible cluster (instance = cluster, vertex = corner).

struct Vertex {
  px: f32, py: f32, pz: f32,
  n: u32,
  u: f32, v: f32,
  mat: u32,
  aux: u32,
};

struct Cluster {
  cx: f32, cy: f32, cz: f32, radius: f32,
  vertOffset: u32,
  triOffset: u32,
  packed: u32,   // triCount | lod << 8 | flags << 12
  tile: u32,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> vertices: array<Vertex>;
@group(1) @binding(1) var<storage, read> tris: array<u32>;
@group(1) @binding(2) var<storage, read> clusters: array<Cluster>;
@group(1) @binding(3) var<storage, read> visible: array<u32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) mat: u32,
  @location(4) @interpolate(flat) aux: u32,
};

fn fetch(vi: u32, ii: u32, ok: ptr<function, bool>) -> Vertex {
  let c = clusters[visible[ii]];
  let tri = vi / 3u;
  if (tri >= (c.packed & 0xffu)) {
    *ok = false;
    return vertices[0];
  }
  *ok = true;
  let packed = tris[c.triOffset + tri];
  let local = (packed >> ((vi % 3u) * 8u)) & 0xffu;
  return vertices[c.vertOffset + local];
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var ok = true;
  let v = fetch(vi, ii, &ok);
  var o: VOut;
  if (!ok) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  let p = vec3f(v.px, v.py, v.pz);
  o.pos = frame.viewProj * vec4f(p, 1.0);
  o.world = p;
  o.normal = octDecode(v.n);
  o.uv = vec2f(v.u, v.v);
  o.mat = v.mat;
  o.aux = v.aux;
  return o;
}

fn leafCutout(i: VOut) {
  if ((i.mat & 0xffu) == 25u) {
    if (textureSampleLevel(leafTex, linearSampler, i.uv, 0.0).a < 0.5) { discard; }
  }
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> GOut {
  leafCutout(i);
  var n = normalize(i.normal);
  if (!ff && (i.mat & 0xffu) != 25u) { n = -n; }
  let s = cityMaterial(i.world, n, i.uv, i.mat, i.aux);
  return writeG(s, i.world, i.pos);
}

// Shadow variant: depth only, light matrix from the shadow uniform.
struct ShadowView { viewProj: mat4x4f };
@group(0) @binding(1) var<uniform> shadowView: ShadowView;

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) leaf: u32,
};

@vertex fn vsShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SOut {
  var ok = true;
  let v = fetch(vi, ii, &ok);
  var o: SOut;
  if (!ok) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  o.pos = shadowView.viewProj * vec4f(v.px, v.py, v.pz, 1.0);
  o.uv = vec2f(v.u, v.v);
  o.leaf = select(0u, 1u, (v.mat & 0xffu) == 25u);
  return o;
}

@fragment fn fsShadow(i: SOut) {
  if (i.leaf == 1u && textureSampleLevel(leafTex, linearSampler, i.uv, 0.0).a < 0.5) { discard; }
}
