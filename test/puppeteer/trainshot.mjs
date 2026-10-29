// Screenshot the nearest train from a free camera: node test/puppeteer/trainshot.mjs out.png [time] [dist]
import {sleep, withPage, withServer} from './harness.mjs';
const [, , out = 'test/out/trainshot.png', time = '15', dist = '22'] = process.argv;
await withServer(async base => {
  const r = await withPage(`${base}/index.html?time=${time}&timespeed=0`, async page => {
    await sleep(2000);
    const look = () =>
      page.evaluate(d => {
        const g = window.__game;
        const tr = g.trains.trains[0];
        const m = tr.cars[1].model;
        const p = [m[12], m[13], m[14]];
        // Side of the car: model x axis.
        const sx = m[0], sz = m[2];
        const eye = [p[0] + sx * d + m[8] * 8, p[1] + 1.5, p[2] + sz * d + m[10] * 8];
        const dx = p[0] - eye[0], dy = p[1] + 1.5 - eye[1], dz = p[2] - eye[2];
        g.freeCam.setPose(eye, Math.atan2(dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
        g.freeMode = true;
        g.freeCam.speed = 0;
        return p;
      }, Number(dist));
    for (let i = 0; i < 30; i++) {
      await look();
      await sleep(50);
    }
    await page.screenshot({path: out});
    return look();
  }, {timeout: 180000});
  console.log(JSON.stringify(r.result), r.errors.slice(0, 3));
});
