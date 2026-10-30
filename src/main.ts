import type {CityType} from './city/config.ts';
import type {CameraMode} from './game/camera.ts';
import {Game} from './game/game.ts';
import type {WeatherKind} from './game/weather.ts';
import {initGpu, reportError, resizeToCss} from './gpu/device.ts';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) =>
  params.has(k) ? Number(params.get(k)) : d;

async function main() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  // size=WIDTHxHEIGHT fixes the canvas size in CSS pixels (e.g. for videos).
  const size = params.get('size')?.match(/^(\d+)x(\d+)$/);
  if (size) {
    canvas.style.width = `${size[1]}px`;
    canvas.style.height = `${size[2]}px`;
  }
  // ui=0 hides the overlays (clean screenshots and videos).
  if (params.get('ui') === '0')
    for (const id of ['hud', 'stats', 'help', 'toolbar'])
      document.getElementById(id)!.style.visibility = 'hidden';
  resizeToCss(canvas);
  const gpu = await initGpu(canvas);
  const spawn = params.get('spawn')?.split(',').map(Number) as
    [number, number] | undefined;
  const game = new Game(gpu, {
    cityType: (params.get('city') ?? 'neon') as CityType,
    seed: num('seed', 1),
    hour: num('time', 16.5),
    timeSpeed: num('timespeed', 1 / 60),
    weather: (params.get('weather') ?? 'sunny') as WeatherKind,
    camera: (params.get('cam') as CameraMode | null) ?? undefined,
    director: params.get('director') !== '0',
    vehicle: params.get('vehicle') ?? 'sports',
    spawn,
    shot: params.get('shot') ?? undefined,
    debug: num('debug', 0),
    traffic: num('traffic', 380),
    quality: params.get('quality') === 'low' ? 0 : 1,
    freecam: params.get('freecam')?.split(',').map(Number),
  });
  await game.init();
  (window as unknown as {__game: Game}).__game = game;
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
    last = now;
    try {
      game.frame(dt);
    } catch (e) {
      reportError(`[frame] ${e instanceof Error ? e.stack : e}`);
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch(e => reportError(`[main] ${e instanceof Error ? e.stack : e}`));
