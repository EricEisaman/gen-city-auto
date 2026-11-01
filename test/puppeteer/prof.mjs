// Frame-time profiler over a set of fixed scenarios.
//
//   node test/puppeteer/prof.mjs [WxH ...] [--only=substr] [--q=extra&query] [--json=out.json]
//        [--ablate=ssr,gtao,ssr+cityrefl,...] [--frames=240] [--passes] [--live]
//
// Default: for each scenario, the median over --frames frames of the
// uncapped rAF interval, the GPU frame span (one timestamp pair around the
// whole frame, ?prof=frame) and the CPU time of game.frame, plus the CPU
// per-subsystem table. The simulation and camera are frozen while measuring
// so every frame renders the same image.
//
// --ablate: also measures each listed feature switched off (render/ablation.ts
// names; '+' combines several) against the baseline; the delta is that
// feature's cost. The baseline is re-measured at the end to show drift.
// 'matN' draws city material id N (city-materials.wgsl M_*) as a flat colour,
// e.g. --ablate=mat3,mat5,mat3+mat5 (facade, glass).
//
// Sizes: WxH canvas sizes in CSS pixels (= render resolution; the renderer
// ignores devicePixelRatio), e.g. 640x360 960x540 1280x720 for a resolution
// sweep (fill-bound vs vertex/CPU-bound).
//
// --live: keep the simulation (and the chase camera) running while
// measuring, so caches keyed on the view (the shadow cache) see real motion.
// Noisier: each measurement renders a different stretch of the drive.
//
// --passes: per-pass GPU timestamps (?prof=1, every segment its own pass).
// On Apple (tile-based) GPUs passes overlap and timestamps exist only at
// pass boundaries, so treat these as indicative only; prefer --ablate.
import {writeFile} from 'node:fs/promises';
import {OFF_BITS, orOff} from '../../src/render/ablation.ts';
import {sleep, withPage, withServer} from './harness.mjs';

const argv = process.argv.slice(2);
const sizes = argv.filter(a => /^\d+x\d+$/.test(a));
if (!sizes.length) sizes.push('1280x720');
const opt = k => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const only = opt('only');
const jsonOut = opt('json');
const extra = opt('q') ?? '';
const frames = Number(opt('frames') ?? 240);
const passes = argv.includes('--passes');
const liveRun = argv.includes('--live');
const ablate = (opt('ablate') ?? '').split(',').filter(Boolean);
// 'mat3' = city material id 3 drawn flat (cityMaterial early-out).
const isMat = n => /^mat\d+$/.test(n);
const bitsOf = s =>
  s.split('+').reduce((b, n) => {
    if (isMat(n)) return b;
    if (!(n in OFF_BITS)) throw new Error(`unknown ablation flag ${n}`);
    return orOff(b, OFF_BITS[n]);
  }, 0);
const matsOf = s => s.split('+').filter(isMat).reduce((b, n) => (b | (1 << Number(n.slice(3)))) >>> 0, 0);
for (const a of ablate) bitsOf(a);

// Free-camera scenarios are fixed views; chase ones follow the autopiloted
// car for a few seconds and then freeze.
export const SCENARIOS = [
  {name: 'day chase', hour: 14, weather: 'sunny', shot: 'chase'},
  {name: 'night rain chase', hour: 22, weather: 'rain', shot: 'chase'},
  {name: 'heli aerial', hour: 16, weather: 'cloudy', heli: true, shot: 'aerial'},
  {name: 'first-person', hour: 15, weather: 'sunny', camera: 'first'},
  // Dense downtown street at eye level, looking along a busy avenue.
  {name: 'downtown street', hour: 13, weather: 'sunny', freecam: [208, 26.7, -349, 2.13, 0.02]},
  // Far skyline: 200 m up at the north-west edge, looking across to downtown.
  {name: 'far skyline', hour: 17.2, weather: 'sunny', freecam: [-2400, 200, -2800, 2.34, -0.1]},
].filter(s => !only || s.name.includes(only));

const ARGS = [
  '--enable-dawn-features=allow_unsafe_apis',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
];

