const socket = io({
  transports: ['websocket'],
  upgrade: false,
});

const HOST_ROOM_KEY = 'quizPanelHostRoom';

const createSection = document.getElementById('createSection');
const controlSection = document.getElementById('controlSection');
const createRoomBtn = document.getElementById('createRoomBtn');
const createMessage = document.getElementById('createMessage');
const controlMessage = document.getElementById('controlMessage');

const roomCodeEl = document.getElementById('roomCode');
const toggleInputBtn = document.getElementById('toggleInputBtn');
const toggleDisplayBtn = document.getElementById('toggleDisplayBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const modeTextBtn = document.getElementById('modeTextBtn');
const modeHandwritingBtn = document.getElementById('modeHandwritingBtn');
const hostCurrentModePill = document.getElementById('hostCurrentModePill');
const playerCards = document.getElementById('playerCards');
const playerQrImage = document.getElementById('playerQrImage');
const playerUrlSelect = document.getElementById('playerUrlSelect');
const monitorUrlInput = document.getElementById('monitorUrlInput');
const copyPlayerUrlBtn = document.getElementById('copyPlayerUrlBtn');
const copyMonitorUrlBtn = document.getElementById('copyMonitorUrlBtn');
const openMonitorBtn = document.getElementById('openMonitorBtn');
const reloadNetworkBtn = document.getElementById('reloadNetworkBtn');

let currentRoom = null;
let urlCandidates = [];

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setMessage(target, text, type = '') {
  target.textContent = text || '';
  target.className = 'status-text';
  if (type) target.classList.add(type);
}

function saveHostRoomCode(roomCode) {
  if (!roomCode) return;

  try {
    sessionStorage.setItem(HOST_ROOM_KEY, roomCode);
  } catch (_error) {
    // ignore storage failures
  }
}

function clearHostRoomCode() {
  try {
    sessionStorage.removeItem(HOST_ROOM_KEY);
  } catch (_error) {
    // ignore storage failures
  }
}

function resetToCreateView(message = '', type = '') {
  currentRoom = null;
  createSection.classList.remove('hidden');
  controlSection.classList.add('hidden');
  setMessage(createMessage, message, type);
}

async function copyTextToClipboard(text, buttonEl) {
  const value = String(text || '');
  if (!value) return false;

  let success = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      success = true;
    } catch (_err) {
      success = false;
    }
  }

  if (!success) {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      success = document.execCommand('copy');
    } catch (_err) {
      success = false;
    }
    document.body.removeChild(textarea);
  }

  if (success && buttonEl) {
    const originalContent = buttonEl.textContent;
    buttonEl.textContent = 'コピー済み';
    buttonEl.classList.add('button-success');
    setTimeout(() => {
      buttonEl.textContent = originalContent;
      buttonEl.classList.remove('button-success');
    }, 2000);
  }
  return success;
}

function getPlayerJoinUrl(baseUrl, roomCode) {
  const url = new URL('/player-entry.html', baseUrl);
  url.searchParams.set('room', roomCode);
  return url.toString();
}

function getMonitorUrl(baseUrl, roomCode) {
  const url = new URL('/monitor.html', baseUrl);
  url.searchParams.set('room', roomCode);
  return url.toString();
}

