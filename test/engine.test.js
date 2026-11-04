const { test } = require('node:test');
const assert = require('node:assert/strict');
const Show = require('../public/show-engine');
const cues = Show.normalize([
  { id: 'base', start: 0, duration: 15, type: 'color', value: '#0088ff', group: 'all' },
  { id: 'override', start: 5, duration: 3, type: 'color', value: '#ff0055', group: '2組' },
  { id: 'torch', start: 3, duration: 6, type: 'torch', value: true, group: 'all' },
  { id: 'pulse', start: 6, duration: 1, type: 'pulse', group: '1組', interval: 500 },
], 20);
test('seeking reconstructs independent channels and class overrides', () => {
  assert.deepEqual(Show.stateAt(cues, 5.5, '1組'), { color: '#0088ff', rainbow: false, torch: true });
  assert.deepEqual(Show.stateAt(cues, 5.5, '2組'), { color: '#ff0055', rainbow: false, torch: true });
  assert.equal(Show.stateAt(cues, 6.6, '1組').torch, false);
  assert.equal(Show.stateAt(cues, 7.2, '1組').torch, true);
  assert.deepEqual(Show.stateAt(cues, 20, '2組'), { color: '#000000', rainbow: false, torch: false });
  assert.equal(Show.stateAt(cues, 8, '2組').color, '#0088ff');
});
test('playback clock honors scheduled start, pause, seek and end', () => {
  const show = { playing: true, position: 5, startTime: 10000, duration: 20 };
  assert.equal(Show.position(show, 9000), 5);
  assert.equal(Show.position(show, 12000), 7);
  assert.equal(Show.position({ ...show, playing: false }, 12000), 5);
  assert.equal(Show.position(show, 100000), 20);
});
test('rainbow and pulse have deterministic phase after seeking', () => {
  const c = Show.normalize([{ start: 2, duration: 10, type: 'rainbow', group: 'all' }], 20);
  assert.equal(Show.stateAt(c, 8, '4組').color, 'hsl(0 100% 55%)');
  assert.equal(Show.stateAt(c, 12, '4組').rainbow, false);
});
test('invalid or excessive programs are rejected before playback', () => {
  assert.throws(() => Show.normalize([{ start: NaN, duration: 1, type: 'torch', value: true, group: 'all' }], 20));
  assert.throws(() => Show.normalize([{ start: 0, duration: 1, type: 'color', value: 'url(x)', group: 'all' }], 20));
  assert.throws(() => Show.normalize(Array(2001).fill({}), 20));
  assert.throws(() => Show.normalize([{ start: 0, duration: -1, type: 'torch', value: true, group: 'all' }], 20));
});
test('accelerating and decelerating pulse phase matches independent numerical integration', () => {
  for (const [a, b] of [[1000, 200], [200, 1500], [500, 500], [1000, 50], [50, 1000]]) {
    const cue = { interval: a, intervalEnd: b, rampDuration: 4, duration: 10 };
    for (const end of [0, 0.4, 1.7, 4, 6]) {
      const steps = 20000, dt = end / steps;
      let numerical = 0;
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) * dt;
        numerical += dt / ((a + (b - a) * Math.min(t / 4, 1)) / 1000);
      }
      assert.ok(Math.abs(Show.pulsePhase(cue, end) - numerical) < 0.00001);
    }
  }
});
test('ramped pulses survive serialization and seeking with continuous terminal speed', () => {
  const c = Show.normalize([{ start: 2, duration: 10, type: 'pulse', group: '2組', interval: 1000, intervalEnd: 200, rampDuration: 4 }], 12);
  const restored = Show.normalize(JSON.parse(JSON.stringify(c)), 12);
  assert.deepEqual(restored, c);
  assert.ok(Math.abs(Show.pulsePhase(c[0], 6) - Show.pulsePhase(c[0], 5) - 5) < 1e-9);
  for (const time of [2, 3.2, 5.99, 6, 7.45, 11]) {
    assert.equal(Show.stateAt(restored, time, '2組').torch, Math.floor(Show.pulsePhase(c[0], time - 2) + 1e-9) % 2 === 0);
    assert.equal(Show.stateAt(restored, time, '1組').torch, false);
  }
  assert.throws(() => Show.normalize([{ ...c[0], intervalEnd: NaN }], 12));
  assert.throws(() => Show.normalize([{ ...c[0], intervalEnd: 20 }], 12));
  assert.throws(() => Show.normalize([{ ...c[0], rampDuration: -1 }], 12));
});
test('50ms fixed intervals and ramp endpoints are preserved without a 200ms clamp', () => {
  const fixed = Show.normalize([{ start: 0, duration: 10, type: 'pulse', group: 'all', interval: 50 }], 10);
  assert.equal(fixed[0].interval, 50);
  assert.equal(Show.stateAt(fixed, 0.049, '1組').torch, true);
  assert.equal(Show.stateAt(fixed, 0.05, '1組').torch, false);
  assert.equal(Show.stateAt(fixed, 0.1, '1組').torch, true);
  const ramp = Show.normalize([{ ...fixed[0], interval: 1000, intervalEnd: 50, rampDuration: 2 }], 10);
  assert.equal(ramp[0].intervalEnd, 50);
  assert.ok(Math.abs(Show.pulsePhase(ramp[0], 4) - Show.pulsePhase(ramp[0], 3) - 20) < 1e-9);
});
