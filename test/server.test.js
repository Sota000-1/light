const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../server');
const Show = require('../public/show-engine');
let url; const sockets = [];
before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${server.address().port}`; });
after(async () => { for (const s of sockets) s.disconnect(); await new Promise(r => io.close(r)); });
const once = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`Timed out: ${event}`)); }, 2500);
  const listener = data => { clearTimeout(timer); resolve(data); }; socket.once(event, listener);
});
async function client() { const s = connect(url, { transports: ['websocket'] }); sockets.push(s); await once(s, 'connect'); return s; }
async function admin(eventId) { const s = await client(); const state = once(s, 'show-state'); s.emit('join-admin', { eventId }); await state; return s; }
function command(s, data) { return new Promise((resolve, reject) => s.timeout(2000).emit('show-control', data, (e, r) => e ? reject(e) : resolve(r))); }
const program = (eventId, overrides = {}) => ({ eventId, action: 'play', title: 'Song', songId: 'song', duration: 10, position: 2,
  cues: [{ start: 0, duration: 8, type: 'color', value: '#0088ff', group: 'all' }, { start: 1, duration: 4, type: 'torch', value: true, group: '2組' }], ...overrides });
test('live seek, pause and late joins share the current position; events stay isolated', async () => {
  const a = await admin('main'); const c = await client();
  let received = once(c, 'show-state'); c.emit('join-client', { eventId: 'main', group: '2組' }); await received;
  const other = await client(); received = once(other, 'show-state'); other.emit('join-client', { eventId: 'gym', group: '1組' }); await received;
  const otherEvents = []; other.on('show-state', s => otherEvents.push(s));
  received = once(c, 'show-state'); const r = await command(a, program('main')); const state = await received;
  assert.equal(r.ok, true); assert.equal(state.show.position, 2); assert.ok(state.show.startTime >= Date.now() + 300);
  const late = await client(); received = once(late, 'show-state'); late.emit('join-client', { eventId: 'main', group: '1組' });
  assert.equal((await received).show.owner, a.id);
  received = once(c, 'show-state'); await command(a, program('main', { action: 'pause', position: 4.5 }));
  const paused = (await received).show; assert.equal(paused.playing, false); assert.equal(Show.position(paused, Date.now() + 100000), 4.5);
  received = once(c, 'show-state'); await command(a, { eventId: 'main', action: 'stop' }); assert.equal((await received).show, null);
  assert.equal(otherEvents.length, 0);
});
test('invalid program does not cancel an existing show, and cross-event control is rejected', async () => {
  const a = await admin('validation'); await command(a, program('validation'));
  const bad = await command(a, program('validation', { cues: [{ start: 0, duration: -1, type: 'torch', value: true, group: 'all' }] }));
  assert.equal(bad.ok, false);
  assert.equal((await command(a, program('main'))).ok, false);
  const c = await client(); const state = once(c, 'show-state'); c.emit('join-client', { eventId: 'validation', group: '1組' }); assert.equal((await state).show.title, 'Song');
  await command(a, { eventId: 'validation', action: 'stop' });
});
test('operator disconnect and natural end black out the room', async () => {
  const a = await admin('disconnect'); const c = await client(); let received = once(c, 'show-state'); c.emit('join-client', { eventId: 'disconnect' }); await received;
  await command(a, program('disconnect')); received = once(c, 'show-state'); a.disconnect(); assert.equal((await received).show, null);
  const b = await admin('disconnect'); await command(b, program('disconnect', { duration: 0.1, position: 0, cues: [] }));
  received = once(c, 'show-state'); assert.equal((await received).show, null);
});
test('operator switching rooms leaves old updates and ends their active show', async () => {
  const a = await admin('switch1'); await command(a, program('switch1'));
  let received = once(a, 'show-state'); a.emit('join-admin', { eventId: 'switch2' }); await received;
  assert.equal((await command(a, program('switch1'))).ok, false);
  const c = await client(); received = once(c, 'show-state'); c.emit('join-client', { eventId: 'switch1' }); assert.equal((await received).show, null);
});
function manualCommand(s, data) { return new Promise((resolve, reject) => s.timeout(2000).emit('manual-command', data, (e, r) => e ? reject(e) : resolve(r))); }
test('realtime commands preserve independent screen/torch/class state and ramp phase', async () => {
  const a = await admin('pads');
  const send = data => manualCommand(a, { eventId: 'pads', group: 'all', ...data });
  assert.equal((await send({ channel: 'screen', mode: 'color', color: '#ff0055' })).ok, true);
  assert.equal((await send({ channel: 'torch', mode: 'on', group: '1組' })).ok, true);
  const ramp = await send({ channel: 'torch', mode: 'ramp', group: '2組', interval: 1000, intervalEnd: 200, rampDuration: 2 });
  assert.equal(ramp.ok, true);
  const recolored = await send({ channel: 'screen', mode: 'color', group: '2組', color: '#0088ff' });
  assert.equal(recolored.show.startTime, ramp.show.startTime);
  const t = 3;
  assert.equal(Show.stateAt(recolored.show.cues, t, '1組').color, '#ff0055');
  assert.equal(Show.stateAt(recolored.show.cues, t, '1組').torch, true);
  assert.equal(Show.stateAt(recolored.show.cues, t, '2組').color, '#0088ff');
  assert.equal(Show.stateAt(recolored.show.cues, t, '2組').torch, Show.stateAt(ramp.show.cues, t, '2組').torch);
  const off = await send({ channel: 'torch', mode: 'off' });
  assert.equal(Show.stateAt(off.show.cues, 3, '1組').torch, false);
  assert.equal(Show.stateAt(off.show.cues, 3, '2組').color, '#0088ff');
  assert.equal((await send({ channel: 'torch', mode: 'ramp', interval: 1000, intervalEnd: 20, rampDuration: 2 })).ok, false);
  assert.equal((await manualCommand(a, { eventId: 'main', channel: 'torch', mode: 'on', group: 'all' })).ok, false);
  const late = await client(); const received = once(late, 'show-state'); late.emit('join-client', { eventId: 'pads', group: '1組' });
  assert.deepEqual((await received).show.cues, off.show.cues);
  await command(a, { eventId: 'pads', action: 'stop' });
});
test('momentary flash turns off after 250ms without changing the screen', async () => {
  const a = await admin('flash');
  await manualCommand(a, { eventId: 'flash', group: 'all', channel: 'screen', mode: 'color', color: '#00cc44' });
  const result = await manualCommand(a, { eventId: 'flash', group: '3組', channel: 'torch', mode: 'flash' });
  const flash = result.show.cues.find(c => c.type === 'torch' && c.value === true);
  assert.equal(Show.stateAt(result.show.cues, flash.start + 0.1, '3組').torch, true);
  assert.equal(Show.stateAt(result.show.cues, flash.start + 0.3, '3組').torch, false);
  assert.equal(Show.stateAt(result.show.cues, flash.start + 0.3, '3組').color, '#00cc44');
  assert.equal(Show.stateAt(result.show.cues, flash.start + 0.1, '1組').torch, false);
  await command(a, { eventId: 'flash', action: 'stop' });
});
