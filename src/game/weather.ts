// Weather states with smooth transitions, surface wetness that builds up in
// rain and dries afterwards, and lightning during storms.

import {Rng} from '../math/random.ts';
import {lerp} from '../math/vec.ts';
import type {Weather} from '../render/renderer.ts';

export type WeatherKind = 'sunny' | 'cloudy' | 'rain' | 'storm';
export const WEATHER_KINDS: WeatherKind[] = [
  'sunny',
  'cloudy',
  'rain',
  'storm',
];

const TARGETS: Record<
  WeatherKind,
  {cloud: number; rain: number; fog: number; wind: number}
> = {
  sunny: {cloud: 0.42, rain: 0, fog: 0.0, wind: 0.4},
  cloudy: {cloud: 0.78, rain: 0, fog: 0.12, wind: 0.7},
  rain: {cloud: 0.92, rain: 0.65, fog: 0.35, wind: 0.9},
  storm: {cloud: 1.0, rain: 1.0, fog: 0.55, wind: 1.6},
};

export class WeatherSystem {
  kind: WeatherKind = 'sunny';
  cycle = false;
  state: Weather = {
    cloud: 0.42,
    rain: 0,
    wetness: 0,
    fog: 0,
    lightning: 0,
    wind: [0.8, 0.3],
  };
  private rng = new Rng(55);
  private nextFlash = 5;
  private flash = 0;
  private cycleTimer = 0;

  set(kind: WeatherKind, immediate = false) {
    this.kind = kind;
    if (immediate) {
      const t = TARGETS[kind];
      this.state.cloud = t.cloud;
      this.state.rain = t.rain;
      this.state.fog = t.fog;
      this.state.wetness = t.rain > 0 ? 0.9 + t.rain * 0.1 : 0;
    }
  }

  update(dt: number) {
    if (this.cycle) {
      this.cycleTimer += dt;
      if (this.cycleTimer > 90) {
        this.cycleTimer = 0;
        const i = WEATHER_KINDS.indexOf(this.kind);
        this.kind =
          WEATHER_KINDS[
            (i + (this.rng.chance(0.7) ? 1 : 3)) % WEATHER_KINDS.length
          ];
      }
    }
    const t = TARGETS[this.kind];
    const k = 1 - Math.exp(-dt * 0.15);
    const s = this.state;
    s.cloud = lerp(s.cloud, t.cloud, k);
    s.rain = lerp(s.rain, t.rain, k * 1.5);
    s.fog = lerp(s.fog, t.fog, k);
    // Wetness: quick to soak, slow to dry.
    s.wetness =
      s.rain > 0.05
        ? Math.min(1, s.wetness + dt * 0.05 * s.rain)
        : Math.max(0, s.wetness - dt * 0.004);
    const w = lerp(Math.hypot(s.wind[0], s.wind[1]), t.wind, k);
    s.wind = [0.94 * w, 0.34 * w];
    // Lightning.
    if (this.kind === 'storm') {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) {
        this.flash = 1;
        this.nextFlash = this.rng.range(3, 12);
      }
    }
    this.flash = Math.max(0, this.flash - dt * 4);
    const flicker =
      this.flash > 0 ? this.flash * (0.6 + 0.4 * Math.sin(this.flash * 60)) : 0;
    s.lightning = flicker;
  }
}
