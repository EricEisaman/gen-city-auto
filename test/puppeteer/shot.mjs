// Screenshot the game: node test/puppeteer/shot.mjs "<query>" out.png [waitMs]
import {sleep, withPage, withServer} from './harness.mjs';
const [, , query = '', out = 'test/out/shot.png', wait = '3000'] = process.argv;
await withServer(async base => {
  const r = await withPage(`${base}/index.html?${query}`, async page => {
    await sleep(Number(wait));
    await page.screenshot({path: out});
    return page.evaluate(() => window.__stats);
  }, {timeout: 180000});
  for (const l of r.logs) if (!/Download the React|favicon/.test(l)) console.log(l.slice(0, 600));
  if (r.errors.length) console.log('ERRORS:\n' + r.errors.join('\n').slice(0, 4000));
  console.log('ready', r.ready, 'load', (r.loadTime / 1000).toFixed(1) + 's', JSON.stringify(r.result));
});
