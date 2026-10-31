// Nearest-first selection for the per-frame light list (world/city.ts).

/**
 * Indices of the `n` smallest of d[0..count), in ascending order (ties in
 * index order, as a stable sort of all of them would give), without sorting
 * the whole candidate list: a quickselect finds the n-th distance first.
 */
export function nearestFirst(d: Float64Array, count: number, n: number) {
  let idx: number[] = [];
  if (n <= 0) return idx;
  if (count <= n) {
    for (let i = 0; i < count; i++) idx.push(i);
  } else {
    const tmp = d.slice(0, count);
    const t = select(tmp, n - 1);
    let below = 0;
    for (let i = 0; i < count; i++) if (d[i] < t) below++;
    let ties = n - below;
    for (let i = 0; i < count; i++) {
      if (d[i] < t) idx.push(i);
      else if (d[i] === t && ties > 0) {
        idx.push(i);
        ties--;
      }
    }
  }
  idx.sort((a, b) => d[a] - d[b] || a - b);
  idx = idx.slice(0, n);
  return idx;
}

/** k-th smallest value of a (reorders a). */
function select(a: Float64Array, k: number) {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const x = a[i];
        a[i] = a[j];
        a[j] = x;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}
