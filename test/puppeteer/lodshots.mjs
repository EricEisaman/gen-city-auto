// Far-detail A/B within one build: each far view rendered with the simulation
// frozen three ways, so the difference is exactly what a tile's LOD1 -> LOD2
// swap (city/lod.ts) and the base far cull change on screen:
//   <view>-off   LOD1 shells everywhere, no fine-detail far cull
//   <view>-lod2  LOD2 beyond 1500 m, no far cull
//   <view>-both  LOD2 and far cull (the default)
//   node test/puppeteer/lodshots.mjs <outDir>
import {ensureDir, sleep, withPage, withServer} from './harness.mjs';
const outDir = process.argv[2] ?? 'test/out/lodshots';
const VIEWS = [
  {name: 'skyline', hour: 17.2, freecam: [-2400, 200, -2800, 2.34, -0.1]},
  {name: 'skyline-night', hour: 21, freecam: [-2400, 200, -2800, 2.34, -0.1]},
  {name: 'aerial', hour: 15, freecam: [0, 420, 300, 3.14, -0.6]},
  {name: 'aerial-far', hour: 10, freecam: [1800, 260, 1600, -0.8, -0.12]},
  {name: 'street-long', hour: 13, freecam: [208, 26.7, -349, 2.13, 0.02]},
];
const MODES = [
  {tag: 'off', lod2: 1e9, far: 0},
  {tag: 'lod2', lod2: 1500, far: 0},
  {tag: 'both', lod2: 1500, far: 1},
];
await ensureDir(outDir);
await withServer(async base => {
  const r = await withPage(`${base}/index.html?timespeed=0&ui=0&traffic=380&scale=100`, async page => {
    await sleep(2000);
    await page.evaluate(() => (window.__game.freeze = true));
    for (const v of VIEWS) {
      for (const m of MODES) {
        await page.evaluate((v, m) => {
          const g = window.__game;
          g.hour = v.hour;
          g.weather.set('sunny', true);
          const [x, y, z, yaw, pitch] = v.freecam;
          g.freeCam.setPose([x, y, z], yaw, pitch);
          g.freeMode = true;
          g.city.lod2Dist = m.lod2;
          g.renderer.farCullScale = m.far;
        }, v, m);
        for (let i = 0; i < 120; i++) {
          await sleep(250);
          if ((await page.evaluate(() => window.__stats.queue)) === 0) break;
        }
        await sleep(3500);
        const f = `${outDir}/${v.name}-${m.tag}.png`;
        await page.screenshot({path: f});
        console.log(f, JSON.stringify(await page.evaluate(() => [window.__stats.lod0, window.__stats.lod1, window.__stats.lod2])));
      }
    }
  }, {timeout: 180000});
  if (r.errors.length) console.log('ERRORS:\n' + r.errors.join('\n'));
});
