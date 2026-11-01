// Sampled main-thread JS CPU profile (Chrome DevTools Protocol Profiler) over
// the prof.mjs scenarios, with the simulation running.
//
//   node test/puppeteer/cpuprof.mjs [WxH] [--only=substr] [--secs=4] [--top=25]
//        [--q=extra&query] [--json=out.json] [--save=dir]
//
// Per scenario: self time per source file and per function (ms per frame),
// mapped back to src/ through dist/main.js.map, plus the inclusive time of
// the main per-frame entry points. '(idle)' is the main thread waiting
// (for rAF or the GPU process); '(program)' is native work outside JS
// (WebGPU calls into the GPU process show up under their JS caller as the
// native function's own name, e.g. writeBuffer). --save writes each
// .cpuprofile for DevTools.
import fs from 'node:fs/promises';
import path from 'node:path';
import {sleep, withPage, withServer} from './harness.mjs';

const argv = process.argv.slice(2);
const size = argv.find(a => /^\d+x\d+$/.test(a)) ?? '1280x720';
const opt = k => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const only = opt('only');
const secs = Number(opt('secs') ?? 4);
const top = Number(opt('top') ?? 25);
const extra = opt('q') ?? '';
const jsonOut = opt('json');
const saveDir = opt('save');

// Same scenarios as prof.mjs.
const SCENARIOS = [
  {name: 'day chase', hour: 14, weather: 'sunny', shot: 'chase'},
  {name: 'night rain chase', hour: 22, weather: 'rain', shot: 'chase'},
  {name: 'heli aerial', hour: 16, weather: 'cloudy', heli: true, shot: 'aerial'},
  {name: 'first-person', hour: 15, weather: 'sunny', camera: 'first'},
  {name: 'downtown street', hour: 13, weather: 'sunny', freecam: [208, 26.7, -349, 2.13, 0.02]},
  {name: 'far skyline', hour: 17.2, weather: 'sunny', freecam: [-2400, 200, -2800, 2.34, -0.1]},
].filter(s => !only || s.name.includes(only));

