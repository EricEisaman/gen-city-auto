// City geometry builder and clusterizer.
//
// Vertex format (32 bytes, read with vertex pulling in WGSL):
//   pos: f32x3, normal: u32 (octahedral unorm16x2), uv: f32x2, mat: u32, aux: u32
// mat = material id (low 8 bits) | parameter (high 24 bits).
// aux: material-specific. For TUBE_MATS (wire, frame, paint, metal, lamp,
// ledLine) the low 16 bits are the tube radius in 0.5 mm units, written by
// tube() and 0 on every other primitive (vertex() clears them); city.wgsl's
// vs widens such tubes to a minimum on-screen width: hashed partial coverage for most, a
// solid ~1 px line for wires (CM.wire params != 0, or param 0 under 2 cm
// radius: utility spans; tyres stay hashed) and lamp / LED line
// tubes (whose light is scaled by the true coverage). The high 16 bits stay
// free (seed), except bit 31 on a tube: FINE_TUBE (distance fade).
//
// Meshes are split into clusters of at most 128 triangles / 255 vertices. Each
// triangle is stored as one u32 holding three 8-bit cluster-local indices.

import type {Vec2, Vec3} from '../math/vec.ts';

export const CM = {
  road: 0,
  sidewalk: 1,
  /**
   * Kerb faces (param 0; uv x metres along, y metres up). Param 1: precast
   * concrete of planter kerbs, tree-pit frames, verge skirts and median
   * tops (same uv; curbMat may tint it apart from kerb stone).
   */
  curb: 2,
  facade: 3,
  roof: 4,
  glass: 5,
  metal: 6,
  sign: 7,
  foliage: 8,
  /** Tree trunks: uv x metres around, y metres up; aux = the tree's hash. */
  bark: 9,
  grass: 10,
  lamp: 11,
  concrete: 12,
  rail: 13,
  /**
   * Signal lamps: lamp | group << 2 | phase << 3 (| 0x800 upper ped lamp).
   * Lamp 3 (pedestrian) is on the pictogram geometry only (the lit figure,
   * uv 0..1 over the 0.34 m lens square); the lens around it is paint 0x91.
   */
  signal: 14,
  frame: 15,
  paint: 16,
  shopfront: 17,
  screen: 18,
  tile: 19,
  wire: 20,
  vending: 21,
  ledLine: 22,
  water: 23,
  asphaltPlain: 24,
  leaves: 25,
  carPark: 26,
  /** Road signs: param & 0xff = sign kind, 0x100 = back face; uv 0..1. */
  roadSign: 27,
  /** Clipped hedge (param 0, box uv in metres) or tree grate (param 1). */
  hedge: 28,
} as const;

/** Materials whose aux low 16 bits carry a tube radius (see header). */
const TUBE_MATS =
  (1 << CM.wire) |
  (1 << CM.frame) |
  (1 << CM.paint) |
  (1 << CM.metal) |
  (1 << CM.lamp) |
  (1 << CM.ledLine);

/**
 * Tube aux flag: fine hardware (OHLE droppers, arms, insulators) that
 * city.wgsl fades out with distance (FINE_NEAR..FINE_FAR), so it does not
 * read as beads strung along the wires at mid / far range.
 */
export const FINE_TUBE = 0x80000000;

export const VERTEX_BYTES = 32;
export const VERTEX_WORDS = 8;
export const CLUSTER_TRIS = 128;
export const CLUSTER_VERTS = 255;
export const CLUSTER_WORDS = 8;
/**
 * Cluster flag (packed bits 12-15): the cluster holds alpha-tested geometry
 * (leaf cards, or tubes the vertex shader may widen to hashed coverage), so
 * it is drawn with the discarding pipeline; every other cluster goes through
 * the opaque one, which keeps the GPU's hidden-surface removal on.
 */
export const CLUSTER_ALPHA = 2;
/**
 * Cluster record bits 16-31 (packed word): the distance in metres past which
 * the cull pass drops the cluster (0 = never), so fine detail of always-
 * resident meshes (kerbs, railings, wires, thin road paint) goes at range.
 * cull.wgsl jitters it per cluster (+-20 %) so the cut is not one ring.
 */
