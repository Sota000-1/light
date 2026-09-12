// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// 接続端末の管理 { socketId: { group: '1組' } }
let clients = {};
let currentTimer = null;
let currentSpeed = 300; // ミリ秒（初期値）

function stopCurrentMode() {
  if (currentTimer) {
    clearInterval(currentTimer);
    currentTimer = null;
  }
  io.emit('torch', { state: false });
}

// クラス別の人数を集計して送信
function broadcastStatus() {
  const counts = { '全クラス': 0, '1組': 0, '2組': 0, '3組': 0, '4組': 0 };
  for (const id in clients) {
    counts['全クラス']++;
    const grp = clients[id].group;
    if (counts[grp] !== undefined) counts[grp]++;
  }
  io.emit('status-update', counts);
}

io.on('connection', (socket) => {
  // スマホがクラスを選択して参加
  socket.on('join-client', (data) => {
    socket.isClient = true;
    socket.group = data.group || '1組';
    socket.join(socket.group); // クラス別の通信部屋に入る
    clients[socket.id] = { group: socket.group };
    broadcastStatus();
  });

  // スピード（テンポ）のリアルタイム変更
  socket.on('change-speed', (data) => {
    currentSpeed = Number(data.speed);
  });

  // 管理画面からのコマンド
  socket.on('admin-command', (data) => {
    stopCurrentMode();
    const targetRoom = data.targetGroup === '全クラス' ? io : io.to(data.targetGroup);

    if (data.mode === 'all-on') {
      targetRoom.emit('torch', { state: true });
    } else if (data.mode === 'all-off') {
      stopCurrentMode();
    }
    // 🎲 ランダムきらめき
    else if (data.mode === 'random') {
      currentTimer = setInterval(() => {
        const clientIds = Object.keys(clients).filter(id => 
          data.targetGroup === '全クラス' || clients[id].group === data.targetGroup
        );
        if (clientIds.length === 0) return;
        const randomId = clientIds[Math.floor(Math.random() * clientIds.length)];
        io.to(randomId).emit('pulse', { duration: Math.max(100, currentSpeed * 0.8) });
      }, currentSpeed);
    }
    // ⚡ ストロボ（高速点滅）
    else if (data.mode === 'strobe') {
      let isOn = false;
      currentTimer = setInterval(() => {
        isOn = !isOn;
        targetRoom.emit('torch', { state: isOn });
      }, Math.max(50, currentSpeed / 2));
    }
    // 🏫 クラス対抗ウェーブ（1組 → 2組 → 3組 → 4組）
    else if (data.mode === 'class-wave') {
      const classList = ['1組', '2組', '3組', '4組'];
      let index = 0;
      currentTimer = setInterval(() => {
        io.emit('torch', { state: false }); // 一旦消す
        const targetClass = classList[index];
        io.to(targetClass).emit('torch', { state: true }); // そのクラスだけ点灯
        index = (index + 1) % classList.length;
      }, currentSpeed * 2);
    }
  });

  socket.on('disconnect', () => {
    if (socket.isClient) {
      delete clients[socket.id];
      broadcastStatus();
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running: http://localhost:${PORT}`);
});