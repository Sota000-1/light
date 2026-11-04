const { test } = require('node:test');
const assert = require('node:assert/strict');
const Lanes = require('../public/lane-model');
const Show = require('../public/show-engine');
const cue = (group, type, value, laneId) => ({ id: `${group}-${type}`, start: 0, duration: 10, group, type, value, ...(laneId ? { laneId } : {}) });
test('legacy cues migrate into visible class/channel lanes without changing output', () => {
  const old = { cues: [cue('all', 'color', '#0088ff'), cue('2組', 'torch', true), cue('3組', 'color', '#ff0055')] };
  const migrated = Lanes.normalizeSong(old);
  assert.equal(migrated.lanes.length, 4);
  for (const c of migrated.cues) assert.ok(migrated.lanes.some(l => l.id === c.laneId && l.group === c.group && l.channel === Lanes.channel(c.type)));
  for (const group of Show.groups) assert.deepEqual(Show.stateAt(migrated.cues, 3, group), Show.stateAt(old.cues, 3, group));
  assert.deepEqual(Lanes.normalizeSong(migrated), migrated);
});
test('four class lanes play independent simultaneous screen and torch cues', () => {
  const lanes = Show.groups.flatMap((group, i) => ['screen', 'torch'].map(channel => ({ id: `${i}-${channel}`, name: channel, channel, group })));
  const colors = ['#ff0055', '#0088ff', '#00cc44', '#9900ff'];
  const cues = Show.groups.flatMap((group, i) => [cue(group, 'color', colors[i], `${i}-screen`), cue(group, 'torch', i % 2 === 0, `${i}-torch`)]);
  const song = Lanes.normalizeSong({ lanes, cues });
  const restored = Lanes.normalizeSong(JSON.parse(JSON.stringify({ ...song, cues: Show.normalize(song.cues, 10) })));
  assert.deepEqual(restored.lanes, song.lanes);
  assert.deepEqual(restored.cues.map(c => c.laneId), song.cues.map(c => c.laneId));
  Show.groups.forEach((group, i) => {
    const state = Show.stateAt(restored.cues, 5, group);
    assert.equal(state.color, colors[i]); assert.equal(state.torch, i % 2 === 0);
  });
});
test('moving a clip to another lane updates its output group and preserves other lanes', () => {
  const lanes = [{ id: 'red', name: 'A', channel: 'screen', group: '1組' }, { id: 'blue', name: 'B', channel: 'screen', group: '2組' }];
  const song = Lanes.normalizeSong({ lanes, cues: [cue('1組', 'color', '#ff0055', 'blue')] });
  assert.equal(song.cues[0].group, '2組');
  assert.equal(Show.stateAt(song.cues, 2, '1組').color, '#000000');
  assert.equal(Show.stateAt(song.cues, 2, '2組').color, '#ff0055');
});
test('empty lanes survive roundtrip; invalid and excessive lanes are rejected', () => {
  assert.deepEqual(Lanes.normalizeSong({ lanes: [], cues: [] }), { lanes: [], cues: [] });
  const lane = { id: 'a', group: 'all', channel: 'screen', name: 'A' };
  assert.throws(() => Lanes.normalizeSong({ lanes: [lane, lane], cues: [] }));
  assert.throws(() => Lanes.normalizeSong({ lanes: [{ ...lane, group: '5組' }], cues: [] }));
  assert.throws(() => Lanes.normalizeSong({ lanes: Array.from({ length: 65 }, (_, i) => ({ ...lane, id: String(i) })), cues: [] }));
});
