// Diagnostics for devices without a console (phones).
//
// Always on: a heartbeat that notices the main thread blocked for 400 ms
// or more (Safari has no long-task API) and records each block in the
// startup timeline as a 'stall' span, named after the loading-screen label
// shown when it started, e.g. a sync GPU call waiting on shader compiles.
//
// Always on too: crash breadcrumbs (breadcrumbs.ts); the panel says when the
// previous load ended unexpectedly, and where.
//
// ?diag=1 adds an on-screen panel to screenshot: the stalls, the GPU's
// queue latency (submit -> done, sampled every second: seconds there mean
// the GPU itself is stuck), frames drawn, device lost, errors, the device
// and adapter, and once loaded the startup timeline (the [startup] table
// of the console). 'Copy' puts the whole report on the clipboard.

import {lowMemory, cores} from '../caps.ts';
import {deviceLost} from '../gpu/device.ts';
import {Breadcrumbs} from './breadcrumbs.ts';

const params = new URLSearchParams(location.search);
export const diagOn = params.get('diag') === '1';

interface Stall {
  at: number;
  dur: number;
  during: string;
}

const now = () => performance.now();
const label = () => {
  const l = document.getElementById('loading');
  if (l && l.style.display !== 'none')
    return document.getElementById('loadmsg')?.textContent ?? 'loading';
  return 'game';
};

class Diag {
  readonly stalls: Stall[] = [];
  private beat = now();
  private beatLabel = 'start';
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private frames = 0;
  private lastFrame = 0;
  private frameMs = 0;
  private gpuLast = -1;
  private gpuMax = 0;
  private gpuSince = 0;
  private panel: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  /** Crash breadcrumbs (and the note about a load that ended badly). */
  private readonly crumbs = new Breadcrumbs(label);

  constructor() {
    setInterval(() => this.heartbeat(), 100);
    if (diagOn) {
      setInterval(() => this.probeGpu(), 1000);
      setInterval(() => this.draw(), 500);
    }
  }

  setGpu(adapter: GPUAdapter, device: GPUDevice) {
    this.adapter = adapter;
    this.device = device;
  }

  /** Once per drawn frame (main.ts), with the CPU time of game.frame. */
  frame(cpuMs: number) {
    this.frames++;
    this.lastFrame = now();
    this.frameMs = this.frameMs ? this.frameMs * 0.9 + cpuMs * 0.1 : cpuMs;
  }

  private heartbeat() {
    const t = now();
    const gap = t - this.beat;
    // (Timers slow down in a hidden tab: not a stall.)
    if (gap >= 400 && document.visibilityState === 'visible') {
      const s = {at: this.beat, dur: gap, during: this.beatLabel};
      this.stalls.push(s);
      if (this.stalls.length > 200) this.stalls.shift();
      // (Into the startup table while it is open; timeline.ts.)
      if (!window.__startup.done)
        window.__startup.spans.push({
          name: `main thread blocked (during "${s.during}")`,
          start: s.at,
          end: t,
          track: 'stall',
        });
    }
    this.beat = t;
    this.beatLabel = label();
  }

  /** Submit -> done latency of the GPU queue (one probe in flight). */
  private probeGpu() {
    const d = this.device;
    if (!d || this.gpuSince) return;
    const t0 = (this.gpuSince = now());
    void d.queue.onSubmittedWorkDone().then(() => {
      this.gpuLast = now() - t0;
      this.gpuMax = Math.max(this.gpuMax, this.gpuLast);
      this.gpuSince = 0;
    });
  }