export const CLUSTER_FAR_SHIFT = 16;
export const CLUSTER_FAR_MAX = 0xffff;
/** Grid cell (m) clusterize() groups far-classed triangles by. */
const CLUSTER_CELL = 64;

/** Interleaves the low 16 bits of x and z (Z-order). */
function morton(x: number, z: number) {
  const spread = (v: number) => {
    v &= 0xffff;
    v = (v | (v << 8)) & 0x00ff00ff;
    v = (v | (v << 4)) & 0x0f0f0f0f;
    v = (v | (v << 2)) & 0x33333333;
    v = (v | (v << 1)) & 0x55555555;
    return v;
  };
  return (spread(x) | (spread(z) << 1)) >>> 0;
}

/** True for a vertex the city fragment shader may discard. */
function alphaTested(mat: number, aux: number) {
  const id = mat & 0xff;
  // Leaf cards cut out; solid LOD2 crowns (param LEAF_SOLID) do not.
  if (id === CM.leaves) return ((mat >>> 8) & 0x100) === 0;
  // LED line tubes are always drawn solid (never hashed): opaque pipeline.
  return (
    id !== CM.ledLine &&
    id < 32 &&
    ((TUBE_MATS >>> id) & 1) === 1 &&
    (aux & 0xffff) > 0
  );
}

export function packMat(id: number, param = 0) {
  return ((param & 0xffffff) << 8) | (id & 0xff);
}

function octEncode(n: Vec3): number {
  const l = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) || 1;
  let x = n[0] / l;
  let y = n[1] / l;
  if (n[2] < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const qx = Math.round((x * 0.5 + 0.5) * 65535);
  const qy = Math.round((y * 0.5 + 0.5) * 65535);
  return ((qy & 0xffff) << 16) | (qx & 0xffff);
}

/** Growable typed-array mesh in the city vertex format. */
export class CMesh {
  f32: Float32Array;
  u32: Uint32Array;
  vcount = 0;
  idx: Uint32Array;
  icount = 0;
  /** Set while tube() emits its rings (they keep their radius in aux). */
  private inTube = false;

  constructor(vcap = 4096, icap = 8192) {
    const buf = new ArrayBuffer(vcap * VERTEX_BYTES);
    this.f32 = new Float32Array(buf);
    this.u32 = new Uint32Array(buf);
    this.idx = new Uint32Array(icap);
  }

  private growV(n: number) {
    if (this.vcount + n <= this.f32.length / VERTEX_WORDS) return;
    let cap = this.f32.length / VERTEX_WORDS;
    while (cap < this.vcount + n) cap *= 2;
    const buf = new ArrayBuffer(cap * VERTEX_BYTES);
    new Uint32Array(buf).set(this.u32.subarray(0, this.vcount * VERTEX_WORDS));
    this.f32 = new Float32Array(buf);
    this.u32 = new Uint32Array(buf);
  }

  private growI(n: number) {
    if (this.icount + n <= this.idx.length) return;
    let cap = this.idx.length;
    while (cap < this.icount + n) cap *= 2;
    const idx = new Uint32Array(cap);
    idx.set(this.idx.subarray(0, this.icount));
    this.idx = idx;
  }

  vertex(p: Vec3, n: Vec3, u: number, v: number, mat: number, aux = 0) {
    const id = mat & 0xff;
    if (!this.inTube && id < 32 && (TUBE_MATS >>> id) & 1) aux &= 0xffff0000;
    this.growV(1);
    const o = this.vcount * VERTEX_WORDS;
    this.f32[o] = p[0];
    this.f32[o + 1] = p[1];
    this.f32[o + 2] = p[2];
    this.u32[o + 3] = octEncode(n);
    this.f32[o + 4] = u;
    this.f32[o + 5] = v;
    this.u32[o + 6] = mat >>> 0;
    this.u32[o + 7] = aux >>> 0;
    return this.vcount++;
  }

