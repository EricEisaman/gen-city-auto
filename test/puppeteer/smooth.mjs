// Measures motion smoothness: per-frame heading changes of the player, the
// camera and traffic cars. Large single-frame jumps indicate popping.
import {withPage, withServer} from './harness.mjs';

await withServer(async base => {
  const r = await withPage(`${base}/index.html?timespeed=0&cam=chase&director=0`, async page =>
    page.evaluate(
      () =>
        new Promise(res => {
          const g = window.__game;
          const ang = (x, z) => Math.atan2(x, z);
          const wrap = a => Math.abs(((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          let prevP = null;
          let prevC = null;
          const prevCars = new Map();
          const p = [];
          const c = [];
          const cars = [];
          let n = 0;
          const tick = () => {
            const pl = g.player;
            const yaw = ang(pl.model[8], pl.model[10]);
            if (prevP !== null) p.push(wrap(yaw - prevP));
            prevP = yaw;
            const lc = g.lastCam;
            const cy = Math.atan2(lc.target[0] - lc.eye[0], lc.target[2] - lc.eye[2]);
            if (prevC !== null) c.push(wrap(cy - prevC));
            prevC = cy;
            for (const car of g.traffic.cars.slice(0, 60)) {
              const h = ang(car.model[8], car.model[10]);
              const q = prevCars.get(car);
              if (q !== undefined) {
                cars.push(wrap(h - q));
                if (wrap(h - q) > 0.2) window.__jumps = [...(window.__jumps ?? []), {d: (wrap(h - q) * 180) / Math.PI, turn: !!car.f.turn, s: car.f.s, speed: car.f.speed}];
              }
              prevCars.set(car, h);
            }
            if (++n < 480) requestAnimationFrame(tick);
            else {
              const stat = a => {
                const s = [...a].sort((x, y) => x - y);
                return {p99deg: ((s[Math.floor(s.length * 0.99)] ?? 0) * 180) / Math.PI, maxdeg: ((s[s.length - 1] ?? 0) * 180) / Math.PI};
              };
              res({player: stat(p), camera: stat(c), cars: stat(cars), jumps: (window.__jumps ?? []).slice(0, 8)});
            }
          };
          requestAnimationFrame(tick);
        }),
    ),
  );
  console.log(JSON.stringify(r.result, null, 1));
});
