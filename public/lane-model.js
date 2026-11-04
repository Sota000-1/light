(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./show-engine'));
  else root.LightLanes = factory(root.LightShow);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Show) {
  'use strict';
  const MAX_LANES = 64;
  const channel = type => ['color', 'rainbow'].includes(type) ? 'screen' : 'torch';
  const validGroups = ['all', ...Show.groups];
  function normalizeSong(song) {
    const legacy = !Array.isArray(song.lanes);
    const source = legacy ? [
      { id: 'screen-all', name: '画面', channel: 'screen', group: 'all' },
      { id: 'torch-all', name: 'ライト', channel: 'torch', group: 'all' }
    ] : song.lanes;
    if (source.length > MAX_LANES) throw new Error('レーンは64本までです');
    const ids = new Set();
    const lanes = source.map(lane => {
      if (!lane || typeof lane.id !== 'string' || !lane.id || lane.id.length > 100 || ids.has(lane.id) ||
          !['screen', 'torch'].includes(lane.channel) || !validGroups.includes(lane.group)) throw new Error('レーンの設定が不正です');
      ids.add(lane.id);
      return { id: lane.id, name: String(lane.name || (lane.channel === 'screen' ? '画面' : 'ライト')).slice(0, 80), channel: lane.channel, group: lane.group };
    });
    const cues = song.cues.map(cue => {
      let lane = lanes.find(l => l.id === cue.laneId && l.channel === channel(cue.type));
      if (!lane) lane = lanes.find(l => l.group === cue.group && l.channel === channel(cue.type));
      if (!lane) {
        if (lanes.length >= MAX_LANES) throw new Error('レーンは64本までです');
        let id = `${channel(cue.type)}-${cue.group}`, suffix = 0;
        while (ids.has(id)) id = `${channel(cue.type)}-${cue.group}-${++suffix}`;
        ids.add(id);
        lane = { id, name: channel(cue.type) === 'screen' ? '画面' : 'ライト', channel: channel(cue.type), group: cue.group };
        lanes.push(lane);
      }
      return { ...cue, laneId: lane.id, group: lane.group };
    });
    return { ...song, lanes, cues };
  }
  return { MAX_LANES, channel, normalizeSong };
});
