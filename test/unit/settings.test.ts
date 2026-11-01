import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  DEFAULTS,
  DynamicScale,
  FIELDS,
  PRESETS,
  autoScale,
  loadStored,
  urlOverrides,
} from '../../src/ui/settings.ts';

void test('defaults and presets only use values the menu offers', () => {
  for (const f of FIELDS) {
    const ok = (v: unknown) => f.options.some(([, x]) => x === v);
    assert.ok(ok(DEFAULTS[f.key]), `default ${f.key}`);
    for (const [name, p] of Object.entries(PRESETS))
      if (f.key in p)
        assert.ok(
          ok((p as Record<string, unknown>)[f.key]),
          `${name} ${f.key}`,
        );
  }
});

void test('the high preset matches the defaults', () => {
  for (const [k, v] of Object.entries(PRESETS.high))
    assert.equal(DEFAULTS[k as keyof typeof DEFAULTS], v, k);
});

void test('url overrides', () => {
  const o = urlOverrides(new URLSearchParams('scale=75&clouds=9&shadows=1024'));
  assert.equal(o.scale, 75);
  assert.equal(o.shadows, 1024);
  assert.ok(!('clouds' in o), 'invalid cloud level dropped');
  assert.equal(urlOverrides(new URLSearchParams('scale=60')).scale, 60);
  assert.equal(
    urlOverrides(new URLSearchParams('scale=dynamic')).scale,
    'dynamic',
  );
  assert.ok(!('scale' in urlOverrides(new URLSearchParams('scale=7'))));
  const low = urlOverrides(new URLSearchParams('gfx=low&scale=100'));
  assert.equal(low.preset, 'low');
  assert.equal(low.scale, 100, 'scale beats the preset');
  assert.equal(low.shadows, PRESETS.low.shadows);
  assert.deepEqual(urlOverrides(new URLSearchParams('')), {});
});

void test('stored settings survive a missing localStorage', () => {
  assert.deepEqual(loadStored(), {});
});

void test('auto scale by display size', () => {
  assert.equal(autoScale(1280, 720), 1);
  assert.equal(autoScale(1920, 1080), 0.85);
  assert.equal(autoScale(2560, 1440), 0.75);
  assert.equal(autoScale(3840, 2160), 0.75);
});

void test('dynamic scale steps down fast, up slowly, within bounds', () => {
  const d = new DynamicScale();
  let s = 1;
  // 30 ms against a 60 fps budget: drops after the settle period.
  for (let i = 0; i < 29; i++) s = d.update(30, 60);
  assert.equal(s, 1);
  s = d.update(30, 60);
  assert.ok(s < 1 && s >= 0.8, `first step ${s}`);
  for (let i = 0; i < 1000; i++) s = d.update(30, 60);
  assert.equal(s, 0.5, 'floor');
  // Plenty of headroom: climbs back in 5% steps.
  const before = s;
  for (let i = 0; i < 90; i++) s = d.update(5, 60);
  assert.equal(s, before + 0.05);
  for (let i = 0; i < 10000; i++) s = d.update(5, 60);
  assert.equal(s, 1, 'ceiling');
  // Inside the band: holds.
  for (let i = 0; i < 500; i++) s = d.update(13, 60);
  assert.equal(s, 1);
  // No measurement yet: holds.
  assert.equal(d.update(0, 60), 1);
});
