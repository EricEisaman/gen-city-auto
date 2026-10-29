import type {CityType} from './city/config.ts';
import {initGpu, reportError, resizeToCss} from './gpu/device.ts';
import type {Vec3} from './math/vec.ts';
import {Renderer} from './render/renderer.ts';
import {City} from './world/city.ts';

const params = new URLSearchParams(location.search);

async function main() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  resizeToCss(canvas);
  const gpu = await initGpu(canvas);
  const renderer = await Renderer.create(gpu);
  const loadMsg = document.getElementById('loadmsg')!;
  const loadBar = document.getElementById('loadbar')!;
  const progress = (msg: string, f: number) => {
    loadMsg.textContent = msg;
    loadBar.style.width = `${Math.round(f * 100)}%`;
  };
  const cam = (params.get('cam') ?? '0,120,300,0,-0.2').split(',').map(Number);
  let eye: Vec3 = [cam[0], cam[1], cam[2]];
  let yaw = cam[3] ?? 0;
  let pitch = cam[4] ?? -0.2;
  const city = new City(renderer, (params.get('city') ?? 'neon') as CityType, Number(params.get('seed') ?? 1));
  await city.load(progress, () => eye);
  document.getElementById('loading')!.style.display = 'none';

  const keys = new Set<string>();
  addEventListener('keydown', e => keys.add(e.code));
  addEventListener('keyup', e => keys.delete(e.code));
  canvas.addEventListener('mousemove', e => {
    if (e.buttons & 1) {
      yaw -= e.movementX * 0.003;
      pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.003));
    }
  });
  const hour = Number(params.get('time') ?? 15);
  const weather = params.get('weather') ?? 'clear';
  const wx = {
    clear: {cloud: 0.25, rain: 0, wetness: 0, fog: 0},
    cloudy: {cloud: 0.75, rain: 0, wetness: 0, fog: 0.1},
    rain: {cloud: 0.9, rain: 0.7, wetness: 0.9, fog: 0.35},
    storm: {cloud: 1, rain: 1, wetness: 1, fog: 0.5},
  }[weather] ?? {cloud: 0.25, rain: 0, wetness: 0, fog: 0};
  let last = performance.now();
  const t0 = last;
  let frames = 0;
  const statsEl = document.getElementById('stats')!;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    resizeToCss(canvas);
    const speed = keys.has('ShiftLeft') ? 120 : 30;
    const fwd: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const right: Vec3 = [Math.cos(yaw), 0, Math.sin(yaw)];
    const mv = (v: Vec3, s: number) => {
      eye = [eye[0] + v[0] * s, eye[1] + v[1] * s, eye[2] + v[2] * s];
    };
    if (keys.has('KeyW')) mv(fwd, speed * dt);
    if (keys.has('KeyS')) mv(fwd, -speed * dt);
    if (keys.has('KeyD')) mv(right, speed * dt);
    if (keys.has('KeyA')) mv(right, -speed * dt);
    eye[1] = Math.max(eye[1], city.groundHeight(eye[0], eye[2]) + 1.5);
    city.updateStreaming(eye);
    const night = renderer.sky.night;
    city.updateLights(eye, night, 1);
    renderer.render({
      eye,
      target: [eye[0] + fwd[0], eye[1] + fwd[1], eye[2] + fwd[2]],
      fov: 1.0,
      near: 0.1,
      time: (now - t0) / 1000,
      dt,
      hour,
      weather: {...wx, lightning: 0, wind: [0.8, 0.3]},
      debug: Number(params.get('debug') ?? 0),
    });
    frames++;
    if (frames % 15 === 0) {
      statsEl.textContent = `${(1 / dt).toFixed(0)} fps  ${JSON.stringify(renderer.stats)}  ${JSON.stringify(city.stats)}`;
    }
    if (frames === 30) window.__ready = true;
    window.__stats = {...renderer.stats, ...city.stats, eye};
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch(e => reportError(`[main] ${e instanceof Error ? e.stack : e}`));
