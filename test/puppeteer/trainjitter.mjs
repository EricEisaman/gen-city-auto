// Per-frame train/camera trace over the default auto-director run:
// node test/puppeteer/trainjitter.mjs [seconds] [out.json] [?query]
import fs from 'node:fs/promises';
import {sleep, withPage, withServer} from './harness.mjs';
const [, , secs = '30', out = 'test/out/trainjitter.json', query = ''] =
  process.argv;
await withServer(async base => {
  const r = await withPage(
    `${base}/index.html${query}`,
    async page => {
      await page.evaluate(() => {
        const g = window.__game;
        const orig = g.frame.bind(g);
        window.__trace = [];
        g.frame = dt => {
          orig(dt);
          const sh = g.camera.shot;
          window.__trace.push({
            t: g.time,
            dt,
            shot: sh?.name,
            focus: sh?.focus,
            trains: g.trains.trains.map(tr => [tr.s, tr.speed, tr.dwell]),
            tf: g.camera.trainFocus(),
            eye: g.lastCam?.eye,
            target: g.lastCam?.target,
          });
        };
      });
      await sleep(Number(secs) * 1000);
      return page.evaluate(() => window.__trace);
    },
    {timeout: 180000},
  );
  await fs.writeFile(out, JSON.stringify(r.result));
  console.log('frames', r.result?.length, r.errors.slice(0, 3));
});
