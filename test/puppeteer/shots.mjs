// Screenshot matrix for the AAA judge: loads the game once, then drives it
// through times of day, weather and camera shots via window.__game.
//   node test/puppeteer/shots.mjs [outDir] [only-name-substring]
import {ensureDir, sleep, withPage, withServer} from './harness.mjs';

const outDir = process.argv[2] ?? 'test/out/shots';
const only = process.argv[3];
// Each scenario asks the director for a shot; if that shot is not valid at
// the vehicle's current position (blocked, inside geometry) the director picks
// another, exactly as in normal play. The HUD shows the shot actually used.
const SHOTS = [
  {name: '01-day-1', hour: 14, weather: 'sunny', shot: 'chase'},
  {name: '02-day-2', hour: 11, weather: 'sunny', shot: 'flyby'},
  {name: '03-golden-1', hour: 17.7, weather: 'sunny', shot: 'aerial'},
  {name: '04-golden-2', hour: 17.8, weather: 'sunny', shot: 'telephoto'},
  {name: '05-dusk', hour: 18.35, weather: 'sunny', shot: 'train'},
  {name: '06-night-1', hour: 22, weather: 'sunny', shot: 'chase'},
  {name: '07-night-2', hour: 23, weather: 'sunny', shot: 'side'},
  {name: '08-night-rain', hour: 21.5, weather: 'rain', shot: 'flyby'},
  {name: '09-day-rain', hour: 12, weather: 'rain', shot: 'chase'},
  {name: '10-storm', hour: 16, weather: 'storm', shot: 'orbit'},
  {name: '11-first-person', hour: 15, weather: 'sunny', camera: 'first'},
  {name: '12-helicopter', hour: 17, weather: 'cloudy', heli: true, shot: 'orbit'},
].filter(s => !only || s.name.includes(only));

await ensureDir(outDir);
const {writeFile} = await import('node:fs/promises');
await withServer(async base => {
  const r = await withPage(`${base}/index.html?timespeed=0&ui=0&scale=100${process.env.Q ?? ''}`, async (page, logs) => {
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
          g.forceShot(s.shot, false);
        }
      }, s);
      await sleep(2500);
      const file = `${outDir}/${s.name}.png`;
      await page.screenshot({path: file});
      const st = await page.evaluate(() => window.__stats);
      // Link that reproduces this exact view with the free camera.
      const url = await page.evaluate(() => window.__game.shareUrl());
      results.push({file, fps: st.fps, shot: st.shot, url: url.replace(/^.*\?/, '')});
      console.log(file, JSON.stringify({fps: st.fps, shot: st.shot}));
    }
    return results;
  }, {timeout: 180000});
  if (r.result) await writeFile(`${outDir}/views.json`, JSON.stringify(r.result, null, 1));
  const errs = r.logs.filter(l => /error|WebGPU|WGSL/i.test(l));
  if (errs.length) console.log(errs.join('\n'));
  if (r.errors.length) console.log('ERRORS:\n' + r.errors.join('\n'));
});
