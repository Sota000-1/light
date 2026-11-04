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
