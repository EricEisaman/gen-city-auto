// Prompt release of big typed arrays.
//
// A dropped ArrayBuffer's memory comes back only when the garbage collector
// gets to it, and the city workers churn through hundreds of MB of mesh
// buffers (tile meshes, clusterize and pack copies, grown CMesh buffers):
// at load most of the renderer process was such garbage (neon seed 1: 4.1 GB
// of JS heap + array buffers across the page and its workers, 1.0 GB of it
// live). Detaching a buffer (ArrayBuffer.prototype.transfer(0)) frees its
// memory at once. Only for buffers nothing else views any more: every view
// of a released buffer reads as empty.

type Detachable = ArrayBuffer & {
  transfer?: (n: number) => ArrayBuffer;
  detached?: boolean;
};

/** Frees the buffers behind `arrays` now (no-op where unsupported). */
export function release(
  ...arrays: (ArrayBufferView | ArrayBuffer | null | undefined)[]
) {
  for (const a of arrays) {
    if (!a) continue;
    const b = (ArrayBuffer.isView(a) ? a.buffer : a) as Detachable;
    if (b instanceof ArrayBuffer && b.transfer && !b.detached && b.byteLength)
      b.transfer(0);
  }
}
