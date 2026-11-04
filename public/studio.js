/* Audio stays on the operator's device. Only lighting cues cross the socket. */
'use strict';
const $ = id => document.getElementById(id);
const engine = LightShow;
const socket = io({ autoConnect: false });
const audio = $('audio');
const uid = () => crypto.randomUUID();
const time = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${(n % 60).toFixed(2).padStart(5, '0')}`;
let db, songs = [], current = null, selected = null, selectedLane = null, px = 24, position = 0, playing = false;
let ownLive = false, transport = null, remoteShow = null, eventId = 'main', clockOffset = 0, bestRTT = Infinity;
let seeking = false, liveRequest = 0, pendingSeek = null, saveVersion = 0;
let url = null, undo = [], redo = [], saveChain = Promise.resolve(), busy = false, playbackGeneration = 0;
const phoneEls = [];
function say(message, error = false) { $('message').textContent = message; $('message').classList.toggle('error', error); }
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function request(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
async function openDB() {
  const r = indexedDB.open('fes-light-studio', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
  db = await request(r);
  songs = (await request(db.transaction('songs').objectStore('songs').getAll())).map(LightLanes.normalizeSong);
}
function storeRecord(record, remove = false) {
  saveChain = saveChain.catch(() => {}).then(() => new Promise((resolve, reject) => {
    if (!db) return reject(new Error('保存先が使えません'));
    const tx = db.transaction('songs', 'readwrite');
    const store = tx.objectStore('songs');
    if (remove) store.delete(record.id); else store.put(record);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }));
  return saveChain;
}
function persist() {
  if (!current) return;
  const version = ++saveVersion;
  const copy = { ...current, cues: structuredClone(current.cues), lanes: structuredClone(current.lanes) };
  $('saveStatus').textContent = '保存中…';
  storeRecord(copy).then(() => { if (version === saveVersion) $('saveStatus').textContent = '保存済み'; }).catch(() => {
    $('saveStatus').textContent = '未保存'; say('保存に失敗しました。空き容量を確認し、演出をバックアップしてください。', true);
  });
}
function snapshot() { if (current) { undo.push(historyState()); if (undo.length > 80) undo.shift(); redo = []; } }
function changed() { current.cues.forEach(c => { if (c.type === 'pulse' && c.intervalEnd !== undefined) c.rampDuration = c.duration; }); Object.assign(current, LightLanes.normalizeSong(current)); current.cues.sort((a, b) => a.start - b.start); persist(); renderTimeline(); renderInspector(); renderLibrary(); }
function editable() {
  if (!current) { say('先に曲を追加してください。', true); return false; }
  if (ownLive || busy) { say('演出を編集するには本番送信を停止してください。', true); return false; }
  return true;
}
function renderLibrary() {
  $('songCount').textContent = `${songs.length}曲`;
  $('songList').replaceChildren(...songs.map(s => {
    const b = element('button', undefined, 'song-item' + (current?.id === s.id ? ' selected' : ''));
    b.append(element('strong', s.title), element('small', `${time(s.duration)} · ${s.cues.length}演出${s.blob ? '' : ' · 音源未設定'}`));
    b.onclick = () => selectSong(s.id); return b;
  }));
}
function selectSong(id) {
  if (ownLive || busy) { say('曲を切り替える前に本番送信を停止してください。', true); return; }
  localStop();
  current = songs.find(s => s.id === id) || null;
  selected = null; selectedLane = current?.lanes[0]?.id || null; position = 0; undo = []; redo = [];
  if (url) URL.revokeObjectURL(url);
  audio.removeAttribute('src'); url = null;
  if (current?.blob) { url = URL.createObjectURL(current.blob); audio.src = url; }
  $('songTitle').textContent = current?.title || '曲を追加して、演出をつくろう';
  $('songMeta').textContent = current ? `${current.audioName || '音源未設定'} · ${time(current.duration)} · ${current.cues.length}演出` : '音源を取り込むと波形とタイムラインが表示されます';
  $('durationText').textContent = `/ ${time(current?.duration || 0)}`;
  $('seek').max = current?.duration || 1;
  $('relinkAudio').hidden = !current;
  renderLibrary(); renderTimeline(); renderInspector();
  $('timelineScroll').scrollLeft = 0;
}
async function audioData(file) {
  if (file.size > 150 * 1024 * 1024) throw new Error('1曲150MB以内の音源を選んでください');
  const temp = new Audio(); const source = URL.createObjectURL(file);
  let duration;
  try {
    duration = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('音源の読み込みがタイムアウトしました')), 15000);
      temp.onloadedmetadata = () => { clearTimeout(timer); resolve(temp.duration); };
      temp.onerror = () => { clearTimeout(timer); reject(new Error('この音源形式を再生できません')); };
      temp.src = source;
    });
  } finally { temp.removeAttribute('src'); temp.load(); URL.revokeObjectURL(source); }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7200) throw new Error('曲は2時間以内にしてください');
  let peaks = [];
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (AudioContext) {
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      const data = decoded.getChannelData(0); const samples = Math.min(3000, Math.ceil(duration * 20));
      for (let i = 0; i < samples; i++) {
        let peak = 0; const first = Math.floor(i * data.length / samples), end = Math.floor((i + 1) * data.length / samples);
        for (let j = first; j < end; j += Math.max(1, Math.floor((end - first) / 100))) peak = Math.max(peak, Math.abs(data[j]));
        peaks.push(peak);
      }
    } catch { say('波形は取得できませんでしたが、音楽の再生と演出編集はできます。'); }
    finally { await ctx.close(); }
  }
  return { duration, peaks };
}
async function importAudio(files, relink = false) {
  if (ownLive || busy) return say('本番送信を停止してから曲を追加してください。', true);
  busy = true;
  const existingId = current?.id; let last = null;
  try {
    for (const file of files) {
      say(`「${file.name}」を読み込んでいます…`);
      const data = await audioData(file);
      const existing = relink ? songs.find(s => s.id === existingId) : songs.find(s => !s.blob && s.audioName === file.name);
      if (existing && existing.cues.some(c => c.start + c.duration > data.duration + 0.01)) throw new Error('音源が演出より短いため差し替えできません。元の音源を選んでください');
      const s = LightLanes.normalizeSong({ id: uid(), title: file.name.replace(/\.[^.]+$/, ''), cues: [], ...existing, ...data, blob: file, audioName: file.name });
      await storeRecord(s);
      if (existing) songs[songs.indexOf(existing)] = s; else songs.push(s);
      last = s.id;
    }
    say('曲を保存しました。波形をクリックし、演出を追加してください。');
  } catch (e) { say(`読み込みに失敗しました：${e.message}`, true); }
  finally { busy = false; if (last) selectSong(last); renderLibrary(); $('audioFiles').value = ''; $('relinkInput').value = ''; }
}
async function addDemo() {
  if (ownLive || busy) return;
  const rate = 16000, seconds = 16, count = rate * seconds;
  const buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const t = i / rate, beat = t % 0.5, note = [261.63, 329.63, 392, 523.25][Math.floor(t / 2) % 4];
    const sample = 0.18 * Math.sin(2 * Math.PI * note * t) * Math.exp(-beat * 9) + 0.14 * Math.sin(2 * Math.PI * 80 * t) * Math.exp(-beat * 35);
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  await importAudio([new File([buffer], 'FES LIGHT デモ.wav', { type: 'audio/wav' })]);
  if (!current || current.audioName !== 'FES LIGHT デモ.wav') return;
  current.cues = engine.normalize([
    { start: 0, duration: 8, type: 'color', value: '#0088ff', group: 'all', label: 'イントロ・青' },
    { start: 4, duration: 4, type: 'torch', value: true, group: '1組', label: '1組・ライト' },
    { start: 8, duration: 6, type: 'rainbow', group: 'all', label: 'サビ・虹色' },
    { start: 8, duration: 6, type: 'pulse', group: 'all', label: 'ビート・ライト', interval: 500 },
    { start: 14, duration: 2, type: 'color', value: '#000000', group: 'all', label: 'エンディング・暗転' }
  ], 16).map(c => ({ ...c, id: uid() }));
  changed(); say('16秒のデモ曲を追加しました。試聴やタイムライン編集を試せます。');
}
const LABEL_WIDTH = 152;
const laneTitle = lane => `${lane.group === 'all' ? '全クラス' : lane.group} · ${lane.name}`;
function ensureLane(group, channel) {
  let lane = current.lanes.find(l => l.group === group && l.channel === channel);
  if (!lane) {
    if (current.lanes.length >= LightLanes.MAX_LANES) throw new Error('レーンは64本までです');
    lane = { id: uid(), name: channel === 'screen' ? '画面' : 'ライト', group, channel };
    current.lanes.push(lane);
  }
  return lane;
}
function historyState() { return structuredClone({ cues: current.cues, lanes: current.lanes, selected, selectedLane }); }
function restoreHistory(state) {
  current.cues = state.cues; current.lanes = state.lanes; selected = state.selected; selectedLane = state.selectedLane;
  if (!current.lanes.some(l => l.id === selectedLane)) selectedLane = current.lanes[0]?.id || null;
  changed();
}
function renderLaneControls() {
  const lanes = current?.lanes || [];
  if (!lanes.some(l => l.id === selectedLane)) selectedLane = lanes[0]?.id || null;
  $('activeLane').replaceChildren(...lanes.map(l => new Option(laneTitle(l), l.id)));
  $('activeLane').value = selectedLane || '';
  $('activeLane').disabled = !lanes.length;
  $('editLane').disabled = $('deleteLane').disabled = !selectedLane || ownLive;
}
function chooseLane(id, reveal = false) {
  selectedLane = id; renderLaneControls();
  document.querySelectorAll('.effect-track').forEach(track => track.classList.toggle('active-lane', track.dataset.laneId === id));
  if (reveal) {
    const row = Array.from($('effectTracks').children).find(el => el.dataset.laneId === id);
    if (row) {
      const top = row.offsetTop, scroll = $('timelineScroll');
      if (top < scroll.scrollTop) scroll.scrollTop = top;
      else if (top + row.offsetHeight > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = top + row.offsetHeight - scroll.clientHeight;
    }
  }
}
function openLaneDialog(edit = false) {
  if (!editable()) return;
  const lane = edit ? current.lanes.find(l => l.id === selectedLane) : null;
  $('laneForm').dataset.editId = lane?.id || '';
  $('laneDialogTitle').textContent = lane ? 'レーン設定' : 'レーンを追加';
  $('laneName').value = lane?.name || '新しいレーン';
  $('laneGroup').value = lane?.group || current.lanes.find(l => l.id === selectedLane)?.group || 'all';
  $('laneChannel').value = lane?.channel || 'screen';
  $('laneChannel').disabled = !!lane && current.cues.some(c => c.laneId === lane.id);
  $('laneDialog').showModal();
}
function setupLanes() {
  $('activeLane').onchange = e => chooseLane(e.target.value, true);
  $('addLane').onclick = () => openLaneDialog();
  $('editLane').onclick = () => openLaneDialog(true);
  $('cancelLane').onclick = () => $('laneDialog').close();
  $('laneForm').onsubmit = e => {
    e.preventDefault(); if (!editable()) return;
    const id = $('laneForm').dataset.editId;
    const lane = current.lanes.find(l => l.id === id);
    if (!lane && current.lanes.length >= LightLanes.MAX_LANES) return say('レーンは64本までです。', true);
    const name = $('laneName').value.trim(); if (!name) return;
    snapshot();
    const next = { id: lane?.id || uid(), name, group: $('laneGroup').value, channel: $('laneChannel').value };
    if (lane) Object.assign(lane, next); else current.lanes.push(next);
    current.cues.forEach(c => { if (c.laneId === next.id) c.group = next.group; });
    selectedLane = next.id; changed(); chooseLane(next.id, true); $('laneDialog').close();
    say('レーンを保存しました。このレーンを選んで演出を追加できます。');
  };
  $('classLanes').onclick = () => {
    if (!editable()) return;
    const missing = engine.groups.flatMap(group => ['screen', 'torch'].map(channel => ({ group, channel })))
      .filter(({ group, channel }) => !current.lanes.some(l => l.group === group && l.channel === channel));
    if (!missing.length) return say('4クラス分の画面・ライトのレーンはすでにあります。');
    if (current.lanes.length + missing.length > LightLanes.MAX_LANES) return say('レーンは64本までです。', true);
    snapshot(); missing.forEach(({ group, channel }) => ensureLane(group, channel));
    selectedLane = ensureLane('1組', 'screen').id; changed(); chooseLane(selectedLane, true);
    say('4クラスそれぞれの画面・ライトのレーンを用意しました。同時刻に違う演出を追加できます。');
  };
  $('deleteLane').onclick = () => {
    if (!editable()) return;
    const lane = current.lanes.find(l => l.id === selectedLane); if (!lane) return;
    const count = current.cues.filter(c => c.laneId === lane.id).length;
    if (count && !confirm(`「${laneTitle(lane)}」と${count}個の演出を削除しますか？元に戻すこともできます。`)) return;
    snapshot(); current.lanes = current.lanes.filter(l => l.id !== lane.id); current.cues = current.cues.filter(c => c.laneId !== lane.id);
    selected = null; selectedLane = current.lanes[0]?.id || null; changed();
  };
  $('cueLane').onchange = () => {
    const lane = current?.lanes.find(l => l.id === $('cueLane').value);
    if (lane) $('cueGroup').value = lane.group;
  };
  $('cueGroup').onchange = () => {
    const cue = current?.cues.find(c => c.id === selected); if (!cue) return;
    $('cueLane').value = current.lanes.find(l => l.group === $('cueGroup').value && l.channel === LightLanes.channel(cue.type))?.id || '';
  };
}

function renderTimeline() {
  const duration = current?.duration || 30;
  const width = Math.max(1, duration * px);
  renderLaneControls();
  $('timeline').style.width = `${width + LABEL_WIDTH}px`;
  $('effectTracks').replaceChildren();
  for (const lane of current?.lanes || []) {
    const track = element('div', undefined, 'track effect-track' + (lane.id === selectedLane ? ' active-lane' : ''));
    track.dataset.laneId = lane.id; track.dataset.channel = lane.channel;
    const label = element('button', undefined, 'track-name');
    label.append(element('strong', lane.name), element('small', `${lane.group === 'all' ? '全クラス' : lane.group} · ${lane.channel === 'screen' ? '画面' : 'ライト'}`));
    label.title = laneTitle(lane); label.onclick = e => { e.stopPropagation(); chooseLane(lane.id); };
    const clips = element('div', undefined, 'clips'); clips.dataset.laneId = lane.id;
    track.append(label, clips); $('effectTracks').append(track);
  }
  $('ruler').replaceChildren();
  $('ruler').style.width = `${width}px`;
  document.querySelectorAll('.track').forEach(track => { track.style.width = `${width}px`; });
  const step = px >= 60 ? 1 : px >= 25 ? 5 : 10;
  for (let t = 0; t < duration; t += step) {
    const tick = element('span', time(t).slice(0, 5), 'tick'); tick.style.left = `${t * px}px`; $('ruler').append(tick);
  }
  document.querySelectorAll('.clips').forEach(el => el.replaceChildren());
  for (const cue of current?.cues || []) {
    const screen = cue.type === 'color' || cue.type === 'rainbow';
    const clip = element('button', undefined, 'clip' + (!screen ? ' torch-clip' : '') + (cue.id === selected ? ' selected' : ''));
    clip.dataset.id = cue.id;
    clip.style.left = `${cue.start * px}px`; clip.style.width = `${cue.duration * px}px`;
    if (cue.type === 'color') clip.style.backgroundColor = cue.value;
    if (cue.type === 'rainbow') clip.style.background = 'linear-gradient(90deg,#b74466,#5476ad,#458d62)';
    clip.style.textShadow = '0 1px 3px #000,0 0 4px #000';
    clip.append(element('span', cue.label), element('small', cue.group === 'all' ? '全クラス' : cue.group), element('span', '', 'resize'));
    clip.setAttribute('aria-label', `${cue.label} ${cue.start.toFixed(2)}秒から${cue.duration.toFixed(2)}秒`);
    clip.onpointerdown = e => dragCue(e, cue, clip);
    clip.onclick = e => { e.stopPropagation(); selected = cue.id; chooseLane(cue.laneId); renderInspector(); markSelected(); };
    Array.from($('effectTracks').children).find(track => track.dataset.laneId === cue.laneId)?.querySelector('.clips').append(clip);
  }
  const canvas = $('waveform'); canvas.width = Math.min(16000, Math.ceil(width));
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#68c4a5';
  const peaks = current?.peaks || [];
  peaks.forEach((p, i) => { const height = Math.max(1, p * 65); ctx.fillRect(i / peaks.length * canvas.width, (74 - height) / 2, Math.max(1, canvas.width / peaks.length - 1), height); });
  $('undo').disabled = !undo.length || ownLive; $('redo').disabled = !redo.length || ownLive;
  if (current) $('songMeta').textContent = `${current.audioName || '音源未設定'} · ${time(current.duration)} · ${current.cues.length}演出`;
}
function markSelected() { document.querySelectorAll('.clip').forEach(el => el.classList.toggle('selected', el.dataset.id === selected)); }
function dragCue(e, cue, clip) {
  if (!editable() || e.button !== 0) return;
  e.stopPropagation(); e.preventDefault(); selected = cue.id; chooseLane(cue.laneId); renderInspector(); markSelected();
  const resizing = e.target.classList.contains('resize');
  const startX = e.clientX, startY = e.clientY, originalStart = cue.start, originalDuration = cue.duration;
  let moved = false;
  clip.setPointerCapture(e.pointerId);
  clip.onpointermove = ev => {
    const delta = Math.round((ev.clientX - startX) / px * 20) / 20;
    if (!delta && Math.abs(ev.clientY - startY) < 4 && !moved) return;
    if (!moved) { snapshot(); moved = true; }
    if (resizing) cue.duration = engine.clamp(originalDuration + delta, 0.05, current.duration - cue.start);
    else cue.start = engine.clamp(originalStart + delta, 0, current.duration - cue.duration);
    clip.style.left = `${cue.start * px}px`; clip.style.width = `${cue.duration * px}px`;
    $('cueStart').value = cue.start.toFixed(2); $('cueDuration').value = cue.duration.toFixed(2);
    document.querySelectorAll('.drop-lane').forEach(el => el.classList.remove('drop-lane'));
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.effect-track');
    if (!resizing && target?.dataset.channel === LightLanes.channel(cue.type)) target.classList.add('drop-lane');
  };
  const finish = ev => {
    if (moved && !resizing && ev.type !== 'pointercancel') {
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.effect-track');
      const lane = current.lanes.find(l => l.id === row?.dataset.laneId && l.channel === LightLanes.channel(cue.type));
      if (lane) { cue.laneId = lane.id; cue.group = lane.group; selectedLane = lane.id; }
    }
    document.querySelectorAll('.drop-lane').forEach(el => el.classList.remove('drop-lane'));
    clip.onpointermove = null; clip.onpointerup = null; clip.onpointercancel = null; if (moved) changed();
  };
  clip.onpointerup = finish; clip.onpointercancel = finish;
}
function renderInspector() {
  const c = current?.cues.find(c => c.id === selected);
  $('cueForm').hidden = !c; $('cueEmpty').hidden = !!c;
  if (!c) return;
  $('cueLabel').value = c.label; $('cueStart').value = c.start.toFixed(2); $('cueDuration').value = c.duration.toFixed(2);
  $('cueLane').replaceChildren(new Option('対象に合わせてレーンを作成', ''), ...current.lanes.filter(l => l.channel === LightLanes.channel(c.type)).map(l => new Option(laneTitle(l), l.id)));
  $('cueLane').value = c.laneId;
  $('cueGroup').value = c.group; $('cueColor').value = c.type === 'color' ? c.value : '#0088ff';
  $('cueTorch').value = String(c.value); $('cueInterval').value = c.interval / 1000;
  $('cueRamp').checked = c.type === 'pulse' && c.intervalEnd !== undefined;
  $('cueIntervalEnd').value = (c.intervalEnd || 200) / 1000;
  $('rampField').hidden = c.type !== 'pulse'; $('intervalEndField').hidden = c.type !== 'pulse' || !$('cueRamp').checked;
  $('colorField').hidden = c.type !== 'color'; $('torchField').hidden = c.type !== 'torch'; $('intervalField').hidden = c.type !== 'pulse';
}
function addCue(type) {
  if (!editable()) return;
  if (position >= current.duration - 0.05) return say('曲の終わりより前に再生位置を移動してください。', true);
  const channel = LightLanes.channel(type === 'blackout' ? 'color' : type);
  const active = current.lanes.find(l => l.id === selectedLane);
  if (!current.lanes.some(l => l.group === (active?.group || 'all') && l.channel === channel) && current.lanes.length >= LightLanes.MAX_LANES) return say('レーンは64本までです。', true);
  snapshot();
  const lane = active?.channel === channel ? active : ensureLane(active?.group || 'all', channel);
  selectedLane = lane.id;
  const c = { id: uid(), laneId: lane.id, start: Math.round(position * 100) / 100, duration: Math.min(5, current.duration - position), type: type === 'blackout' ? 'color' : type,
    value: type === 'torch' ? true : type === 'blackout' ? '#000000' : type === 'color' ? '#0088ff' : null,
    label: { color: '画面色', rainbow: '虹色', torch: 'ライト点灯', pulse: 'ライト点滅', blackout: '暗転' }[type], group: lane.group, interval: 500 };
  current.cues.push(c); selected = c.id; changed(); chooseLane(lane.id, true);
}
function localStop() { playbackGeneration++; audio.pause(); playing = false; transport = null; $('playPreview').textContent = '▶ 試聴'; }
async function previewPlay() {
  if (!current?.blob) return say('再生する音源を追加・再設定してください。', true);
  if (ownLive) return say('本番送信中です。一時停止または全員停止を使用してください。', true);
  if (position >= current.duration) position = 0;
  const generation = ++playbackGeneration;
  audio.currentTime = position;
  try { await audio.play(); if (generation !== playbackGeneration) return; playing = true; transport = null; say('ローカル試聴中です。参加者には送信していません。'); }
  catch (e) { if (e.name !== 'AbortError') say('音源を再生できません。音源を再設定してください。', true); }
}
function control(action, pos = position) {
  if (!socket.connected) return Promise.reject(new Error('サーバーに接続されていません'));
  return new Promise((resolve, reject) => {
    socket.timeout(4000).emit('show-control', { eventId, action, songId: current?.id, title: current?.title, duration: current?.duration,
      cues: current?.cues || [], position: pos }, (error, result) => {
      if (error) reject(new Error('送信の確認が取れません。接続を確認し、必要なら全員停止してください'));
      else if (!result.ok) reject(new Error(result.error)); else resolve(result);
    });
  });
}
async function livePlay() {
  if (!current?.blob) return say('本番で使う音源を追加・再設定してください。', true);
  if (busy) return;
  busy = true;
  const token = ++liveRequest;
  try {
    // Unlock operator audio inside the click gesture before waiting for the server.
    await audio.play(); audio.pause();
    if (token !== liveRequest) return;
    const result = await control('play', position >= current.duration ? 0 : position);
    if (token !== liveRequest) return;
    ownLive = true; transport = result.show; playing = true; audio.currentTime = result.show.position;
    say('本番送信を開始しました。音楽はこの端末で再生されます。');
  } catch (e) { localStop(); say(e.message, true); }
  finally { finishControl(); renderTimeline(); }
}
function finishControl() {
  busy = false;
  if (pendingSeek !== null) { const t = pendingSeek; pendingSeek = null; seekTo(t); }
}
async function pausePlayback() {
  if (busy) return;
  if (!ownLive) { position = audio.currentTime || position; localStop(); return; }
  busy = true;
  const token = liveRequest;
  try { const result = await control('pause'); if (token !== liveRequest) return; localStop(); transport = result.show; ownLive = true; position = result.show.position; audio.currentTime = position; }
  catch (e) { say(e.message, true); }
  finally { finishControl(); }
}
async function seekTo(t) {
  if (!current) return;
  if (busy) { if (ownLive) pendingSeek = t; return; }
  t = engine.clamp(t, 0, current.duration);
  if (ownLive) {
    busy = true;
    const token = liveRequest;
    try { const result = await control(playing ? 'play' : 'pause', t); if (token !== liveRequest) return; audio.pause(); audio.currentTime = t; transport = result.show; position = t; }
    catch (e) { say(e.message, true); }
    finally { finishControl(); }
  } else { position = t; if (current.blob) audio.currentTime = t; }
}
async function emergency() {
  liveRequest++; pendingSeek = null;
  localStop(); ownLive = false; position = 0;
  if (current?.blob) audio.currentTime = 0;
  try { await control('stop'); say('全クラスの画面とライトを停止・暗転しました。'); }
  catch (e) { say(e.message, true); }
  renderTimeline();
}
function syncClock() {
  if (!socket.connected) return;
  const before = Date.now();
  socket.timeout(2000).emit('clock-sync', {}, (error, serverTime) => {
    if (error) return;
    const rtt = Date.now() - before;
    if (rtt < bestRTT + 20) { bestRTT = Math.min(bestRTT, rtt); clockOffset = serverTime - (before + rtt / 2); }
  });
}
function frame() {
  if (playing && current) {
    if (ownLive && transport) {
      const now = Date.now() + clockOffset;
      position = engine.position(transport, now);
      if (now >= transport.startTime && audio.paused && position < current.duration && !busy) audio.play().catch(() => {
        localStop(); control('stop').catch(() => {}); ownLive = false; say('音楽を再生できなかったため本番送信を停止しました。', true);
      });
      if (Math.abs(audio.currentTime - position) > 0.18) audio.currentTime = position;
    } else position = audio.currentTime;
    if (position >= current.duration) { position = current.duration; localStop(); if (ownLive) { ownLive = false; control('stop').catch(e => say(e.message, true)); } }
  }
  $('timecode').textContent = time(position); if (!seeking) $('seek').value = position;
  $('playhead').style.left = `${LABEL_WIDTH + position * px}px`;
  const manualPreview = document.body.classList.contains('live-mode') && remoteShow?.title === '手動操作';
  phoneEls.forEach(({ phone, torch, group }) => {
    const state = engine.stateAt(manualPreview ? remoteShow.cues : current?.cues || [], manualPreview ? 0 : position, group);
    phone.style.backgroundColor = state.color; torch.classList.toggle('on', state.torch);
  });
  $('playbackBadge').textContent = ownLive ? (playing ? '● 本番送信中' : '本番 一時停止') : manualPreview ? '手動操作中' : 'ローカル試聴';
  $('playbackBadge').classList.toggle('live', ownLive);
  $('startLive').textContent = ownLive && !playing ? '▶ この位置から本番を再開' : '● この位置から本番送信';
  $('liveStatus').textContent = remoteShow ? `会場：${remoteShow.title} · ${remoteShow.playing ? '送信中' : '一時停止中'}` : '参加者への送信は停止中';
  const next = current?.cues.find(c => c.start > position);
  $('nextCue').textContent = next ? `次の演出：${time(next.start)} ${next.label}` : '次の演出：—';
  realtimePanel?.render();
  requestAnimationFrame(frame);
}
let realtimePanel;
function mode(mode) {
  document.body.classList.toggle('live-mode', mode === 'live');
  $('studio').hidden = mode === 'join' || mode === 'realtime'; $('participants').hidden = mode !== 'join'; $('realtime').hidden = mode !== 'realtime';
  realtimePanel?.setActive(mode === 'realtime');
  if (mode === 'realtime') window.scrollTo(0, 0);
  ['edit', 'live', 'realtime', 'join'].forEach(m => $(m + 'Tab').classList.toggle('active', mode === m));
}
function joinEvent() {
  if (!socket.connected) return;
  socket.emit('join-admin', { eventId }); syncClock();
  const name = $('eventSelect').selectedOptions[0].textContent;
  const link = new URL('/client.html', location.origin); link.searchParams.set('event', eventId); link.searchParams.set('name', name);
  $('clientLink').href = link; $('clientLink').textContent = link;
  $('qrLink').href = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(link)}`;
}
function manual(type, value) {
  if (!socket.connected) return say('サーバー接続を確認してください。', true);
  localStop(); ownLive = false;
  const group = $('manualGroup').value;
  const cues = (remoteShow?.title === '手動操作' ? remoteShow.cues : []).filter(c => !(c.type === type && (group === 'all' || c.group === group)));
  cues.push({ id: uid(), start: 0, duration: 7200, type, value, label: '手動操作', group, interval: 500 });
  socket.timeout(4000).emit('show-control', { eventId, action: 'pause', title: '手動操作', duration: 7200, position: 0, cues }, (err, result) => {
    if (err || !result.ok) say(result?.error || '手動操作の送信に失敗しました', true); else say('手動操作を送信しました。');
  });
}
async function backup() {
  if (!songs.length) return say('バックアップする曲がありません。', true);
  const data = { version: 1, songs: songs.map(({ blob, peaks, ...s }) => s) };
  const link = element('a'); const u = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  link.href = u; link.download = 'fes-light-project.json'; link.click(); setTimeout(() => URL.revokeObjectURL(u), 1000);
  say('演出をバックアップしました。音源ファイルは別に保管してください。');
}
async function restore(file) {
  if (!file || ownLive || busy) return;
  busy = true; let last;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('バックアップが大きすぎます');
    const data = JSON.parse(await file.text());
    if (data.version !== 1 || !Array.isArray(data.songs) || data.songs.length > 200) throw new Error('バックアップの形式が不正です');
    const incoming = data.songs.map(s => {
      if (!Number.isFinite(s.duration) || s.duration <= 0 || s.duration > 7200) throw new Error('曲の長さが不正です');
      return LightLanes.normalizeSong({ id: uid(), title: String(s.title || '読み込んだ曲').slice(0, 150), duration: s.duration,
        audioName: String(s.audioName || '').slice(0, 255), ...(Array.isArray(s.lanes) ? { lanes: s.lanes } : {}), cues: engine.normalize(s.cues, s.duration), peaks: [], blob: null });
    });
    for (const s of incoming) { await storeRecord(s); songs.push(s); last = s.id; }
    say('演出を読み込みました。「音源を再設定」から元の曲を選んでください。');
  } catch (e) { say(`読み込みに失敗しました：${e.message}`, true); }
  finally { busy = false; if (last) selectSong(last); $('importProject').value = ''; }
}
function setup() {
  setupLanes();
  realtimePanel = LightRealtime.mount($('realtime'), {
    send: payload => {
      localStop(); ownLive = false; liveRequest++; pendingSeek = null;
      if (!socket.connected) return Promise.reject(new Error('サーバー接続を確認してください'));
      return new Promise((resolve, reject) => socket.timeout(4000).emit('manual-command', { ...payload, eventId }, (error, result) => {
        if (error || !result?.ok) reject(new Error(result?.error || '操作の送信を確認できませんでした')); else resolve(result);
      }));
    }, stop: emergency, notify: say,
    getState: () => ({ show: remoteShow, now: Date.now() + clockOffset, connected: socket.connected })
  });
  $('cueRamp').onchange = () => { $('intervalEndField').hidden = !$('cueRamp').checked; };
  engine.groups.forEach(group => {
    const phone = element('div', undefined, 'phone'); const torch = element('span', '', 'torch');
    phone.append(torch, element('span', group, 'phone-label')); $('phones').append(phone); phoneEls.push({ phone, torch, group });
  });
  const relink = element('label', '音源を再設定', 'file-button'); relink.id = 'relinkAudio'; relink.hidden = true;
  const input = element('input'); input.id = 'relinkInput'; input.type = 'file'; input.accept = 'audio/*,.mp3,.wav,.m4a'; input.onchange = () => importAudio(input.files, true); relink.append(input);
  $('renameSong').parentNode.prepend(relink);
  $('demoSong').onclick = addDemo;
  $('audioFiles').onchange = e => importAudio(e.target.files);
  $('dropZone').ondragover = e => { e.preventDefault(); $('dropZone').classList.add('dragging'); };
  $('dropZone').ondragleave = () => $('dropZone').classList.remove('dragging');
  $('dropZone').ondrop = e => { e.preventDefault(); $('dropZone').classList.remove('dragging'); importAudio(e.dataTransfer.files); };
  document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => addCue(b.dataset.add));
  $('cueForm').onsubmit = e => {
    e.preventDefault(); if (!editable()) return;
    const c = current.cues.find(c => c.id === selected); if (!c) return;
    const next = { ...c, label: $('cueLabel').value, start: Number($('cueStart').value), duration: Number($('cueDuration').value),
      group: $('cueGroup').value, value: c.type === 'color' ? $('cueColor').value : c.type === 'torch' ? $('cueTorch').value === 'true' : null,
      interval: Number($('cueInterval').value) * 1000 };
    delete next.intervalEnd; delete next.rampDuration;
    if (c.type === 'pulse' && $('cueRamp').checked) { next.intervalEnd = Number($('cueIntervalEnd').value) * 1000; next.rampDuration = next.duration; }
    if (next.start + next.duration > current.duration + 0.001) return say('演出が曲の終わりを超えています。', true);
    try {
      engine.normalize([next], current.duration);
      const chosen = current.lanes.find(l => l.id === $('cueLane').value && l.group === next.group && l.channel === LightLanes.channel(next.type));
      if (!chosen && !current.lanes.some(l => l.group === next.group && l.channel === LightLanes.channel(next.type)) && current.lanes.length >= LightLanes.MAX_LANES) throw new Error('レーンは64本までです');
      snapshot(); const lane = chosen || ensureLane(next.group, LightLanes.channel(next.type));
      Object.assign(c, next, { laneId: lane.id }); selectedLane = lane.id; changed(); say('演出を更新しました。');
    }
    catch (e) { say(e.message, true); }
  };
  $('deleteCue').onclick = () => { if (!editable()) return; snapshot(); current.cues = current.cues.filter(c => c.id !== selected); selected = null; changed(); };
  $('duplicateCue').onclick = () => { if (!editable()) return; const c = current.cues.find(c => c.id === selected); if (!c) return; snapshot(); const copy = { ...c, id: uid(), start: Math.min(current.duration - c.duration, c.start + c.duration) }; current.cues.push(copy); selected = copy.id; changed(); };
  $('undo').onclick = () => { if (!editable() || !undo.length) return; redo.push(historyState()); restoreHistory(undo.pop()); };
  $('redo').onclick = () => { if (!editable() || !redo.length) return; undo.push(historyState()); restoreHistory(redo.pop()); };
  $('zoom').oninput = e => { px = Number(e.target.value); renderTimeline(); };
  $('timeline').onclick = e => { if (e.target.closest('.clip') || e.target.closest('.track-name')) return; const row = e.target.closest('.effect-track'); if (row) chooseLane(row.dataset.laneId); const r = $('timeline').getBoundingClientRect(); seekTo((e.clientX - r.left - LABEL_WIDTH) / px); };
  $('seek').onpointerdown = () => { seeking = true; };
  $('seek').onpointercancel = () => { seeking = false; };
  $('seek').onchange = e => { seeking = false; seekTo(Number(e.target.value)); };
  $('seek').onpointerup = () => { seeking = false; };
  $('rewind').onclick = () => seekTo(0); $('playPreview').onclick = previewPlay; $('pause').onclick = pausePlayback; $('startLive').onclick = livePlay; $('emergency').onclick = emergency;
  $('volume').oninput = e => { audio.volume = Number(e.target.value); }; audio.volume = 0.8;
  audio.onended = () => { position = current?.duration || 0; localStop(); if (ownLive) { ownLive = false; control('stop').catch(e => say(e.message, true)); } };
  audio.onerror = () => { if (playing || ownLive) { localStop(); if (ownLive) control('stop').catch(() => {}); ownLive = false; say('音源の再生に失敗したため送信を停止しました。', true); } };
  $('renameSong').onclick = () => { if (!editable()) return; const name = prompt('曲名', current.title); if (name?.trim()) { current.title = name.trim().slice(0, 150); persist(); $('songTitle').textContent = current.title; renderLibrary(); } };
  $('deleteSong').onclick = async () => { if (!editable() || !confirm(`「${current.title}」の曲と演出を削除しますか？`)) return; try { await storeRecord(current, true); songs = songs.filter(s => s.id !== current.id); selectSong(songs[0]?.id); } catch { say('削除できませんでした。', true); } };
  ['edit', 'live', 'realtime', 'join'].forEach(m => $(m + 'Tab').onclick = () => mode(m));
  $('eventSelect').onchange = async () => { if (ownLive) { await emergency(); } localStop(); eventId = $('eventSelect').value; remoteShow = null; joinEvent(); };
  $('newEvent').onclick = () => { const name = prompt('新しい会場名'); if (!name?.trim()) return; const opt = new Option(name.trim(), 'ev_' + uid()); $('eventSelect').add(opt); saveEvents(); };
  function saveEvents() { try { localStorage.setItem('fes-light-events', JSON.stringify(Array.from($('eventSelect').options).map(o => ({ id: o.value, name: o.textContent })))); } catch {} }
  try { const events = JSON.parse(localStorage.getItem('fes-light-events') || '[]'); for (const ev of events) { if (ev && typeof ev.id === 'string' && typeof ev.name === 'string' && !Array.from($('eventSelect').options).some(o => o.value === ev.id)) $('eventSelect').add(new Option(ev.name, ev.id)); } } catch {}
  $('copyLink').onclick = () => navigator.clipboard.writeText($('clientLink').href).then(() => say('参加リンクをコピーしました。')).catch(() => say('リンクを長押ししてコピーしてください。'));
  $('exportProject').onclick = backup; $('importProject').onchange = e => restore(e.target.files[0]);
  [['赤', '#ff0055'], ['青', '#0088ff'], ['黄', '#ffd000'], ['緑', '#00cc44'], ['紫', '#9900ff'], ['白', '#ffffff'], ['暗転', '#000000']].forEach(([name, color]) => {
    const b = element('button', name); b.style.background = color; b.style.color = ['#ffd000', '#ffffff'].includes(color) ? '#000' : '#fff'; b.onclick = () => manual('color', color); $('manualColors').append(b);
  });
  $('manualOn').onclick = () => manual('torch', true); $('manualOff').onclick = () => manual('torch', false);
  try { $('legacyImport').hidden = !localStorage.getItem('my_timeline'); } catch {}
  $('legacyImport').onclick = () => {
    if (!editable()) return;
    try {
      const steps = JSON.parse(localStorage.getItem('my_timeline')); if (!Array.isArray(steps)) throw new Error();
      const cues = steps.filter(s => Number.isFinite(s.sec) && s.sec >= 0 && s.sec < current.duration).map((s, i, all) => {
        const channel = s.type === 'torch' ? 'torch' : 'screen';
        const end = all.slice(i + 1).find(n => n.sec > s.sec && (n.type === 'torch' ? 'torch' : 'screen') === channel)?.sec || current.duration;
        return { id: uid(), start: s.sec, duration: end - s.sec, type: s.type, value: s.value, group: 'all', label: s.label || '以前の演出', interval: 500 };
      });
      const valid = engine.normalize(cues, current.duration); snapshot(); current.cues.push(...valid); changed(); say('以前の演出を取り込みました。');
    } catch { say('以前の演出を取り込めませんでした。', true); }
  };
  window.addEventListener('beforeunload', () => { if (ownLive) socket.emit('show-control', { action: 'stop', eventId }); });
}
socket.on('connect', () => { $('connection').textContent = '● 接続済み'; bestRTT = Infinity; joinEvent(); });
socket.on('disconnect', () => { $('connection').textContent = '接続が切れました'; if (ownLive) { localStop(); ownLive = false; say('接続が切れたため音楽を停止しました。再接続後に本番送信を再開してください。', true); } remoteShow = null; });
socket.on('show-state', data => {
  if (data.eventId !== eventId) return;
  remoteShow = data.show;
  if (ownLive && (!data.show || data.show.owner !== socket.id || data.show.songId !== current?.id)) { localStop(); ownLive = false; }
});
socket.on('status-update', counts => {
  $('participantsCount').textContent = counts['全クラス'] || 0;
  $('groupCounts').replaceChildren(...engine.groups.map(g => element('span', `${g}：${counts[g] || 0}台`, 'badge')));
});
socket.on('client-list-update', devices => {
  $('deviceList').replaceChildren(...devices.map(d => { const el = element('div', undefined, 'device'); el.append(element('strong', d.name), element('small', d.group)); return el; }));
});
(async () => {
  setup();
  try { await openDB(); renderLibrary(); if (songs.length) selectSong(songs[0].id); else renderTimeline(); }
  catch { say('ブラウザの保存機能が使えません。通常のブラウザ設定で開き直してください。', true); }
  socket.connect(); setInterval(syncClock, 10000); requestAnimationFrame(frame);
})();
