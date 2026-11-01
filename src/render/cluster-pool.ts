// GPU pool of city clusters: one big vertex buffer, triangle buffer and cluster
// table shared by every tile, with simple best-fit range allocators. The
// vertex buffer holds packed vertex words (city/vpack.ts), allocated in
// words.

import {CLUSTER_ALPHA, CLUSTER_WORDS, type ClusterData} from '../city/cmesh.ts';

class RangeAllocator {
  private free: [number, number][] = [];
  top = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  alloc(n: number): number {
    // Best fit: small shells (LOD1 / LOD2 swap in and out all the time) go
    // into small holes and leave the big ones for LOD0 tiles; first fit
    // scattered them through every hole until no LOD0 tile fit any more.
    let best = -1;
    for (let i = 0; i < this.free.length; i++) {
      const len = this.free[i][1];
      if (len >= n && (best < 0 || len < this.free[best][1])) best = i;
    }
    if (best >= 0) {
      const [start, len] = this.free[best];
      if (len === n) this.free.splice(best, 1);
      else this.free[best] = [start + n, len - n];
      return start;
    }
    if (this.top + n > this.capacity) return -1;
    const s = this.top;
    this.top += n;
    return s;
  }

  release(start: number, n: number) {
    this.free.push([start, n]);
    // Coalesce neighbors.
    this.free.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of this.free) {
      const last = merged[merged.length - 1];
      if (last && last[0] + last[1] === r[0]) last[1] += r[1];
      else merged.push([r[0], r[1]]);
    }
    const tail = merged[merged.length - 1];
    if (tail && tail[0] + tail[1] === this.top) {
      this.top = tail[0];
      merged.pop();
    }
    this.free = merged;
  }

  get used() {
    let f = 0;
    for (const r of this.free) f += r[1];
    return this.top - f;
  }
}

export interface PoolHandle {
  v: number;
  vn: number;
  t: number;
  tn: number;
  c: number;
  cn: number;
  /** Alpha-tested clusters among them (stats). */
  an?: number;
  /** Tile, LOD and bounds of the batch (renderer: shadow cache). */
  tile?: number;
  lod?: number;
  bounds?: [[number, number, number], [number, number, number]];
}

export class ClusterPool {
  /** Packed vertex words (vpack.ts). */
  readonly vertexBuffer: GPUBuffer;
  readonly triBuffer: GPUBuffer;
  readonly clusterBuffer: GPUBuffer;
  private verts: RangeAllocator;
  private tris: RangeAllocator;
  private clusters: RangeAllocator;
  readonly maxClusters: number;
  private device: GPUDevice;

  constructor(
    device: GPUDevice,
    maxWords: number,
    maxTris: number,
    maxClusters: number,
  ) {
    this.device = device;
    this.maxClusters = maxClusters;
    this.vertexBuffer = device.createBuffer({
      label: 'city/pool/vertices',
      size: maxWords * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.triBuffer = device.createBuffer({
      label: 'city/pool/triangles',
      size: maxTris * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.clusterBuffer = device.createBuffer({
      label: 'city/pool/clusters',
      size: maxClusters * CLUSTER_WORDS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.verts = new RangeAllocator(maxWords);
    this.tris = new RangeAllocator(maxTris);
    this.clusters = new RangeAllocator(maxClusters);
  }

  /** Number of cluster slots the cull pass must scan. */
  private alphaClusters = 0;

  get clusterHighWater() {
    return this.clusters.top;
  }

  get stats() {
    return {
      /** Vertex words. */
      verts: this.verts.used,
      tris: this.tris.used,
      clusters: this.clusters.used,
      vertsTop: this.verts.top,
      trisTop: this.tris.top,
      clustersTop: this.clusters.top,
      alphaClusters: this.alphaClusters,
    };
  }

  upload(d: ClusterData): PoolHandle | null {
    const vn = d.vertices.length;
    const tn = d.tris.length;
    const cn = d.clusterCount;
    if (cn === 0) return {v: 0, vn: 0, t: 0, tn: 0, c: 0, cn: 0};
    const v = this.verts.alloc(vn);
    const t = v < 0 ? -1 : this.tris.alloc(tn);
    const c = t < 0 ? -1 : this.clusters.alloc(cn);
    if (v < 0 || t < 0 || c < 0) {
      if (v >= 0) this.verts.release(v, vn);
      if (t >= 0) this.tris.release(t, tn);
      return null;
    }
    const cl = d.clusters.slice();
    let an = 0;
    for (let i = 0; i < cn; i++) {
      // (Word offset in the low 28 bits, vpack.ts; the pool is smaller.)
      cl[i * CLUSTER_WORDS + 4] += v;
      cl[i * CLUSTER_WORDS + 5] += t;
      if ((cl[i * CLUSTER_WORDS + 6] >>> 12) & CLUSTER_ALPHA) an++;
    }
    this.alphaClusters += an;
    const q = this.device.queue;
    q.writeBuffer(this.vertexBuffer, v * 4, d.vertices);
    q.writeBuffer(this.triBuffer, t * 4, d.tris);
    q.writeBuffer(this.clusterBuffer, c * CLUSTER_WORDS * 4, cl);
    return {v, vn, t, tn, c, cn, an};
  }

  free(h: PoolHandle) {
    if (h.cn === 0) return;
    this.alphaClusters -= h.an ?? 0;
    // Zero the cluster records so culling skips them.
    this.device.queue.writeBuffer(
      this.clusterBuffer,
      h.c * CLUSTER_WORDS * 4,
      new Uint32Array(h.cn * CLUSTER_WORDS),
    );
    this.verts.release(h.v, h.vn);
    this.tris.release(h.t, h.tn);
    this.clusters.release(h.c, h.cn);
  }
}
