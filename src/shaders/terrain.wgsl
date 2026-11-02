// Heightfield terrain (instanced quadtree patches with skirts) and the sea.

struct Patch { origin: vec2f, size: f32, pad: f32 };

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var heightTex: texture_2d<f32>;
@group(1) @binding(1) var landTex: texture_2d<f32>;
@group(1) @binding(2) var<storage, read> patches: array<Patch>;

const GRID = 32u;

// Bilinear height of the map, its edge rows extended outward.
fn heightMap(xz: vec2f) -> f32 {
  let n = i32(frame.world.z);
  let g = (xz + frame.world.x * 0.5) / frame.world.y;
  let i = vec2i(floor(g));
  let f = g - vec2f(i);
  let c = vec2i(n - 1);
  let a = textureLoad(heightTex, clamp(i, vec2i(0), c), 0).r;
  let b = textureLoad(heightTex, clamp(i + vec2i(1, 0), vec2i(0), c), 0).r;
  let d = textureLoad(heightTex, clamp(i + vec2i(0, 1), vec2i(0), c), 0).r;
  let e = textureLoad(heightTex, clamp(i + vec2i(1, 1), vec2i(0), c), 0).r;
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}

fn heightAt(xz: vec2f) -> f32 {
  var h = heightMap(xz);
  // Outside the generated world: land continues as a gentle plain, sea stays sea.
  let edge = max(abs(xz.x), abs(xz.y)) - frame.world.x * 0.5;
  if (edge > 0.0) {
    if (h < 1.0) { h = mix(h, -20.0, clamp(edge / 400.0, 0.0, 1.0)); }
    else {
      // The edge row's dents (road troughs, kerbs) blur out along the edge
      // over the first 300 m instead of running to the horizon as grooves
      // (never down into the water: banks stay put).
      // (gen-base.ts outskirts places its blocks on the same ground.)
      let t = select(vec2f(1.0, 0.0), vec2f(0.0, 1.0), abs(xz.x) >= abs(xz.y));
      var acc = 0.0;
      for (var k = -2; k <= 2; k++) { acc += heightMap(xz + t * (f32(k) * 40.0)); }
      h = max(mix(h, acc * 0.2, clamp(edge / 300.0, 0.0, 1.0)), min(h, 1.5));
      h = h + (valueNoise(xz * 0.002) - 0.5) * 20.0 * clamp(edge / 1500.0, 0.0, 1.0);
    }
  }
  return h;
}

fn landAt(xz: vec2f) -> u32 {
  let n = i32(frame.world.z);
  let g = vec2i(round((xz + frame.world.x * 0.5) / frame.world.y));
  if (any(g < vec2i(0)) || any(g >= vec2i(n))) { return 1u; }
  return u32(textureLoad(landTex, g, 0).r * 255.0 + 0.5);
}

// Beyond the generated world: the ground of the outskirts (gen-base.ts
// outskirts), a street grid on its 75 m block cells (lines at -size / 2 +
// 75 k): 10 m of asphalt on each line, 2 m of pavement either side, paved
// lots in between. Patterns fade to the cell's mean once a pixel covers a
// few metres, so the grid never aliases toward the horizon.
const OUT_CELL = 75.0;
fn outskirtsGround(xz: vec2f, foot: f32) -> vec3f {
  let q = (xz + frame.world.x * 0.5) / OUT_CELL;
  let cellId = floor(q);
  let l = (q - cellId) * OUT_CELL;
  let d = min(l, vec2f(OUT_CELL) - l);
  let dl = min(d.x, d.y);
  let w = max(foot, 0.05);
  let road = 1.0 - smoothstep(5.0 - w, 5.0 + w, dl);
  let walk = 1.0 - smoothstep(7.0 - w, 7.0 + w, dl);
  // 6 % of the blocks are parks (gen-base.ts outskirtsPark leaves them
  // unbuilt): lawn under clumps of tree canopy.
  let ci = vec2u(vec2i(cellId) + 4096);
  let park = (hashu((ci.x * 73856093u) ^ (ci.y * 19349663u)) & 0xffffu) < 3932u;
  var lot = vec3f(0.25, 0.245, 0.235) * (0.85 + 0.3 * hash21(cellId));
  var lotMean = vec3f(0.25, 0.245, 0.235);
  if (park) {
    let canopy = smoothstep(0.42, 0.62, valueNoise(xz * 0.12));
    lotMean = vec3f(0.08, 0.12, 0.05);
    lot = mix(mix(vec3f(0.11, 0.16, 0.06), vec3f(0.045, 0.075, 0.035), canopy), lotMean, smoothstep(2.0, 6.0, foot));
  }
  let asph = vec3f(0.1, 0.1, 0.102);
  let pave = vec3f(0.34, 0.33, 0.31);
  // Dashed centre line (6 m dashes) while it is wider than a pixel.
  let along = select(l.y, l.x, d.y < d.x);
  let dash = step(fract(along / 12.0), 0.5) * (1.0 - smoothstep(0.08, 0.2, dl)) * (1.0 - smoothstep(0.1, 0.25, foot));
  var c = mix(mix(lot, pave, walk), asph, road);
  c = mix(c, vec3f(0.45, 0.44, 0.4), dash * 0.6);
  // Area mean of a cell: 25 % asphalt, 9 % pavement, 66 % lot.
  let mean = asph * 0.249 + pave * 0.09 + lotMean * 0.661;
  c = mix(c, mean, smoothstep(2.0, 8.0, foot));
  return c * (0.9 + 0.2 * valueNoise(xz * 0.02));
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = patches[ii];
  let side = GRID + 3u;
  let i = vi % side;
  let j = vi / side;
  let gi = clamp(i32(i) - 1, 0, i32(GRID));
  let gj = clamp(i32(j) - 1, 0, i32(GRID));
  let skirt = i == 0u || j == 0u || i == side - 1u || j == side - 1u;
  let xz = p.origin + vec2f(f32(gi), f32(gj)) / f32(GRID) * p.size;
  var h = heightAt(xz);
  if (skirt) { h -= p.size * 0.04 + 2.0; }
  var o: VOut;
  o.world = vec3f(xz.x, h, xz.y);
  o.pos = frame.viewProj * vec4f(o.world, 1.0);
  return o;
}