  /**
   * Appends another mesh's vertex words (VERTEX_WORDS per vertex) and its
   * triangles (re-indexed past this mesh's vertices).
   */
  append(words: Uint32Array, idx: Uint32Array) {
    const base = this.vcount;
    const nv = words.length / VERTEX_WORDS;
    this.growV(nv);
    this.u32.set(words, base * VERTEX_WORDS);
    this.vcount += nv;
    this.growI(idx.length);
    for (let i = 0; i < idx.length; i++)
      this.idx[this.icount + i] = idx[i] + base;
    this.icount += idx.length;
  }

  /** Appends a copy of vertex `i` of `src`; returns its index. */
  copyVertex(src: CMesh, i: number) {
    this.growV(1);
    this.u32.set(
      src.u32.subarray(i * VERTEX_WORDS, (i + 1) * VERTEX_WORDS),
      this.vcount * VERTEX_WORDS,
    );
    return this.vcount++;
  }

  tri(a: number, b: number, c: number) {
    this.growI(3);
    this.idx[this.icount++] = a;
    this.idx[this.icount++] = b;
    this.idx[this.icount++] = c;
  }

  /** Position of vertex i. */
  pos(i: number): Vec3 {
    const o = i * VERTEX_WORDS;
    return [this.f32[o], this.f32[o + 1], this.f32[o + 2]];
  }

