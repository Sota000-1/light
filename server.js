// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let clients = {}; // { socketId: { id, group, name, isOn } }
let classCounters = { '1組': 0, '2組': 0, '3組': 0, '4組': 0 };
let currentTimer = null;
let currentSpeed = 300;

function stopCurrentMode() {
  if (currentTimer) {
    clearInterval(currentTimer);
    currentTimer = null;
  }
  for (const id in clients) {
    clients[id].isOn = false;
  }
  io.emit('torch', { state: false });
  broadcastClientList();
}

function getCounts() {
  const counts = { '全クラス': 0, '1組': 0, '2組': 0, '3組': 0, '4組': 0 };
  for (const id in clients) {
    counts['全クラス']++;
    const grp = clients[id].group;
    if (counts[grp] !== undefined) counts[grp]++;
  }
  return counts;
}

// クライアント一覧を管理画面へ送信
function broadcastClientList() {
  io.emit('client-list-update', Object.values(clients));
  io.emit('status-update', getCounts());
}

io.on('connection', (socket) => {
  socket.emit('status-update', getCounts());
  socket.emit('client-list-update', Object.values(clients));

  socket.on('request-status', () => {
    socket.emit('status-update', getCounts());
    socket.emit('client-list-update', Object.values(clients));
  });

  // スマホ参加
  socket.on('join-client', (data) => {
    socket.isClient = true;
    socket.group = data.group || '1組';
    socket.join(socket.group);

    classCounters[socket.group] = (classCounters[socket.group] || 0) + 1;
    const clientName = data.name && data.name.trim() !== '' 
      ? data.name.trim() 
      : `${socket.group} #${classCounters[socket.group]}`;

    clients[socket.id] = {
      id: socket.id,
      group: socket.group,
      name: clientName,
      isOn: false
    };

    broadcastClientList();
    console.log(`スマホ参加: ${clientName}`);
  });

  socket.on('change-speed', (data) => {
    currentSpeed = Number(data.speed);
  });

  // 個別端末の操作
  socket.on('single-command', (data) => {
    const target = clients[data.id];
    if (!target) return;

    if (data.action === 'toggle') {
      target.isOn = !target.isOn;
      io.to(data.id).emit('torch', { state: target.isOn });
      broadcastClientList();
    } else if (data.action === 'pulse') {
      io.to(data.id).emit('pulse', { duration: 300 });
    }
  });

  // 全体・クラス一括操作
  socket.on('admin-command', (data) => {
    stopCurrentMode();
    const targetRoom = data.targetGroup === '全クラス' ? io : io.to(data.targetGroup);

    if (data.mode === 'all-on') {
      for (const id in clients) {
        if (data.targetGroup === '全クラス' || clients[id].group === data.targetGroup) {
          clients[id].isOn = true;
        }
      }
      targetRoom.emit('torch', { state: true });
      broadcastClientList();
    } else if (data.mode === 'all-off') {
      stopCurrentMode();
    } else if (data.mode === 'random') {
      currentTimer = setInterval(() => {
        const clientIds = Object.keys(clients).filter(id => 
          data.targetGroup === '全クラス' || clients[id].group === data.targetGroup
        );
        if (clientIds.length === 0) return;
        const randomId = clientIds[Math.floor(Math.random() * clientIds.length)];
        io.to(randomId).emit('pulse', { duration: Math.max(100, currentSpeed * 0.8) });
      }, currentSpeed);
    } else if (data.mode === 'strobe') {
      let isOn = false;
      currentTimer = setInterval(() => {
        isOn = !isOn;
        targetRoom.emit('torch', { state: isOn });
      }, Math.max(60, currentSpeed / 2));
    } else if (data.mode === 'class-wave') {
      const classList = ['1組', '2組', '3組', '4組'];
      let index = 0;
      currentTimer = setInterval(() => {
        const targetClass = classList[index];
        io.to(targetClass).emit('pulse', { duration: currentSpeed * 1.5 });
        index = (index + 1) % classList.length;
      }, currentSpeed * 2);
    }
  });

  socket.on('disconnect', () => {
    if (socket.isClient) {
      delete clients[socket.id];
      broadcastClientList();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running: http://localhost:${PORT}`);
});
