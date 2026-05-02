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
const MAX_DRAWING_DATA_URL_LENGTH = 450 * 1024;
const HOST_RECONNECT_GRACE_MS = 60 * 1000;
const PLAYER_RECONNECT_GRACE_MS = 10 * 60 * 1000;
const ROOM_PHASES = new Set(['setup', 'open', 'locked', 'revealAnswers', 'revealResults']);
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

function normalizeAnswerMode(value) {
  return value === 'handwriting' ? 'handwriting' : 'text';
}

function parseRoomAnswerMode(value) {
  if (value === 'text' || value === 'handwriting') {
    return value;
  }
  return '';
}

function normalizeRoomPhase(value) {
  return ROOM_PHASES.has(value) ? value : 'setup';
}

function isRevealPhase(phase) {
  return phase === 'revealAnswers' || phase === 'revealResults';
}

function phaseAllowsInput(phase) {
  return phase === 'open';
}

function phaseToRevealMode(phase) {
  if (phase === 'revealAnswers') return 1;
  if (phase === 'revealResults') return 2;
  return 0;
}

function normalizeDrawingDataUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (!normalized.startsWith('data:image/png;base64,')) return '';
  if (normalized.length > MAX_DRAWING_DATA_URL_LENGTH) return '';
  return normalized;
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
    phase: 'setup',
    answerMode: 'text',
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

function getPlayerBySocketId(room, socketId) {
  return Array.from(room.players.values()).find((player) => player.currentSocketId === socketId) || null;
}

function getPlayerByToken(room, playerToken) {
  return room.players.get(String(playerToken || '').trim());
}

function getCommittedAnswer(player) {
  return player.locked ? player.draftText : '';
}

function getCommittedDrawing(player) {
  return player.locked ? player.drawingDataUrl : '';
}

function getCommittedAnswerMode(player) {
  return player.locked ? parseRoomAnswerMode(player.answerMode) || 'text' : 'text';
}

function snapshotCommittedAnswer(player) {
  const mode = getCommittedAnswerMode(player);
  return {
    mode,
    text: mode === 'text' ? getCommittedAnswer(player) : '',
    drawingDataUrl: mode === 'handwriting' ? getCommittedDrawing(player) : '',
  };
}

function serializeBoard(room) {
  return getSortedPlayers(room).map((player) => ({
    id: player.id,
    slot: player.slot,
    name: player.name,
    connected: !!player.currentSocketId,
    draftText: player.draftText,
    answerText: getCommittedAnswer(player),
    answerImage: getCommittedDrawing(player),
    answerMode: getCommittedAnswerMode(player),
    displayText: room.revealedAnswers.get(player.id)?.text || '',
    displayImage: room.revealedAnswers.get(player.id)?.drawingDataUrl || '',
    displayMode: room.revealedAnswers.get(player.id)?.mode || 'text',
    charCount: Array.from(getCommittedAnswer(player)).length,
    lastEditedAt: player.lastEditedAt,
    result: player.result,
    locked: player.locked,
  }));
}

function serializeHostRoom(room) {
  const board = serializeBoard(room);
  const phase = normalizeRoomPhase(room.phase);
  return {
    code: room.code,
    phase,
    answerMode: room.answerMode,
    inputEnabled: phaseAllowsInput(phase),
    revealMode: phaseToRevealMode(phase),
    playerCount: board.length,
    board,
  };
}

function serializePlayerRoom(room, playerId) {
  const player = room.players.get(playerId);
  const phase = normalizeRoomPhase(room.phase);
  return {
    code: room.code,
    phase,
    answerMode: room.answerMode,
    inputEnabled: phaseAllowsInput(phase),
    revealMode: phaseToRevealMode(phase),
    me: player
      ? {
          id: player.id,
          name: player.name,
          draftText: player.draftText,
          drawingDataUrl: player.drawingDataUrl,
          answerMode: player.answerMode,
          result: player.result,
          locked: player.locked,
        }
      : null,
  };
}