@fragment fn fs(i: VOut) -> GOut {
  let xz = i.world.xz;
  let e = frame.world.y;
  let hx = heightAt(xz + vec2f(e, 0.0)) - heightAt(xz - vec2f(e, 0.0));
  let hz = heightAt(xz + vec2f(0.0, e)) - heightAt(xz - vec2f(0.0, e));
  let n = normalize(vec3f(-hx, 2.0 * e, -hz));
  // Ground footprint of the pixel (filters the outskirts street grid).
  let foot = max(length(dpdx(xz)), length(dpdy(xz)));
  let outside = max(abs(xz.x), abs(xz.y)) > frame.world.x * 0.5;
  var s = defaultSurf(n);
  let land = landAt(xz);
  let h = i.world.y;
  let slope = 1.0 - n.y;
  let nz = fbm2(xz * 0.05);
  let grass = mix(vec3f(0.09, 0.15, 0.045), vec3f(0.16, 0.2, 0.08), nz) * (0.8 + 0.2 * valueNoise(xz * 3.0) + 0.1 * (hash21(floor(xz * 12.0)) - 0.5));
  let dirt = vec3f(0.24, 0.19, 0.14) * (0.8 + 0.4 * valueNoise(xz * 0.3));
  let rock = vec3f(0.33, 0.31, 0.29) * (0.8 + 0.3 * valueNoise(xz * 0.2 + h));
  s.albedo = mix(grass, dirt, smoothstep(0.55, 0.75, nz + slope));
  s.albedo = mix(s.albedo, rock, smoothstep(0.35, 0.6, slope));
  s.rough = 0.95;
  if (land == 1u) {
    s.albedo = vec3f(0.3, 0.29, 0.27) * (0.8 + 0.3 * valueNoise(xz * 0.5));
    if (outside) { s.albedo = outskirtsGround(xz, foot); }
    s.cls = CLASS_GROUND;
  } else if (land == 2u) {
    s.albedo = grass;
  } else if (land == 3u) {
    // Under-road fill (seen where a junction plate leaves a gap): the tone
    // of fresh junction asphalt, without blotches, so it doesn't read as
    // a dark, saw-edged stain.
    s.albedo = vec3f(0.072, 0.07, 0.068) * (0.95 + 0.1 * valueNoise(xz * 0.7));
    s.rough = 0.8;
    s.cls = CLASS_GROUND;
  }
  // Beaches and river banks: concrete embankment in the city, sand elsewhere.
  // (Beyond the world the outskirts run down to a narrow strand.)
  let sandTop = select(2.2, 1.5, outside);
  if (h < sandTop && land != 3u) {
    let sand = vec3f(0.5, 0.45, 0.36) * (0.85 + 0.15 * valueNoise(xz));
    s.albedo = mix(s.albedo, sand, smoothstep(sandTop, 1.0, h));
  }
  if (h < frame.world.w) {
    s.albedo = mix(vec3f(0.18, 0.17, 0.14), vec3f(0.08, 0.1, 0.09), clamp(-h / 8.0, 0.0, 1.0));
  }
  if (land == 2u || land == 0u) {
    s.albedo *= 1.0 - frame.weather.z * 0.35;
  } else {
    // Lots and road fill darken evenly; pools only form at low spots,
    // not as world-noise blobs across every lot.
    applyWetness(&s, i.world, select(0.15, 0.25, land == 3u) * n.y, 0.5);
  }
  return writeG(s, i.world, i.pos);
}

// --- Sea --------------------------------------------------------------------

struct WOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
};

