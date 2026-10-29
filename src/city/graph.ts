// Planar road graph: build from polylines, split at intersections, merge close
// nodes, prune dead ends, and extract faces (city blocks).

import {
  cross2,
  dist2,
  polygonArea,
  segmentIntersect,
  sub2,
  type Vec2,
} from '../math/vec.ts';

export interface GNode {
  p: Vec2;
  edges: number[];
}

export interface GEdge {
  a: number;
  b: number;
  kind: number;
  dead?: boolean;
}

export interface Polyline {
  pts: Vec2[];
  kind: number;
  /** Longest water crossing allowed (bridge), meters. */
  maxBridge?: number;
}

export class Graph {
  nodes: GNode[] = [];
  edges: GEdge[] = [];

  addNode(p: Vec2) {
    this.nodes.push({p: [p[0], p[1]], edges: []});
    return this.nodes.length - 1;
  }

  addEdge(a: number, b: number, kind: number) {
    if (a === b) return -1;
    for (const e of this.nodes[a].edges) {
      const E = this.edges[e];
      if (!E.dead && ((E.a === a && E.b === b) || (E.a === b && E.b === a))) {
        E.kind = Math.max(E.kind, kind);
        return e;
      }
    }
    this.edges.push({a, b, kind});
    const id = this.edges.length - 1;
    this.nodes[a].edges.push(id);
    this.nodes[b].edges.push(id);
    return id;
  }

  other(e: number, n: number) {
    const E = this.edges[e];
    return E.a === n ? E.b : E.a;
  }

  liveEdges(n: number) {
    return this.nodes[n].edges.filter(e => !this.edges[e].dead);
  }

  degree(n: number) {
    return this.liveEdges(n).length;
  }

  removeEdge(e: number) {
    this.edges[e].dead = true;
  }

  /** Rebuild into a compact graph without dead edges or orphan nodes. */
  compact(): Graph {
    const g = new Graph();
    const map = new Map<number, number>();
    const id = (n: number) => {
      let m = map.get(n);
      if (m === undefined) {
        m = g.addNode(this.nodes[n].p);
        map.set(n, m);
      }
      return m;
    };
    for (const e of this.edges) {
      if (e.dead) continue;
      g.addEdge(id(e.a), id(e.b), e.kind);
    }
    return g;
  }
}

/** Snapping point index for node creation. */
class PointIndex {
  private cells = new Map<string, number[]>();
  private size: number;
  private nodes: GNode[];

  constructor(nodes: GNode[], tolerance: number) {
    this.nodes = nodes;
    this.size = tolerance;
  }

  private key(x: number, y: number) {
    return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
  }

  find(p: Vec2): number {
    const cx = Math.floor(p[0] / this.size);
    const cy = Math.floor(p[1] / this.size);
    let best = -1;
    let bd = this.size;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const n of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const d = dist2(this.nodes[n].p, p);
          if (d < bd) {
            bd = d;
            best = n;
          }
        }
      }
    }
    return best;
  }

  add(n: number) {
    const p = this.nodes[n].p;
    const k = this.key(p[0], p[1]);
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = []));
    c.push(n);
  }
}

/**
 * Build a planar graph from polylines: every crossing becomes a node, and
 * endpoints within `snap` meters are merged.
 */
export function planarize(lines: Polyline[], snap = 2): Graph {
  interface Seg {
    a: Vec2;
    b: Vec2;
    kind: number;
    cuts: number[];
  }
  const segs: Seg[] = [];
  for (const l of lines) {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      if (dist2(l.pts[i], l.pts[i + 1]) < 0.01) continue;
      segs.push({a: l.pts[i], b: l.pts[i + 1], kind: l.kind, cuts: [0, 1]});
    }
  }
  // Spatial hash of segments for intersection tests.
  const cell = 64;
  const grid = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / cell);
    const x1 = Math.floor(Math.max(s.a[0], s.b[0]) / cell);
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / cell);
    const y1 = Math.floor(Math.max(s.a[1], s.b[1]) / cell);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = `${x},${y}`;
        let c = grid.get(k);
        if (!c) grid.set(k, (c = []));
        c.push(i);
      }
    }
  });
  // For each segment, test the later segments sharing any of its cells.
  segs.forEach((A, si) => {
    const x0 = Math.floor(Math.min(A.a[0], A.b[0]) / cell);
    const x1 = Math.floor(Math.max(A.a[0], A.b[0]) / cell);
    const y0 = Math.floor(Math.min(A.a[1], A.b[1]) / cell);
    const y1 = Math.floor(Math.max(A.a[1], A.b[1]) / cell);
    const seen = new Set<number>();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (const sj of grid.get(`${x},${y}`) ?? []) {
          if (sj <= si || seen.has(sj)) continue;
          seen.add(sj);
          const B = segs[sj];
          const r = segmentIntersect(A.a, A.b, B.a, B.b);
          if (r) {
            A.cuts.push(r[0]);
            B.cuts.push(r[1]);
          }
        }
      }
    }
  });
  const g = new Graph();
  const index = new PointIndex(g.nodes, snap);
  const nodeAt = (p: Vec2) => {
    let n = index.find(p);
    if (n < 0) {
      n = g.addNode(p);
      index.add(n);
    }
    return n;
  };
  for (const s of segs) {
    s.cuts.sort((x, y) => x - y);
    let prev = nodeAt(s.a);
    for (let k = 1; k < s.cuts.length; k++) {
      const t = s.cuts[k];
      if (t - s.cuts[k - 1] < 1e-6 && k < s.cuts.length - 1) continue;
      const p: Vec2 = [
        s.a[0] + (s.b[0] - s.a[0]) * t,
        s.a[1] + (s.b[1] - s.a[1]) * t,
      ];
      const n = nodeAt(p);
      if (n !== prev) g.addEdge(prev, n, s.kind);
      prev = n;
    }
  }
  return g;
}

