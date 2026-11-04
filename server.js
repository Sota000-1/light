// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Show = require('./public/show-engine');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1024 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));

let clients = {}; // { socketId: { id, eventId, group, name, isOn } }
const shows = new Map();
const showEnds = new Map();
let currentTimers = {}; // { eventId: timer }

function publishShow(eventId) {
  const show = shows.get(eventId) || null;
  io.to(eventId).to(`admin_${eventId}`).emit('show-state', { eventId, show, serverTime: Date.now() });
}
function clearShow(eventId, notify = true) {
  clearTimeout(showEnds.get(eventId));
  showEnds.delete(eventId);
  shows.delete(eventId);
  if (notify) publishShow(eventId);
}
function stopCurrentMode(eventId, notify = true) {
  clearShow(eventId, notify);
  if (currentTimers[eventId]) {
    clearInterval(currentTimers[eventId]);
    delete currentTimers[eventId];
  }
  for (const id in clients) {
    if (clients[id].eventId === eventId) clients[id].isOn = false;
  }
  io.to(eventId).emit('stop-timeline');
  io.to(eventId).emit('stop-effects'); // クライアント側の自律点滅・ストロボを停止
  io.to(eventId).emit('torch', { state: false });
  broadcastClientList(eventId);
}

function getCounts(eventId) {
  const counts = { '全クラス': 0, '1組': 0, '2組': 0, '3組': 0, '4組': 0 };
  for (const id in clients) {
    if (clients[id].eventId === eventId) {
      counts['全クラス']++;
      const grp = clients[id].group;
      if (counts[grp] !== undefined) counts[grp]++;
    }
  }
  return counts;
}

function getDevices(eventId) {
  return Object.values(clients).filter(c => c.eventId === eventId);
}

function broadcastClientList(eventId) {
  io.to(`admin_${eventId}`).emit('client-list-update', getDevices(eventId));
  io.to(`admin_${eventId}`).emit('status-update', getCounts(eventId));
}

