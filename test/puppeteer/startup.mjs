// Startup timeline: load the game and print window.__startup (every load
// phase, see src/ui/timeline.ts) plus main-thread long tasks.
//   node build.mjs && node test/puppeteer/startup.mjs [query] [--runs=N] [--shot=ms] [--json]
// --shot=ms saves test/out/loading.png that many ms after navigation.
import {ensureDir, sleep, withServer} from './harness.mjs';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const opt = k => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const query = args.find(a => !a.startsWith('--')) ?? '';
const runs = Number(opt('runs') ?? 1);
const shotAt = opt('shot') ? Number(opt('shot')) : null;
const json = args.includes('--json');

await withServer(async base => {
  const totals = [];
  for (let run = 0; run < runs; run++) {
    const browser = await puppeteer.launch({headless: true, protocolTimeout: 180000});
    try {
      const page = await browser.newPage();
      await page.setViewport({width: 1280, height: 720});
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const t0 = Date.now();
      await page.goto(`${base}/index.html?${query}`);
      if (shotAt !== null) {
        await sleep(Math.max(0, shotAt - (Date.now() - t0)));
        await ensureDir('test/out');
        await page.screenshot({path: 'test/out/loading.png'});
        console.log('saved test/out/loading.png');
      }
      while (Date.now() - t0 < 180000) {
        const s = await page.evaluate(() => ({
          done: window.__startup?.done,
          errors: (window.__errors || []).length,
        }));
        if (s.done || s.errors || errors.length) break;
        await sleep(100);
      }
      const st = await page.evaluate(() => window.__startup);
      const errs = await page.evaluate(() => window.__errors || []);
      if (errs.length || errors.length) console.log('errors:', [...errs, ...errors].join('\n'));
      if (!st?.done) {
        console.log('startup never finished');
        continue;
      }
      totals.push(st.total);
      if (json) {
        console.log(JSON.stringify(st));
        continue;
      }
      const lt = st.longTasks;
      console.log(
        `run ${run + 1}: ready at ${st.total} ms; long tasks ${lt.length}, ` +
          `${lt.reduce((a, b) => a + b.dur, 0)} ms total, longest ${Math.max(0, ...lt.map(l => l.dur))} ms`,
      );
      if (runs === 1 || run === 0) {
        for (const sp of [...st.spans].sort((a, b) => a.start - b.start))
          console.log(
            `${sp.start.toFixed(0).padStart(6)} ${(sp.end - sp.start).toFixed(0).padStart(6)} ms  ${sp.track.padEnd(10)} ${sp.name}`,
          );
        const big = lt.filter(l => l.dur >= 200);
        if (big.length)
          console.log('long tasks >= 200 ms (start dur):', big.map(l => `${l.start}+${l.dur}`).join(' '));
      }
    } finally {
      await browser.close();
    }
  }
  if (totals.length > 1) console.log(`ready ms: ${totals.join(' ')}  median ${totals.sort((a, b) => a - b)[totals.length >> 1]}`);
});
