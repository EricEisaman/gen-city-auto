// DOM menu, HUD and help overlay.

import {PRESETS, type CityType} from '../city/config.ts';
import {CAMERA_MODES} from '../game/camera.ts';
import {WEATHER_KINDS} from '../game/weather.ts';
import type {Game} from '../game/game.ts';
import {FIELDS, type Settings} from './settings.ts';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
};

export class UI {
  private game: Game;
  private hud = document.getElementById('hud')!;
  private stats = document.getElementById('stats')!;
  private help = document.getElementById('help')!;
  private menu = document.getElementById('menu')!;
  private timeInput!: HTMLInputElement;
  private weatherSel!: HTMLSelectElement;
  private camSel!: HTMLSelectElement;
  private perf = document.getElementById('perf')!;
  private vehBtn = document.getElementById('btn-veh')!;
  /** Graphics setting selects, refreshed when a preset changes others. */
  private gfxSels = new Map<keyof Settings, HTMLSelectElement>();
  showStats = false;

  constructor(game: Game) {
    this.game = game;
    const g = game;
    this.build();
    for (const b of document.querySelectorAll<HTMLElement>('#toolbar button'))
      b.onmousedown = e => e.preventDefault(); // keep keyboard focus on the canvas
    document.getElementById('btn-cam')!.onclick = () => g.cycleCamera();
    document.getElementById('btn-veh')!.onclick = () => g.toggleHeli();
    document.getElementById('btn-menu')!.onclick = () => this.toggleMenu();
    this.help.innerHTML =
      '<b>WASD</b> drive / fly &nbsp; <b>Space</b> handbrake / climb &nbsp; <b>Shift</b> descend &nbsp; <b>Q/E</b> yaw<br>' +
      '<b>C</b> camera (last = free fly: WASD, Space/Shift, drag to look, wheel = speed) &nbsp; <b>L</b> copy link to this view<br>' +
      '<b>K</b> auto director &nbsp; <b>V</b> car / helicopter &nbsp; <b>B</b> next vehicle<br>' +
      '<b>T</b> +1 hour &nbsp; <b>Y</b> weather &nbsp; <b>N</b> new city &nbsp; <b>M</b> menu &nbsp; <b>F</b> stats &nbsp; <b>H</b> hide help<br>' +
      'Let go of the controls and the car drives itself while the director films it.';
  }

  private build() {
    const g = this.game;
    const citySel = el('select');
    for (const [k, p] of Object.entries(PRESETS))
      citySel.append(el('option', {value: k, textContent: p.name}));
    citySel.value = g.cityType;
    const seed = el('input', {
      type: 'number',
      value: String(g.seed),
    } as Partial<HTMLInputElement>);
    seed.style.width = '80px';
    const gen = el('button', {textContent: 'Generate'});
    gen.onclick = () =>
      void g.regenerate(citySel.value as CityType, Number(seed.value) || 1);
    const rnd = el('button', {textContent: 'Random city'});
    rnd.onclick = () => {
      seed.value = String(Math.floor(Math.random() * 100000));
      void g.regenerate(citySel.value as CityType, Number(seed.value));
    };
    this.timeInput = el('input', {
      type: 'range',
      min: '0',
      max: '24',
      step: '0.05',
      value: String(g.hour),
    } as Partial<HTMLInputElement>);
    this.timeInput.oninput = () => (g.hour = Number(this.timeInput.value));
    const speedSel = el('select');
    for (const [label, v] of [
      ['Paused', 0],
      ['1 min/s', 1 / 60],
      ['10 min/s', 1 / 6],
      ['1 h/s', 1],
    ] as const)
      speedSel.append(el('option', {value: String(v), textContent: label}));
    speedSel.value = String(g.timeSpeed);
    speedSel.onchange = () => (g.timeSpeed = Number(speedSel.value));
    this.weatherSel = el('select');
    for (const w of WEATHER_KINDS)
      this.weatherSel.append(el('option', {value: w, textContent: w}));
    this.weatherSel.value = g.weather.kind;
    this.weatherSel.onchange = () =>
      g.weather.set(this.weatherSel.value as (typeof WEATHER_KINDS)[number]);
    const cycle = el('input', {
      type: 'checkbox',
      checked: g.weather.cycle,
    } as Partial<HTMLInputElement>);
    cycle.onchange = () => (g.weather.cycle = cycle.checked);
    this.camSel = el('select');
    for (const m of [...CAMERA_MODES, 'free'])
      this.camSel.append(el('option', {value: m, textContent: m}));
    this.camSel.onchange = () => {
      g.freeMode = this.camSel.value === 'free';
      if (!g.freeMode)
        g.camera.mode = this.camSel.value as (typeof CAMERA_MODES)[number];
    };
    const director = el('input', {
      type: 'checkbox',
      checked: g.camera.directorEnabled,
    } as Partial<HTMLInputElement>);
    director.onchange = () => (g.camera.directorEnabled = director.checked);
    const vehSel = el('select');
    vehSel.onfocus = () => {
      vehSel.innerHTML = '';
      g.vehicles.variants.forEach((v, i) => {
        if (v.info.kind !== 'train' && v.info.kind !== 'person')
          vehSel.append(
            el('option', {
              value: String(i),
              textContent: `${v.info.name} #${v.info.seed}`,
            }),
          );
      });
      vehSel.value = String(g.player.variant);
    };
    vehSel.onchange = () => g.selectVehicle(Number(vehSel.value));
    vehSel.append(el('option', {textContent: 'choose…'}));
    const link = el('button', {textContent: 'Copy link to this view'});
    link.onclick = () => {
      const url = g.shareUrl();
      void navigator.clipboard
        ?.writeText(url)
        .then(() => (link.textContent = 'Copied!'))
        .catch(() => prompt('Link to this view', url));
      setTimeout(() => (link.textContent = 'Copy link to this view'), 1500);
    };
    const row = (label: string, ...c: Node[]) =>
      el('label', {}, label, el('span', {}, ...c));
    this.menu.append(
      el('div', {className: 'menu-title'}, 'GEN CITY AUTO'),
      row('City', citySel),
      row('Seed', seed, gen),
      row('', rnd),
      row('Time', this.timeInput),
      row('Clock', speedSel),
      row('Weather', this.weatherSel),
      row('Cycle weather', cycle),
      row('Camera', this.camSel),
      row('Auto director', director),
      row('Vehicle', vehSel),
      row('', link),
      el('div', {className: 'menu-section'}, 'GRAPHICS'),
    );
    for (const f of FIELDS) {
      const sel = el('select');
      f.options.forEach(([label], i) =>
        sel.append(el('option', {value: String(i), textContent: label})),
      );
      sel.onchange = () => {
        const v = f.options[Number(sel.value)][1];
        g.setSetting(f.key, v as never);
        this.syncGraphics();
      };
      this.gfxSels.set(f.key, sel);
      this.menu.append(row(f.label, sel));
    }
    const reset = el('button', {textContent: 'Reset graphics to defaults'});
    reset.onclick = () => {
      g.resetSettings();
      this.syncGraphics();
    };
    this.menu.append(row('', reset));
    this.syncGraphics();
  }

