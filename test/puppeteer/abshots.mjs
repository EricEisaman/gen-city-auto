// Visual A/B for performance work: renders the profiler's scenarios with the
// simulation frozen (same pedestrians/traffic pose each run) into outDir.
//   node test/puppeteer/abshots.mjs <outDir> [--q=extra&query]
// Run once on each build and compare (e.g. tools/montage.mjs --labels).
import {ensureDir, sleep, withPage, withServer} from './harness.mjs';

const argv = process.argv.slice(2);
const outDir = argv.find(a => !a.startsWith('--')) ?? 'test/out/ab';
const extra = argv.find(a => a.startsWith('--q='))?.slice(4) ?? '';
const DOWNTOWN = [208, 26.7, -349, 2.13, 0.02];
const VIEWS = [
  {name: 'downtown-day', hour: 13, weather: 'sunny', freecam: DOWNTOWN},
  {name: 'downtown-night-rain', hour: 22, weather: 'rain', freecam: DOWNTOWN},
  // Street level in the rain, looking down the wet carriageway (lamp
  // streaks, puddles, reflections).
  {name: 'street-night-rain', hour: 22, weather: 'rain', freecam: [208, 26.7, -349, 2.13, -0.12]},
  {name: 'street-dusk-rain', hour: 18.6, weather: 'rain', freecam: [215, 26.5, -330, 3.6, -0.1]},
  {name: 'downtown-golden', hour: 17.7, weather: 'sunny', freecam: [215, 30, -330, 3.6, -0.15]},
  {name: 'skyline', hour: 17.2, weather: 'sunny', freecam: [-2400, 200, -2800, 2.34, -0.1]},
  {name: 'trees-wires', hour: 11, weather: 'cloudy', freecam: [230, 26, -340, 0.9, 0.25]},
  {name: 'aerial', hour: 15, weather: 'sunny', freecam: [0, 420, 300, 3.14, -0.6]},
  // Far views (LOD2 tiles, far-culled base detail): night windows and signs,
  // and a low aerial across the city.
  {name: 'skyline-night', hour: 21, weather: 'sunny', freecam: [-2400, 200, -2800, 2.34, -0.1]},
  {name: 'aerial-far', hour: 10, weather: 'sunny', freecam: [1800, 260, 1600, -0.8, -0.12]},
  {name: 'aerial-far-night', hour: 23, weather: 'sunny', freecam: [1800, 260, 1600, -0.8, -0.12]},
];

await ensureDir(outDir);
await withServer(async base => {
  const r = await withPage(`${base}/index.html?timespeed=0&ui=0&traffic=380${extra ? '&' + extra : ''}`, async page => {
    // Let traffic and pedestrians settle, then freeze them for every view.
    await sleep(2000);
    await page.evaluate(() => (window.__game.freeze = true));
    for (const v of VIEWS) {
      await page.evaluate(v => {
        const g = window.__game;
        g.hour = v.hour;
        g.weather.set(v.weather, true);
        const [x, y, z, yaw, pitch] = v.freecam;
        g.freeCam.setPose([x, y, z], yaw, pitch);
        g.freeMode = true;
      }, v);
      // Let streaming catch up (queued + in flight), then TAA settle.
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        if ((await page.evaluate(() => window.__stats.queue)) === 0) break;
      }
      await sleep(4000);
      await page.screenshot({path: `${outDir}/${v.name}.png`});
      console.log(`${outDir}/${v.name}.png`);
    }
  }, {timeout: 180000});
  if (r.errors.length) console.log('ERRORS:\n' + r.errors.join('\n'));
});