@vertex fn vsWater(@builtin(vertex_index) vi: u32) -> WOut {
  // A 64x64 grid of quads centered on the camera, growing with distance.
  let quad = vi / 6u;
  let corner = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1))[vi % 6u];
  let gx = f32(quad % 64u) + corner.x;
  let gz = f32(quad / 64u) + corner.y;
  let g = (vec2f(gx, gz) / 64.0) * 2.0 - 1.0;
  let warped = sign(g) * g * g * 40000.0;
  let snap = floor(frame.camPos.xz / 64.0) * 64.0;
  var o: WOut;
  o.world = vec3f(warped.x + snap.x, frame.world.w, warped.y + snap.y);
  o.pos = frame.viewProj * vec4f(o.world, 1.0);
  return o;
}

// Value noise with its analytic gradient: (value, d/dx, d/dy).
fn noiseD(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let a = hash21(i);
  let b = hash21(i + vec2f(1, 0));
  let c = hash21(i + vec2f(0, 1));
  let d = hash21(i + vec2f(1, 1));
  let k = a - b - c + d;
  return vec3f(
    a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y,
    du * vec2f(b - a + k * u.y, c - a + k * u.x),
  );
}

// Surface slope of calm urban water: rotated, non-harmonic octaves of drifting
// gradient noise (no repeating sine pattern), from 14 m swells to 30 cm
// ripples. Octaves narrower than a few pixels are dropped and their slope
// energy returned as roughness, so grazing and distant water turns into a
// soft mirror instead of sparkling. Returns (slope x, slope z, extra rough).
fn waveSlope(p: vec2f, t: f32, footprint: f32) -> vec3f {
  let wind = frame.wind.xy;
  let ws = length(wind);
  let wdir = select(vec2f(0.94, 0.34), wind / ws, ws > 1e-3);
  // Breeze strength: sunny ~0.4, storm 1.6. Rain adds chop.
  let energy = (0.55 + 0.45 * clamp(ws, 0.0, 2.0)) * (1.0 + frame.weather.y * 0.6);
  var g = vec2f(0.0);
  var lost = 0.0;
  var wl = 14.0;
  var amp = 0.03;
  var ang = 0.0;
  for (var k = 0; k < 6; k++) {
    let c = cos(ang);
    let sn = sin(ang);
    let rot = mat2x2f(c, sn, -sn, c);
    // Short waves move faster relative to their size (dispersion).
    let drift = (rot * wdir) * t * (0.35 + 0.25 * f32(k)) / wl;
    let q = rot * p / wl + drift + vec2f(f32(k) * 17.3, f32(k) * 5.9);
    // Fade before an octave falls below ~3 pixels.
    let vis = smoothstep(wl * 0.35, wl * 0.12, footprint);
    let nd = noiseD(q);
    // d/dp of n(R p / wl) = R^T grad / wl.
    let grad = transpose(rot) * nd.yz / wl;
    let s = amp * wl * energy;
    g += grad * s * vis;
    // Slope variance this octave would have added (|grad n| ~ 1.2 / wl).
    let slope = amp * energy * 1.2;
    lost += (1.0 - vis) * slope * slope;
    wl *= 0.53;
    amp *= 0.92;
    ang += 2.1;
  }
  return vec3f(g, sqrt(lost));
}

@fragment fn fsWater(i: WOut) -> GOut {
  let toEye = frame.camPos.xyz - i.world;
  let dist = length(toEye);
  // Pixel footprint on the water, stretched along the view at grazing angles.
  let pixelAngle = 2.0 / (frame.proj[1][1] * frame.resolution.y);
  let footprint = dist * pixelAngle / max(abs(toEye.y) / dist, 0.08);
  let w = waveSlope(i.world.xz, frame.time.x, footprint);
  // Raindrop rings: a fine high-frequency chop while it rains.
  var g = w.xy;
  if (frame.weather.y > 0.01) {
    let rq = noiseD(i.world.xz * 3.1 + frame.time.x * vec2f(0.7, -0.5));
    g += rq.yz * 0.012 * frame.weather.y * smoothstep(0.4, 0.1, footprint);
  }
  let n = normalize(vec3f(-g.x, 1.0, -g.y));
  var s = defaultSurf(n);
  let depth = frame.world.w - heightAt(i.world.xz);
  // Murky green-brown river water: the bed shows through only in the
  // shallows at the bank, deeper water is dark absorption colour.
  let deep = vec3f(0.018, 0.028, 0.02);
  let murk = vec3f(0.05, 0.055, 0.035);
  let bank = vec3f(0.11, 0.1, 0.075);
  s.albedo = mix(murk, deep, smoothstep(0.5, 5.0, depth));
  s.albedo = mix(s.albedo, bank, smoothstep(0.6, 0.0, depth) * 0.7);
  // Base gloss plus the slope variance of the waves too small to draw.
  s.rough = clamp(sqrt(0.045 * 0.045 + w.z * w.z * 4.0) + frame.weather.y * 0.06, 0.04, 0.22);
  // Far, grazing water: a pixel spans metres of depth, so screen-space
  // reflection rays re-hit the water itself and feed its own colour back
  // (a dark band across the sea). Past that point the surface is glossy
  // enough that the sky/skyline reflection alone reads right.
  s.rough = mix(s.rough, 0.38, smoothstep(1.2, 3.5, footprint));
  s.cls = CLASS_WATER;
  return writeG(s, i.world, i.pos);
}
