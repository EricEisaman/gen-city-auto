// Vehicle design description shared by the vehicle generators, the turntable
// tool and the game renderer.
//
// Local frame: +x = vehicle right, +y = up, +z = forward. The ground is y = 0 and
// the origin is centered between the axles (or under the rotor mast).

import type {Vec3} from '../math/vec.ts';
import type {Mesh} from '../nurbs/mesh.ts';

/** Material ids stored per vertex. The renderer maps these to PBR parameters. */
export const Mat = {
  /** Main body paint; tinted by the per-instance color. */
  paint: 0,
  /** Secondary paint (stripes, two-tone roofs, liveries); per-instance color 2. */
  paint2: 1,
  glass: 2,
  chrome: 3,
  rubber: 4,
  /** Unpainted black/grey trim plastic (bumpers, grilles, mirrors). */
  plastic: 5,
  /** Emissive white at night / when lights are on. */
  headlight: 6,
  /** Emissive red; brighter when braking. */
  taillight: 7,
  /** Interior surfaces (door cards, headliner, floor). */
  interior: 8,
  seat: 9,
  /** Dashboard with emissive gauges at night. */
  dash: 10,
  /** Dark painted metal (chassis, rotor blades, pantograph). */
  metal: 11,
  /** Wheel rims (silver alloy). */
  rim: 12,
  /** Amber indicators. */
  indicator: 13,
  /** Emissive destination/route screens on buses and trains. */
  screen: 14,
} as const;
export type MatId = (typeof Mat)[keyof typeof Mat];

export type VehicleKind = 'car' | 'taxi' | 'van' | 'truck' | 'bus' | 'helicopter' | 'train';

export interface Wheel {
  /** Wheel center in vehicle space. */
  position: Vec3;
  radius: number;
  width: number;
  /** Front wheels that steer. */
  steer: boolean;
}

export interface Rotor {
  /** Hub position in vehicle space. */
  position: Vec3;
  /** Spin axis (unit). */
  axis: Vec3;
  /** Rotor mesh modeled around the origin, spinning about `axis`. */
  mesh: Mesh;
}

export interface VehicleDesign {
  name: string;
  kind: VehicleKind;
  /** Overall dimensions in meters (x = width, y = height, z = length). */
  size: Vec3;
  /** Static body, glass, lights and interior. */
  body: Mesh;
  /** Wheel mesh modeled around the origin with its axle along x. */
  wheelMesh?: Mesh;
  wheels: Wheel[];
  rotors: Rotor[];
  /** Steering wheel/yoke mesh around the origin (turns about its local z). */
  steeringWheel?: {position: Vec3; tilt: number; mesh: Mesh};
  /** Driver eye position for the first-person camera. */
  driverEye: Vec3;
  /** Light positions for dynamic lighting (headlights shine toward +z). */
  headlights: Vec3[];
  taillights: Vec3[];
  /** Suggested body colors (linear RGB 0..1) the traffic system picks from. */
  palette: Vec3[];
}

export type VehicleGenerator = (seed: number) => VehicleDesign;
