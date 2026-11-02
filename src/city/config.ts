// City presets. Every preset drives the same generation pipeline with different
// parameters. Tokyo ("neon") is the primary target.

export type CityType = 'neon' | 'metro' | 'harbour' | 'river';

/**
 * Facade colour palette of a city preset: its index, which the city shader
 * reads in frame.off.w bits 8-15 (city-materials.wgsl facadeCity /
 * FACADE_WEIGHTS).
 */
export function facadePaletteOf(type: CityType): number {
  return {neon: 0, metro: 1, harbour: 2, river: 3}[type] ?? 0;
}

export interface CityParams {
  type: CityType;
  name: string;
  /** World is a square of this size in meters, centered on the origin. */
  size: number;
  /** Heightfield resolution (meters per sample). */
  cell: number;
  /** Max terrain relief of uplands in meters. */
  relief: number;
  /** Feature scale of hills in meters. */
  hillScale: number;
  /** Fraction of the map edge given to sea (0 = landlocked). */
  sea: {side: 'south' | 'east' | 'harbour' | 'none'; extent: number};
  rivers: number;
  /** Radial/ring arterial pattern (Tokyo) vs. single main grid (Manhattan-like). */
  arterials: 'radial' | 'grid';
  ringCount: number;
  radialCount: number;
  /** Minor street spacing range in meters. */
  blockSize: [number, number];
  /** Probability a minor grid patch keeps a single orientation over a whole region. */
  gridRegularity: number;
  /** Height distribution: mean floors downtown, falloff with distance from center. */
  downtownFloors: number;
  suburbFloors: number;
  /** Probability multiplier for business signs on buildings. */
  signDensity: number;
  /** Probability of glass curtain-wall towers in the core. */
  modernity: number;
  /** Elevated rail lines. */
  railLines: number;
  /** Elevated expressways. */
  expressways: number;
  parkFraction: number;
  /**
   * Which side of the road traffic keeps to (Tokyo, Hong Kong: left; New
   * York: right). Lanes, trains, the road paint (stop lines, arrows, turn
   * guides), the drivers' seats and the road furniture that faces one
   * direction of travel (signals, guide and regulatory signs: nearside())
   * follow it; the layout does not depend on it.
   */
  drive: 'left' | 'right';
}

/** +1 where traffic keeps left, -1 where it keeps right. */
export function keepLeft(p: Pick<CityParams, 'drive'>): 1 | -1 {
  return p.drive === 'right' ? -1 : 1;
}

/**
 * The nearside of traffic travelling along `d` (x, z): the unit lateral
 * from the centreline toward the kerb that traffic keeps to. World space
 * is y up and right-handed (mat4.lookAt), so the left of travel direction
 * d is (dz, -dx) and its right (-dz, dx); RoadNet.lanePos puts the lanes
 * on this side. Road furniture for that traffic stands on (regulatory
 * signs, signal poles on the far corner) or hangs over (guide signs,
 * signal heads) this side.
 */
export function nearside(
  p: Pick<CityParams, 'drive'>,
  d: readonly [number, number],
): [number, number] {
  const k = keepLeft(p);
  return [d[1] * k, -d[0] * k];
}

export const PRESETS: Record<CityType, CityParams> = {
  neon: {
    type: 'neon',
    name: 'Neon Sprawl (Tokyo)',
    size: 6144,
    cell: 4,
    relief: 55,
    hillScale: 1400,
    sea: {side: 'south', extent: 0.2},
    rivers: 2,
    arterials: 'radial',
    ringCount: 4,
    radialCount: 9,
    blockSize: [38, 80],
    gridRegularity: 0.55,
    downtownFloors: 22,
    suburbFloors: 4,
    signDensity: 1,
    modernity: 0.65,
    railLines: 3,
    expressways: 5,
    parkFraction: 0.05,
    drive: 'left',
  },
  metro: {
    type: 'metro',
    name: 'Metro Island (New York)',
    size: 6144,
    cell: 4,
    relief: 30,
    hillScale: 1800,
    sea: {side: 'east', extent: 0.25},
    rivers: 1,
    arterials: 'grid',
    ringCount: 0,
    radialCount: 0,
    blockSize: [60, 230],
    gridRegularity: 0.95,
    downtownFloors: 35,
    suburbFloors: 6,
    signDensity: 0.35,
    modernity: 0.55,
    railLines: 1,
    expressways: 4,
    parkFraction: 0.07,
    drive: 'right',
  },
  harbour: {
    type: 'harbour',
    name: 'Harbour Peaks (Hong Kong)',
    size: 6144,
    cell: 4,
    relief: 220,
    hillScale: 1200,
    sea: {side: 'harbour', extent: 0.22},
    rivers: 0,
    arterials: 'radial',
    ringCount: 2,
    radialCount: 7,
    blockSize: [40, 90],
    gridRegularity: 0.4,
    downtownFloors: 40,
    suburbFloors: 18,
    signDensity: 0.9,
    modernity: 0.75,
    railLines: 2,
    expressways: 3,
    parkFraction: 0.04,
    drive: 'left',
  },
  river: {
    type: 'river',
    name: 'River Mountain (Chongqing)',
    size: 6144,
    cell: 4,
    relief: 160,
    hillScale: 900,
    sea: {side: 'none', extent: 0},
    rivers: 2,
    arterials: 'radial',
    ringCount: 2,
    radialCount: 8,
    blockSize: [45, 100],
    gridRegularity: 0.3,
    downtownFloors: 34,
    suburbFloors: 14,
    signDensity: 0.8,
    modernity: 0.7,
    railLines: 2,
    expressways: 3,
    parkFraction: 0.04,
    drive: 'left',
  },
};
