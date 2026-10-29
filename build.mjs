// Bundles the game with esbuild into dist/.
//   node build.mjs            one-off development build
//   node build.mjs --prod     minified build (used by the GitHub Pages workflow)
//   node build.mjs --watch    rebuild on change (add --serve to also start express)
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const args = new Set(process.argv.slice(2));
const prod = args.has('--prod');

await fs.mkdir('dist', {recursive: true});
for (const page of ['index.html', 'vehicles.html']) {
  await fs.copyFile(page, `dist/${page}`);
}
await fs.cp('static', 'dist', {recursive: true}).catch(() => {});

// Production: strip comments and redundant whitespace from WGSL sources.
const minifyWgsl = {
  name: 'minify-wgsl',
  setup(build) {
    build.onLoad({filter: /\.wgsl$/}, async args => {
      const src = await fs.readFile(args.path, 'utf8');
      const out = src
        .replace(/\/\/.*$/gm, '')
        .split('\n')
        .map(l => l.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .join('\n');
      return {contents: out, loader: 'text'};
    });
  },
};

const options = {
  entryPoints: {
    main: 'src/main.ts',
    'city-worker': 'src/workers/city-worker.ts',
    turntable: 'src/tools/turntable.ts',
    'vehicle-worker': 'src/workers/vehicle-worker.ts',
  },
  bundle: true,
  format: 'esm',
  target: 'es2023',
  outdir: 'dist',
  sourcemap: !prod,
  minify: prod,
  loader: {'.wgsl': 'text'},
  plugins: prod ? [minifyWgsl] : [],
  logLevel: 'info',
};

if (args.has('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  if (args.has('--serve')) {
    const {startServer} = await import('./server.mjs');
    startServer();
  }
} else {
  await esbuild.build(options);
  if (prod) {
    // Report compressed sizes of what ships.
    let raw = 0;
    let gz = 0;
    const rows = [];
    for (const f of await fs.readdir('dist')) {
      if (!/\.(js|css|html)$/.test(f)) continue;
      const b = await fs.readFile(`dist/${f}`);
      const g = zlib.gzipSync(b, {level: 9}).length;
      raw += b.length;
      gz += g;
      rows.push(`${f.padEnd(24)} ${(b.length / 1024).toFixed(1).padStart(8)} KB  gzip ${(g / 1024).toFixed(1).padStart(7)} KB`);
    }
    console.log(rows.join('\n'));
    console.log(`${'total'.padEnd(24)} ${(raw / 1024).toFixed(1).padStart(8)} KB  gzip ${(gz / 1024).toFixed(1).padStart(7)} KB`);
  }
}
