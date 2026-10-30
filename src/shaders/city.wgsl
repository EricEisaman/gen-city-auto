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
  // Pixel coverage of a widened thin tube (1 = solid).
  @location(5) cov: f32,
};

// Wire (20), frame (15), paint (16) and metal (6) tubes carry their radius
// in aux bits 0-15 (0.5 mm units, 0 = not a tube; see cmesh.ts). A tube
// thinner than MIN_TUBE_PX pixels is pushed out along its radial normal to
// that width and drawn with hashed partial coverage (TAA turns it into a
// thin continuous line instead of dashes).
const MIN_TUBE_PX = 0.7;
const TUBE_MATS = (1u << 6u) | (1u << 15u) | (1u << 16u) | (1u << 20u);

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
  var p = vec3f(v.px, v.py, v.pz);
  o.pos = frame.viewProj * vec4f(p, 1.0);
  o.normal = octDecode(v.n);
  o.cov = 1.0;
  let id = v.mat & 0xffu;
  let r = f32(v.aux & 0xffffu) * 0.0005;
  if (id < 32u && ((TUBE_MATS >> id) & 1u) == 1u && r > 0.0) {
    // World size of one pixel at this depth (projected radius r covers
    // r * proj[1][1] * h / (2 w) pixels).
    let px = 2.0 * max(o.pos.w, 1e-3) / (frame.proj[1][1] * frame.resolution.y);
    let rMin = MIN_TUBE_PX * px;
    if (r < rMin) {
      p += o.normal * (rMin - r);
      o.pos = frame.viewProj * vec4f(p, 1.0);
      o.cov = r / rMin;
    }
  }
  o.world = p;
  o.uv = vec2f(v.u, v.v);
  o.mat = v.mat;
  o.aux = v.aux;
  return o;
}

// Mipmapped leaf alpha. The leaf texture's mips are coverage-preserving
// (src/render/sign-atlas.ts), so a 0.5 cutoff keeps crown density at range.
fn leafAlpha(uv: vec2f) -> f32 {
  let dx = dpdx(uv) * 256.0;
  let dy = dpdy(uv) * 256.0;
  let lod = clamp(0.5 * log2(max(dot(dx, dx), dot(dy, dy))), 0.0, 8.0);
  return textureSampleLevel(leafTex, linearSampler, uv, lod).a;
}

// Interleaved gradient noise, advanced every frame so TAA integrates the
// dithered edge band into smooth partial coverage instead of a fixed stipple.
fn leafDither(fragPos: vec2f) -> f32 {
  let p = fragPos + (frame.time.z % 64.0) * 5.588238;
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

// Hashed alpha test limited to the screen-space transition band: alpha is
// rescaled by its own pixel footprint (fwidth) into pixel coverage, so leaf
// interiors stay solid, the background stays clear, and only the one-pixel
// silhouette band dithers (stable once TAA resolves it).
fn leafCutout(i: VOut) {
  let a = leafAlpha(i.uv);
  let w = max(fwidth(a), 0.02);
  let cov = clamp((a - 0.5) / w + 0.5, 0.0, 1.0);
  if ((i.mat & 0xffu) == 25u && cov <= leafDither(i.pos.xy)) { discard; }
}

@fragment fn fs(i: VOut, @builtin(front_facing) ff: bool) -> GOut {
  dWorldX = dpdx(i.world);
  dWorldY = dpdy(i.world);
  dUvX = dpdx(i.uv);
  dUvY = dpdy(i.uv);
  leafCutout(i);
  // Widened thin tubes: hashed coverage, gone below 8 % of a pixel.
  if (i.cov < 1.0 && (i.cov < 0.08 || i.cov <= leafDither(i.pos.xy))) { discard; }
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
  if (i.leaf == 1u && textureSampleLevel(leafTex, linearSampler, i.uv, 2.0).a < 0.5) { discard; }
}
