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
      if (c.intervalEnd !== undefined && (!Number.isFinite(c.intervalEnd) || c.intervalEnd < 50 || c.intervalEnd > 2000)) throw new Error('終了間隔は0.05〜2秒で指定してください');
      if (c.rampDuration !== undefined && (!Number.isFinite(c.rampDuration) || c.rampDuration <= 0 || c.rampDuration > 7200)) throw new Error('変化時間が不正です');
      const ramp = c.type === 'pulse' && c.intervalEnd !== undefined ? { intervalEnd: c.intervalEnd, rampDuration: Math.min(c.rampDuration || c.duration, duration - c.start) } : {};
      return { ...ramp, id: String(c.id || i).slice(0, 100), ...(typeof c.laneId === 'string' ? { laneId: c.laneId.slice(0, 100) } : {}), start: c.start, duration: Math.min(c.duration, duration - c.start), type: c.type,
        value: c.type === 'torch' ? c.value : c.type === 'color' ? c.value : null,
        group: c.group, label: String(c.label || '').slice(0, 100), interval: clamp(c.interval || 500, 50, 2000) };
    }).sort((a, b) => a.start - b.start);
  }
  // Integrate toggle frequency, rather than dividing elapsed time by a changing interval.
  // This keeps the phase continuous and reproducible after seeking or reconnecting.
  function pulsePhase(cue, elapsed) {
    const a = clamp(cue.interval || 500, 50, 2000) / 1000;
    const b = clamp(cue.intervalEnd === undefined ? cue.interval || 500 : cue.intervalEnd, 50, 2000) / 1000;
    const duration = cue.rampDuration || cue.duration;
    const t = Math.max(0, elapsed);
    if (Math.abs(b - a) < 1e-9) return t / a;
    const rampTime = Math.min(t, duration);
    const phase = duration / (b - a) * Math.log1p((b - a) * rampTime / (duration * a));
    return phase + Math.max(0, t - duration) / b;
  }
  function stateAt(cues, time, group) {
    const state = { color: '#000000', rainbow: false, torch: false };
    for (const c of cues) {
      if (c.start > time || time >= c.start + c.duration || (c.group !== 'all' && c.group !== group)) continue;
      if (c.type === 'color') { state.color = c.value; state.rainbow = false; }
      if (c.type === 'rainbow') { state.rainbow = true; state.color = `hsl(${((time - c.start) * 60) % 360} 100% 55%)`; }
      if (c.type === 'torch') state.torch = c.value;
      if (c.type === 'pulse') state.torch = Math.floor(pulsePhase(c, time - c.start) + 1e-9) % 2 === 0;
    }
    return state;
  }
  function position(show, now) {
    return clamp(show.position + (show.playing ? Math.max(0, now - show.startTime) / 1000 : 0), 0, show.duration);
  }
  return { groups, types, clamp, normalize, pulsePhase, stateAt, position };
});
