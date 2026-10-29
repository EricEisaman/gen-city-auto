import {initGpu, reportError} from './gpu/device.ts';

async function main() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const gpu = await initGpu(canvas);
  void gpu;
  window.__ready = true;
}

main().catch(e => reportError(`[main] ${e instanceof Error ? e.stack : e}`));