async function setup(page, s) {
  await page.evaluate(s => {
    const g = window.__game;
    g.freeze = false;
    g.renderer.offBits = 0;
    g.renderer.offMats = 0;
    g.hour = s.hour;
    g.weather.set(s.weather, true);
    const heli = g.player.kind === 'heli';
    if (s.heli && !heli) g.player.spawnHeli(g.vehicles.variantsOf('helicopter')[0] ?? 0);
    if (!s.heli && heli)
      g.player.spawnCar(g.player.pos[0], g.player.pos[2], g.vehicles.variants.findIndex(v => v.info.name === 'sports'));
    g.freeMode = false;
    if (s.freecam) {
      const [x, y, z, yaw, pitch] = s.freecam;
      g.freeCam.setPose([x, y, z], yaw, pitch);
      g.freeMode = true;
    } else if (s.camera) {
      g.camera.directorEnabled = false;
      g.camera.mode = s.camera;
    } else {
      g.camera.directorEnabled = true;
      g.camera.mode = 'chase';
      g.forceShot(s.shot, true);
    }
  }, s);
}

const median = a => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/** Medians over `n` frames: rAF interval, GPU span, CPU frame(). */
async function measure(page, n) {
  const r = await page.evaluate(
    n =>
      new Promise(res => {
        const g = window.__game;
        const s0 = g.renderer.prof?.spans.length ?? 0;
        const c0 = g.cpuFrames.length;
        const sr0 = g.renderer.shadowRedraws ?? 0;
        const raf = [];
        let last = performance.now();
        const tick = now => {
          raf.push(now - last);
          last = now;
          if (raf.length < n) return requestAnimationFrame(tick);
          // Timestamp readbacks land a few frames late.
          setTimeout(
            () =>
              res({
                raf: raf.slice(1),
                gpu: g.renderer.prof?.spans.slice(s0) ?? [],
                cpu: g.cpuFrames.slice(c0),
                redraws: ((g.renderer.shadowRedraws ?? 0) - sr0) / raf.length,
                cpuSub: window.__stats.cpu,
                passes: window.__stats.gpu,
              }),
            200,
          );
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
  // Keep the arrays from growing without bound.
  await page.evaluate(() => {
    const g = window.__game;
    if (g.renderer.prof) g.renderer.prof.spans.length = 0;
    g.cpuFrames.length = 0;
  });
  return {
    frame: median(r.raf),
    gpu: median(r.gpu),
    cpu: median(r.cpu),
    redraws: r.redraws,
    cpuSub: r.cpuSub,
    passes: r.passes,
  };
}

const fmt = v => (v === undefined || Number.isNaN(v) ? '-' : v.toFixed(2));
const col = 11;
const row = (label, vals) => console.log(label.padEnd(26) + vals.map(v => (typeof v === 'string' ? v : fmt(v)).padStart(col)).join(''));

const all = {};
await withServer(async base => {
  for (const size of sizes) {
    const [w, h] = size.split('x').map(Number);
    const r = await withPage(
      `${base}/index.html?timespeed=0&ui=0&prof=${passes ? 1 : 'frame'}&size=${size}${extra ? '&' + extra : ''}`,
      async page => {
        const out = {};
        for (const s of SCENARIOS) {
          await setup(page, s);
          await sleep(s.freecam ? 4000 : 3000);
          // CPU subsystems with the simulation running.
          const live = await measure(page, 90);
          if (!liveRun) await page.evaluate(() => (window.__game.freeze = true));
          await sleep(500);
          const res = {live, base: await measure(page, frames), off: {}};
          for (const a of ablate) {
            await page.evaluate(
              ([b, m]) => {
                window.__game.renderer.offBits = b;
                window.__game.renderer.offMats = m;
              },
              [bitsOf(a), matsOf(a)],
            );
            await sleep(400);
            res.off[a] = await measure(page, frames);
          }
          await page.evaluate(() => {
            window.__game.renderer.offBits = 0;
            window.__game.renderer.offMats = 0;
          });
          if (ablate.length) {
            await sleep(400);
            res.base2 = await measure(page, frames);
          }
          // Visible clusters / triangles per cull view (after timing: the
          // count costs an extra atomic per visible cluster).
          // The first readback lands late (behind the uncapped frame queue):
          // wait for two fresh ones.
          for (let k = 0; k < 2; k++) {
            await page.evaluate(() => {
              const r = window.__game.renderer;
              r.cullStats = true;
              delete r.stats.mainTris;
            });
            for (let t = 0; t < 100; t++) {
              await sleep(100);
              if (await page.evaluate(() => window.__game.renderer.stats.mainTris !== undefined)) break;
            }
          }
          res.info = await page.evaluate(() => {
            const s = window.__stats;
            return {
              shot: s.shot,
              tris: s.tris,
              clusters: s.clusters,
              lights: s.lights,
              mainClusters: s.mainClusters,
              mainTris: s.mainTris,
              shadowClusters: s.shadowClusters,
              shadowTris: s.shadowTris,
              cascadeTris: [0, 1, 2, 3].map(c => s[`shadow${c}Tris`]),
              lod: [s.lod0, s.lod1, s.lod2],
            };
          });
          await page.evaluate(() => (window.__game.renderer.cullStats = false));
          out[s.name] = res;
          console.log(
            `[${size}] ${s.name}: frame ${fmt(res.base.frame)}ms gpu ${fmt(res.base.gpu)}ms cpu ${fmt(res.base.cpu)}ms cascade redraws/frame ${fmt(res.base.redraws)} (live: frame ${fmt(live.frame)} gpu ${fmt(live.gpu)} cpu ${fmt(live.cpu)})`,
          );
        }
        return out;
      },
      {timeout: 240000, width: w, height: h, args: ARGS},
    );
    if (r.errors.length) console.log('ERRORS:\n' + r.errors.join('\n'));
    all[size] = r.result;
    const res = r.result;
    const names = Object.keys(res);
    const head = names.map(n => n.slice(0, col - 1));
    console.log(`\n=== ${size} (medians, frozen view) ===`);
    row('', head);
    row('GPU frame ms', names.map(n => res[n].base.gpu));
    row('rAF frame ms', names.map(n => res[n].base.frame));
    row('CPU frame() ms', names.map(n => res[n].base.cpu));
    row('live GPU ms', names.map(n => res[n].live.gpu));
    row('live rAF ms', names.map(n => res[n].live.frame));
    row('live CPU ms', names.map(n => res[n].live.cpu));
    if (ablate.length) {
      console.log('\nGPU ms saved by switching off (baseline - off; + = cost)');
      row('', head);
      for (const a of ablate) row(a, names.map(n => res[n].base.gpu - res[n].off[a].gpu));
      row('(baseline drift)', names.map(n => res[n].base2.gpu - res[n].base.gpu));
      console.log('\nrAF ms saved by switching off');
      row('', head);
      for (const a of ablate) row(a, names.map(n => res[n].base.frame - res[n].off[a].frame));
    }
    console.log('\nCPU ms per subsystem (live simulation, window mean)');
    row('', head);
    const keys = new Set();
    for (const n of names) for (const k of Object.keys(res[n].live.cpuSub ?? {})) keys.add(k);
    for (const k of keys) row(k, names.map(n => res[n].live.cpuSub?.[k]));
    if (passes) {
      console.log('\nGPU per-pass exclusive ms (indicative only on TBDR)');
      row('', head);
      const pk = new Set();
      for (const n of names) for (const k of Object.keys(res[n].base.passes ?? {})) pk.add(k);
      const sorted = [...pk].sort((a, b) => names.reduce((t, n) => t + (res[n].base.passes[b] ?? 0) - (res[n].base.passes[a] ?? 0), 0));
      for (const k of sorted) row(k, names.map(n => res[n].base.passes?.[k]));
    }
    for (const n of names) console.log(`  ${n}: ${JSON.stringify(res[n].info)}`);
  }
});
if (jsonOut) await writeFile(jsonOut, JSON.stringify(all, null, 1));
