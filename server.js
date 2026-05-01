const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket'],
  allowUpgrades: false,
  perMessageDeflate: false,
});

const PORT = Number(process.env.PORT) || 3000;
const MAX_NAME_LENGTH = 12;
const MAX_ANSWER_LENGTH = 24;
const HOST_RECONNECT_GRACE_MS = 60 * 1000;
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  for (let index = 0; index < 6; index += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return rooms.has(code) ? makeRoomCode() : code;
}

function getRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

function normalizeName(value) {
  return Array.from(String(value || '').trim()).slice(0, MAX_NAME_LENGTH).join('');
}

function normalizeAnswer(value) {
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_ANSWER_LENGTH)
    .join('');
}

function getLocalIpv4Addresses() {
  const networks = os.networkInterfaces();
  const results = [];

  for (const networkName of Object.keys(networks)) {
    for (const network of networks[networkName] || []) {
      if (network.family === 'IPv4' && !network.internal) {
        results.push({ name: networkName, address: network.address });
      }
    }
  }

  return results;
}

function createRoom(hostSocketId) {
  const code = makeRoomCode();
  const room = {
    code,
    hostSocketId,
    hostDisconnectTimer: null,
    inputEnabled: true,
    revealMode: 0, // 0: Hidden, 1: Open Answers, 2: Reveal Correct
    nextSlot: 1,
    players: new Map(),
    monitorSocketIds: new Set(),
    revealedAnswers: new Map(),
  };

  rooms.set(code, room);
  return room;
}

function getSortedPlayers(room) {
  return Array.from(room.players.values()).sort((left, right) => left.slot - right.slot);
}

function getCommittedAnswer(player) {
  return player.locked ? player.draftText : '';
}

function serializeBoard(room) {
  return getSortedPlayers(room).map((player) => ({
    id: player.id,
    slot: player.slot,
    name: player.name,
    draftText: player.draftText,
    answerText: getCommittedAnswer(player),
    displayText: room.revealedAnswers.get(player.id) || '',
    charCount: Array.from(getCommittedAnswer(player)).length,
    lastEditedAt: player.lastEditedAt,
    result: player.result,
    locked: player.locked,
  }));
}

function serializeHostRoom(room) {
  const board = serializeBoard(room);
  return {
    code: room.code,
    inputEnabled: room.inputEnabled,
    revealMode: room.revealMode,
    playerCount: board.length,
    board,
  };
}

function serializePlayerRoom(room, playerId) {
  const player = room.players.get(playerId);
  return {
    code: room.code,
    inputEnabled: room.inputEnabled,
    revealMode: room.revealMode,
    me: player
      ? {
          id: player.id,
          name: player.name,
          draftText: player.draftText,
          result: player.result,
          locked: player.locked,
        }
      : null,
  };
}

function serializeMonitorRoom(room) {
  return {
    code: room.code,
    inputEnabled: room.inputEnabled,
    revealMode: room.revealMode,
    board: serializeBoard(room).map((player) => ({
      id: player.id,
      slot: player.slot,
      name: player.name,
      displayText: player.displayText,
      result: player.result,
      locked: player.locked,
    })),
  };
}

function emitRoomState(room) {
  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit('host:room', serializeHostRoom(room));
  }

  for (const player of room.players.values()) {
    io.to(player.id).emit('player:room', serializePlayerRoom(room, player.id));
  }

  for (const monitorId of room.monitorSocketIds) {
    io.to(monitorId).emit('monitor:room', serializeMonitorRoom(room));
  }
}

function requireHost(roomCode, socket, ack) {
  const room = getRoom(roomCode);
  if (!room || room.hostSocketId !== socket.id) {
    ack({ ok: false, message: '親機として接続できません。' });
    return null;
  }

  return room;
}

function clearRound(room) {
  for (const player of room.players.values()) {
    player.draftText = '';
    player.lastEditedAt = null;
    player.result = 'pending';
    player.locked = false;
  }

  room.inputEnabled = true;
  room.revealMode = 0;
  room.revealedAnswers.clear();
}

function requestPlayerLocks(room) {
  for (const player of room.players.values()) {
    if (!player.locked) {
      io.to(player.id).emit('player:forceLock', { roomCode: room.code });
    }
  }
}

