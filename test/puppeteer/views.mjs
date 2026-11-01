// Several free-camera views of one city, loading it once:
//   node test/puppeteer/views.mjs "<city query>" outDir name=x,y,z,yaw,pitch ...
// e.g. node test/puppeteer/views.mjs "city=harbour&seed=1&time=15" out \
//        a=2.5,371,179.5,-2.13,-0.53 b=14.6,120.3,260.6,1.02,-0.4
import {ensureDir, sleep, withPage, withServer} from './harness.mjs';

const [, , query = '', outDir = 'test/out/views', ...specs] = process.argv;
const views = specs.map(s => {
  const [name, pose] = s.split('=');
  return {name, pose: pose.split(',').map(Number)};
});
await ensureDir(outDir);
await withServer(async base => {
  const first = views[0]?.pose.join(',') ?? '0,300,0,0,-0.5';
  const r = await withPage(
    `${base}/index.html?timespeed=0&weather=sunny&${query}&freecam=${first}`,
    async page => {
      for (const v of views) {
        await page.evaluate(p => {
          const g = window.__game;
          g.freeCam.setPose([p[0], p[1], p[2]], p[3], p[4], p[5] || 1);
          g.freeMode = true;
        }, v.pose);
        await sleep(6000);
        await page.screenshot({path: `${outDir}/${v.name}.png`});
        console.log(`${outDir}/${v.name}.png`);
      }
    },
    {timeout: 240000},
  );
  if (r.errors.length) console.log('ERRORS:\n' + r.errors.join('\n'));
});
