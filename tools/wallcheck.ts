// Walls left out as flush against a neighbour but standing in plain view.
//   node tools/wallcheck.ts [cities=harbour,river,neon] [seeds=1,2]
// building() skips party and rear walls a neighbour stands against. It used
// to take the neighbour as filling its footprint up to its roof, but towers
// stand back from their podium edge and set-back midrises from their top
// storeys, so walls went missing beside them. "old" counts what that left
// out; "new" (neighbours filled to solidTop) should be zero.
import {PRESETS, type CityType} from '../src/city/config.ts';
import {exposedFlushWalls, solidTop} from '../src/city/gen-tile.ts';
import {generateLayout, type Building} from '../src/city/layout.ts';

const cities = (process.argv[2] ?? 'harbour,river,neon').split(
  ',',
) as CityType[];
const seeds = (process.argv[3] ?? '1,2').split(',').map(Number);
const roof = (b: Building) => b.base + b.height;

for (const city of cities)
  for (const seed of seeds) {
    const L = generateLayout(PRESETS[city], seed);
    const count = (topOf: (b: Building) => number) => {
      let n = 0,
        area = 0,
        worst = {id: -1, a: 0};
      L.buildings.forEach((b, bi) => {
        const a = exposedFlushWalls(L, bi, topOf);
        if (a > 1) n++;
        area += a;
        if (a > worst.a) worst = {id: b.id, a};
      });
      return `${n} (${Math.round(area)} m^2, worst id ${worst.id} ${Math.round(worst.a)} m^2)`;
    };
    console.log(
      `${city} seed ${seed}: ${L.buildings.length} buildings; with missing ` +
        `walls old ${count(roof)}, new ${count(solidTop)}`,
    );
  }