function setRevealMode(room, mode) {
  if (mode === 1 || mode === 2) {
    // 初めて回答を開く際に、その時点の回答を固定
    if (room.revealMode === 0) {
      room.revealedAnswers.clear();
      for (const player of room.players.values()) {
        room.revealedAnswers.set(player.id, getCommittedAnswer(player));
      }
    }
  } else {
    // 非表示にする際
    room.revealedAnswers.clear();
  }
  room.revealMode = mode;
}

function attachHost(room, socket) {
  if (room.hostDisconnectTimer) {
    clearTimeout(room.hostDisconnectTimer);
    room.hostDisconnectTimer = null;
  }

  room.hostSocketId = socket.id;
  socket.join(room.code);
  socket.data.role = 'host';
  socket.data.roomCode = room.code;
}

function scheduleRoomClose(room) {
  room.hostSocketId = null;

  if (room.hostDisconnectTimer) {
    clearTimeout(room.hostDisconnectTimer);
  }

  room.hostDisconnectTimer = setTimeout(() => {
    closeRoom(room);
  }, HOST_RECONNECT_GRACE_MS);
}

function closeRoom(room) {
  if (room.hostDisconnectTimer) {
    clearTimeout(room.hostDisconnectTimer);
    room.hostDisconnectTimer = null;
  }

  io.to(room.code).emit('room:closed');
  rooms.delete(room.code);
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/network-info', (_req, res) => {
  res.json({
    port: PORT,
    lanAddresses: getLocalIpv4Addresses(),
  });
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/version', (_req, res) => {
  res.json({
    version: 'quiz-panel-simplified-2026-05-01',
  });
});

app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '').trim();

  if (!text) {
    res.status(400).send('Missing text');
    return;
  }

  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      width: 320,
      errorCorrectionLevel: 'M',
    });
    res.type('image/svg+xml').send(svg);
  } catch (_error) {
    res.status(500).send('QR generation failed');
  }
});

