// Startup timeline: every load phase as a performance.measure span (visible in
// the DevTools Performance panel), collected into window.__startup for
// scripts (test/puppeteer/startup.mjs) and printed to the console once the
// first frames are up. Times are ms since navigation start. Worker phases
// arrive as absolute times (timeOrigin + now) and are rebased here.

export interface Span {
  name: string;
  start: number;
  end: number;
  /** Track (main, gpu, worker N, ...) for the printed table. */
  track: string;
}

declare global {
  interface Window {
    __startup: {
      spans: Span[];
      longTasks: {start: number; dur: number}[];
      done: boolean;
      total?: number;
    };
  }
}

window.__startup = {spans: [], longTasks: [], done: false};

// Main-thread blocks of 50 ms or more (a page that cannot paint).
try {
  new PerformanceObserver(list => {
    if (window.__startup.done) return;
    for (const e of list.getEntries())
      window.__startup.longTasks.push({
        start: Math.round(e.startTime),
        dur: Math.round(e.duration),
      });
  }).observe({type: 'longtask', buffered: true});
} catch {
  // (longtask is Chromium only.)
}

const now = () => performance.now();

/** Record a finished span (ms since navigation start). */
export function addSpan(
  name: string,
  start: number,
  end: number,
  track = 'main',
) {
  window.__startup.spans.push({name, start, end, track});
  try {
    performance.measure(`${track}: ${name}`, {start, end});
  } catch {
    // (Bad times from a worker clock: keep the span, skip the measure.)
  }
}

/** Start a span; call the result to end it. */
export function begin(name: string, track = 'main') {
  const t = now();
  return () => addSpan(name, t, now(), track);
}

/** Time a synchronous call. */
export function timed<T>(name: string, fn: () => T, track = 'main'): T {
  const end = begin(name, track);
  try {
    return fn();
  } finally {
    end();
  }
}

/** Time a promise from now until it settles. */
export function timedAsync<T>(name: string, p: Promise<T>, track = 'main') {
  const end = begin(name, track);
  return p.finally(end);
}

/** A worker's absolute time (timeOrigin + now) on this page's clock. */
export function fromWorker(abs: number) {
  return abs - performance.timeOrigin;
}

/** Absolute clock for workers to send (see fromWorker). */
export function absNow() {
  return performance.timeOrigin + performance.now();
}

/** A zero-length marker. */
export function mark(name: string, track = 'main') {
  const t = now();
  addSpan(name, t, t, track);
}

/** Close the timeline and print it. */
export function finish() {
  const s = window.__startup;
  if (s.done) return;
  s.done = true;
  s.total = Math.round(now());
  const spans = [...s.spans].sort((a, b) => a.start - b.start);
  const lt = s.longTasks;
  const ltTotal = lt.reduce((a, b) => a + b.dur, 0);
  const ltMax = lt.reduce((a, b) => Math.max(a, b.dur), 0);
  const lines = spans.map(
    sp =>
      `${sp.start.toFixed(0).padStart(6)} ${(sp.end - sp.start).toFixed(0).padStart(6)} ms  ${sp.track.padEnd(10)} ${sp.name}`,
  );
  console.log(
    `[startup] ready at ${s.total} ms; main-thread long tasks: ${lt.length}, ${ltTotal} ms total, longest ${ltMax} ms\n` +
      '[startup]  start    dur      track      phase\n' +
      lines.map(l => `[startup] ${l}`).join('\n'),
  );
}

/** Work counted for the loading screen (n / N). */
export const counters = {
  pipelines: {done: 0, total: 0},
  vehicles: {done: 0, total: 0},
};

/** Track a create*PipelineAsync promise: timeline span and counter. */
export function pipeline<T>(name: string, p: Promise<T>): Promise<T> {
  counters.pipelines.total++;
  return timedAsync(`pipeline ${name}`, p, 'gpu').then(r => {
    counters.pipelines.done++;
    return r;
  });
}
