// Tessellates every registered vehicle design (a few seeded variants, three
// LODs each) off the main thread.

import {setDetailScale, type Mesh} from '../nurbs/mesh.ts';
import {designs} from '../vehicles/designs/index.ts';
import type {VehicleDesign} from '../vehicles/types.ts';

export const VEHICLE_LODS = [1, 0.45, 0.2];
export const VARIANTS_PER_DESIGN = 2;

export interface PackedMesh {
  vertices: ArrayBuffer; // pos f32x3, normal f32x3, mat u32 (28 bytes)
  indices: Uint32Array;
}

export interface VehicleVariant {
  name: string;
  kind: VehicleDesign['kind'];
  seed: number;
  size: VehicleDesign['size'];
  wheels: VehicleDesign['wheels'];
  rotors: {position: VehicleDesign['driverEye']; axis: VehicleDesign['driverEye']}[];
  steeringWheel?: {position: VehicleDesign['driverEye']; tilt: number};
  driverEye: VehicleDesign['driverEye'];
  headlights: VehicleDesign['headlights'];
  taillights: VehicleDesign['taillights'];
  palette: VehicleDesign['palette'];
  /** Per LOD: body, wheel, rotors[], steering. */
  lods: {body: PackedMesh; wheel: PackedMesh | null; rotors: PackedMesh[]; steering: PackedMesh | null}[];
}

function pack(m: Mesh): PackedMesh {
  const n = m.positions.length / 3;
  const buf = new ArrayBuffer(n * 28);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  for (let i = 0; i < n; i++) {
    f[i * 7] = m.positions[i * 3];
    f[i * 7 + 1] = m.positions[i * 3 + 1];
    f[i * 7 + 2] = m.positions[i * 3 + 2];
    f[i * 7 + 3] = m.normals[i * 3];
    f[i * 7 + 4] = m.normals[i * 3 + 1];
    f[i * 7 + 5] = m.normals[i * 3 + 2];
    u[i * 7 + 6] = m.materials[i];
  }
  return {vertices: buf, indices: new Uint32Array(m.indices)};
}

self.onmessage = () => {
  const out: VehicleVariant[] = [];
  const transfer: Transferable[] = [];
  const errors: string[] = [];
  for (const [name, gen] of Object.entries(designs)) {
    for (let v = 0; v < VARIANTS_PER_DESIGN; v++) {
      const seed = v * 7919 + 1;
      try {
        let variant: VehicleVariant | null = null;
        for (const scale of VEHICLE_LODS) {
          setDetailScale(scale);
          const d = gen(seed);
          if (!variant) {
            variant = {
              name,
              kind: d.kind,
              seed,
              size: d.size,
              wheels: d.wheels,
              rotors: d.rotors.map(r => ({position: r.position, axis: r.axis})),
              steeringWheel: d.steeringWheel ? {position: d.steeringWheel.position, tilt: d.steeringWheel.tilt} : undefined,
              driverEye: d.driverEye,
              headlights: d.headlights,
              taillights: d.taillights,
              palette: d.palette,
              lods: [],
            };
          }
          const lod = {
            body: pack(d.body),
            wheel: d.wheelMesh ? pack(d.wheelMesh) : null,
            rotors: d.rotors.map(r => pack(r.mesh)),
            steering: d.steeringWheel ? pack(d.steeringWheel.mesh) : null,
          };
          for (const pm of [lod.body, lod.wheel, ...lod.rotors, lod.steering]) {
            if (pm) transfer.push(pm.vertices, pm.indices.buffer);
          }
          variant.lods.push(lod);
        }
        if (variant) out.push(variant);
      } catch (e) {
        errors.push(`${name}#${seed}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  setDetailScale(1);
  (self as unknown as Worker).postMessage({variants: out, errors}, transfer);
};
