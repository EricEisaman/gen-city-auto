// Traffic turn smoothness: steps the traffic simulation at a fixed 60 Hz in
// the page and measures per-frame yaw changes of every car (max, p99, yaw
// rate jumps), how often bodies stick out of the asphalt mid-turn and how
// often two cars overlap. Writes a JSON summary, a yaw-vs-time plot of cars
// turning at junctions and a top-down frame montage of a busy junction.
//
// node test/puppeteer/carturns.mjs [outDir] [seconds] [?query]
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import {withPage, withServer} from './harness.mjs';

const [, , outDir = 'test/out/carturns', secs = '40', query = '?seed=1'] =
  process.argv;
await fs.mkdir(outDir, {recursive: true});

await withServer(async base => {
  const r = await withPage(
    `${base}/index.html${query}${query.includes('?') ? '&' : '?'}ui=0&director=0`,
    async page => {
      // Take over the frame loop: rAF frames do nothing, we step by hand.
      await page.evaluate(() => {
        const g = window.__game;
        g.__frame = g.frame.bind(g);
        g.frame = () => {};
      });
      const stats = await page.evaluate(
        steps => {
          const g = window.__game;
          const tr = g.traffic;
          const net = tr.net;
          const dt = 1 / 60;
          const focus = [...g.player.pos];
          const ids = new WeakMap();
          let nextId = 0;
          const series = new Map(); // id -> {t0, yaw[], turn[]}
          const dyaws = [];
          const drates = [];
          let clampFrames = 0;
          let frames = 0;
          let offRoad = 0;
          let offSamples = 0;
          let overlaps = 0;
          let overlapSamples = 0;
          const prev = new Map();
          const inPoly = (x, z, poly) => {
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const a = poly[i];
              const b = poly[j];
              if (
                a[1] > z !== b[1] > z &&
                x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]
              )
                inside = !inside;
            }
            return inside;
          };
          const onAsphalt = (x, z) => {
            for (const ji of net.junctionGrid.get(net.key(x, z)) ?? [])
              if (inPoly(x, z, net.geom.junctions[ji].outline)) return true;
            const nr = net.nearestRoad(x, z, 1);
            if (!nr) return false;
            return nr.dist < roadHalf(nr.chain);
          };
          const RW = {};
          const roadHalf = ci => {
            const k = net.chains[ci].kind;
            if (RW[k] === undefined) {
              // Widest lane offset + half a car approximates the deck half width.
              RW[k] = net.laneOffset(ci, net.lanesPerDir(ci) - 1) + 1.6;
            }
            return RW[k];
          };
          const corners = f => {
            const [dx, dz] = f.dir;
            const hl = f.length / 2 - 0.2;
            const hw = 0.8;
            const out = [];
            for (const [a, b] of [
              [hl, hw],
              [hl, -hw],
              [-hl, hw],
              [-hl, -hw],
            ])
              out.push([
                f.pos[0] + dx * a + dz * b,
                f.pos[2] + dz * a - dx * b,
              ]);
            return out;
          };
          for (let k = 0; k < steps; k++) {
            g.time += dt;
            tr.update(dt, g.time, focus, []);
            frames++;
            for (const c of tr.cars) {
              const f = c.f;
              let id = ids.get(f);
              if (id === undefined) ids.set(f, (id = nextId++));
              const yaw = Math.atan2(f.dir[0], f.dir[1]);
              let s = series.get(id);
              if (!s) series.set(id, (s = {t0: k, yaw: [], turn: [], pos: []}));
              s.yaw.push(yaw);
              s.turn.push(f.turn ? 1 : 0);
              const p = prev.get(id);
              if (p) {
                let d = yaw - p.yaw;
                while (d > Math.PI) d -= 2 * Math.PI;
                while (d < -Math.PI) d += 2 * Math.PI;
                const rate = d / dt;
                dyaws.push(Math.abs(d));
                if (Math.abs(rate) > 4.95) clampFrames++;
                if (p.rate !== undefined) drates.push(Math.abs(rate - p.rate));
                prev.set(id, {yaw, rate});
              } else prev.set(id, {yaw});
              // Body corners off the asphalt (turning cars, every 5th frame).
              if (f.turn && k % 5 === 0) {
                for (const q of corners(f)) {
                  offSamples++;
                  if (!onAsphalt(q[0], q[1])) offRoad++;
                }
              }
            }
            // Overlapping cars (centres closer than ~ a car width), every 10th.
            if (k % 10 === 0) {
              const cs = tr.cars.map(c => c.f);
              for (let i = 0; i < cs.length; i++)
                for (let j = i + 1; j < cs.length; j++) {
                  const a = cs[i],
                    b = cs[j];
                  const dx = a.pos[0] - b.pos[0],
                    dz = a.pos[2] - b.pos[2];
                  if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
                  if (Math.abs(a.pos[1] - b.pos[1]) > 2) continue;
                  overlapSamples++;
                  // Separating axis test of the two footprints.
                  const box = f => {
                    const [ux, uz] = f.dir;
                    return {
                      c: [f.pos[0], f.pos[2]],
                      u: [ux, uz],
                      v: [uz, -ux],
                      e: [f.length / 2 - 0.15, 0.8],
                    };
                  };
                  const A = box(a),
                    B = box(b);
                  const d = [B.c[0] - A.c[0], B.c[1] - A.c[1]];
                  let sep = false;
                  for (const ax of [A.u, A.v, B.u, B.v]) {
                    const proj = X =>
                      X.e[0] * Math.abs(X.u[0] * ax[0] + X.u[1] * ax[1]) +
                      X.e[1] * Math.abs(X.v[0] * ax[0] + X.v[1] * ax[1]);
                    if (
                      Math.abs(d[0] * ax[0] + d[1] * ax[1]) >
                      proj(A) + proj(B)
                    ) {
                      sep = true;
                      break;
                    }
                  }
                  if (!sep) overlaps++;
                }
            }
          }
          const pct = (a, q) => {
            const s = [...a].sort((x, y) => x - y);
            return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
          };
          const deg = 180 / Math.PI;
          // Pick turning cars: completed turns with a big heading change.
          const picks = [];
          for (const [id, s] of series) {
            for (let i = 1; i < s.turn.length; i++) {
              if (s.turn[i] && !s.turn[i - 1]) {
                let j = i;
                while (j < s.turn.length && s.turn[j]) j++;
                if (j >= s.turn.length || i < 90 || j + 90 > s.turn.length)
                  continue;
                let d = s.yaw[j] - s.yaw[i];
                while (d > Math.PI) d -= 2 * Math.PI;
                while (d < -Math.PI) d += 2 * Math.PI;
                if (Math.abs(d) > 1.2) {
                  const a = i - 90,
                    b = j + 90;
                  const yaw = [];
                  let acc = s.yaw[a];
                  for (let m = a; m < b; m++) {
                    if (m > a) {
                      let e = s.yaw[m] - s.yaw[m - 1];
                      while (e > Math.PI) e -= 2 * Math.PI;
                      while (e < -Math.PI) e += 2 * Math.PI;
                      acc += e;
                    }
                    yaw.push(acc);
                  }
                  picks.push({id, yaw, turn: s.turn.slice(a, b), start: 90});
                  break;
                }
              }
            }
            if (picks.length >= 8) break;
          }
          return {
            frames,
            carFrames: dyaws.length,
            maxDyawDeg: dyaws.reduce((m, v) => Math.max(m, v), 0) * deg,
            p99DyawDeg: pct(dyaws, 0.99) * deg,
            p999DyawDeg: pct(dyaws, 0.999) * deg,
            maxDrateDegS: drates.reduce((m, v) => Math.max(m, v), 0) * deg,
            p999DrateDegS: pct(drates, 0.999) * deg,
            p99DrateDegS: pct(drates, 0.99) * deg,
            rateClampFrac: clampFrames / dyaws.length,
            offRoadFrac: offRoad / Math.max(1, offSamples),
            overlapFrac: overlaps / Math.max(1, overlapSamples),
            overlaps,
            picks,
          };
        },
        Math.round(Number(secs) * 60),
      );

      // Top-down montage of the signalised 4+ arm junction nearest the
      // player (layout only, so the same junction before and after a change).
      const frames = await page.evaluate(() => {
        const g = window.__game;
        const net = g.traffic.net;
        const pp = g.player.pos;
        let best = -1;
        let bestD = Infinity;
        let at = [0, 0];
        net.junctions.forEach((j, ji) => {
          if (j.arms.length < 4 || !j.signal) return;
          const d = Math.hypot(j.p[0] - pp[0], j.p[1] - pp[2]);
          if (d < bestD) {
            bestD = d;
            best = ji;
            at = j.p;
          }
        });
        // Free camera pitch is capped just short of straight down: step the
        // eye back so the junction is in the middle of the frame.
        const yaw = net.geom.junctions[best].arms[0]?.angle ?? 0;
        const h = 32;
        const back = h * Math.tan(Math.PI / 2 - 1.5);
        g.freeCam.setPose(
          [
            at[0] - Math.sin(yaw) * back,
            net.junctions[best].h + h,
            at[1] + Math.cos(yaw) * back,
          ],
          yaw,
          -1.5,
          0.8,
        );
        g.freeMode = true;
        return {index: best, at};
      });
      const shots = [];
      for (let i = 0; i < 24; i++) {
        await page.evaluate(() => {
          const g = window.__game;
          for (let k = 0; k < 20; k++) g.__frame(1 / 60);
        });
        const vp = page.viewport();
        const s = Math.min(vp.width, vp.height);
        shots.push(
          await page.screenshot({
            encoding: 'base64',
            clip: {
              x: (vp.width - s) / 2,
              y: (vp.height - s) / 2,
              width: s,
              height: s,
            },
          }),
        );
      }
      return {stats, shots, junction: frames};
    },
    {timeout: 240000},
  );
  if (!r.result) {
    console.log('failed', r.errors);
    return;
  }
  const {stats, shots, junction} = r.result;
  const {picks, ...summary} = stats;
  await fs.writeFile(
    path.join(outDir, 'stats.json'),
    JSON.stringify({...summary, junction, picks}, null, 1),
  );
  console.log(JSON.stringify(summary, null, 1));
  // Plot + montage rendered by a throwaway page.
  const browser = await puppeteer.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setViewport({width: 1200, height: 700});
    await page.setContent(
      `<canvas id=c width=1200 height=700></canvas><script>
      const picks = ${JSON.stringify(picks)};
      const c = document.getElementById('c').getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, 1200, 700);
      const L = 70, T = 30, W = 1100, H = 300;
      const cols = ['#2563eb','#dc2626','#16a34a','#9333ea','#ea580c','#0891b2','#be185d','#65a30d'];
      let n = 0; for (const p of picks) n = Math.max(n, p.yaw.length);
      const plot = (top, h, val, lo, hi, label) => {
        c.strokeStyle = '#ccc'; c.strokeRect(L, top, W, h);
        c.fillStyle = '#333'; c.font = '13px sans-serif';
        c.fillText(label, L, top - 8);
        c.fillText(hi.toFixed(0), 10, top + 10); c.fillText(lo.toFixed(0), 10, top + h);
        picks.forEach((p, k) => {
          c.strokeStyle = cols[k % cols.length]; c.lineWidth = 1.5; c.beginPath();
          for (let i = 0; i < p.yaw.length; i++) {
            const v = val(p, i);
            const x = L + (i / n) * W, y = top + h - ((v - lo) / (hi - lo)) * h;
            i ? c.lineTo(x, y) : c.moveTo(x, y);
          }
          c.stroke();
        });
      };
      const deg = 180 / Math.PI;
      plot(T, H, (p, i) => (p.yaw[i] - p.yaw[p.start]) * deg, -180, 180,
        'yaw relative to turn start (deg) vs frame (60 Hz)');
      plot(T + H + 50, 280, (p, i) => i ? (p.yaw[i] - p.yaw[i - 1]) * deg * 60 : 0, -400, 400,
        'yaw rate (deg/s)');
      </script>`,
    );
    await page.screenshot({path: path.join(outDir, 'yaw.png')});
    const cell = 250;
    await page.setViewport({width: cell * 6 + 20, height: cell * 4 + 12});
    await page.setContent(
      `<body style="margin:0;display:grid;grid-template-columns:repeat(6,${cell}px);gap:4px;background:#fff">` +
        shots
          .map(
            s =>
              `<img src="data:image/png;base64,${s}" width=${cell} height=${cell}>`,
          )
          .join('') +
        '</body>',
    );
    await new Promise(res => setTimeout(res, 300));
    await page.screenshot({path: path.join(outDir, 'montage.png')});
  } finally {
    await browser.close();
  }
  console.log('wrote', path.resolve(outDir));
});
