// Tessellates every registered vehicle design (a few seeded variants, three
// LODs each) off the main thread.

import {setDetailScale, type Mesh} from '../nurbs/mesh.ts';
import {designs} from '../vehicles/designs/index.ts';
import {person} from '../vehicles/person.ts';
import type {VehicleDesign} from '../vehicles/types.ts';

export const VEHICLE_LODS = [1, 0.45, 0.2];
/**
 * A fourth, far LOD (index VEHICLE_LODS.length): the coarsest one
 * simplified by vertex clustering on a grid of size / FAR_CELLS. Coarser
 * tessellation cannot get there: every NURBS patch keeps at least 2 x 2
 * segments, so LOD2 stays at ~5k triangles for a car. Only drawn where the
 * renderer asks for it (VehicleRenderer.farLod; the phone tier).
 */
const FAR_CELLS = 12;
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
  rotors: {
    position: VehicleDesign['driverEye'];
    axis: VehicleDesign['driverEye'];
  }[];
  steeringWheel?: {position: VehicleDesign['driverEye']; tilt: number};
  driverEye: VehicleDesign['driverEye'];
  headlights: VehicleDesign['headlights'];
  taillights: VehicleDesign['taillights'];
  palette: VehicleDesign['palette'];
  /** Per LOD: body, wheel, rotors[], steering. */
  lods: {
    body: PackedMesh;
    wheel: PackedMesh | null;
    rotors: PackedMesh[];
    steering: PackedMesh | null;
  }[];
}

/**
 * Vertex-clustering simplification of a packed mesh: vertices snap to the
 * mean of their grid cell (per material, so colours do not bleed), and the
 * triangles that collapse or repeat are dropped. Null when nothing useful
 * is left (the caller keeps the finer mesh).
 */
function simplify(pm: PackedMesh, cell: number): PackedMesh | null {
  const f = new Float32Array(pm.vertices);
  const u = new Uint32Array(pm.vertices);
  const n = f.length / 7;
  const ids = new Map<string, number>();
  const remap = new Uint32Array(n);
  const acc: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(f[i * 7] / cell)},${Math.floor(f[i * 7 + 1] / cell)},${Math.floor(f[i * 7 + 2] / cell)},${u[i * 7 + 6]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
      acc.push(0, 0, 0, 0, 0, 0, 0, u[i * 7 + 6]);
    }
    remap[i] = id;
    for (let k = 0; k < 6; k++) acc[id * 8 + k] += f[i * 7 + k];
    acc[id * 8 + 6]++;
  }
  const seen = new Set<string>();
  const idx: number[] = [];
  const tri = pm.indices;
  for (let t = 0; t < tri.length; t += 3) {
    const a = remap[tri[t]];
    const b = remap[tri[t + 1]];
    const c = remap[tri[t + 2]];
    if (a === b || b === c || a === c) continue;
    // (Both windings kept: thin parts are double-sided.)
    const key = `${a},${b},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seen.add(`${b},${c},${a}`);
    seen.add(`${c},${a},${b}`);
    idx.push(a, b, c);
  }
  if (idx.length < 36 || idx.length >= tri.length * 0.8) return null;
  const m = ids.size;
  const buf = new ArrayBuffer(m * 28);
  const of = new Float32Array(buf);
  const ou = new Uint32Array(buf);
  for (let i = 0; i < m; i++) {
    const w = acc[i * 8 + 6];
    for (let k = 0; k < 3; k++) of[i * 7 + k] = acc[i * 8 + k] / w;
    const l = Math.hypot(acc[i * 8 + 3], acc[i * 8 + 4], acc[i * 8 + 5]) || 1;
    for (let k = 3; k < 6; k++) of[i * 7 + k] = acc[i * 8 + k] / l;
    ou[i * 7 + 6] = acc[i * 8 + 7];
  }
  return {vertices: buf, indices: new Uint32Array(idx)};
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

self.onmessage = (e: MessageEvent<{names?: string[]}>) => {
  const only = e.data?.names;
  const out: VehicleVariant[] = [];
  const transfer: Transferable[] = [];
  const errors: string[] = [];
  for (const [name, gen] of [
    ...Object.entries(designs),
    ['person', person] as const,
  ]) {
    if (only && !only.includes(name)) continue;
    for (let v = 0; v < (name === 'person' ? 8 : VARIANTS_PER_DESIGN); v++) {
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
              steeringWheel: d.steeringWheel
                ? {
                    position: d.steeringWheel.position,
                    tilt: d.steeringWheel.tilt,
                  }
                : undefined,
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
        if (variant) {
          // The far LOD from the coarsest (meshes the clustering cannot
          // reduce stay as they are).
          const last = variant.lods[variant.lods.length - 1];
          const cell = Math.max(...variant.size) / FAR_CELLS;
          const far = (pm: PackedMesh) => {
            const s = simplify(pm, cell);
            if (s) transfer.push(s.vertices, s.indices.buffer);
            return s ?? pm;
          };
          variant.lods.push({
            body: far(last.body),
            wheel: last.wheel && far(last.wheel),
            rotors: last.rotors.map(far),
            steering: null,
          });
          out.push(variant);
        }
      } catch (e) {
        errors.push(`${name}#${seed}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  setDetailScale(1);
  (self as unknown as Worker).postMessage({variants: out, errors}, transfer);
};
