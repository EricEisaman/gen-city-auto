// Device capabilities that size the worker pools and memory budgets, with URL
// overrides for testing: ?cores=N (logical cores), ?lowmem=1|0, ?serial=1|0.

const params = new URLSearchParams(
  typeof location === 'undefined' ? '' : location.search,
);

/** Logical cores (navigator.hardwareConcurrency, or ?cores=). */
export function cores(): number {
  const o = Number(params.get('cores'));
  if (o >= 1) return Math.floor(o);
  return navigator.hardwareConcurrency || 4;
}

/**
 * A device to treat as short of memory: phones and tablets (which kill a
 * tab well before a desktop would page) and anything reporting 4 GB or less
 * (navigator.deviceMemory, Chromium only), or ?lowmem=1.
 */
export function lowMemory(): boolean {
  const o = params.get('lowmem');
  if (o !== null) return o === '1';
  const mem = (navigator as Navigator & {deviceMemory?: number}).deviceMemory;
  if (mem !== undefined && mem <= 4) return true;
  // iPadOS reports a desktop user agent; its touch points give it away.
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod|Android|Mobile/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

/**
 * Load the city in memory-saving order (world/city.ts load): fewer city
 * workers, and the base build and the tiles one after another instead of
 * overlapping the vehicle and texture workers and each other. Slower to
 * load; on with lowMemory(), or ?serial=1|0.
 */
export function serialLoad(): boolean {
  const o = params.get('serial');
  if (o !== null) return o === '1';
  return lowMemory();
}
