// Rail viaduct vertex count in the river city: base mesh with vs without
// the rail elevateds.
import {PRESETS} from '../src/city/config.ts';
import {generateLayout} from '../src/city/layout.ts';
import {buildBase} from '../src/city/gen-base.ts';
const L = generateLayout(PRESETS.river, 1);
const all = buildBase(L);
const none = buildBase({
  ...L,
  elevated: L.elevated.filter(e => e.kind !== 'rail'),
});
console.log(
  `base ${all.mesh.vcount} without rail ${none.mesh.vcount} rail ${all.mesh.vcount - none.mesh.vcount} lights ${(all.lights.length - none.lights.length) / 8}`,
);