io.on('connection', (socket) => {
  socket.on('host:create', (_payload = {}, ack = () => {}) => {
    try {
      const existingRoom = getRoom(socket.data.roomCode);
      if (socket.data.role === 'host' && existingRoom && existingRoom.hostSocketId === socket.id) {
        closeRoom(existingRoom);
      }

      const room = createRoom(socket.id);
      attachHost(room, socket);

      ack({ ok: true, room: serializeHostRoom(room) });
      emitRoomState(room);
    } catch (_error) {
      ack({ ok: false, message: 'ルームを作成できませんでした。' });
    }
  });

  socket.on('host:resume', ({ roomCode }, ack = () => {}) => {
    const room = getRoom(roomCode);
    if (!room) {
      ack({ ok: false, message: '再接続するルームが見つかりません。' });
      return;
    }

    attachHost(room, socket);
    ack({ ok: true, room: serializeHostRoom(room) });
    emitRoomState(room);
  });

  socket.on('host:setInputEnabled', ({ roomCode, inputEnabled }, ack = () => {}) => {
    const room = requireHost(roomCode, socket, ack);
    if (!room) return;

    const nextEnabled = inputEnabled !== false;
    const shouldRequestLocks = room.inputEnabled && !nextEnabled;

    room.inputEnabled = nextEnabled;
    ack({ ok: true, room: serializeHostRoom(room) });
    emitRoomState(room);

    if (shouldRequestLocks) {
      requestPlayerLocks(room);
    }
  });

  socket.on('host:setRevealMode', ({ roomCode, mode }, ack = () => {}) => {
    const room = requireHost(roomCode, socket, ack);
    if (!room) return;

    setRevealMode(room, Number(mode) || 0);

    ack({ ok: true, room: serializeHostRoom(room) });
    emitRoomState(room);
  });

  socket.on('host:setResult', ({ roomCode, playerId, result }, ack = () => {}) => {
    const room = requireHost(roomCode, socket, ack);
    if (!room) return;

    const player = room.players.get(String(playerId || ''));
    if (!player) {
      ack({ ok: false, message: '対象の子機が見つかりません。' });
      return;
    }

    player.result = result === 'correct' ? 'correct' : 'pending';
    ack({ ok: true, room: serializeHostRoom(room) });
    emitRoomState(room);
  });

  socket.on('host:clearAll', ({ roomCode }, ack = () => {}) => {
    const room = requireHost(roomCode, socket, ack);
    if (!room) return;

    clearRound(room);
    ack({ ok: true, room: serializeHostRoom(room) });
    emitRoomState(room);
  });

  socket.on('player:join', ({ roomCode, name }, ack = () => {}) => {
    const room = getRoom(roomCode);
    const normalizedName = normalizeName(name);

    if (!room) {
      ack({ ok: false, message: 'ルームが見つかりません。' });
      return;
    }

    if (!normalizedName) {
      ack({ ok: false, message: '名前を入力してください。' });
      return;
    }

    const player = {
      id: socket.id,
      slot: room.nextSlot,
      name: normalizedName,
      draftText: '',
      lastEditedAt: null,
      result: 'pending',
      locked: false,
    };

    room.nextSlot += 1;
    room.players.set(socket.id, player);
    socket.join(room.code);
    socket.data.role = 'player';
    socket.data.roomCode = room.code;

    ack({
      ok: true,
      room: serializePlayerRoom(room, player.id),
      player: { id: player.id, name: player.name },
    });
    emitRoomState(room);
  });

  socket.on('player:updateDraft', ({ roomCode, text }, ack = () => {}) => {
    const room = getRoom(roomCode);
    if (!room) {
      ack({ ok: false, message: 'ルームが見つかりません。' });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      ack({ ok: false, message: '子機として参加できていません。' });
      return;
    }

    if (!room.inputEnabled || player.locked) {
      ack({ ok: false, message: '現在は入力ロック中です。' });
      return;
    }

    player.draftText = normalizeAnswer(text);
    player.lastEditedAt = Date.now();

    ack({
      ok: true,
      me: {
        id: player.id,
        name: player.name,
        draftText: player.draftText,
        locked: player.locked,
      },
    });
    emitRoomState(room);
  });
  
  socket.on('player:submitAnswer', ({ roomCode, text }, ack = () => {}) => {
    const room = getRoom(roomCode);
    if (!room) {
      ack({ ok: false, error: 'ルームが見つかりません。' });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      ack({ ok: false, error: '参加できていません。' });
      return;
    }

    if (!room.inputEnabled || player.locked) {
      ack({ ok: false, error: '現在は入力を受け付けていません。' });
      return;
    }

    player.draftText = normalizeAnswer(text);
    player.locked = true;
    player.lastEditedAt = Date.now();

    ack({ ok: true, room: serializePlayerRoom(room, player.id) });
    emitRoomState(room);
  });

  socket.on('player:lockDraft', ({ roomCode, text }, ack = () => {}) => {
    const room = getRoom(roomCode);
    if (!room) {
      ack({ ok: false, error: 'ルームが見つかりません。' });
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) {
      ack({ ok: false, error: '参加情報が見つかりません。' });
      return;
    }

    if (player.locked) {
      ack({ ok: true, room: serializePlayerRoom(room, player.id) });
      return;
    }

    player.draftText = normalizeAnswer(text);
    player.locked = true;
    player.lastEditedAt = Date.now();

    ack({ ok: true, room: serializePlayerRoom(room, player.id) });
    emitRoomState(room);
  });

  socket.on('monitor:join', ({ roomCode }, ack = () => {}) => {
    const room = getRoom(roomCode);
    if (!room) {
      ack({ ok: false, message: 'ルームが見つかりません。' });
      return;
    }

    room.monitorSocketIds.add(socket.id);
    socket.join(room.code);
    socket.data.role = 'monitor';
    socket.data.roomCode = room.code;

    const payload = serializeMonitorRoom(room);
    ack({ ok: true, room: payload });
    io.to(socket.id).emit('monitor:room', payload);
  });

  socket.on('disconnect', () => {
    const { role, roomCode } = socket.data;
    if (!roomCode) return;

    const room = getRoom(roomCode);
    if (!room) return;

    if (role === 'host') {
      scheduleRoomClose(room);
      return;
    }

    if (role === 'monitor') {
      room.monitorSocketIds.delete(socket.id);
      return;
    }

    if (role === 'player') {
      room.players.delete(socket.id);
      room.revealedAnswers.delete(socket.id);
      emitRoomState(room);
    }
  });
});

server.listen(PORT, () => {
  console.log('Quiz Panel server started');
  console.log(`Host screen   : http://localhost:${PORT}/host.html`);
  console.log(`Landing page  : http://localhost:${PORT}/`);
  console.log('Player entry  : Open from the host QR or join URL after creating a room');
  console.log('Monitor screen: Open from the host monitor URL after creating a room');

  const lanAddresses = getLocalIpv4Addresses();
  if (lanAddresses.length) {
    console.log('Local network host URLs:');
    lanAddresses.forEach(({ name, address }) => {
      console.log(`- [${name}] http://${address}:${PORT}/host.html`);
    });
  }
});