  /** Triangle whose winding is chosen so its front faces along `n`. */
  triFacing(a: number, b: number, c: number, n: Vec3) {
    const A = this.pos(a),
      B = this.pos(b),
      C = this.pos(c);
    const ux = B[0] - A[0],
      uy = B[1] - A[1],
      uz = B[2] - A[2];
    const vx = C[0] - A[0],
      vy = C[1] - A[1],
      vz = C[2] - A[2];
    const cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx;
    if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) this.tri(a, b, c);
    else this.tri(a, c, b);
  }

  /** Quad from 4 corners in order around the quad; faces along n. */
  quad(p: Vec3[], n: Vec3, uv: Vec2[], mat: number, aux = 0) {
    const a = this.vertex(p[0], n, uv[0][0], uv[0][1], mat, aux);
    const b = this.vertex(p[1], n, uv[1][0], uv[1][1], mat, aux);
    const c = this.vertex(p[2], n, uv[2][0], uv[2][1], mat, aux);
    const d = this.vertex(p[3], n, uv[3][0], uv[3][1], mat, aux);
    this.triFacing(a, b, c, n);
    this.triFacing(a, c, d, n);
  }

  /** Quad with an explicit (possibly non-planar) normal per corner. */
  quadN(p: Vec3[], ns: Vec3[], uv: Vec2[], mat: number, face: Vec3, aux = 0) {
    const ids = p.map((q, i) =>
      this.vertex(q, ns[i], uv[i][0], uv[i][1], mat, aux),
    );
    this.triFacing(ids[0], ids[1], ids[2], face);
    this.triFacing(ids[0], ids[2], ids[3], face);
  }

  /**
   * Oriented box: center, half extents along (right, up, forward) axes, with
   * the box rotated by `yaw` about +y. UVs are in meters on each face.
   * `skipBack` drops the -forward face (boxes mounted on a wall facing out).
   */
  box(
    c: Vec3,
    h: Vec3,
    mat: number,
    yaw = 0,
    aux = 0,
    skipBottom = true,
    skipBack = false,
  ) {
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const R: Vec3 = [cs, 0, -sn];
    const U: Vec3 = [0, 1, 0];
    const F: Vec3 = [sn, 0, cs];
    const P = (x: number, y: number, z: number): Vec3 => [
      c[0] + R[0] * x * h[0] + F[0] * z * h[2],
      c[1] + y * h[1],
      c[2] + R[2] * x * h[0] + F[2] * z * h[2],
    ];
    const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
    // +x face
    this.quad(
      [P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)],
      R,
      [
        [0, 0],
        [2 * h[2], 0],
        [2 * h[2], 2 * h[1]],
        [0, 2 * h[1]],
      ],
      mat,
      aux,
    );
    this.quad(
      [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)],
      neg(R),
      [
        [0, 0],
        [2 * h[2], 0],
        [2 * h[2], 2 * h[1]],
        [0, 2 * h[1]],
      ],
      mat,
      aux,
    );
    this.quad(
      [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)],
      F,
      [
        [0, 0],
        [2 * h[0], 0],
        [2 * h[0], 2 * h[1]],
        [0, 2 * h[1]],
      ],
      mat,
      aux,
    );
    if (!skipBack)
      this.quad(
        [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)],
        neg(F),
        [
          [0, 0],
          [2 * h[0], 0],
          [2 * h[0], 2 * h[1]],
          [0, 2 * h[1]],
        ],
        mat,
        aux,
      );
    this.quad(
      [P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)],
      U,
      [
        [0, 0],
        [2 * h[0], 0],
        [2 * h[0], 2 * h[2]],
        [0, 2 * h[2]],
      ],
      mat,
      aux,
    );
    if (!skipBottom) {
      this.quad(
        [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)],
        neg(U),
        [
          [0, 0],
          [2 * h[0], 0],
          [2 * h[0], 2 * h[2]],
          [0, 2 * h[2]],
        ],
        mat,
        aux,
      );
    }
  }

  /**
   * Box spanning segment a->b (a thick line), e.g. wires, rails, girders.
   * `w` and `hgt` are half the section's width and height. `hide`: a
   * direction (say into a wall) whose facing side is not drawn. `chamfer`
   * (metres) bevels the section's corners at 45 degrees, so the edges catch
   * a highlight line (corners next to a hidden side stay square). uv: u =
   * metres along, v = metres across each face.
   */
  beam(
    a: Vec3,
    b: Vec3,
    w: number,
    hgt: number,
    mat: number,
    aux = 0,
    hide?: Vec3,
    chamfer = 0,
  ) {
    // Thin square bars are drawn as a tube of the same section (half the
    // vertices; at a few cm nobody can tell the corners are smooth).
    if (w === hgt && w <= 0.06) {
      this.tube([a, b], w * Math.SQRT2, mat, aux);
      return;
    }
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const f: Vec3 = [dx / len, dy / len, dz / len];
    let r: Vec3 = [f[2], 0, -f[0]];
    const rl = Math.hypot(r[0], r[2]);
    r = rl > 1e-4 ? [r[0] / rl, 0, r[2] / rl] : [1, 0, 0];
    const u: Vec3 = [
      r[1] * f[2] - r[2] * f[1],
      r[2] * f[0] - r[0] * f[2],
      r[0] * f[1] - r[1] * f[0],
    ];
    // Section offsets (x along r, y along u) in metres.
    const P = (p: Vec3, x: number, y: number): Vec3 => [
      p[0] + r[0] * x + u[0] * y,
      p[1] + r[1] * x + u[1] * y,
      p[2] + r[2] * x + u[2] * y,
    ];
    // The four sides (+r, +u, -r, -u) as start/end corners, going around.
    const sides: [number, number, number, number][] = [
      [w, -hgt, w, hgt],
      [w, hgt, -w, hgt],
      [-w, hgt, -w, -hgt],
      [-w, -hgt, w, -hgt],
    ];
    const hidden = sides.map(([x0, y0, x1, y1]) => {
      if (!hide) return false;
      const nx = (y1 - y0) / (Math.abs(y1 - y0) || 1);
      const ny = (x0 - x1) / (Math.abs(x0 - x1) || 1);
      const n = [
        r[0] * nx + u[0] * ny,
        r[1] * nx + u[1] * ny,
        r[2] * nx + u[2] * ny,
      ];
      return n[0] * hide[0] + n[1] * hide[1] + n[2] * hide[2] > 0.7;
    });
    const c = Math.min(chamfer, w * 0.9, hgt * 0.9);
    // Profile points: each side's ends pulled in by c where its corner with
    // the next / previous side is bevelled.
    const prof: [number, number, boolean][] = [];
    for (let i = 0; i < 4; i++) {
      const [x0, y0, x1, y1] = sides[i];
      const l = Math.hypot(x1 - x0, y1 - y0);
      const tx = (x1 - x0) / l;
      const ty = (y1 - y0) / l;
      const bevIn = c > 0 && !hidden[i] && !hidden[(i + 3) & 3];
      const bevOut = c > 0 && !hidden[i] && !hidden[(i + 1) & 3];
      const s0 = bevIn ? c : 0;
      const s1 = bevOut ? c : 0;
      prof.push([x0 + tx * s0, y0 + ty * s0, hidden[i]]);
      prof.push([x1 - tx * s1, y1 - ty * s1, !bevOut]);
    }
    // Edges of the profile: k even = a side, k odd = a corner (a bevel when
    // its two points differ).
    for (let k = 0; k < 8; k++) {
      const [x0, y0, skip] = prof[k];
      const [x1, y1] = prof[(k + 1) & 7];
      if (skip) continue;
      const el = Math.hypot(x1 - x0, y1 - y0);
      if (el < 1e-5) continue;
      const nx = (y1 - y0) / el;
      const ny = (x0 - x1) / el;
      const n: Vec3 = [
        r[0] * nx + u[0] * ny,
        r[1] * nx + u[1] * ny,
        r[2] * nx + u[2] * ny,
      ];
      this.quad(
        [P(a, x0, y0), P(b, x0, y0), P(b, x1, y1), P(a, x1, y1)],
        n,
        [
          [0, 0],
          [len, 0],
          [len, el],
          [0, el],
        ],
        mat,
        aux,
      );
    }
  }

  /**
   * Thin round bar (pipe, rail, wire, post) through `pts`: a square section
   * turned 45 degrees with radial normals, so it shades like a cylinder.
   * Joints share their ring: 4 vertices per point instead of a beam's 16 per
   * segment. uv: u = metres along, v = 0..1 around. No end caps.
   * Wire, frame, paint, metal and lamp tubes store r in aux (see the
   * header) so the vertex shader can keep them at least ~1 px wide.
   */
  tube(pts: Vec3[], r: number, mat: number, aux = 0) {
    if (pts.length < 2) return;
    const id = mat & 0xff;
    if (id < 32 && (TUBE_MATS >>> id) & 1)
      aux = (aux & 0xffff0000) | Math.min(0xffff, Math.round(r * 2000));
    this.inTube = true;
    const rings: number[] = [];
    let u = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      if (i > 0) u += Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
      let f: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const fl = Math.hypot(f[0], f[1], f[2]) || 1;
      f = [f[0] / fl, f[1] / fl, f[2] / fl];
      // Side axis horizontal (or x for vertical bars), up = side x forward.
      let s: Vec3 = [f[2], 0, -f[0]];
      const sl = Math.hypot(s[0], s[2]);
      s = sl > 1e-4 ? [s[0] / sl, 0, s[2] / sl] : [1, 0, 0];
      const up: Vec3 = [
        s[1] * f[2] - s[2] * f[1],
        s[2] * f[0] - s[0] * f[2],
        s[0] * f[1] - s[1] * f[0],
      ];
      for (let k = 0; k < 4; k++) {
        const c = k === 0 || k === 3 ? 1 : -1;
        const d = k < 2 ? 1 : -1;
        const n: Vec3 = [
          (s[0] * c + up[0] * d) * Math.SQRT1_2,
          (s[1] * c + up[1] * d) * Math.SQRT1_2,
          (s[2] * c + up[2] * d) * Math.SQRT1_2,
        ];
        rings.push(
          this.vertex(
            [p[0] + n[0] * r, p[1] + n[1] * r, p[2] + n[2] * r],
            n,
            u,
            k / 4,
            mat,
            aux,
          ),
        );
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) & 3;
        const a = rings[i * 4 + k],
          b = rings[i * 4 + k1],
          c = rings[i * 4 + 4 + k1],
          d = rings[i * 4 + 4 + k];
        // Face normal: between the two corner normals.
        const pa = this.pos(a),
          pb = this.pos(b);
        const m: Vec3 = [
          (pa[0] + pb[0]) / 2 - pts[i][0],
          (pa[1] + pb[1]) / 2 - pts[i][1],
          (pa[2] + pb[2]) / 2 - pts[i][2],
        ];
        this.triFacing(a, b, c, m);
        this.triFacing(a, c, d, m);
      }
    }
    this.inTube = false;
  }

  /** Vertical cylinder (n sides) from y0 to y1. */
  cylinder(
    c: Vec3,
    radius: number,
    height: number,
    sides: number,
    mat: number,
    cap = true,
    aux = 0,
  ) {
    const ring: number[] = [];
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const n: Vec3 = [Math.cos(a), 0, Math.sin(a)];
      const u = (i / sides) * Math.PI * 2 * radius;
      ring.push(
        this.vertex(
          [c[0] + n[0] * radius, c[1], c[2] + n[2] * radius],
          n,
          u,
          0,
          mat,
          aux,
        ),
      );
      ring.push(
        this.vertex(
          [c[0] + n[0] * radius, c[1] + height, c[2] + n[2] * radius],
          n,
          u,
          height,
          mat,
          aux,
        ),
      );
    }
    for (let i = 0; i < sides; i++) {
      const a = ring[i * 2],
        b = ring[i * 2 + 1],
        cc = ring[i * 2 + 2],
        d = ring[i * 2 + 3];
      const ang = ((i + 0.5) / sides) * Math.PI * 2;
      const n: Vec3 = [Math.cos(ang), 0, Math.sin(ang)];
      this.triFacing(a, b, d, n);
      this.triFacing(a, d, cc, n);
    }
    if (cap) {
      const center = this.vertex(
        [c[0], c[1] + height, c[2]],
        [0, 1, 0],
        0,
        0,
        mat,
        aux,
      );
      const top: number[] = [];
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        top.push(
          this.vertex(
            [
              c[0] + Math.cos(a) * radius,
              c[1] + height,
              c[2] + Math.sin(a) * radius,
            ],
            [0, 1, 0],
            Math.cos(a) * radius,
            Math.sin(a) * radius,
            mat,
            aux,
          ),
        );
      }
      for (let i = 0; i < sides; i++)
        this.triFacing(center, top[i + 1], top[i], [0, 1, 0]);
    }
  }
}

