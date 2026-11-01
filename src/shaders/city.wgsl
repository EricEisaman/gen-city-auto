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
// The far draw (cull.wgsl argsFar) reads its clusters from the list's end.
override FAR_LIST = false;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) mat: u32,
  @location(4) @interpolate(flat) aux: u32,
  // Pixel coverage of a widened thin tube: 1 = solid; 0..1 = hashed partial
  // coverage; < 0 = a solid min-width line whose true coverage is -cov
  // (emissive tubes scale their light by it).
  @location(5) cov: f32,
};

// Wire (20), frame (15), paint (16), metal (6), lamp (11) and LED line (22)
// tubes carry their radius in aux bits 0-15 (0.5 mm units, 0 = not a tube;
// see cmesh.ts). A tube thinner than MIN_TUBE_PX pixels is pushed out along its
// radial normal to that width and drawn with hashed partial coverage.
//
// Hashed coverage only resolves where TAA keeps its history: the variance
// clip throws the history away in every frame whose 3x3 neighbourhood has
// no covered sample, so a sparse dither came out as beads and stair-steps.
// Overhead line wires (wire params 1-2) and lamp tubes are therefore drawn
// as SOLID lines at least MIN_LINE_PX wide (~1 px across the diamond
// section: every pixel column along the line holds a sample each frame and
// TAA's jitter anti-aliases it into a soft continuous line). Round 4 still
// gave the wires a 50 % hashed coverage floor between the close range and
// LINE_FADE, which is exactly the mid range (120-300 m): that was the
// "barbed wire" beading. Wires now stay solid out to LINE_FADE and only
// then drop to a 30 % dither; lamps scale their light by the true coverage.
const MIN_TUBE_PX = 0.7;
const MIN_LINE_PX = 0.7;
const LINE_FADE = 700.0;
const TUBE_MATS = (1u << 6u) | (1u << 11u) | (1u << 15u) | (1u << 16u) | (1u << 20u) | (1u << 22u);
// Fine hardware (aux bit 31, cmesh.ts FINE_TUBE: OHLE droppers, registration
// and messenger arms, drop poles, insulators): at mid / far range each piece
// is a 1 px dot, so a line of them read as beads strung along the continuous
// wires. They fade out (hashed coverage) between FINE_NEAR and FINE_FAR and
// leave the contact / messenger / feeder lines and the portals to carry the
// read.
const FINE_TUBE = 0x80000000u;
const FINE_NEAR = 45.0;
const FINE_FAR = 100.0;

fn fetch(vi: u32, ii: u32, ok: ptr<function, bool>) -> Vertex {
  let c = clusters[visible[select(ii, arrayLength(&visible) - 1u - ii, FAR_LIST)]];
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
    // Lines: lamp tubes, overhead-line wires (params 1-2) and every other
    // thin wire under 2 cm radius (utility spans, service drops, cable
    // stubs): a hashed sub-pixel wire beaded into a dotted line in the sky
    // (the TAA variance clip drops the sparse dither). Bike / tyre rings
    // (wire param 0, r 2.2 cm) keep the hashed coverage.
    // LED lines (22): the rooftop crown line of towers, 2 dm across, so a
    // sub-pixel bright line at range; jittered, its pixels were lit in some
    // frames and empty in others and the variance clip kept resetting the
    // history (the flickering tower tops at dusk / night).
    let lit = id == 11u || id == 22u;
    let isLine = lit || (id == 20u && ((v.mat >> 8u) != 0u || r < 0.02));
    let rMin = select(MIN_TUBE_PX, MIN_LINE_PX, isLine) * px;
    if (r < rMin) {
      p += o.normal * (rMin - r);
      o.pos = frame.viewProj * vec4f(p, 1.0);
      o.cov = r / rMin;
      if (lit || (isLine && o.pos.w < LINE_FADE)) {
        // Solid min-width line (no dither); -cov carries the true coverage.
        o.cov = -o.cov;
      } else if (isLine) {
        o.cov = max(o.cov, 0.3);
      }
    }
    if ((v.aux & FINE_TUBE) != 0u) {
      let fade = 1.0 - smoothstep(FINE_NEAR, FINE_FAR, o.pos.w);
      if (fade < 1.0) { o.cov = select(abs(o.cov), 1.0, o.cov < 0.0) * fade; }
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
  fragXY = i.pos.xy;
  leafCutout(i);
  // Widened thin tubes: hashed coverage, gone below 8 % of a pixel.
  if (i.cov >= 0.0 && i.cov < 1.0 && (i.cov < 0.08 || i.cov <= leafDither(i.pos.xy))) { discard; }
  return shadeCity(i, ff);
}

// The same without any discard (opaque clusters: the GPU's hidden-surface
// removal stays on for a pipeline that never discards).
@fragment fn fsOpaque(i: VOut, @builtin(front_facing) ff: bool) -> GOut {
  dWorldX = dpdx(i.world);
  dWorldY = dpdy(i.world);
  dUvX = dpdx(i.uv);
  dUvY = dpdy(i.uv);
  fragXY = i.pos.xy;
  return shadeCity(i, ff);
}

fn shadeCity(i: VOut, ff: bool) -> GOut {
  var n = normalize(i.normal);
  if (!ff && (i.mat & 0xffu) != 25u) { n = -n; }
  // A widened (sub-pixel) overhead-line wire: each pixel used to sample one
  // facet of the diamond section, so its sharp metal highlight flipped
  // pixel to pixel along the line (a speckled rope at 10-30 m). Shade it as
  // its pixel-mean instead: a view-facing normal, a broad lobe.
  let subWire = i.cov < 0.0 && (i.mat & 0xffu) == 20u;
  if (subWire) { n = normalize(frame.camPos.xyz - i.world); }
  var s = cityMaterial(i.world, n, i.uv, i.mat, i.aux);
  if (subWire) { s.rough = max(s.rough, 0.6); }
  // Solid min-width lamp line: its light spread over the widened pixels
  // (energy-preserving: the same mean light as the old sub-pixel dashes).
  if (i.cov < 0.0) { s.emissive *= -i.cov; }
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
