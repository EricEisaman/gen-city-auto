// Smoke test: load the game, render frames, fail on any WebGPU/WGSL/page error.
import {sleep, withPage, withServer} from './harness.mjs';

let failed = false;
await withServer(async base => {
  for (const q of ['', 'time=22&weather=rain', 'city=harbour&seed=7&vehicle=heli', 'city=metro&seed=3&weather=storm', 'city=river&seed=5&cam=first&director=0']) {
    const r = await withPage(`${base}/index.html?${q}`, async page => {
      await sleep(3000);
      return page.evaluate(() => window.__stats);
    }, {timeout: 180000});
    const bad = r.logs.filter(l => /\[WebGPU\]|\[WGSL error\]|pageerror|\[main\]|\[frame\]/.test(l));
    const ok = r.ready && !r.errors.length && !bad.length;
    console.log(`${ok ? 'PASS' : 'FAIL'} ?${q} load ${(r.loadTime / 1000).toFixed(1)}s ${JSON.stringify(r.result ?? {})}`);
    if (!ok) {
      failed = true;
      console.log([...r.errors, ...bad].join('\n').slice(0, 3000));
    }
  }
});
process.exit(failed ? 1 : 0);