  /** The report as text (the panel and Copy). */
  report(): string {
    const t = now();
    const f1 = (v: number) => (v / 1000).toFixed(1);
    const lines: string[] = [];
    const st = window.__startup;
    lines.push(
      `t ${f1(t)} s · ${label()} · frames ${this.frames}` +
        (this.frames
          ? ` (last ${f1(t - this.lastFrame)} s ago, cpu ${this.frameMs.toFixed(1)} ms)`
          : '') +
        (st.done ? ` · ready at ${f1(st.total ?? 0)} s` : ''),
    );
    const lost = this.crumbs.note();
    if (lost) lines.push(lost.toUpperCase().slice(0, 1) + lost.slice(1));
    const s = window.__stats as {fps?: number; render?: string};
    const game = (window as unknown as {__game?: {renderer?: {gpuMs?: number}}})
      .__game;
    const gpuBusy = this.gpuSince ? t - this.gpuSince : 0;
    lines.push(
      `fps ${s.fps ?? '-'} · render ${s.render ?? '-'} · gpu ${game?.renderer?.gpuMs?.toFixed(1) ?? '-'} ms` +
        ` · queue latency ${this.gpuLast < 0 ? '-' : this.gpuLast.toFixed(0)} ms (max ${this.gpuMax.toFixed(0)})` +
        (gpuBusy > 1500 ? ` · GPU BUSY ${f1(gpuBusy)} s` : ''),
    );
    const mem = window.__gpuMem?.();
    if (mem)
      lines.push(
        `gpu memory ${(mem.total / 2 ** 20).toFixed(0)} MB (peak ${(mem.peak / 2 ** 20).toFixed(0)})`,
      );
    if (deviceLost)
      lines.push(
        `DEVICE LOST: ${deviceLost.reason ?? 'unknown'}: ${deviceLost.message}`,
      );
    const errs = window.__errors;
    if (errs.length) {
      lines.push(`errors ${errs.length}:`);
      for (const e of errs.slice(0, 8)) lines.push('  ' + e.slice(0, 300));
    }
    if (this.stalls.length) {
      lines.push(`main thread blocked >= 0.4 s: ${this.stalls.length}`);
      for (const x of [...this.stalls]
        .sort((a, b) => b.dur - a.dur)
        .slice(0, 8))
        lines.push(`  ${f1(x.at)} s +${f1(x.dur)} s during "${x.during}"`);
    }
    const info = (this.adapter as {info?: GPUAdapterInfo} | null)?.info;
    lines.push(
      `${navigator.userAgent}`,
      `screen ${screen.width}x${screen.height} dpr ${devicePixelRatio} · lowmem ${lowMemory()} · cores ${cores()}`,
    );
    if (info)
      lines.push(
        `adapter ${[info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || '(no info)'}`,
      );
    if (this.device)
      lines.push(`features ${[...this.device.features].join(' ')}`);
    if (st.done) {
      lines.push('startup (ms: start dur track phase), spans >= 50 ms:');
      const keep = [...st.spans]
        .filter(
          x =>
            x.end - x.start >= 50 &&
            !x.name.startsWith('pipeline ') &&
            !x.name.startsWith('shader info'),
        )
        .sort((a, b) => a.start - b.start);
      for (const x of keep)
        lines.push(
          `${x.start.toFixed(0).padStart(6)} ${(x.end - x.start).toFixed(0).padStart(6)} ${x.track.padEnd(9)} ${x.name}`,
        );
      const pipes = st.spans.filter(x => x.name.startsWith('pipeline '));
      if (pipes.length) {
        const last = Math.max(...pipes.map(x => x.end));
        const first = Math.min(...pipes.map(x => x.start));
        lines.push(
          `pipelines: ${pipes.length}, all done ${(last - first).toFixed(0)} ms after the first started`,
        );
      }
    }
    return lines.join('\n');
  }

  private draw() {
    if (!this.panel) this.build();
    if (this.body && this.body.style.display !== 'none')
      this.body.textContent = this.report();
  }

  private build() {
    const p = document.createElement('div');
    p.id = 'diag';
    const bar = document.createElement('div');
    bar.className = 'diag-bar';
    const btn = (text: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.addEventListener('click', e => {
        e.stopPropagation();
        fn();
      });
      bar.append(b);
      return b;
    };
    const body = document.createElement('pre');
    btn('diag ▾', () => {
      body.style.display = body.style.display === 'none' ? '' : 'none';
    });
    const copy = btn('copy', () => {
      void navigator.clipboard?.writeText(this.report()).then(
        () => (copy.textContent = 'copied'),
        () => (copy.textContent = 'copy failed'),
      );
    });
    p.append(bar, body);
    document.body.append(p);
    this.panel = p;
    this.body = body;
  }
}

export const diag = new Diag();