io.on('connection', (socket) => {
  socket.on('clock-sync', (_data, reply) => { if (typeof reply === 'function') reply(Date.now()); });
  socket.on('show-control', (data, reply) => {
    const answer = result => { if (typeof reply === 'function') reply(result); };
    try {
      if (!data || socket.adminEvent !== data.eventId) throw new Error('会場への接続を確認してください');
      const ev = socket.adminEvent;
      if (data.action === 'stop') {
        stopCurrentMode(ev);
        io.to(ev).emit('set-color', { color: '#000000' });
        return answer({ ok: true });
      }
      if (data.action !== 'play' && data.action !== 'pause') throw new Error('操作が不正です');
      const duration = Number(data.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 7200) throw new Error('曲の長さは2時間以内にしてください');
      const cues = Show.normalize(data.cues, duration);
      const position = Show.clamp(data.position, 0, duration);
      stopCurrentMode(ev, false);
      const show = { owner: socket.id, songId: String(data.songId || '').slice(0, 100), title: String(data.title || '').slice(0, 150),
        duration, cues, position, playing: data.action === 'play', startTime: Date.now() + 500 };
      shows.set(ev, show);
      publishShow(ev);
      if (show.playing) showEnds.set(ev, setTimeout(() => {
        stopCurrentMode(ev);
        io.to(ev).emit('set-color', { color: '#000000' });
      }, (duration - position) * 1000 + 500));
      answer({ ok: true, show, serverTime: Date.now() });
    } catch (error) { answer({ ok: false, error: error.message }); }
  });
  // 管理者がイベント部屋に参加
  socket.on('join-admin', (data) => {
    const eventId = data.eventId || 'main';
    if (socket.adminEvent && socket.adminEvent !== eventId) {
      if (shows.get(socket.adminEvent)?.owner === socket.id) {
        stopCurrentMode(socket.adminEvent);
        io.to(socket.adminEvent).emit('set-color', { color: '#000000' });
      }
      socket.leave(`admin_${socket.adminEvent}`);
    }
    socket.adminEvent = eventId;
    socket.join(`admin_${eventId}`);
    socket.emit('show-state', { eventId, show: shows.get(eventId) || null, serverTime: Date.now() });
    socket.emit('status-update', getCounts(eventId));
    socket.emit('client-list-update', getDevices(eventId));
  });

  // スマホ参加
  socket.on('join-client', (data) => {
    if (socket.isClient && clients[socket.id]) {
      const old = clients[socket.id];
      socket.leave(old.eventId);
      socket.leave(`${old.eventId}_${old.group}`);
      delete clients[socket.id];
      broadcastClientList(old.eventId);
    }
    socket.isClient = true;
    socket.eventId = data.eventId || 'main';
    socket.group = data.group || '1組';
    
    // イベント部屋 + クラス部屋に参加
    socket.join(socket.eventId);
    socket.join(`${socket.eventId}_${socket.group}`);

    const existingCount = getDevices(socket.eventId).filter(c => c.group === socket.group).length + 1;
    const clientName = data.name && data.name.trim() !== '' 
      ? data.name.trim() 
      : `${socket.group} #${existingCount}`;

    clients[socket.id] = { 
      id: socket.id, 
      eventId: socket.eventId, 
      group: socket.group, 
      name: clientName, 
      isOn: false 
    };

    broadcastClientList(socket.eventId);
    socket.emit('show-state', { eventId: socket.eventId, show: shows.get(socket.eventId) || null, serverTime: Date.now() });
  });

  socket.on('leave-client', () => {
    if (socket.isClient && clients[socket.id]) {
      const ev = clients[socket.id].eventId;
      socket.leave(ev);
      socket.leave(`${ev}_${clients[socket.id].group}`);
      delete clients[socket.id];
      socket.isClient = false;
      broadcastClientList(ev);
    }
  });

  // タイムライン自律再生
  socket.on('admin-start-timeline', (data) => {
    const ev = data.eventId || 'main';
    stopCurrentMode(ev);
    io.to(ev).emit('start-timeline', { timeline: data.timeline, startTime: Date.now() + 500 });
  });

  // カラー変更
  socket.on('admin-color', (data) => {
    const ev = data.eventId || 'main';
    stopCurrentMode(ev);
    const target = data.targetGroup === '全クラス' ? io.to(ev) : io.to(`${ev}_${data.targetGroup}`);
    if (data.color === 'rainbow') {
      target.emit('set-color', { mode: 'rainbow' });
    } else {
      target.emit('set-color', { color: data.color });
    }
  });

  // 個別操作
  socket.on('single-command', (data) => {
    const target = clients[data.id];
    if (!target || socket.adminEvent !== target.eventId) return;
    const nextOn = !target.isOn;
    stopCurrentMode(target.eventId);
    if (data.action === 'toggle') {
      target.isOn = nextOn;
      io.to(data.id).emit('torch', { state: target.isOn });
      broadcastClientList(target.eventId);
    } else if (data.action === 'pulse') {
      io.to(data.id).emit('pulse', { duration: 300 });
    }
  });

  // 一斉・クラスコマンド
  socket.on('admin-command', (data) => {
    const ev = data.eventId || 'main';
    stopCurrentMode(ev);
    const target = data.targetGroup === '全クラス' ? io.to(ev) : io.to(`${ev}_${data.targetGroup}`);

    if (data.mode === 'all-on') {
      for (const id in clients) {
        if (clients[id].eventId === ev && (data.targetGroup === '全クラス' || clients[id].group === data.targetGroup)) {
          clients[id].isOn = true;
        }
      }
      target.emit('torch', { state: true });
      broadcastClientList(ev);
    } else if (data.mode === 'all-off') {
      stopCurrentMode(ev);
    } else if (data.mode === 'random') {
      currentTimers[ev] = setInterval(() => {
        const evClients = getDevices(ev).filter(c => data.targetGroup === '全クラス' || c.group === data.targetGroup);
        if (evClients.length === 0) return;
        const rand = evClients[Math.floor(Math.random() * evClients.length)];
        io.to(rand.id).emit('pulse', { duration: 250 });
      }, 300);
    } else if (data.mode === 'strobe') {
      // クライアント側に指定された間隔（ミリ秒）を送信してローカルで高速点滅させる
      const interval = data.interval || 100;
      target.emit('strobe', { interval: interval });
    } else if (data.mode === 'class-wave') {
      const classList = ['1組', '2組', '3組', '4組'];
      let index = 0;
      currentTimers[ev] = setInterval(() => {
        const cls = classList[index];
        io.to(`${ev}_${cls}`).emit('pulse', { duration: 400 });
        index = (index + 1) % classList.length;
      }, 500);
    }
  });

  socket.on('disconnect', () => {
    if (socket.adminEvent && shows.get(socket.adminEvent)?.owner === socket.id) {
      stopCurrentMode(socket.adminEvent);
      io.to(socket.adminEvent).emit('set-color', { color: '#000000' });
    }
    if (socket.isClient && clients[socket.id]) {
      const ev = clients[socket.id].eventId;
      delete clients[socket.id];
      broadcastClientList(ev);
    }
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = { server, io };

