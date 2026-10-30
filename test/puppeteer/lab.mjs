// Asset lab screenshots: one building, road junction or rail viaduct alone in
// the real renderer, from fixed camera presets at several times of day.
//   node test/puppeteer/lab.mjs <building|road|rail> [--pick=0] [--kind=midrise]
//     [--station=1] [--ctx=0|1|0,1] [--views=street,facade,...]
//     [--times=day,golden,night,rain] [--size=1280x720] [--wait=2500]
// Images go to test/out/lab/<asset>-<kind?><pick>[-ctx]-<view>-<time>.png
// (kind is "station" for --station=1, "-ctx" marks --ctx=1, the asset in its
// surrounding streets), plus a contact sheet
// test/out/lab/<asset>[-station][-ctx]-sheet.png and
// <asset>[-station][-ctx]-views.json (links). --ctx=0,1 renders both sets.
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {ensureDir, sleep, withPage, withServer} from './harness.mjs';

const args = process.argv.slice(2);
const opt = k => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const asset = args.find(a => !a.startsWith('--')) ?? 'building';
if (!['building', 'road', 'rail'].includes(asset)) {
  console.error(`unknown asset ${asset} (building|road|rail)`);
  process.exit(1);
}
const pick = opt('pick') ?? '0';
const kind = opt('kind');
const [width, height] = (opt('size') ?? '1280x720').split('x').map(Number);
const wait = Number(opt('wait') ?? 2500);
// Same hours and weather as the judge's screenshot matrix (shots.mjs).
const TIMES = {
  day: {hour: 14, weather: 'sunny'},
  golden: {hour: 17.7, weather: 'sunny'},
  dusk: {hour: 18.35, weather: 'sunny'},
  night: {hour: 22, weather: 'sunny'},
  rain: {hour: 12, weather: 'rain'},
  nightrain: {hour: 21.5, weather: 'rain'},
  storm: {hour: 16, weather: 'storm'},
};
const times = (opt('times') ?? 'day,night').split(',');
for (const t of times) {
  if (!TIMES[t]) {
    console.error(`unknown time ${t} (${Object.keys(TIMES).join('|')})`);
    process.exit(1);
  }
}
const station = opt('station') === '1';
const outDir = 'test/out/lab';
await ensureDir(outDir);
const ctxs = (opt('ctx') ?? '0').split(',');

let failed = false;
await withServer(async base => {
  for (const ctx of ctxs) await run(base, ctx === '1');
});

async function run(base, ctx) {
  const cx = ctx ? '-ctx' : '';
  const tag = `${asset}-${kind ?? (station ? 'station' : '')}${pick}${cx}`;
  const q = new URLSearchParams({
    lab: asset,
    pick,
    timespeed: '0',
    ui: '0',
    size: `${width}x${height}`,
  });
  if (kind) q.set('kind', kind);
  if (ctx) q.set('ctx', '1');
  for (const k of ['station', 'city', 'seed', 'debug'])
    if (opt(k)) q.set(k, opt(k));

  const r = await withPage(
    `${base}/index.html?${q}`,
    async page => {
      const lab = await page.evaluate(() => {
        const l = window.__game.city.summary.lab;
        return {label: l.label, views: Object.keys(l.views)};
      });
      console.log(`lab: ${lab.label}; views ${lab.views.join(',')}`);
      const views = opt('views')?.split(',') ?? lab.views;
      const results = [];
      for (const view of views) {
        if (!lab.views.includes(view)) {
          console.log(`skip ${view}: not available for this ${asset}`);
          continue;
        }
        for (const time of times) {
          await page.evaluate(
            (view, t) => {
              const g = window.__game;
              g.hour = t.hour;
              g.weather.set(t.weather, true);
              g.setLabView(view);
            },
            view,
            TIMES[time],
          );
          // Let streaming catch up, then TAA and auto exposure settle.
          for (let i = 0; i < 80; i++) {
            if ((await page.evaluate(() => window.__stats.queue)) === 0) break;
            await sleep(250);
          }
          await sleep(wait);
          const file = `${outDir}/${tag}-${view}-${time}.png`;
          await page.screenshot({path: file});
          const st = await page.evaluate(() => window.__stats);
          const url = await page.evaluate(() => window.__game.shareUrl());
          results.push({file, view, time, url: url.replace(/^.*\?/, '')});
          console.log(
            file,
            JSON.stringify({fps: st.fps, lod0: st.lod0, lod1: st.lod1}),
          );
        }
      }
      return {label: lab.label, results};
    },
    {width, height, timeout: 180000},
  );
  for (const l of r.logs)
    if (/error|warn|WebGPU|WGSL/i.test(l)) console.log(l.slice(0, 600));
  if (r.errors.length) {
    failed = true;
    console.log('ERRORS:\n' + r.errors.join('\n').slice(0, 4000));
  }
  if (!r.result) {
    failed = true;
    console.log('lab page never became ready');
    return;
  }
  const sheetTag = `${asset}${station ? '-station' : ''}${cx}`;
  await writeFile(
    `${outDir}/${sheetTag}-views.json`,
    JSON.stringify(r.result, null, 1),
  );
  const files = r.result.results.map(x => x.file);
  if (files.length) {
    const sheet = `${outDir}/${sheetTag}-sheet.png`;
    execFileSync(
      'node',
      [
        'tools/montage.mjs',
        `--cols=${times.length}`,
        '--labels',
        sheet,
        ...files,
      ],
      {stdio: 'inherit'},
    );
    console.log(sheet);
  }
}
process.exit(failed ? 1 : 0);
