// Screenshot matrix for the AAA judge: loads the game once, then drives it
// through times of day, weather and camera shots via window.__game.
//   node test/puppeteer/shots.mjs [outDir] [only-name-substring]
import {ensureDir, sleep, withPage, withServer} from './harness.mjs';

const outDir = process.argv[2] ?? 'test/out/shots';
const only = process.argv[3];
const SHOTS = [
  {name: 'day-chase', hour: 14, weather: 'sunny', shot: 'chase'},
  {name: 'day-flyby', hour: 11, weather: 'sunny', shot: 'flyby'},
  {name: 'golden-aerial', hour: 18.3, weather: 'sunny', shot: 'aerial'},
  {name: 'golden-telephoto', hour: 18.0, weather: 'cloudy', shot: 'telephoto'},
  {name: 'dusk-train', hour: 19.0, weather: 'sunny', shot: 'train'},
  {name: 'night-chase', hour: 22, weather: 'sunny', shot: 'chase'},
  {name: 'night-side', hour: 23, weather: 'sunny', shot: 'side'},
  {name: 'night-rain-bumper', hour: 21.5, weather: 'rain', shot: 'bumper'},
  {name: 'rain-day-chase', hour: 12, weather: 'rain', shot: 'chase'},
  {name: 'storm-orbit', hour: 16, weather: 'storm', shot: 'orbit'},
  {name: 'first-person', hour: 15, weather: 'sunny', camera: 'first'},
  {name: 'heli-aerial', hour: 17, weather: 'cloudy', heli: true, shot: 'orbit'},
].filter(s => !only || s.name.includes(only));

await ensureDir(outDir);
await withServer(async base => {
  const r = await withPage(`${base}/index.html?timespeed=0&spawn=30,-893`, async (page, logs) => {
    const results = [];
    for (const s of SHOTS) {
      await page.evaluate(async s => {
        const g = window.__game;
        g.hour = s.hour;
        g.weather.set(s.weather, true);
        if (s.heli && g.player.kind !== 'heli') g.player.spawnHeli(g.vehicles.variantsOf('helicopter')[0] ?? 0);
        if (!s.heli && g.player.kind === 'heli') g.player.spawnCar(g.player.pos[0], g.player.pos[2], g.vehicles.variants.findIndex(v => v.info.name === 'sports'));
        if (s.camera) {
          g.camera.directorEnabled = false;
          g.camera.mode = s.camera;
        } else {
          g.camera.mode = 'chase';
          g.forceShot(s.shot);
        }
      }, s);
      await sleep(2500);
      const file = `${outDir}/${s.name}.png`;
      await page.screenshot({path: file});
      const st = await page.evaluate(() => window.__stats);
      results.push({file, fps: st.fps, shot: st.shot});
      console.log(file, JSON.stringify({fps: st.fps, shot: st.shot}));
    }
    return results;
  }, {timeout: 180000});
  const errs = r.logs.filter(l => /error|WebGPU|WGSL/i.test(l));
  if (errs.length) console.log(errs.join('\n'));
  if (r.errors.length) console.log('ERRORS:\n' + r.errors.join('\n'));
});