/** Merge nodes closer than `dist` (keeps junctions clean). */
export function mergeCloseNodes(g: Graph, dist: number): Graph {
  const parent = g.nodes.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (const e of g.edges) {
    if (e.dead) continue;
    if (dist2(g.nodes[e.a].p, g.nodes[e.b].p) < dist) {
      parent[find(e.a)] = find(e.b);
    }
  }
  const out = new Graph();
  const map = new Map<number, number>();
  const sums = new Map<number, [number, number, number]>();
  g.nodes.forEach((n, i) => {
    const r = find(i);
    const s = sums.get(r) ?? [0, 0, 0];
    s[0] += n.p[0];
    s[1] += n.p[1];
    s[2] += 1;
    sums.set(r, s);
  });
  const id = (i: number) => {
    const r = find(i);
    let m = map.get(r);
    if (m === undefined) {
      const s = sums.get(r)!;
      m = out.addNode([s[0] / s[2], s[1] / s[2]]);
      map.set(r, m);
    }
    return m;
  };
  for (const e of g.edges) {
    if (e.dead) continue;
    const a = id(e.a);
    const b = id(e.b);
    if (a !== b) out.addEdge(a, b, e.kind);
  }
  return out;
}

/** Remove dead-end edges repeatedly. */
export function pruneDeadEnds(g: Graph) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let n = 0; n < g.nodes.length; n++) {
      const live = g.liveEdges(n);
      if (live.length === 1) {
        g.removeEdge(live[0]);
        changed = true;
      }
    }
  }
}

/** Remove edges whose endpoints make a very sharp angle with a sibling (slivers). */
export function removeSlivers(g: Graph, minAngle: number) {
  for (let n = 0; n < g.nodes.length; n++) {
    const live = g.liveEdges(n);
    if (live.length < 2) continue;
    const dirs = live.map(e => {
      const q = g.nodes[g.other(e, n)].p;
      const p = g.nodes[n].p;
      return Math.atan2(q[1] - p[1], q[0] - p[0]);
    });
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        let d = Math.abs(dirs[i] - dirs[j]);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d < minAngle) {
          // Drop the lower-class (or shorter) edge.
          const ei = g.edges[live[i]];
          const ej = g.edges[live[j]];
          const li = dist2(g.nodes[ei.a].p, g.nodes[ei.b].p);
          const lj = dist2(g.nodes[ej.a].p, g.nodes[ej.b].p);
          const drop =
            ei.kind !== ej.kind
              ? ei.kind < ej.kind
                ? live[i]
                : live[j]
              : li < lj
                ? live[j]
                : live[i];
          g.removeEdge(drop);
        }
      }
    }
  }
}

export interface Face {
  /** Node ids around the face, counter-clockwise. */
  nodes: number[];
  /** Edge ids: edges[i] connects nodes[i] -> nodes[i+1]. */
  edges: number[];
  area: number;
}