async function setup(page, s) {
  await page.evaluate(s => {
    const g = window.__game;
    g.freeze = false;
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

// --- Source maps (VLQ) -------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = Object.fromEntries([...B64].map((c, i) => [c, i]));
async function loadMap(file) {
  const m = JSON.parse(await fs.readFile(file, 'utf8'));
  // lines[genLine] = sorted [genCol, srcIdx, srcLine][]
  const lines = [];
  let src = 0;
  let sl = 0;
  let sc = 0;
  for (const lineStr of m.mappings.split(';')) {
    const segs = [];
    let gc = 0;
    if (lineStr)
      for (const seg of lineStr.split(',')) {
        const v = [];
        let shift = 0;
        let val = 0;
        for (const ch of seg) {
          const d = B64I[ch];
          val += (d & 31) << shift;
          if (d & 32) shift += 5;
          else {
            v.push(val & 1 ? -(val >>> 1) : val >>> 1);
            val = 0;
            shift = 0;
          }
        }
        gc += v[0];
        if (v.length >= 4) {
          src += v[1];
          sl += v[2];
          sc += v[3];
          segs.push([gc, src, sl]);
        }
      }
    lines.push(segs);
  }
  return {
    lookup(line, col) {
      const segs = lines[line];
      if (!segs || !segs.length) return null;
      let lo = 0;
      let hi = segs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segs[mid][0] <= col) lo = mid;
        else hi = mid - 1;
      }
      const s = segs[lo];
      return {file: m.sources[s[1]].replace(/^(\.\.\/)+/, ''), line: s[2] + 1};
    },
  };
}

const RENDER_FILES = /^src\/render\/(renderer|frame|shadow-cache|shadow-cull|cluster-pool|profiler|rain|sprites|detail-tex|sign-atlas|ablation)\.ts$/;
function categoryOf(file, fn) {
  if (RENDER_FILES.test(file)) return 'renderer';
  if (file === 'src/render/vehicles.ts') return 'vehicle instances';
  if (file === 'src/game/traffic.ts') return fn === 'draw' ? 'traffic draw' : 'traffic sim';
  if (file === 'src/game/pedestrians.ts') return 'pedestrians';
  if (file === 'src/game/trains.ts') return 'trains+helis';
  if (file === 'src/game/player.ts') return 'player/physics';
  if (file === 'src/game/camera.ts') return 'camera';
  if (file === 'src/world/city.ts') return fn === 'updateLights' ? 'lights gather' : 'streaming/city';
  if (file === 'src/game/game.ts') return 'game.frame (headlights etc)';
  if (file.startsWith('src/ui/')) return 'ui';
  if (file === 'src/game/input.ts') return 'input';
  if (file === 'src/main.ts') return 'main loop';
  if (file === 'src/world/sky.ts') return 'renderer';
  return null;
}

// --- Profile aggregation -----------------------------------------------------
function analyse(profile, map, frames) {
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  const loc = n => {
    const cf = n.callFrame;
    const name = cf.functionName || '(anonymous)';
    if (!cf.url) return {file: name.startsWith('(') ? name : '(native)', fn: name};
    if (/main\.js$/.test(cf.url)) {
      const r = map.lookup(cf.lineNumber, cf.columnNumber);
      if (r) return {file: r.file, fn: `${name} ${r.file.replace(/^src\//, '')}:${r.line}`};
    }
    return {file: cf.url.replace(/^.*\//, ''), fn: name};
  };
  // Native leaves (WebGPU calls etc.) are charged to "native:<name> <- caller file".
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const perFile = new Map();
  const perFn = new Map();
  let total = 0;
  for (const [id, ms] of self) {
    const n = byId.get(id);
    let {file, fn} = loc(n);
    if (file === '(native)') {
      const p = byId.get(parent.get(id));
      const pl = p ? loc(p) : {file: '?'};
      fn = `native ${fn} <- ${pl.fn ?? pl.file}`;
      file = `native <- ${pl.file}`;
    }
    perFile.set(file, (perFile.get(file) ?? 0) + ms);
    perFn.set(fn, (perFn.get(fn) ?? 0) + ms);
    total += ms;
  }
  // Inclusive time per function (outermost occurrence only).
  const incl = new Map();
  const walk = (id, seen) => {
    const n = byId.get(id);
    const {fn} = loc(n);
    let t = self.get(id) ?? 0;
    const inner = new Set(seen);
    inner.add(fn);
    for (const c of n.children ?? []) t += walk(c, inner);
    if (!seen.has(fn)) incl.set(fn, (incl.get(fn) ?? 0) + t);
    return t;
  };
  walk(profile.nodes[0].id, new Set());
  // Subsystem of each sample: the nearest frame (leaf up) in a file that
  // owns a subsystem; shared helpers (math, road geometry) are skipped.
  const perCat = new Map();
  for (const [id, ms] of self) {
    let cat = null;
    const leaf = byId.get(id);
    const leafNative = !leaf.callFrame.url && !leaf.callFrame.functionName.startsWith('(');
    for (let n = leaf; n && !cat; n = byId.get(parent.get(n.id))) {
      const name = n.callFrame.functionName;
      if (name === '(garbage collector)' || name === '(program)' || name === '(idle)') {
        cat = name;
        break;
      }
      const {file} = loc(n);
      const c = categoryOf(file, name);
      if (!c) continue;
      cat = c;
      if (leafNative) {
        const ln = leaf.callFrame.functionName;
        if (c === 'renderer') cat = ln === 'writeBuffer' ? 'renderer writeBuffer (mostly GPU backpressure wait)' : 'renderer WebGPU calls';
        else if (c === 'vehicle instances') cat = 'vehicle upload/bind';
      }
    }
    cat ??= '(other)';
    perCat.set(cat, (perCat.get(cat) ?? 0) + ms);
  }
  const per = m => [...m].map(([k, v]) => [k, v / frames]).sort((a, b) => b[1] - a[1]);
  return {total: total / frames, perCat: per(perCat), perFile: per(perFile), perFn: per(perFn), incl: per(incl)};
}

const fmt = v => v.toFixed(3).padStart(8);
const all = {};
await withServer(async base => {
  const map = await loadMap('dist/main.js.map');
  const [w, h] = size.split('x').map(Number);
  const r = await withPage(
    `${base}/index.html?ui=0&prof=frame&size=${size}${/(^|&)scale=/.test(extra) ? '' : '&scale=100'}${extra ? '&' + extra : ''}`,
    async page => {
      const cdp = await page.createCDPSession();
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', {interval: 100});
      for (const s of SCENARIOS) {
        await setup(page, s);
        await sleep(s.freecam ? 4000 : 3000);
        const f0 = await page.evaluate(() => window.__game.frames);
        await cdp.send('Profiler.start');
        await sleep(secs * 1000);
        const {profile} = await cdp.send('Profiler.stop');
        const f1 = await page.evaluate(() => window.__game.frames);
        const frames = f1 - f0;
        if (saveDir) {
          await fs.mkdir(saveDir, {recursive: true});
          await fs.writeFile(path.join(saveDir, `${s.name.replace(/\W+/g, '-')}.cpuprofile`), JSON.stringify(profile));
        }
        const a = analyse(profile, map, frames);
        all[s.name] = {frames, msPerFrame: (secs * 1000) / frames, ...a};
        console.log(`\n=== ${s.name}: ${frames} frames, ${((secs * 1000) / frames).toFixed(2)} ms/frame wall ===`);
        console.log('-- ms/frame by subsystem');
        for (const [k, v] of a.perCat) console.log(fmt(v) + '  ' + k);
        console.log('-- self ms/frame by file');
        for (const [k, v] of a.perFile.slice(0, top)) console.log(fmt(v) + '  ' + k);
        console.log('-- self ms/frame by function');
        for (const [k, v] of a.perFn.slice(0, top)) console.log(fmt(v) + '  ' + k);
        console.log('-- inclusive ms/frame');
        for (const [k, v] of a.incl.slice(0, top)) console.log(fmt(v) + '  ' + k);
      }
    },
    {timeout: 240000, width: w, height: h, args: ['--enable-dawn-features=allow_unsafe_apis', '--disable-gpu-vsync', '--disable-frame-rate-limit']},
  );
  if (r.errors.length) console.log('ERRORS:\n' + r.errors.join('\n'));
});
// Subsystem table across scenarios.
const names = Object.keys(all);
const cats = new Set();
for (const n of names) for (const [k] of all[n].perCat) cats.add(k);
const col = 11;
console.log('\n=== ms/frame by subsystem (sampled, live simulation) ===');
console.log(''.padEnd(44) + names.map(n => n.slice(0, col - 1).padStart(col)).join(''));
const val = (n, k) => all[n].perCat.find(e => e[0] === k)?.[1] ?? 0;
const sorted = [...cats].sort((a, b) => names.reduce((t, n) => t + val(n, b) - val(n, a), 0));
for (const k of sorted) console.log(k.slice(0, 43).padEnd(44) + names.map(n => val(n, k).toFixed(2).padStart(col)).join(''));
console.log('wall ms/frame'.padEnd(44) + names.map(n => all[n].msPerFrame.toFixed(2).padStart(col)).join(''));
if (jsonOut) await fs.writeFile(jsonOut, JSON.stringify(all, null, 1));
