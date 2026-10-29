// Performance run: measures frame times over a few camera situations.
import {sleep, withPage, withServer} from './harness.mjs';

await withServer(async base => {
  await withPage(`${base}/index.html?timespeed=0`, async page => {
    for (const [label, setup] of [
      ['day street', g => { g.hour = 14; g.weather.set('sunny', true); g.forceShot('chase'); }],
      ['night rain', g => { g.hour = 22; g.weather.set('rain', true); g.forceShot('chase'); }],
      ['aerial', g => { g.hour = 16; g.weather.set('cloudy', true); g.forceShot('aerial'); }],
    ]) {
      await page.evaluate(`(${setup.toString()})(window.__game)`);
      await sleep(1500);
      const r = await page.evaluate(() => new Promise(res => {
        const times = [];
        let last = performance.now();
        const f = now => {
          times.push(now - last);
          last = now;
          if (times.length < 180) requestAnimationFrame(f);
          else res(times);
        };
        requestAnimationFrame(f);
      }));
      r.sort((a, b) => a - b);
      const avg = r.reduce((a, b) => a + b, 0) / r.length;
      const stats = await page.evaluate(() => window.__stats);
      console.log(`${label.padEnd(12)} avg ${avg.toFixed(1)}ms  p95 ${r[Math.floor(r.length * 0.95)].toFixed(1)}ms  tris ${stats.tris} clusters ${stats.clusters} lights ${stats.lights}`);
    }
  }, {timeout: 180000});
});
