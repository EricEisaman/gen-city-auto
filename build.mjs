// Bundles the game with esbuild into dist/.
//   node build.mjs            one-off development build
//   node build.mjs --prod     minified build (used by the GitHub Pages workflow)
//   node build.mjs --watch    rebuild on change (add --serve to also start express)
import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';

const args = new Set(process.argv.slice(2));
const prod = args.has('--prod');

await fs.mkdir('dist', {recursive: true});
for (const page of ['index.html', 'vehicles.html']) {
  await fs.copyFile(page, `dist/${page}`);
}
await fs.cp('static', 'dist', {recursive: true}).catch(() => {});

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
  sourcemap: true,
  minify: prod,
  loader: {'.wgsl': 'text'},
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
}