/** Extract bounded faces (counter-clockwise) from a planar graph. */
export function extractFaces(g: Graph, maxArea = Infinity): Face[] {
  // Sort outgoing edges by angle at each node.
  const sorted: number[][] = g.nodes.map((node, n) => {
    const live = g.liveEdges(n);
    return live
      .map(e => {
        const q = g.nodes[g.other(e, n)].p;
        return {e, a: Math.atan2(q[1] - node.p[1], q[0] - node.p[0])};
      })
      .sort((x, y) => x.a - y.a)
      .map(x => x.e);
  });
  const visited = new Set<string>();
  const faces: Face[] = [];
  for (let e = 0; e < g.edges.length; e++) {
    if (g.edges[e].dead) continue;
    for (const [from, to] of [
      [g.edges[e].a, g.edges[e].b],
      [g.edges[e].b, g.edges[e].a],
    ]) {
      if (visited.has(`${from}>${to}`)) continue;
      const nodes: number[] = [];
      const edges: number[] = [];
      let u = from;
      let v = to;
      let edge = e;
      let ok = true;
      for (let guard = 0; guard < 10000; guard++) {
        const key = `${u}>${v}`;
        if (visited.has(key)) {
          ok = u === from && v === to;
          break;
        }
        visited.add(key);
        nodes.push(u);
        edges.push(edge);
        // At v, take the next edge clockwise from the edge back to u
        // (that traces the face on the left of u->v).
        const list = sorted[v];
        const idx = list.indexOf(edge);
        const next = list[(idx - 1 + list.length) % list.length];
        u = v;
        v = g.other(next, u);
        edge = next;
      }
      if (!ok || nodes.length < 3) continue;
      const poly = nodes.map(n => g.nodes[n].p);
      const area = polygonArea(poly);
      if (area > 1 && area < maxArea) faces.push({nodes, edges, area});
    }
  }
  return faces;
}

/** Chains of edges through degree-2 nodes (polylines between junctions). */
export interface Chain {
  nodes: number[];
  edges: number[];
  kind: number;
}

export function buildChains(g: Graph): Chain[] {
  const used = new Set<number>();
  const chains: Chain[] = [];
  const isJunction = (n: number) => g.degree(n) !== 2;
  const walk = (start: number, firstEdge: number) => {
    const nodes = [start];
    const edges: number[] = [];
    let n = start;
    let e = firstEdge;
    const kind = g.edges[e].kind;
    for (;;) {
      used.add(e);
      edges.push(e);
      n = g.other(e, n);
      nodes.push(n);
      if (isJunction(n) || n === start) break;
      const next = g.liveEdges(n).find(x => x !== e && !used.has(x));
      if (next === undefined || g.edges[next].kind !== kind) break;
      e = next;
    }
    chains.push({nodes, edges, kind});
  };
  for (let n = 0; n < g.nodes.length; n++) {
    if (!isJunction(n)) continue;
    for (const e of g.liveEdges(n)) if (!used.has(e)) walk(n, e);
  }
  // Also chains that end at kind changes on degree-2 nodes, and closed loops.
  for (let e = 0; e < g.edges.length; e++) {
    if (!g.edges[e].dead && !used.has(e)) walk(g.edges[e].a, e);
  }
  return chains;
}

/** Offset a closed CCW polygon inward by per-edge distances. Null if it collapses. */
export function insetPolygon(poly: Vec2[], dist: number[]): Vec2[] | null {
  interface Line {
    p: Vec2;
    d: Vec2;
    off: number;
  }
  let lines: Line[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const e = sub2(b, a);
    const l = Math.hypot(e[0], e[1]);
    if (l < 1e-6) continue;
    lines.push({p: a, d: [e[0] / l, e[1] / l], off: dist[i]});
  }
  const meet = (A: Line, B: Line, offset: boolean): Vec2 => {
    const pa: Vec2 = offset
      ? [A.p[0] - A.d[1] * A.off, A.p[1] + A.d[0] * A.off]
      : A.p;
    const pb: Vec2 = offset
      ? [B.p[0] - B.d[1] * B.off, B.p[1] + B.d[0] * B.off]
      : B.p;
    const den = cross2(A.d, B.d);
    if (Math.abs(den) < 0.08) return pb;
    const t = cross2(sub2(pb, pa), B.d) / den;
    return [pa[0] + A.d[0] * t, pa[1] + A.d[1] * t];
  };
  for (let iter = 0; iter < 24; iter++) {
    const n = lines.length;
    if (n < 3) return null;
    const base: Vec2[] = [];
    const out: Vec2[] = [];
    for (let k = 0; k < n; k++) {
      const prev = lines[(k - 1 + n) % n];
      base.push(meet(prev, lines[k], false));
      out.push(meet(prev, lines[k], true));
    }
    // Find the most inverted edge (offset edge pointing against its line).
    let worst = -1;
    let worstVal = 0;
    for (let k = 0; k < n; k++) {
      const e1 = sub2(out[(k + 1) % n], out[k]);
      const along = e1[0] * lines[k].d[0] + e1[1] * lines[k].d[1];
      if (along < 0.5 && 0.5 - along > worstVal) {
        worstVal = 0.5 - along;
        worst = k;
      }
    }
    if (worst < 0) {
      const a0 = polygonArea(base);
      const a1 = polygonArea(out);
      return a1 > 0 && a1 < a0 ? out : null;
    }
    lines = lines.filter((_, k) => k !== worst);
  }
  return null;
}
