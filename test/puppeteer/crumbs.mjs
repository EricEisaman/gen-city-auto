// Crash breadcrumbs (src/ui/breadcrumbs.ts): crash the renderer mid-load
// (CDP Page.crash, like iOS killing the tab for memory), load again with
// ?diag=1 and check the console and the diag panel name where it ended.
//   node build.mjs && node test/puppeteer/crumbs.mjs [ms before the crash]
import puppeteer from 'puppeteer';
import {sleep, withServer} from './harness.mjs';

const wait = Number(process.argv[2] ?? 5000);
let ok = false;
await withServer(async base => {
  const browser = await puppeteer.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/index.html?lowmem=1`);
    await sleep(wait);
    const label = await page.evaluate(
      () => document.getElementById('loadmsg')?.textContent,
    );
    const cdp = await page.createCDPSession();
    await cdp.send('Page.crash').catch(() => {});
    await sleep(500);
    console.log(`crashed at ${wait} ms during "${label}"`);
    const page2 = await browser.newPage();
    const warns = [];
    page2.on('console', m => {
      if (m.type() === 'warn' && m.text().startsWith('[diag]'))
        warns.push(m.text());
    });
    await page2.goto(`${base}/index.html?diag=1`);
    await sleep(1500);
    const panel = await page2.evaluate(
      () => document.querySelector('#diag pre')?.textContent ?? '',
    );
    const line = panel.split('\n').find(l => /ended unexpectedly/.test(l));
    console.log('console:', warns.join(' | ') || '(none)');
    console.log('panel:  ', line ?? '(none)');
    ok = warns.length === 1 && !!line;
    // A clean exit: leaving the page marks the record finished.
    await page2.goto('about:blank');
    const page3 = await browser.newPage();
    const warns3 = [];
    page3.on('console', m => {
      if (m.text().startsWith('[diag]')) warns3.push(m.text());
    });
    await page3.goto(`${base}/index.html?diag=1`);
    await sleep(1500);
    console.log('after a clean exit, console:', warns3.join(' | ') || '(none)');
    ok &&= warns3.length === 0;
  } finally {
    await browser.close();
  }
});
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
