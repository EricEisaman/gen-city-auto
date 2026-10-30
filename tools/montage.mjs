// node test/out/tools/montage.mjs out.png a.png b.png c.png d.png  -> 2x2 grid (each scaled 50%..)
// Optional flags before out.png: --cols=N (fixed column count, 16:9 tiles),
// --labels (file name in the corner of each tile).
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const [out, ...files] = args.filter(a => !a.startsWith('--'));
const fixedCols = Number(flags.find(f => f.startsWith('--cols='))?.split('=')[1] ?? 0);
const labels = flags.includes('--labels');
const cols = fixedCols || (files.length > 4 ? 3 : 2);
const w = 640, h = fixedCols ? 360 : 400;
const rows = Math.ceil(files.length / cols);
const imgs = files.map(f => `<div style="position:relative;float:left;width:${w}px;height:${h}px"><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}" style="width:${w}px;height:${h}px;display:block">${labels ? `<span style="position:absolute;left:4px;top:4px;padding:1px 5px;font:13px sans-serif;color:#fff;background:rgba(0,0,0,.55)">${path.basename(f, '.png')}</span>` : ''}</div>`).join('');
const browser = await puppeteer.launch({headless: true});
const page = await browser.newPage();
await page.setViewport({width: w * cols, height: h * rows});
await page.setContent(`<body style="margin:0">${imgs}</body>`);
await page.screenshot({path: out});
await browser.close();