function serializeMonitorRoom(room) {
  const phase = normalizeRoomPhase(room.phase);
  return {
    code: room.code,
    phase,
    answerMode: room.answerMode,
    inputEnabled: phaseAllowsInput(phase),
    revealMode: phaseToRevealMode(phase),
    board: serializeBoard(room).map((player) => ({
      id: player.id,
      slot: player.slot,
      name: player.name,
      displayText: player.displayText,
      displayImage: player.displayImage,
      displayMode: player.displayMode,
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
    if (player.currentSocketId) {
      io.to(player.currentSocketId).emit('player:room', serializePlayerRoom(room, player.id));
    }
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

function clearRound(room, nextPhase = 'setup') {
  const preservedAnswerMode = parseRoomAnswerMode(room.answerMode) || 'text';
  for (const player of room.players.values()) {
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.draftText = '';
    player.drawingDataUrl = '';
    player.answerMode = preservedAnswerMode;
    player.lastEditedAt = null;
    player.result = 'pending';
    player.locked = false;
  }

  room.phase = normalizeRoomPhase(nextPhase);
  room.answerMode = preservedAnswerMode;
  room.revealedAnswers.clear();
}

function requestPlayerLocks(room) {
  for (const player of room.players.values()) {
    if (!player.locked && player.currentSocketId) {
      io.to(player.currentSocketId).emit('player:forceLock', { roomCode: room.code });
    }
  }
}

function setRoomPhase(room, nextPhase) {
  const previousPhase = normalizeRoomPhase(room.phase);
  const normalizedNextPhase = normalizeRoomPhase(nextPhase);

  if (previousPhase === normalizedNextPhase) {
    return { changed: false, shouldRequestLocks: false };
  }

  const wasRevealPhase = isRevealPhase(previousPhase);
  const willRevealPhase = isRevealPhase(normalizedNextPhase);

  if (willRevealPhase && !wasRevealPhase) {
    room.revealedAnswers.clear();
    for (const player of room.players.values()) {
      room.revealedAnswers.set(player.id, snapshotCommittedAnswer(player));
    }
  } else if (!willRevealPhase && wasRevealPhase) {
    room.revealedAnswers.clear();
  }

  room.phase = normalizedNextPhase;
  return {
    changed: true,
    shouldRequestLocks: previousPhase === 'open' && normalizedNextPhase === 'locked',
  };
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

function scheduleRoomClose(room, socketId) {
  if (room.hostSocketId !== socketId) {
    return;
  }

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

  for (const player of room.players.values()) {
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
  }

  io.to(room.code).emit('room:closed');
  rooms.delete(room.code);
}

function attachPlayerSocket(room, player, socket) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }

  player.currentSocketId = socket.id;
  socket.join(room.code);
  socket.data.role = 'player';
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
}

function schedulePlayerDisconnect(room, playerId, socketId) {
  const player = room.players.get(playerId);
  if (!player) return;
  if (player.currentSocketId !== socketId) return;

  player.currentSocketId = null;
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
  }

  player.disconnectTimer = setTimeout(() => {
    room.players.delete(playerId);
    room.revealedAnswers.delete(playerId);
    emitRoomState(room);
  }, PLAYER_RECONNECT_GRACE_MS);
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
    version: 'quiz-panel-handwriting-2026-05-02',
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

  socket.on('host:setAnswerMode', ({ roomCode, mode }, ack = () => {}) => {
    const room = requireHost(roomCode, socket, ack);
    if (!room) return;

    if (normalizeRoomPhase(room.phase) === 'open') {
      ack({ ok: false, message: '回答受付中は回答方法を変更できません。' });
      return;
    }

    room.answerMode = parseRoomAnswerMode(mode);
    if (!room.answerMode) {
      ack({ ok: false, message: '回答方式の指定が不正です。' });
      return;
    }

    for (const player of room.players.values()) {
      if (!player.locked) {
        player.answerMode = room.answerMode;
      }
    }

    ack({ ok: true, room: serializeHostRoom(room) });
    emitRoomState(room);
  });

  socket.on('host:setPhase', ({ roomCode, phase }, ack = () => {}) => {
    const room = requireHost(roomCode, socket, ack);
    if (!room) return;

    const currentPhase = normalizeRoomPhase(room.phase);
    const nextPhase = normalizeRoomPhase(phase);

    if (currentPhase === nextPhase) {
      ack({ ok: true, room: serializeHostRoom(room) });
      return;
    }

    if (nextPhase === 'open') {
      if (currentPhase !== 'setup') {
        ack({ ok: false, message: '回答受付は準備中のときだけ開始できます。' });
        return;
      }
      if (!room.answerMode) {
        ack({ ok: false, message: '先に回答方法を選んでから回答受付を開始してください。' });
        return;
      }
    } else if (nextPhase === 'locked') {
      if (!['open', 'revealAnswers', 'revealResults'].includes(currentPhase)) {
        ack({ ok: false, message: 'この状態から受付終了にはできません。' });
        return;
      }
    } else if (nextPhase === 'revealAnswers') {
      if (!['locked', 'revealResults'].includes(currentPhase)) {
        ack({ ok: false, message: '回答表示は受付終了後に行ってください。' });
        return;
      }
    } else if (nextPhase === 'revealResults') {
      if (!['locked', 'revealAnswers'].includes(currentPhase)) {
        ack({ ok: false, message: '正解表示は回答表示の後で行ってください。' });
        return;
      }
    } else {
      ack({ ok: false, message: '変更先の状態が不正です。' });
      return;
    }

    const transition = setRoomPhase(room, nextPhase);

    ack({ ok: true, room: serializeHostRoom(room) });
    emitRoomState(room);

    if (transition.shouldRequestLocks) {
      requestPlayerLocks(room);
    }
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

  socket.on('host:removePlayer', ({ roomCode, playerId }, ack = () => {}) => {
    const room = requireHost(roomCode, socket, ack);
    if (!room) return;

    const player = room.players.get(String(playerId || ''));
    if (!player) {
      ack({ ok: false, message: '対象の子機が見つかりません。' });
      return;
    }

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    room.players.delete(player.id);
    room.revealedAnswers.delete(player.id);
    ack({ ok: true, room: serializeHostRoom(room) });
    emitRoomState(room);
  });

  socket.on('host:clearAll', ({ roomCode, nextPhase }, ack = () => {}) => {
    const room = requireHost(roomCode, socket, ack);
    if (!room) return;

    clearRound(room, nextPhase);
    ack({ ok: true, room: serializeHostRoom(room) });
    emitRoomState(room);
  });

  socket.on('player:join', ({ roomCode, name, playerToken }, ack = () => {}) => {
    const room = getRoom(roomCode);
    const normalizedName = normalizeName(name);
    const normalizedToken = String(playerToken || '').trim();

    if (!room) {
      ack({ ok: false, message: 'ルームが見つかりません。' });
      return;
    }

    if (!normalizedName) {
      ack({ ok: false, message: '名前を入力してください。' });
      return;
    }

    if (!normalizedToken) {
      ack({ ok: false, message: '参加情報が不足しています。参加し直してください。' });
      return;
    }

    let player = getPlayerByToken(room, normalizedToken);
    if (player) {
      player.name = normalizedName;
      attachPlayerSocket(room, player, socket);

      ack({
        ok: true,
        room: serializePlayerRoom(room, player.id),
        player: { id: player.id, name: player.name },
      });
      emitRoomState(room);
      return;
    }

    player = {
      id: normalizedToken,
      slot: room.nextSlot,
      name: normalizedName,
      draftText: '',
      drawingDataUrl: '',
      answerMode: room.answerMode,
      lastEditedAt: null,
      result: 'pending',
      locked: false,
      currentSocketId: null,
      disconnectTimer: null,
    };

    room.nextSlot += 1;
    room.players.set(player.id, player);
    attachPlayerSocket(room, player, socket);

    ack({
      ok: true,
      room: serializePlayerRoom(room, player.id),
      player: { id: player.id, name: player.name },
    });
    emitRoomState(room);
  });

  socket.on('player:updateDraft', ({ roomCode, text, drawingDataUrl, mode }, ack = () => {}) => {
    const room = getRoom(roomCode);
    if (!room) {
      ack({ ok: false, message: 'ルームが見つかりません。' });
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) {
      ack({ ok: false, message: '子機として参加できていません。' });
      return;
    }

    if (!phaseAllowsInput(room.phase) || player.locked) {
      ack({ ok: false, message: '現在は入力ロック中です。' });
      return;
    }

    const submittedMode = normalizeAnswerMode(mode);
    if (submittedMode !== room.answerMode) {
      ack({ ok: false, message: '現在の出題形式が切り替わりました。画面を確認してください。' });
      return;
    }

    player.answerMode = room.answerMode;
    player.draftText = player.answerMode === 'text' ? normalizeAnswer(text) : '';
    player.drawingDataUrl = player.answerMode === 'handwriting' ? normalizeDrawingDataUrl(drawingDataUrl) : '';
    player.lastEditedAt = Date.now();

    ack({
      ok: true,
      me: {
        id: player.id,
        name: player.name,
        draftText: player.draftText,
        drawingDataUrl: player.drawingDataUrl,
        answerMode: player.answerMode,
        locked: player.locked,
      },
    });
    emitRoomState(room);
  });
  
  socket.on('player:submitAnswer', ({ roomCode, text, drawingDataUrl, mode }, ack = () => {}) => {
    const room = getRoom(roomCode);
    if (!room) {
      ack({ ok: false, error: 'ルームが見つかりません。' });
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) {
      ack({ ok: false, error: '参加できていません。' });
      return;
    }

    if (!phaseAllowsInput(room.phase) || player.locked) {
      ack({ ok: false, error: '現在は入力を受け付けていません。' });
      return;
    }

    const submittedMode = normalizeAnswerMode(mode);
    if (submittedMode !== room.answerMode) {
      ack({ ok: false, error: '現在の出題形式が切り替わりました。画面を確認してください。' });
      return;
    }

    player.answerMode = room.answerMode;
    player.draftText = player.answerMode === 'text' ? normalizeAnswer(text) : '';
    player.drawingDataUrl = player.answerMode === 'handwriting' ? normalizeDrawingDataUrl(drawingDataUrl) : '';

    if (player.answerMode === 'handwriting' && !player.drawingDataUrl) {
      ack({ ok: false, error: '手書き回答を書いてから送信してください。' });
      return;
    }

    if (player.answerMode === 'text' && !player.draftText) {
      ack({ ok: false, error: '回答を入力してから送信してください。' });
      return;
    }

    player.locked = true;
    player.lastEditedAt = Date.now();

    ack({ ok: true, room: serializePlayerRoom(room, player.id) });
    emitRoomState(room);
  });

  socket.on('player:lockDraft', ({ roomCode, text, drawingDataUrl, mode }, ack = () => {}) => {
    const room = getRoom(roomCode);
    if (!room) {
      ack({ ok: false, error: 'ルームが見つかりません。' });
      return;
    }

    const player = getPlayerBySocketId(room, socket.id);
    if (!player) {
      ack({ ok: false, error: '参加情報が見つかりません。' });
      return;
    }

    if (player.locked) {
      ack({ ok: true, room: serializePlayerRoom(room, player.id) });
      return;
    }

    player.answerMode = room.answerMode;
    player.draftText = player.answerMode === 'text' ? normalizeAnswer(text) : '';
    player.drawingDataUrl = player.answerMode === 'handwriting' ? normalizeDrawingDataUrl(drawingDataUrl) : '';
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
      scheduleRoomClose(room, socket.id);
      return;
    }

    if (role === 'monitor') {
      room.monitorSocketIds.delete(socket.id);
      return;
    }

    if (role === 'player') {
      schedulePlayerDisconnect(room, socket.data.playerId, socket.id);
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
