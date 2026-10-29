// Sun/moon positions and an analytic approximation of the atmosphere used for
// lighting constants (sun color at the ground, sky/ground ambient, city glow).
// The rendered sky itself comes from the GPU atmosphere LUTs.

import {clamp, smoothstep, type Vec3} from '../math/vec.ts';

export const SUN_ILLUMINANCE = 12;

export interface SkyState {
  sunDir: Vec3;
  /** 0..1, fades the sun at the horizon. */
  sunUp: number;
  sunColor: Vec3;
  moonDir: Vec3;
  moonLight: number;
  moonPhase: number;
  skyAmbient: Vec3;
  groundAmbient: Vec3;
  cityGlow: Vec3;
  /** 0 = day, 1 = full night. */
  night: number;
}

/** Tokyo latitude-ish sun path. hour in [0, 24). */
export function sunDirection(hour: number, dayOfYear = 245): Vec3 {
  const lat = (35.7 * Math.PI) / 180;
  const decl =
    ((23.44 * Math.PI) / 180) *
    Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));
  const ha = ((hour - 12) / 24) * 2 * Math.PI;
  const alt = Math.asin(
    Math.sin(lat) * Math.sin(decl) +
      Math.cos(lat) * Math.cos(decl) * Math.cos(ha),
  );
  const az = Math.atan2(
    -Math.sin(ha),
    Math.tan(decl) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha),
  );
  // World: +x east, -z north (so +z is south, toward the bay).
  return [
    Math.sin(az) * Math.cos(alt),
    Math.sin(alt),
    -Math.cos(az) * Math.cos(alt),
  ];
}

function transmittance(elev: number, haze: number): Vec3 {
  const deg = (elev * 180) / Math.PI;
  const s = Math.max(Math.sin(elev), 0);
  const airmass =
    1 / (s + 0.50572 * Math.pow(Math.max(deg + 6.07995, 0.01), -1.6364));
  const tauR = [0.0464, 0.108, 0.265];
  const tauM = 0.0053 * haze * 2.5;
  const tauO = [0.0012, 0.0035, 0.0002];
  return [0, 1, 2].map(k =>
    Math.exp(-(tauR[k] + tauM + tauO[k] * 10) * Math.min(airmass, 40)),
  ) as Vec3;
}

export function computeSky(
  hour: number,
  cloudCover: number,
  rain: number,
  haze: number,
  cityLights: number,
): SkyState {
  const sunDir = sunDirection(hour);
  const elev = Math.asin(clamp(sunDir[1], -1, 1));
  const sunUp = smoothstep(-0.02, 0.04, sunDir[1]);
  const T = transmittance(Math.max(elev, -0.05), haze);
  const overcast = clamp(cloudCover * 1.1 - 0.1, 0, 1);
  const sunScale =
    SUN_ILLUMINANCE * sunUp * (1 - overcast * 0.85) * (1 - rain * 0.3);
  const sunColor: Vec3 = [T[0] * sunScale, T[1] * sunScale, T[2] * sunScale];

  // Moon roughly opposite the sun, offset so it is not exactly antipodal.
  const moonDir = sunDirection((hour + 12.6) % 24, 245 + 10);
  const moonPhase = 0.7;
  const moonLight = smoothstep(-0.02, 0.1, moonDir[1]) * (1 - overcast * 0.8);

  // Sky ambient: blue sky irradiance that fades through twilight to night.
  const day = smoothstep(-0.12, 0.25, sunDir[1]);
  const twilight =
    smoothstep(-0.18, 0.0, sunDir[1]) * (1 - smoothstep(0.0, 0.2, sunDir[1]));
  const clear: Vec3 = [0.32, 0.48, 0.85];
  const grey: Vec3 = [0.62, 0.66, 0.72];
  const amb = (k: number) => {
    const base = clear[k] * (1 - overcast) + grey[k] * overcast;
    return (
      base * (day * 0.6 * (1 - rain * 0.35)) +
      [0.32, 0.18, 0.2][k] * twilight * 0.6
    );
  };
  const night = 1 - smoothstep(-0.16, 0.02, sunDir[1]);
  const moonAmb = 0.012 * moonLight;
  const glow: Vec3 = [0.06 * cityLights, 0.035 * cityLights, 0.02 * cityLights];
  const cityGlow: Vec3 = glow.map(
    g => g * night * (0.5 + overcast * 0.9 + rain * 0.5),
  ) as Vec3;
  const skyAmbient: Vec3 = [0, 1, 2].map(
    k => amb(k) + moonAmb * [0.6, 0.7, 1.0][k] + 0.0015 + cityGlow[k] * 0.5,
  ) as Vec3;
  const groundAmbient: Vec3 = [0, 1, 2].map(
    k =>
      skyAmbient[k] * 0.25 +
      sunColor[k] * Math.max(sunDir[1], 0) * 0.04 +
      cityGlow[k] * 0.6,
  ) as Vec3;
  return {
    sunDir,
    sunUp,
    sunColor,
    moonDir,
    moonLight,
    moonPhase,
    skyAmbient,
    groundAmbient,
    cityGlow,
    night,
  };
}
