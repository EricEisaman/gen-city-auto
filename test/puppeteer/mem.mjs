// Memory budget: GPU bytes by category (src/gpu/memtrack.ts) at ready and at
// the peak during load, JS heap of the page and of every worker (peak during
// load and at ready), and the peak RSS of the renderer and GPU processes.
//   node build.mjs && node test/puppeteer/mem.mjs [query] [--json out.json] [--timeline]
// --timeline: every ~250 ms the renderer's RSS and footprint, the GPU
// process's footprint, each context's JS heap + buffers and the loading
// label, then what runs at the peaks.
// e.g. node test/puppeteer/mem.mjs "city=neon&seed=1&cores=2"
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {sleep, withServer} from './harness.mjs';

const args = process.argv.slice(2);
// --timeline: print renderer footprint and heap sum at every sample.
const timeline = args.includes('--timeline');
if (timeline) args.splice(args.indexOf('--timeline'), 1);
const ji = args.indexOf('--json');
const jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
const query = args[0] ?? 'city=neon&seed=1';

/** RSS (MB) of the browser's renderer and GPU processes. */
function rssByType(root) {
  return new Promise(res =>
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,rss=,command='],
      {maxBuffer: 1 << 24},
      (err, out) => {
        const r = {renderer: 0, gpu: 0, pids: {}};
        if (err) return res(r);
        const kids = new Map();
        for (const l of out.trim().split('\n')) {
          const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
          if (!m) continue;
          const [pid, ppid, rss] = [m[1], m[2], m[3]].map(Number);
          if (!kids.has(ppid)) kids.set(ppid, []);
          kids.get(ppid).push([pid, rss, m[4]]);
        }
        const walk = p => {
          for (const [pid, rss, cmd] of kids.get(p) ?? []) {
            if (/--type=renderer/.test(cmd) && rss / 1024 > r.renderer) {
              r.renderer = rss / 1024;
              r.pids.renderer = pid;
            }
            if (/--type=gpu-process/.test(cmd)) {
              r.gpu = Math.max(r.gpu, rss / 1024);
              r.pids.gpu = pid;
            }
            walk(pid);
          }
        };
        walk(root);
        res(r);
      },
    ),
  );
}

/**
 * Physical footprint (MB; what iOS's jetsam limits; RSS also counts the
 * ~1.5 GB of Chrome framework code pages shared with every process) of the
 * given processes, from top.
 */
function footprint(pids) {
  const list = Object.entries(pids);
  if (!list.length) return Promise.resolve({});
  const args = ['-l', '1', '-stats', 'pid,mem'];
  for (const [, pid] of list) args.push('-pid', String(pid));
  return new Promise(res =>
    execFile('top', args, (err, out) => {
      const r = {};
      if (err) return res(r);
      const unit = {K: 1 / 1024, M: 1, G: 1024};
      for (const l of out.split('\n')) {
        const m = l.trim().match(/^(\d+)\s+([\d.]+)([KMG])/);
        if (!m) continue;
        const name = list.find(([, pid]) => pid === Number(m[1]))?.[0];
        if (name) r[name] = Number(m[2]) * unit[m[3]];
      }
      res(r);
    }),
  );
}

const MB = b => (b / (1 << 20)).toFixed(1);

