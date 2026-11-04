(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LightShow = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const groups = ['1組', '2組', '3組', '4組'];
  const types = ['color', 'rainbow', 'torch', 'pulse'];
  const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));
  function normalize(cues, duration) {
    if (!Array.isArray(cues) || cues.length > 2000) throw new Error('演出は2000個までです');
    return cues.map((c, i) => {
      if (!c || !types.includes(c.type)) throw new Error('演出の種類が不正です');
      if (![c.start, c.duration].every(Number.isFinite) || c.start < 0 || c.duration <= 0 || c.start >= duration) throw new Error('演出の時間が不正です');
      if (c.type === 'color' && !/^#[0-9a-f]{6}$/i.test(c.value)) throw new Error('色が不正です');
      if (c.type === 'torch' && typeof c.value !== 'boolean') throw new Error('ライト設定が不正です');
      if (c.group !== 'all' && !groups.includes(c.group)) throw new Error('対象クラスが不正です');
      return { id: String(c.id || i).slice(0, 100), start: c.start, duration: Math.min(c.duration, duration - c.start), type: c.type,
        value: c.type === 'torch' ? c.value : c.type === 'color' ? c.value : null,
        group: c.group, label: String(c.label || '').slice(0, 100), interval: clamp(c.interval || 500, 200, 2000) };
    }).sort((a, b) => a.start - b.start);
  }
  function stateAt(cues, time, group) {
    const state = { color: '#000000', rainbow: false, torch: false };
    for (const c of cues) {
      if (c.start > time || time >= c.start + c.duration || (c.group !== 'all' && c.group !== group)) continue;
      if (c.type === 'color') { state.color = c.value; state.rainbow = false; }
      if (c.type === 'rainbow') { state.rainbow = true; state.color = `hsl(${((time - c.start) * 60) % 360} 100% 55%)`; }
      if (c.type === 'torch') state.torch = c.value;
      if (c.type === 'pulse') state.torch = Math.floor((time - c.start) * 1000 / c.interval) % 2 === 0;
    }
    return state;
  }
  function position(show, now) {
    return clamp(show.position + (show.playing ? Math.max(0, now - show.startTime) / 1000 : 0), 0, show.duration);
  }
  return { groups, types, clamp, normalize, stateAt, position };
});
