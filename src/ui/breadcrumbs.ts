// Crash breadcrumbs: a page killed for memory (iOS reloads the tab) leaves no
// console and no diag panel behind. While loading and for the first 30 s of
// play, a small record (loading label, time, memory estimates) is saved to
// localStorage every half second; a clean exit (leaving the page, or 30 s of
// play) marks it finished. The next load finds an unfinished record, says so
// in the console and keeps it for the ?diag=1 panel (diag.ts).

interface Crumb {
  /** Loading-screen label, or 'game'. */
  label: string;
  /** Seconds since navigation start. */
  t: number;
  /** Wall clock (ms), to say how long ago. */
  at: number;
  /** Seconds since the game was ready (in play). */
  play?: number;
  /** GPU memory allocated (MB, gpu/memtrack.ts). */
  gpu?: number;
  /** JS heap (MB; performance.memory, Chromium only). */
  heap?: number;
  url?: string;
  clean?: boolean;
}

const KEY = 'gca.crumb';
/** The last unfinished record, kept until a newer one replaces it. */
const LOST = 'gca.crumb.lost';
const PLAY_S = 30;

function read(key: string): Crumb | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as Crumb) : null;
  } catch {
    return null;
  }
}

function write(key: string, c: Crumb) {
  try {
    localStorage.setItem(key, JSON.stringify(c));
  } catch {
    // (Storage off, full or private: no breadcrumbs.)
  }
}

const MB = (b: number) => Math.round(b / 2 ** 20);

export class Breadcrumbs {
  /** The latest load that ended unexpectedly, if any. */
  readonly lost: Crumb | null;
  /** That load was the one just before this one. */
  readonly lastLoad: boolean;
  private done = false;
  private label: () => string;

  constructor(label: () => string) {
    this.label = label;
    const prev = read(KEY);
    this.lastLoad = !!prev && !prev.clean;
    if (this.lastLoad) write(LOST, prev!);
    this.lost = this.lastLoad ? prev : read(LOST);
    const note = this.note();
    if (note && this.lastLoad) console.warn(`[diag] ${note}`);
    this.tick();
    setInterval(() => this.tick(), 500);
    // (Leaving or reloading the page; a killed one never gets here.)
    addEventListener('pagehide', () => this.finish());
  }

  /** The note for the diag panel, or null. */
  note(): string | null {
    const c = this.lost;
    if (!c) return null;
    const where =
      c.play !== undefined
        ? `${c.play.toFixed(1)} s into play`
        : `during "${c.label}" at ${c.t.toFixed(1)} s`;
    const mem = [
      c.gpu !== undefined ? `gpu ${c.gpu} MB` : '',
      c.heap !== undefined ? `js heap ${c.heap} MB` : '',
    ].filter(Boolean);
    const ago = Math.round((Date.now() - c.at) / 60000);
    return (
      `${this.lastLoad ? 'previous load' : 'an earlier load'} ended unexpectedly ${where}` +
      (mem.length ? ` (${mem.join(', ')})` : '') +
      (this.lastLoad ? '' : `, ${ago} min ago`)
    );
  }

  private tick() {
    if (this.done) return;
    const t = performance.now() / 1000;
    const st = window.__startup;
    const play = st?.done ? t - (st.total ?? 0) / 1000 : undefined;
    if (play !== undefined && play > PLAY_S) {
      this.finish();
      return;
    }
    const c: Crumb = {label: this.label(), t, at: Date.now(), play};
    try {
      const g = window.__gpuMem?.();
      if (g) c.gpu = MB(g.total);
      const m = (performance as {memory?: {usedJSHeapSize: number}}).memory;
      if (m) c.heap = MB(m.usedJSHeapSize);
    } catch {
      // (Estimates only.)
    }
    c.url = location.search.slice(0, 120);
    write(KEY, c);
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    write(KEY, {
      label: this.label(),
      t: performance.now() / 1000,
      at: Date.now(),
      clean: true,
    });
  }
}