function isPrivateIpv4Host(hostname) {
  return /^(10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function shouldIncludeLanCandidates() {
  const hostname = String(window.location.hostname || '').toLowerCase();
  return hostname === 'localhost' || hostname === '::1' || isPrivateIpv4Host(hostname);
}

function renderPlayerCards(room) {
  playerCards.innerHTML = '';

  if (!room.board.length) {
    const empty = document.createElement('div');
    empty.className = 'board-empty-message';
    empty.textContent = '参加者を待っています。';
    playerCards.appendChild(empty);
    return;
  }

  room.board
    .slice()
    .sort((left, right) => left.slot - right.slot)
    .forEach((player) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.classList.add('host-answer-card');

      const isCorrect = player.result === 'correct';
      const isLockedVisual = !room.inputEnabled || !!player.locked;

      card.classList.toggle('is-correct', isCorrect);
      card.classList.toggle('is-locked-visual', isLockedVisual);

      const revealMode = room.revealMode || 0;
      if (revealMode > 0) card.classList.add('is-revealed');

      const resultLabel = isCorrect ? '正解' : '';
      const text = player.answerText || ' ';
      const isHandwriting = player.answerMode === 'handwriting' && !!player.answerImage;
      const charCount = Array.from(text).length;
      let fontSize = '1.2rem';

      if (charCount <= 4) fontSize = '1.8rem';
      else if (charCount <= 8) fontSize = '1.5rem';
      else if (charCount <= 12) fontSize = '1.3rem';
      else fontSize = '1.1rem';

      const answerMarkup = isHandwriting
        ? '<div class="host-card-drawing"><img class="host-card-image" src="' + player.answerImage + '" alt="手書き回答" /></div>'
        : `<div class="host-card-text" style="font-size: ${fontSize}">${escapeHtml(text)}</div>`;

      card.innerHTML = `
        <div class="host-card-header">
          <span class="host-card-slot">${player.slot}</span>
          <span class="host-card-badge">${resultLabel}</span>
        </div>
        <div class="host-card-body">
          ${answerMarkup}
        </div>
        <div class="host-card-footer">
          <span class="host-card-name">${escapeHtml(player.name)}</span>
        </div>
        <div class="host-lock-indicator"></div>
      `;

      card.addEventListener('click', () => {
        const nextResult = player.result === 'correct' ? 'pending' : 'correct';

        socket.emit(
          'host:setResult',
          { roomCode: room.code, playerId: player.id, result: nextResult },
          (response) => {
            if (!response.ok) {
              setMessage(controlMessage, response.message, 'warn');
              return;
            }

            setMessage(
              controlMessage,
              nextResult === 'correct' ? `${player.name} を正解にしました。` : `${player.name} の正解を解除しました。`,
              'ok'
            );
          }
        );
      });

      playerCards.appendChild(card);
    });
}

function renderUrlOptions(room) {
  playerUrlSelect.innerHTML = '';

  urlCandidates.forEach((baseUrl, index) => {
    const option = document.createElement('option');
    option.value = getPlayerJoinUrl(baseUrl, room.code);
    option.textContent = option.value;
    option.selected = index === 0;
    playerUrlSelect.appendChild(option);
  });

  const selectedPlayerUrl = playerUrlSelect.value || getPlayerJoinUrl(window.location.origin, room.code);
  const selectedBaseUrl = new URL(selectedPlayerUrl).origin;
  playerQrImage.src = `/api/qr?text=${encodeURIComponent(selectedPlayerUrl)}`;
  monitorUrlInput.value = getMonitorUrl(selectedBaseUrl, room.code);
}

async function loadNetworkCandidates() {
  const candidateSet = new Set([window.location.origin]);

  try {
    const response = await fetch('/api/network-info', { cache: 'no-store' });
    if (response.ok) {
      const payload = await response.json();
      const port = Number(payload?.port) || window.location.port || 3000;
      if (shouldIncludeLanCandidates()) {
        (payload?.lanAddresses || []).forEach(({ address }) => {
          if (address) {
            candidateSet.add(`http://${address}:${port}`);
          }
        });
      }
    }
  } catch (_error) {
    // keep current origin only
  }

  const allCandidates = Array.from(candidateSet);
  const preferred = allCandidates.find((url) => !/localhost|127\.0\.0\.1/.test(url)) || window.location.origin;
  urlCandidates = [preferred, ...allCandidates.filter((url) => url !== preferred)];

  if (currentRoom) {
    renderUrlOptions(currentRoom);
  }
}

function renderAnswerMode(room) {
  const isHandwriting = room.answerMode === 'handwriting';
  const isSelected = room.answerMode === 'text' || room.answerMode === 'handwriting';
  modeTextBtn.classList.toggle('button-primary', !isHandwriting);
  modeTextBtn.classList.toggle('button', true);
  modeHandwritingBtn.classList.toggle('button-primary', isHandwriting);
  modeHandwritingBtn.classList.toggle('button', true);
  hostCurrentModePill.textContent = isSelected
    ? `回答方式: ${isHandwriting ? '手書き' : 'テキスト'}`
    : '回答方式: 未選択';
}

function renderRoom(room) {
  currentRoom = room;
  saveHostRoomCode(room.code);
  createSection.classList.add('hidden');
  controlSection.classList.remove('hidden');
  const mode = room.revealMode || 0;

  controlSection.classList.toggle('is-input-locked', !room.inputEnabled);
  controlSection.classList.toggle('is-answer-revealed', mode === 2);
  controlSection.classList.toggle('mode-answers', mode === 1);
  controlSection.classList.toggle('mode-correct', mode === 2);

  const onAirLabel = document.getElementById('hostOnAirLabel');
  if (onAirLabel) {
    if (mode === 0) onAirLabel.textContent = '待機中';
    else if (mode === 1) onAirLabel.textContent = '回答表示中';
    else if (mode === 2) onAirLabel.textContent = '正解表示中';
  }

  roomCodeEl.textContent = room.code;
  toggleInputBtn.textContent = room.inputEnabled ? '配布を締め切る' : '配布開始';
  toggleInputBtn.classList.toggle('button-primary', room.inputEnabled);
  toggleInputBtn.classList.toggle('button-success', !room.inputEnabled);
  toggleInputBtn.disabled = !room.inputEnabled && !room.answerMode;

  let displayBtnText = '回答を表示する';
  let displayBtnClass = 'button-primary';

  if (mode === 1) {
    displayBtnText = '正解表示へ進む';
    displayBtnClass = 'button-success';
  } else if (mode === 2) {
    displayBtnText = '表示を閉じる';
    displayBtnClass = 'button-danger';
  }

  toggleDisplayBtn.textContent = displayBtnText;
  toggleDisplayBtn.className = `button ${displayBtnClass}`;
  toggleDisplayBtn.disabled = !room.playerCount;
  clearAllBtn.disabled = !room.playerCount;

  renderAnswerMode(room);
  renderPlayerCards(room);
  renderUrlOptions(room);
}

function setHostAnswerMode(mode) {
  if (!currentRoom) return;

  socket.emit('host:setAnswerMode', { roomCode: currentRoom.code, mode }, (response) => {
    if (!response.ok) {
      setMessage(controlMessage, response.message, 'warn');
      return;
    }

    setMessage(controlMessage, mode === 'handwriting' ? '回答方式を手書きに切り替えました。' : '回答方式をテキストに切り替えました。', 'ok');
  });
}

createRoomBtn.addEventListener('click', () => {
  socket.emit('host:create', {}, (response) => {
    if (!response.ok) {
      setMessage(createMessage, response.message, 'warn');
      return;
    }

    setMessage(createMessage, '');
    renderRoom(response.room);
    setMessage(controlMessage, 'ルームを作成しました。', 'ok');
  });
});

toggleInputBtn.addEventListener('click', () => {
  if (!currentRoom) return;

  const nextState = !currentRoom.inputEnabled;
  socket.emit(
    'host:setInputEnabled',
    { roomCode: currentRoom.code, inputEnabled: nextState },
    (response) => {
      if (!response.ok) {
        setMessage(controlMessage, response.message, 'warn');
        return;
      }

      setMessage(controlMessage, nextState ? '配布を開始しました。' : '配布を締め切りました。', 'ok');
    }
  );
});

toggleDisplayBtn.addEventListener('click', () => {
  if (!currentRoom) return;

  const currentMode = currentRoom.revealMode || 0;
  const nextMode = (currentMode + 1) % 3;

  socket.emit(
    'host:setRevealMode',
    { roomCode: currentRoom.code, mode: nextMode },
    (response) => {
      if (!response.ok) {
        setMessage(controlMessage, response.message, 'warn');
        return;
      }

      let statusMsg = 'モニター表示を閉じました。';
      if (nextMode === 1) statusMsg = '全員の回答を表示しました。';
      if (nextMode === 2) statusMsg = '正解表示に切り替えました。';
      setMessage(controlMessage, statusMsg, 'ok');
    }
  );
});

clearAllBtn.addEventListener('click', () => {
  if (!currentRoom) return;

  const confirmed = confirm('全員の回答を消して次の問題に進みますか？');
  if (!confirmed) return;

  socket.emit('host:clearAll', { roomCode: currentRoom.code }, (response) => {
    if (!response.ok) {
      setMessage(controlMessage, response.message, 'warn');
      return;
    }

    setMessage(controlMessage, '次の問題の準備ができました。', 'ok');
  });
});

modeTextBtn.addEventListener('click', () => {
  setHostAnswerMode('text');
});

modeHandwritingBtn.addEventListener('click', () => {
  setHostAnswerMode('handwriting');
});

playerUrlSelect.addEventListener('change', () => {
  if (!currentRoom) return;

  playerQrImage.src = `/api/qr?text=${encodeURIComponent(playerUrlSelect.value)}`;
  monitorUrlInput.value = getMonitorUrl(new URL(playerUrlSelect.value).origin, currentRoom.code);
});

copyPlayerUrlBtn.addEventListener('click', async () => {
  if (!playerUrlSelect.value) return;

  const copied = await copyTextToClipboard(playerUrlSelect.value, copyPlayerUrlBtn);
  if (copied) {
    setMessage(controlMessage, '参加URLをコピーしました。', 'ok');
  } else {
    setMessage(controlMessage, '参加URLをコピーできませんでした。', 'warn');
  }
});

copyMonitorUrlBtn.addEventListener('click', async () => {
  if (!monitorUrlInput.value) return;

  const copied = await copyTextToClipboard(monitorUrlInput.value, copyMonitorUrlBtn);
  if (copied) {
    setMessage(controlMessage, 'モニターURLをコピーしました。', 'ok');
  } else {
    setMessage(controlMessage, 'モニターURLをコピーできませんでした。', 'warn');
  }
});

openMonitorBtn.addEventListener('click', () => {
  if (!monitorUrlInput.value) return;
  window.open(monitorUrlInput.value, 'quiz-panel-monitor');
});

reloadNetworkBtn.addEventListener('click', async () => {
  await loadNetworkCandidates();
  setMessage(controlMessage, 'URL候補を更新しました。', 'ok');
});

socket.on('host:room', (room) => {
  renderRoom(room);
});

socket.on('room:closed', () => {
  clearHostRoomCode();
  resetToCreateView('ルームとの接続が終了しました。必要なら新しく作成してください。', 'warn');
});

loadNetworkCandidates();

try {
  const savedRoomCode = String(sessionStorage.getItem(HOST_ROOM_KEY) || '').trim().toUpperCase();
  if (savedRoomCode) {
    setMessage(createMessage, '前回のルームに再接続しています。');
    socket.emit('host:resume', { roomCode: savedRoomCode }, (response) => {
      if (!response.ok) {
        clearHostRoomCode();
        setMessage(createMessage, '前回のルームには再接続できませんでした。新しく作成してください。', 'warn');
        return;
      }

      setMessage(createMessage, '');
      renderRoom(response.room);
      setMessage(controlMessage, 'ルームに再接続しました。', 'ok');
    });
  }
} catch (_error) {
  // ignore storage failures
}
