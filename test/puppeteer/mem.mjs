// Memory budget: GPU bytes by category (src/gpu/memtrack.ts) at ready and at
// the peak during load, JS heap of the page and of every worker (peak during
// load and at ready), and the peak RSS of the renderer and GPU processes.
//   node build.mjs && node test/puppeteer/mem.mjs [query] [--json out.json]
// e.g. node test/puppeteer/mem.mjs "city=neon&seed=1&cores=2"
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {sleep, withServer} from './harness.mjs';

const args = process.argv.slice(2);
const ji = args.indexOf('--json');
const jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
const query = args[0] ?? 'city=neon&seed=1';

/** RSS (MB) of the browser's renderer and GPU processes. */
function rssByType(root) {
  return new Promise(res =>
    execFile('ps', ['-axo', 'pid=,ppid=,rss=,command='], {maxBuffer: 1 << 24}, (err, out) => {
      const r = {renderer: 0, gpu: 0};
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
          if (/--type=renderer/.test(cmd)) r.renderer = Math.max(r.renderer, rss / 1024);
          if (/--type=gpu-process/.test(cmd)) r.gpu = Math.max(r.gpu, rss / 1024);
          walk(pid);
        }
      };
      walk(root);
      res(r);
    }),
  );
}

const MB = b => (b / (1 << 20)).toFixed(1);

await withServer(async base => {
  const browser = await puppeteer.launch({headless: true, protocolTimeout: 300000});
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
    const poll = (async () => {
      while (!done) {
        const r = await rssByType(pid);
        peakRss.renderer = Math.max(peakRss.renderer, r.renderer);
        peakRss.gpu = Math.max(peakRss.gpu, r.gpu);
        try {
          note('main', await mainCdp.send('Runtime.getHeapUsage'));
        } catch {
          /* navigating */
        }
        await Promise.all(
          page.workers().map(async w => {
            try {
              const u = await w.client.send('Runtime.getHeapUsage');
              const name = await w.evaluate(() => self.name || 'worker');
              note(name, u);
            } catch {
              /* worker gone */
            }
          }),
        );
        await sleep(300);
      }
    })();
    const t0 = Date.now();
    await page.goto(`${base}/index.html?${query}`);
    let ready = false;
    while (Date.now() - t0 < 240000) {
      const s = await page.evaluate(() => ({r: window.__ready, e: (window.__errors || []).length}));
      if (s.r || s.e || errs.length) {
        ready = s.r;
        break;
      }
      await sleep(250);
    }
    await sleep(3000);
    done = true;
    await poll;
    const gpu = await page.evaluate(() => window.__gpuMem?.());
    const stats = await page.evaluate(() => window.__stats);
    const errors = [...errs, ...(await page.evaluate(() => window.__errors || []))];
    const loadS = (Date.now() - t0) / 1000;
    console.log(`?${query}  ready ${ready}  load+3s ${loadS.toFixed(1)} s`);
    if (errors.length) console.log('errors:', errors.join('\n').slice(0, 2000));
    if (gpu) {
      const cats = [...new Set([...Object.keys(gpu.byCategory), ...Object.keys(gpu.peakByCategory)])].sort(
        (a, b) => (gpu.byCategory[b] ?? 0) - (gpu.byCategory[a] ?? 0),
      );
      console.log('\nGPU memory (MB)        ready   at peak');
      for (const c of cats)
        console.log(`  ${c.padEnd(20)} ${MB(gpu.byCategory[c] ?? 0).padStart(7)} ${MB(gpu.peakByCategory[c] ?? 0).padStart(9)}`);
      console.log(`  ${'TOTAL'.padEnd(20)} ${MB(gpu.total).padStart(7)} ${MB(gpu.peak).padStart(9)}`);
      const pool = ['verts', 'vertsTop', 'tris', 'trisTop', 'clusters', 'clustersTop'].map(k => `${k} ${stats[k]}`);
      console.log(`  pool use: ${pool.join(', ')}; pool-full drops ${poolFull}`);
      console.log('\nLargest GPU resources (MB):');
      for (const e of gpu.top.slice(0, 20)) console.log(`  ${MB(e.bytes).padStart(8)}  ${e.label}  (${e.desc})`);
    }
    console.log('\nJS heap + array buffers (MB)  ready  peak');
    let sumLast = 0;
    let sumPeak = 0;
    for (const [name, h] of [...heap].sort()) {
      sumLast += h.last;
      sumPeak += h.peak;
      console.log(`  ${name.padEnd(20)} ${MB(h.last).padStart(7)} ${MB(h.peak).padStart(9)}`);
    }
    console.log(`  ${'SUM'.padEnd(20)} ${MB(sumLast).padStart(7)} ${MB(sumPeak).padStart(9)}  (peaks need not coincide)`);
    console.log(`\nPeak RSS: renderer ${(peakRss.renderer / 1024).toFixed(2)} GB, GPU process ${(peakRss.gpu / 1024).toFixed(2)} GB`);
    if (jsonOut)
      fs.writeFileSync(
        jsonOut,
        JSON.stringify({query, ready, gpu, stats, heap: Object.fromEntries(heap), peakRss, errors}, null, 1),
      );
  } finally {
    await browser.close();
  }
});
