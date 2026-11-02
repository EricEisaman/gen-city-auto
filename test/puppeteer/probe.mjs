// Runs the on-device probe (?probe=1, src/game/probe.ts) in headless Chrome
// and prints its table: the same numbers a phone shows, here for a quick
// look at counts (drawn triangles, passes, CPU ms) at a phone-sized canvas.
//
//   node test/puppeteer/probe.mjs [WxH] [--q=lowmem=1&...] [--json=out.json] [--shot=out.png]
//
// Default 852x393 (iPhone 15 Pro landscape, CSS pixels) with ?lowmem=1.
import {writeFile} from 'node:fs/promises';
import {sleep, withPage, withServer} from './harness.mjs';

const argv = process.argv.slice(2);
const size = argv.find(a => /^\d+x\d+$/.test(a)) ?? '852x393';
const opt = k => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const q = opt('q') ?? 'lowmem=1';
const [w, h] = size.split('x').map(Number);

const ARGS = [
  '--enable-dawn-features=allow_unsafe_apis',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
];

await withServer(async base => {
  const url = `${base}/index.html?probe=1&${q}`;
  console.log(url);
  const r = await withPage(
    url,
    async page => {
      for (let t = 0; t < 600; t++) {
        await sleep(500);
        if (await page.evaluate(() => !!window.__probe)) break;
      }
      const shot = opt('shot');
      if (shot) await page.screenshot({path: shot});
      return page.evaluate(() => window.__probe);
    },
    {timeout: 240000, width: w, height: h, args: ARGS},
  );
  if (r.errors.length) console.log('ERRORS:\n' + r.errors.join('\n'));
  const p = r.result;
  if (!p) throw new Error('probe produced no result');
  const {settings, ...info} = p.info;
  console.log(JSON.stringify(info));
  console.log('settings', JSON.stringify(settings));
  const f = v =>
    v === undefined || v === null || Number.isNaN(v)
      ? '-'
      : Math.abs(v) >= 1e5
        ? `${(v / 1e6).toFixed(2)}M`
        : v.toFixed(1);
  const cols = [
    'fps',
    'frameMs',
    'cpuMs',
    'gpuMs',
    'mainTris',
    'mainClusters',
    'shadowTris',
    'shadowClusters',
    'shadowRedraws',
    'passes',
    'draws',
    'directTris',
    'dispatches',
    'objects',
    'writeKB',
  ];
  console.log(
    'config'.padEnd(26) +
      cols.map(c => c.slice(0, 9).padStart(10)).join('') +
      '    render',
  );
  for (const row of p.rows)
    console.log(
      row.name.padEnd(26) +
        cols.map(c => f(row[c]).padStart(10)).join('') +
        '    ' +
        row.render,
    );
  console.log(
    '\nbaseline CPU subsystems',
    JSON.stringify(
      Object.fromEntries(
        Object.entries(p.rows[0].cpuSub).map(([k, v]) => [k, +v.toFixed(2)]),
      ),
    ),
  );
  console.log(
    'baseline GPU passes',
    JSON.stringify(
      Object.fromEntries(
        Object.entries(p.rows[0].gpuPasses).map(([k, v]) => [k, +v.toFixed(3)]),
      ),
    ),
  );
  const json = opt('json');
  if (json) await writeFile(json, JSON.stringify(p, null, 1));
});
