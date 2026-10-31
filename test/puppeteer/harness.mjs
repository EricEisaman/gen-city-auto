// Shared puppeteer helpers: start the express server on dist/, open pages with
// default launch arguments, collect console/WebGPU errors, and retry when
// headless Chrome's compositor stalls (requestAnimationFrame stops ticking).
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {startServer} from '../../server.mjs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Largest RSS (MB) among the descendants of process `root` (the browser):
 * the renderer, which holds the page and all its workers.
 */
function maxChildRss(root) {
  return new Promise(res =>
    execFile('ps', ['-axo', 'pid=,ppid=,rss='], (err, out) => {
      if (err) return res(0);
      const kids = new Map();
      for (const l of out.trim().split('\n')) {
        const [pid, ppid, rss] = l.trim().split(/\s+/).map(Number);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push([pid, rss]);
      }
      let max = 0;
      const walk = p => {
        for (const [pid, rss] of kids.get(p) ?? []) {
          max = Math.max(max, rss);
          walk(pid);
        }
      };
      walk(root);
      res(max / 1024);
    }),
  );
}

export async function withServer(fn) {
  const server = await startServer(0);
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    server.close();
  }
}

/**
 * Open `url`, wait for window.__ready, then call `fn(page, logs)`.
 * Returns {logs, errors, result}.
 */
export async function withPage(url, fn, {width = 1280, height = 720, timeout = 90000, attempts = 4, args = []} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const browser = await puppeteer.launch({headless: true, protocolTimeout: 180000, args});
    // Peak renderer RSS while loading (a city once ran the renderer out of
    // memory before window.__ready).
    let peakRss = 0;
    const pid = browser.process()?.pid;
    const rssTimer = pid
      ? setInterval(() => maxChildRss(pid).then(v => (peakRss = Math.max(peakRss, v))), 250)
      : null;
    try {
      const page = await browser.newPage();
      await page.setViewport({width, height});
      await page.evaluateOnNewDocument(() => {
        const raf = window.requestAnimationFrame.bind(window);
        (function tick() {
          window.__ticks = (window.__ticks || 0) + 1;
          raf(tick);
        })();
      });
      const logs = [];
      page.on('console', e => logs.push(`[${e.type()}] ${e.text()}`));
      let pageError = false;
      page.on('pageerror', e => {
        pageError = true;
        logs.push(`[pageerror] ${e.message}`);
      });
      page.on('requestfailed', r => logs.push(`[requestfailed] ${r.url()}`));
      page.on('response', r => {
        if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`);
      });
      await page.goto(url);
      const t0 = Date.now();
      let ready = false;
      while (Date.now() - t0 < timeout) {
        await sleep(250);
        const s = await page.evaluate(() => ({ready: window.__ready, errors: (window.__errors || []).length}));
        if (s.ready || s.errors || pageError) {
          ready = s.ready;
          break;
        }
      }
      const a = await page.evaluate(() => window.__ticks);
      await sleep(1000);
      const b = await page.evaluate(() => window.__ticks);
      if (b - a < 3 && attempt < attempts) {
        console.log(`[harness] compositor stalled (attempt ${attempt}), retrying`);
        continue;
      }
      const result = ready ? await fn(page, logs) : undefined;
      const errors = await page.evaluate(() => window.__errors || []);
      return {logs, errors, ready, loadTime: Date.now() - t0, peakRss, result};
    } finally {
      if (rssTimer) clearInterval(rssTimer);
      await browser.close();
    }
  }
  throw new Error('page never became responsive');
}

export async function ensureDir(d) {
  await fs.mkdir(d, {recursive: true});
}
