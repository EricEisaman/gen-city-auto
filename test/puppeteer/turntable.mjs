// Render turntable screenshots of vehicle designs.
//   node test/puppeteer/turntable.mjs [design ...] [--views=front,side,...] [--seed=1] [--lights=1]
//   [--zoom=2] [--out=dir]
// Images go to test/out/vehicles/<design>-<view>.png
import {ensureDir, sleep, withPage, withServer} from './harness.mjs';

const args = process.argv.slice(2);
const opt = k => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
let names = args.filter(a => !a.startsWith('--'));
const views = (opt('views') ?? 'three-quarter,side,front,rear,top,interior').split(',');
const seed = opt('seed') ?? '1';
const lights = opt('lights') ?? '0';
const zoom = opt('zoom') ?? '1';
const out = opt('out') ?? 'test/out/vehicles';
await ensureDir(out);

await withServer(async base => {
  if (!names.length) {
    const r = await withPage(`${base}/vehicles.html`, page => page.evaluate(() => window.__stats));
    names = [r.result?.name ?? 'sedan'];
  }
  for (const name of names) {
    for (const view of views) {
      const r = await withPage(`${base}/vehicles.html?design=${name}&view=${view}&seed=${seed}&lights=${lights}&zoom=${zoom}`, async page => {
        await sleep(300);
        const file = `${out}/${name}-${view}${zoom === '1' ? '' : `-z${zoom}`}.png`;
        await page.screenshot({path: file});
        return {file, stats: await page.evaluate(() => window.__stats)};
      }, {width: 960, height: 600});
      for (const l of r.logs) if (/error|warn/i.test(l)) console.log(l);
      if (r.errors.length) console.log('ERRORS:', r.errors.join('\n'));
      if (r.result) console.log(r.result.file, JSON.stringify(r.result.stats));
    }
  }
});