/** Ear-clipping triangulation of a simple CCW polygon. Returns index triples. */
export function triangulate(poly: Vec2[]): number[] {
  const n = poly.length;
  const out: number[] = [];
  if (n < 3) return out;
  const V = Array.from({length: n}, (_, i) => i);
  const area2 = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) =>
    area2(a, b, p) >= 0 && area2(b, c, p) >= 0 && area2(c, a, p) >= 0;
  let guard = 0;
  while (V.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < V.length; i++) {
      const i0 = V[(i - 1 + V.length) % V.length];
      const i1 = V[i];
      const i2 = V[(i + 1) % V.length];
      const a = poly[i0],
        b = poly[i1],
        c = poly[i2];
      if (area2(a, b, c) <= 1e-9) continue;
      let ok = true;
      for (const j of V) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inTri(poly[j], a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(i0, i1, i2);
      V.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate input: fall back to a fan.
      for (let i = 1; i + 1 < V.length; i++) out.push(V[0], V[i], V[i + 1]);
      return out;
    }
  }
  if (V.length === 3) out.push(V[0], V[1], V[2]);
  return out;
}

export interface ClusterData {
  /** Vertex words (VERTEX_WORDS per vertex). */
  vertices: Uint32Array;
  /** Packed triangles (one u32 each). */
  tris: Uint32Array;
  /**
   * Cluster records, CLUSTER_WORDS each:
   *   [cx, cy, cz, radius] as f32, vertOffset, triOffset, triCount | lod << 8 | flags << 12, tile
   * Offsets are relative to this batch; the pool rebases them on upload.
   */
  clusters: Uint32Array;
  clusterCount: number;
  bounds: [Vec3, Vec3];
}

