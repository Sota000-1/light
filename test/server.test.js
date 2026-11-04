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
