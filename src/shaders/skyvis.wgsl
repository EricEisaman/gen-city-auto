// Sky visibility over the skyline height map, shared by the GTAO pass
// (which traces it at half resolution, ao.wgsl) and lighting (full-res
// fallback, ?off=hskyvis). The including module declares `skyline` and
// `frame`.

const OFF_SKYVIS = 4u;

// Bare terrain cells of the skyline map hold -(h + SKYLINE_TERRAIN)
// (world/city.ts), building cells their top: the height either way.
const SKYLINE_TERRAIN = 10000.0;
fn skyH(v: f32) -> f32 {
  return select(v, -v - SKYLINE_TERRAIN, v < -SKYLINE_TERRAIN * 0.5);
}

// Fraction of the sky visible from a point, from a horizon search over the
// building/terrain height map (8 azimuths x 8 doubling steps, 0.5 m .. 64 m).
// Walls only count the half-space they face. Height-map texels are several
// metres wide, so near the point each step also takes the next texel along
// the ray (the conservative edge): pavement half a metre from a 17 m wall
// must see that wall. On a wall, samples still inside its own plane (within
// a texel of it) are skipped, or the wall would occlude itself sideways.
fn skyVisibility(world: vec3f, n: vec3f, pxf: vec2f) -> f32 {
  if ((frame.off.x & OFF_SKYVIS) != 0u) { return 1.0; }
  let N = f32(textureDimensions(skyline).x);
  let size = frame.world.x;
  let cell = size / N;
  let wall = n.y < 0.7;
  let nh = normalize(n.xz + vec2f(1e-5));
  // Per-pixel jitter of the azimuths and step lengths (resolved by TAA), so
  // the height map's texel edges don't print as steps on the pavement.
  let jit = fract(52.9829189 * fract(dot(pxf, vec2f(0.06711056, 0.00583715))) + frame.time.z * 0.618034);
  var occl = 0.0;
  var cnt = 0.0;
  for (var a = 0; a < 8; a++) {
    let ang = (f32(a) + jit) * 0.785398;
    let dir = vec2f(cos(ang), sin(ang));
    if (wall && dot(dir, n.xz) < -0.2) { continue; }
    var maxS = 0.0;
    var dist = 0.5 * (0.75 + 0.5 * fract(jit * 7.0 + f32(a) * 0.618));
    for (var k = 0; k < 8; k++) {
      let p = world.xz + dir * dist;
      let off = select(1e9, dot(dir, nh) * dist, wall);
      if (off > cell * 0.75) {
        let g = vec2i((p + size * 0.5) / size * N);
        if (all(g >= vec2i(0)) && all(g < vec2i(i32(N)))) {
          var h = skyH(textureLoad(skyline, g, 0).r);
          if (dist < cell * 2.0) {
            let g2 = clamp(vec2i((p + dir * cell + size * 0.5) / size * N), vec2i(0), vec2i(i32(N) - 1));
            h = max(h, skyH(textureLoad(skyline, g2, 0).r));
          }
          // (Less half a texel of rise: on sloping terrain the texel itself
          // stands above the point, and the near steps turned dunes and
          // hillsides into grey blocks.)
          let dh = h - world.y - cell * 0.5;
          let s = max(dh, 0.0) / length(vec2f(dist, dh));
          maxS = max(maxS, s);
        }
      }
      dist *= 2.0;
    }
    occl += maxS * maxS;
    cnt += 1.0;
  }
  return clamp(1.0 - occl / max(cnt, 1.0), 0.15, 1.0);
}