/** Split a mesh into clusters (in index order, which is spatially coherent). */
export function clusterize(
  m: CMesh,
  lod: number,
  tile: number,
  flags = 0,
  /**
   * Optional per-triangle cull distance (metres, 0 = never; see
   * CLUSTER_FAR_SHIFT). Clusters then hold one distance each: triangles are
   * grouped by it, and within a group by CLUSTER_CELL grid cell (Morton
   * order) then index order, so pulling the fine detail out of the stream
   * does not stretch clusters along it (index order alone made the base
   * mesh's clusters 30 % larger, which cost the near views in culling).
   */
  farOf?: (tri: number) => number,
): ClusterData {
  const triCount = m.icount / 3;
  const clusterF = new Float32Array(1);
  const asU = new Uint32Array(clusterF.buffer);
  const f2u = (f: number) => {
    clusterF[0] = f;
    return asU[0];
  };
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const vertexWords = m.u32;
  const vertexF = m.f32;
  // Opaque triangles first, then the alpha-tested ones (each in index
  // order), so clusters never mix the two and most of the city draws
  // through the opaque (no-discard) pipeline.
  const triAlpha = (tri: number) => {
    for (let k = 0; k < 3; k++) {
      const g = m.idx[tri * 3 + k];
      if (
        alphaTested(
          vertexWords[g * VERTEX_WORDS + 6],
          vertexWords[g * VERTEX_WORDS + 7],
        )
      )
        return true;
    }
    return false;
  };
  const order = new Uint32Array(triCount);
  const isAlpha = new Uint8Array(triCount);
  let nOpaque = 0;
  for (let i = 0; i < triCount; i++)
    if (!(isAlpha[i] = +triAlpha(i))) nOpaque++;
  {
    let a = 0;
    let b = nOpaque;
    for (let i = 0; i < triCount; i++) order[isAlpha[i] ? b++ : a++] = i;
  }
  // Group keys per triangle: cull distance, then grid cell (each sort is
  // stable within opaque / alpha).
  let far: Uint16Array | null = null;
  let cell: Uint32Array | null = null;
  if (farOf) {
    far = new Uint16Array(triCount);
    cell = new Uint32Array(triCount);
    for (let i = 0; i < triCount; i++) {
      far[i] = Math.min(CLUSTER_FAR_MAX, Math.max(0, Math.round(farOf(i))));
      let x = 0;
      let z = 0;
      for (let k = 0; k < 3; k++) {
        const g = m.idx[i * 3 + k] * VERTEX_WORDS;
        x += vertexF[g];
        z += vertexF[g + 2];
      }
      cell[i] = morton(
        Math.floor(x / 3 / CLUSTER_CELL) + 0x8000,
        Math.floor(z / 3 / CLUSTER_CELL) + 0x8000,
      );
    }
    const f = far;
    const c = cell;
    const sortPart = (lo: number, hi: number) => {
      const part = Array.from(order.subarray(lo, hi));
      part.sort((x, y) => f[x] - f[y] || c[x] - c[y] || x - y);
      order.set(part, lo);
    };
    sortPart(0, nOpaque);
    sortPart(nOpaque, triCount);
  }
  // Typed-array output (grown by doubling) and a per-vertex "local index in
  // the current cluster" table stamped with the cluster number, instead of
  // number[] pushes and a Map per cluster: same output, several times faster.
  let verts = new Uint32Array(
    Math.max(1024, Math.ceil(m.vcount * 1.25)) * VERTEX_WORDS,
  );
  let nv = 0;
  const tris = new Uint32Array(triCount);
  let nt = 0;
  let clusters = new Uint32Array(
    Math.max(64, Math.ceil(triCount / 64)) * CLUSTER_WORDS,
  );
  let nc = 0;
  const stamp = new Int32Array(m.vcount).fill(-1);
  const localOf = new Uint8Array(m.vcount);
  const idx = m.idx;
  let cid = 0;
  let t = 0;
  while (t < triCount) {
    cid++;
    let localSize = 0;
    const vstart = nv / VERTEX_WORDS;
    const tstart = nt;
    let cl0 = Infinity,
      cl1 = Infinity,
      cl2 = Infinity,
      ch0 = -Infinity,
      ch1 = -Infinity,
      ch2 = -Infinity;
    const alpha = t >= nOpaque;
    const farD = far ? far[order[t]] : 0;
    let cellK = cell ? cell[order[t]] : 0;
    while (
      t < triCount &&
      nt - tstart < CLUSTER_TRIS &&
      t >= nOpaque === alpha &&
      (!far || far[order[t]] === farD)
    ) {
      // A new cell starts a new cluster once this one is 3/4 full (the
      // remainder of a cell spills into the next rather than leaving tiny
      // clusters the small-detail cull would drop at range).
      if (cell && cell[order[t]] !== cellK) {
        if (nt - tstart >= (CLUSTER_TRIS * 3) / 4) break;
        cellK = cell[order[t]];
      }
      const tri = order[t];
      const i0 = idx[tri * 3],
        i1 = idx[tri * 3 + 1],
        i2 = idx[tri * 3 + 2];
      // (A vertex repeated in a degenerate triangle counts once per use.)
      const need =
        (stamp[i0] !== cid ? 1 : 0) +
        (stamp[i1] !== cid ? 1 : 0) +
        (stamp[i2] !== cid ? 1 : 0);
      if (localSize + need > CLUSTER_VERTS) break;
      let packed = 0;
      for (let k = 0; k < 3; k++) {
        const g = k === 0 ? i0 : k === 1 ? i1 : i2;
        let l: number;
        if (stamp[g] === cid) l = localOf[g];
        else {
          l = localSize++;
          stamp[g] = cid;
          localOf[g] = l;
          if (nv + VERTEX_WORDS > verts.length) {
            const grown = new Uint32Array(verts.length * 2);
            grown.set(verts);
            verts = grown;
          }
          const gw = g * VERTEX_WORDS;
          for (let w = 0; w < VERTEX_WORDS; w++)
            verts[nv + w] = vertexWords[gw + w];
          nv += VERTEX_WORDS;
          const x = vertexF[gw],
            y = vertexF[gw + 1],
            z = vertexF[gw + 2];
          cl0 = Math.min(cl0, x);
          cl1 = Math.min(cl1, y);
          cl2 = Math.min(cl2, z);
          ch0 = Math.max(ch0, x);
          ch1 = Math.max(ch1, y);
          ch2 = Math.max(ch2, z);
        }
        packed |= l << (k * 8);
      }
      tris[nt++] = packed >>> 0;
      t++;
    }
    const r = Math.hypot(ch0 - cl0, ch1 - cl1, ch2 - cl2) / 2;
    lo[0] = Math.min(lo[0], cl0);
    lo[1] = Math.min(lo[1], cl1);
    lo[2] = Math.min(lo[2], cl2);
    hi[0] = Math.max(hi[0], ch0);
    hi[1] = Math.max(hi[1], ch1);
    hi[2] = Math.max(hi[2], ch2);
    if (nc + CLUSTER_WORDS > clusters.length) {
      const grown = new Uint32Array(clusters.length * 2);
      grown.set(clusters);
      clusters = grown;
    }
    clusters[nc] = f2u((cl0 + ch0) / 2);
    clusters[nc + 1] = f2u((cl1 + ch1) / 2);
    clusters[nc + 2] = f2u((cl2 + ch2) / 2);
    clusters[nc + 3] = f2u(r);
    clusters[nc + 4] = vstart;
    clusters[nc + 5] = tstart;
    clusters[nc + 6] =
      (nt - tstart) |
      (lod << 8) |
      ((flags | (alpha ? CLUSTER_ALPHA : 0)) << 12) |
      (farD << CLUSTER_FAR_SHIFT);
    clusters[nc + 7] = tile;
    nc += CLUSTER_WORDS;
  }
  return {
    vertices: verts.slice(0, nv),
    tris,
    clusters: clusters.slice(0, nc),
    clusterCount: nc / CLUSTER_WORDS,
    bounds: [lo, hi],
  };
}
