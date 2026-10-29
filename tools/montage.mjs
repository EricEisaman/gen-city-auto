// node test/out/tools/montage.mjs out.png a.png b.png c.png d.png  -> 2x2 grid (each scaled 50%..)
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
const [out, ...files] = process.argv.slice(2);
const cols = files.length > 4 ? 3 : 2;
const w = 640, h = 400;
const rows = Math.ceil(files.length / cols);
const imgs = files.map(f => `<img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}" style="width:${w}px;height:${h}px;display:block;float:left">`).join('');
const browser = await puppeteer.launch({headless: true});
const page = await browser.newPage();
await page.setViewport({width: w * cols, height: h * rows});
await page.setContent(`<body style="margin:0">${imgs}</body>`);
await page.screenshot({path: out});
await browser.close();
