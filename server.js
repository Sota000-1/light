// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let clients = {}; // { socketId: { id, eventId, group, name, isOn } }
let currentTimers = {}; // { eventId: timer }

function stopCurrentMode(eventId) {
  if (currentTimers[eventId]) {
    clearInterval(currentTimers[eventId]);
    delete currentTimers[eventId];
  }
  for (const id in clients) {
    if (clients[id].eventId === eventId) clients[id].isOn = false;
  }
  io.to(eventId).emit('stop-timeline');
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
  // 管理者がイベント部屋に参加
  socket.on('join-admin', (data) => {
    const eventId = data.eventId || 'main';
    socket.join(`admin_${eventId}`);
    socket.emit('status-update', getCounts(eventId));
    socket.emit('client-list-update', getDevices(eventId));
  });

  // スマホ参加
  socket.on('join-client', (data) => {
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
    if (!target) return;
    if (data.action === 'toggle') {
      target.isOn = !target.isOn;
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
      let isOn = false;
      currentTimers[ev] = setInterval(() => {
        isOn = !isOn;
        target.emit('torch', { state: isOn });
      }, 100);
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
    if (socket.isClient && clients[socket.id]) {
      const ev = clients[socket.id].eventId;
      delete clients[socket.id];
      broadcastClientList(ev);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