await withServer(async base => {
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 300000,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({width: 1280, height: 720});
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    let poolFull = 0;
    page.on('console', e => {
      if (/cluster pool full/.test(e.text())) poolFull++;
    });
    const pid = browser.process().pid;
    const peakRss = {renderer: 0, gpu: 0};
    const peakFoot = {renderer: 0, gpu: 0};
    const heap = new Map(); // name -> {peak, last}
    // JS heap plus ArrayBuffer backing stores (typed arrays live outside it).
    const note = (name, u) => {
      const used = u.usedSize + (u.backingStorageSize ?? 0);
      const h = heap.get(name) ?? {peak: 0, last: 0};
      h.peak = Math.max(h.peak, used);
      h.last = used;
      heap.set(name, h);
    };
    const mainCdp = await page.createCDPSession();
    let done = false;
    const samples = [];
    let tStart = Date.now();
    // Three independent loops (a busy worker answers CDP only between
    // tasks, and top takes about a second): RSS and the loading label every
    // 200 ms, physical footprint as fast as top allows, and heap queries
    // (at most one in flight per context) whose last answer each row uses.
    let lastFoot = {};
    let pids = {};
    const live = new Map(); // name -> last sample time (ms)
    const inflight = new Set();
    const names = new WeakMap();
    const ask = async (key, fn) => {
      if (inflight.has(key)) return;
      inflight.add(key);
      try {
        await fn();
      } catch {
        /* navigating or worker gone */
      } finally {
        inflight.delete(key);
      }
    };
    const heaps = () => {
      void ask('main', async () => {
        note('main', await mainCdp.send('Runtime.getHeapUsage'));
        live.set('main', Date.now());
      });
      for (const w of page.workers())
        void ask(w, async () => {
          if (!names.has(w))
            names.set(w, await w.evaluate(() => self.name || 'worker'));
          const name = names.get(w);
          note(name, await w.client.send('Runtime.getHeapUsage'));
          live.set(name, Date.now());
        });
    };
    const footLoop = (async () => {
      while (!done) {
        const f = await footprint(pids);
        lastFoot = f;
        for (const k of ['renderer', 'gpu'])
          peakFoot[k] = Math.max(peakFoot[k], f[k] ?? 0);
        await sleep(50);
      }
    })();
    const poll = (async () => {
      while (!done) {
        const r = await rssByType(pid);
        pids = r.pids;
        peakRss.renderer = Math.max(peakRss.renderer, r.renderer);
        peakRss.gpu = Math.max(peakRss.gpu, r.gpu);
        heaps();
        if (timeline) {
          // Contexts heard from in the last 5 s (terminated workers drop).
          let sum = 0;
          const per = [];
          for (const [name, h] of heap) {
            if (Date.now() - (live.get(name) ?? 0) > 5000) continue;
            sum += h.last;
            per.push(
              `${name.replace(/-worker-?/, '')}:${Math.round(h.last / 1048576)}`,
            );
          }
          const label = await Promise.race([
            page
              .evaluate(() => {
                const l = document.getElementById('loading');
                return l && l.style.display !== 'none'
                  ? (document.getElementById('loadmsg')?.textContent ?? '')
                  : 'game';
              })
              .catch(() => ''),
            sleep(150).then(() => '(main busy)'),
          ]);
          samples.push({
            t: Date.now() - tStart,
            rss: Math.round(r.renderer),
            renderer: Math.round(lastFoot.renderer ?? 0),
            gpu: Math.round(lastFoot.gpu ?? 0),
            heap: Math.round(sum / 1048576),
            label,
            per: per.join(' '),
          });
        }
        await sleep(200);
      }
      await footLoop;
    })();
    const t0 = Date.now();
    tStart = t0;
    await page.goto(`${base}/index.html?${query}`);
    let ready = false;
    while (Date.now() - t0 < 240000) {
      const s = await page.evaluate(() => ({
        r: window.__ready,
        e: (window.__errors || []).length,
      }));
      if (s.r || s.e || errs.length) {
        ready = s.r;
        break;
      }
      await sleep(250);
    }
    await sleep(3000);
    done = true;
    await poll;
    // Retained memory: the same after a forced GC in every context.
    const retained = new Map();
    const usage = async cdp => {
      await cdp.send('HeapProfiler.collectGarbage');
      const u = await cdp.send('Runtime.getHeapUsage');
      return u.usedSize + (u.backingStorageSize ?? 0);
    };
    retained.set('main', await usage(mainCdp).catch(() => 0));
    for (const w of page.workers()) {
      try {
        const name = await w.evaluate(() => self.name || 'worker');
        retained.set(name, await usage(w.client));
      } catch {
        /* worker gone */
      }
    }
    const rssAfterGc = await rssByType(pid);
    const footAfterGc = await footprint(rssAfterGc.pids);
    const gpu = await page.evaluate(() => window.__gpuMem?.());
    const stats = await page.evaluate(() => window.__stats);
    const errors = [
      ...errs,
      ...(await page.evaluate(() => window.__errors || [])),
    ];
    const loadS = (Date.now() - t0) / 1000;
    console.log(`?${query}  ready ${ready}  load+3s ${loadS.toFixed(1)} s`);
    if (errors.length) console.log('errors:', errors.join('\n').slice(0, 2000));
    if (gpu) {
      const cats = [
        ...new Set([
          ...Object.keys(gpu.byCategory),
          ...Object.keys(gpu.peakByCategory),
        ]),
      ].sort((a, b) => (gpu.byCategory[b] ?? 0) - (gpu.byCategory[a] ?? 0));
      console.log('\nGPU memory (MB)        ready   at peak');
      for (const c of cats)
        console.log(
          `  ${c.padEnd(20)} ${MB(gpu.byCategory[c] ?? 0).padStart(7)} ${MB(gpu.peakByCategory[c] ?? 0).padStart(9)}`,
        );
      console.log(
        `  ${'TOTAL'.padEnd(20)} ${MB(gpu.total).padStart(7)} ${MB(gpu.peak).padStart(9)}`,
      );
      const pool = [
        'verts',
        'vertsTop',
        'tris',
        'trisTop',
        'clusters',
        'clustersTop',
      ].map(k => `${k} ${stats[k]}`);
      console.log(
        `  pool use: ${pool.join(', ')}; pool-full drops ${poolFull}`,
      );
      console.log('\nLargest GPU resources (MB):');
      for (const e of gpu.top.slice(0, 20))
        console.log(`  ${MB(e.bytes).padStart(8)}  ${e.label}  (${e.desc})`);
    }
    console.log('\nJS heap + array buffers (MB)  ready     peak  after GC');
    let sumLast = 0;
    let sumPeak = 0;
    let sumGc = 0;
    for (const [name, h] of [...heap].sort()) {
      const g = retained.get(name) ?? 0;
      sumLast += h.last;
      sumPeak += h.peak;
      sumGc += g;
      console.log(
        `  ${name.padEnd(20)} ${MB(h.last).padStart(12)} ${MB(h.peak).padStart(8)} ${MB(g).padStart(9)}`,
      );
    }
    console.log(
      `  ${'SUM'.padEnd(20)} ${MB(sumLast).padStart(12)} ${MB(sumPeak).padStart(8)} ${MB(sumGc).padStart(9)}  (peaks need not coincide)`,
    );
    const G = v => ((v ?? 0) / 1024).toFixed(2);
    console.log(
      `\nPeak footprint: renderer ${G(peakFoot.renderer)} GB, GPU process ${G(peakFoot.gpu)} GB; renderer after GC ${G(footAfterGc.renderer)} GB`,
    );
    console.log(
      `Peak RSS: renderer ${(peakRss.renderer / 1024).toFixed(2)} GB, GPU process ${(peakRss.gpu / 1024).toFixed(2)} GB; renderer after GC ${(rssAfterGc.renderer / 1024).toFixed(2)} GB`,
    );
    if (timeline) {
      // Sample times on the page's clock, to match the startup spans.
      const st = await page.evaluate(() => ({
        origin: performance.timeOrigin,
        spans: window.__startup?.spans ?? [],
      }));
      for (const r of samples) r.t = (tStart + r.t - st.origin) / 1000;
      console.log(
        '\nTimeline (MB): renderer RSS / renderer footprint / GPU process footprint, JS heap + buffers of the live contexts, loading label, per context',
      );
      for (const r of samples)
        console.log(
          `${r.t.toFixed(1).padStart(5)}s ${String(r.rss).padStart(5)} ${String(r.renderer).padStart(5)} ${String(r.gpu).padStart(5)} ${String(r.heap).padStart(5)}  ${r.label.padEnd(30).slice(0, 30)} ${r.per}`,
        );
      // What runs at the peaks (startup spans >= 100 ms).
      const at = (what, key) => {
        const top = samples.reduce((a, b) => (b[key] > a[key] ? b : a));
        const ms = top.t * 1000;
        console.log(
          `\nAt the ${what} peak (${top[key]} MB, ${top.t.toFixed(1)} s): ${top.per}`,
        );
        const seen = new Set();
        for (const x of st.spans)
          if (
            x.start <= ms &&
            x.end >= ms &&
            x.end - x.start >= 100 &&
            !seen.has(x.name + x.start) &&
            seen.add(x.name + x.start)
          )
            console.log(
              `  ${x.track.padEnd(10)} ${x.name}  (${(x.start / 1000).toFixed(1)}-${(x.end / 1000).toFixed(1)} s)`,
            );
      };
      if (samples.length) {
        at('renderer RSS', 'rss');
        at('JS heap + buffers (sum of the contexts)', 'heap');
      }
    }
    if (jsonOut)
      fs.writeFileSync(
        jsonOut,
        JSON.stringify(
          {
            query,
            ready,
            gpu,
            stats,
            heap: Object.fromEntries(heap),
            retained: Object.fromEntries(retained),
            peakRss,
            rssAfterGc,
            peakFoot,
            footAfterGc,
            errors,
            samples,
          },
          null,
          1,
        ),
      );
  } finally {
    await browser.close();
  }
});