  /** Show the effective graphics settings in the menu. */
  syncGraphics() {
    const s = this.game.settings;
    for (const f of FIELDS) {
      const sel = this.gfxSels.get(f.key)!;
      const i = f.options.findIndex(([, v]) => v === s[f.key]);
      // (A URL value outside the menu's list, e.g. ?scale=60, shows blank.)
      sel.value = String(i);
      sel.parentElement!.parentElement!.style.display =
        f.key === 'targetFps' && s.scale !== 'dynamic' ? 'none' : '';
    }
  }

  toggleMenu() {
    this.menu.classList.toggle('hidden');
  }

  toggleHelp() {
    this.game.setSetting('help', !this.game.settings.help);
    this.syncGraphics();
  }

  update(fps: number) {
    const g = this.game;
    const p = g.player;
    const kmh = Math.round(Math.abs(p.speed) * 3.6);
    const h = Math.floor(g.hour);
    const m = Math.floor((g.hour - h) * 60);
    const mode = g.freeMode
      ? 'FREE CAMERA'
      : p.autopilot && g.camera.directorEnabled
        ? `AUTOPILOT · ${g.camera.shot?.name ?? ''}`
        : p.autopilot
          ? `AUTOPILOT · ${g.camera.mode}`
          : `MANUAL · ${g.camera.mode}`;
    this.hud.innerHTML = `<div class="speed">${kmh}<span class="unit"> km/h</span></div><div class="info">${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} · ${g.weather.kind} · ${mode}</div>`;
    if (document.activeElement !== this.timeInput)
      this.timeInput.value = String(g.hour);
    if (document.activeElement !== this.weatherSel)
      this.weatherSel.value = g.weather.kind;
    if (document.activeElement !== this.camSel)
      this.camSel.value = g.freeMode ? 'free' : g.camera.mode;
    this.stats.style.display = this.showStats ? '' : 'none';
    this.help.style.display = g.settings.help ? '' : 'none';
    const vehIcon = g.player.kind === 'car' ? '🚁' : '🚗';
    if (this.vehBtn.textContent !== vehIcon) this.vehBtn.textContent = vehIcon;
    this.perf.style.display = g.settings.readout ? '' : 'none';
    if (g.settings.readout) {
      const r = g.renderer;
      const [w, h] = r.renderSize;
      const c = r.gpu.canvas;
      const gpu = r.gpuMs > 0 ? `GPU ${r.gpuMs.toFixed(1)} ms` : 'GPU -';
      this.perf.textContent =
        `${fps.toFixed(0)} fps · ${(1000 / Math.max(fps, 1)).toFixed(1)} ms · ${gpu}\n` +
        `${w}x${h} → ${c.width}x${c.height} (${Math.round((w / c.width) * 100)}%)`;
    }
    if (this.showStats) {
      const s = {
        ...g.renderer.stats,
        ...g.city?.stats,
        cars: g.traffic?.cars.length ?? 0,
        vehicleInstances: g.vehicles.instanceCount,
      };
      this.stats.textContent =
        `${fps.toFixed(0)} fps\n` +
        Object.entries(s)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n') +
        profText('gpu ms', g.renderer.prof?.averages) +
        profText('cpu ms', g.cpuProf?.averages);
    }
  }
}

function profText(title: string, avg: Record<string, number> | undefined) {
  if (!avg || !Object.keys(avg).length) return '';
  return (
    `\n-- ${title}\n` +
    Object.entries(avg)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v.toFixed(2)}`)
      .join('\n')
  );
}
