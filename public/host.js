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
const monitorWaitBtn = document.getElementById('monitorWaitBtn');
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

function getRoomPhase(room) {
  return room?.phase || 'setup';
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
      const card = document.createElement('div');
      card.classList.add('host-answer-card');
      const phase = getRoomPhase(room);
      const canToggleResult = phase === 'locked' || phase === 'revealAnswers' || phase === 'revealResults';

      const isCorrect = player.result === 'correct';
      const isLockedVisual = phase !== 'open' || !!player.locked;
      const canRemovePlayer = !player.connected;

      card.classList.toggle('is-correct', isCorrect);
      card.classList.toggle('is-locked-visual', isLockedVisual);
      card.classList.toggle('is-clickable', canToggleResult);
      card.classList.toggle('is-disconnected', canRemovePlayer);

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
        ? '<img class="host-card-surface host-card-image" src="' + player.answerImage + '" alt="手書き回答" />'
        : `<div class="host-card-surface host-card-text" style="font-size: ${fontSize}">${escapeHtml(text)}</div>`;

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
        ${canRemovePlayer ? '<button class="host-card-remove" type="button">削除</button>' : ''}
      `;

      card.addEventListener('click', (event) => {
        if (event.target.closest('.host-card-remove')) {
          return;
        }
        if (!canToggleResult) {
          return;
        }

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

      const removeBtn = card.querySelector('.host-card-remove');
      if (removeBtn) {
        removeBtn.addEventListener('click', (event) => {
          event.stopPropagation();

          socket.emit('host:removePlayer', { roomCode: room.code, playerId: player.id }, (response) => {
            if (!response.ok) {
              setMessage(controlMessage, response.message, 'warn');
              return;
            }

            setMessage(controlMessage, `${player.name} を一覧から削除しました。`, 'ok');
          });
        });
      }

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
  const phase = getRoomPhase(room);
  const isHandwriting = room.answerMode === 'handwriting';
  modeTextBtn.className = `button host-mode-button${!isHandwriting ? ' button-primary' : ''}`;
  modeHandwritingBtn.className = `button host-mode-button${isHandwriting ? ' button-primary' : ''}`;
  modeTextBtn.disabled = phase !== 'setup';
  modeHandwritingBtn.disabled = phase !== 'setup';
  hostCurrentModePill.textContent = `回答方法: ${isHandwriting ? '手書き' : '通常入力'}`;
}

function configureActionButton(button, config) {
  button.textContent = config.label;
  const roleClass = button.id === 'toggleInputBtn' ? 'host-primary-action' : 'host-monitor-action';
  button.className = `button ${roleClass} ${config.className}`.trim();
  button.disabled = !!config.disabled;
  button.dataset.targetPhase = config.targetPhase || '';
  button.dataset.successMessage = config.successMessage || '';
}

function getPrimaryActionConfig(room) {
  const phase = getRoomPhase(room);
  const hasMode = room.answerMode === 'text' || room.answerMode === 'handwriting';

  if (phase === 'setup') {
    return {
      label: '回答開始',
      className: 'button-success',
      targetPhase: 'open',
      successMessage: '回答受付を開始しました。',
      disabled: !hasMode,
    };
  }

  if (phase === 'open') {
    return {
      label: '回答終了',
      className: 'button-danger',
      targetPhase: 'locked',
      successMessage: '回答受付を終了しました。',
      disabled: false,
    };
  }

  if (phase === 'locked') {
    return {
      label: '回答終了',
      className: 'button-danger',
      targetPhase: '',
      successMessage: '',
      disabled: true,
    };
  }

  if (phase === 'revealAnswers' || phase === 'revealResults') {
    return {
      label: '次の回答を表示',
      className: 'button-success',
      targetPhase: 'nextRound',
      successMessage: '次の問題に切り替えました。',
      disabled: false,
    };
  }
  return {
    label: '回答開始',
    className: 'button-success',
    targetPhase: 'open',
    successMessage: '回答受付を開始しました。',
    disabled: false,
  };
}

function getMonitorActionEnabled(room) {
  const phase = getRoomPhase(room);
  return room.playerCount > 0 && phase !== 'setup' && phase !== 'open';
}

function renderRoom(room) {
  currentRoom = room;
  saveHostRoomCode(room.code);
  createSection.classList.add('hidden');
  controlSection.classList.remove('hidden');

  const phase = getRoomPhase(room);
  const onAirLabel = document.getElementById('hostOnAirLabel');
  const isStageLocked = phase === 'setup' || phase === 'locked';

  controlSection.classList.toggle('is-input-locked', isStageLocked);
  controlSection.classList.toggle('is-answer-revealed', phase === 'revealResults');
  controlSection.classList.toggle('mode-answers', phase === 'revealAnswers');
  controlSection.classList.toggle('mode-correct', phase === 'revealResults');

  if (onAirLabel) {
    if (phase === 'setup') onAirLabel.textContent = '準備中';
    else if (phase === 'open') onAirLabel.textContent = '回答受付中';
    else if (phase === 'locked') onAirLabel.textContent = '受付終了';
    else if (phase === 'revealAnswers') onAirLabel.textContent = 'モニター回答表示中';
    else onAirLabel.textContent = 'モニター正解表示中';
  }

  roomCodeEl.textContent = room.code;

  configureActionButton(toggleInputBtn, getPrimaryActionConfig(room));
  const monitorEnabled = getMonitorActionEnabled(room);

  toggleDisplayBtn.textContent = 'モニターへ回答表示';
  toggleDisplayBtn.className = 'button host-monitor-action button-primary';
  toggleDisplayBtn.disabled = !monitorEnabled;

  clearAllBtn.textContent = 'モニターへ正解表示';
  clearAllBtn.className = 'button host-monitor-action button-danger';
  clearAllBtn.disabled = !monitorEnabled;

  monitorWaitBtn.textContent = 'モニターを待機に戻す';
  monitorWaitBtn.className = 'button host-monitor-action';
  monitorWaitBtn.disabled = !monitorEnabled || phase === 'locked';

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

    setMessage(controlMessage, mode === 'handwriting' ? '回答方法を手書きに設定しました。' : '回答方法を通常入力に設定しました。', 'ok');
  });
}

function changeRoomPhase(targetPhase, successMessage) {
  if (!currentRoom || !targetPhase) return;

  socket.emit('host:setPhase', { roomCode: currentRoom.code, phase: targetPhase }, (response) => {
    if (!response.ok) {
      setMessage(controlMessage, response.message, 'warn');
      return;
    }

    setMessage(controlMessage, successMessage, 'ok');
  });
}

function goToNextRound() {
  if (!currentRoom) return;

  const confirmed = confirm('現在の回答をリセットしていいですか？');
  if (!confirmed) return;

  socket.emit('host:clearAll', { roomCode: currentRoom.code }, (response) => {
    if (!response.ok) {
      setMessage(controlMessage, response.message, 'warn');
      return;
    }

    setMessage(controlMessage, '次の問題に切り替えました。', 'ok');
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
  if (toggleInputBtn.dataset.targetPhase === 'nextRound') {
    goToNextRound();
    return;
  }

  changeRoomPhase(toggleInputBtn.dataset.targetPhase, toggleInputBtn.dataset.successMessage);
});

toggleDisplayBtn.addEventListener('click', () => {
  changeRoomPhase('revealAnswers', 'モニターに回答を表示しました。');
});

clearAllBtn.addEventListener('click', () => {
  changeRoomPhase('revealResults', 'モニターに正解を表示しました。');
});

modeTextBtn.addEventListener('click', () => {
  setHostAnswerMode('text');
});

modeHandwritingBtn.addEventListener('click', () => {
  setHostAnswerMode('handwriting');
});

monitorWaitBtn.addEventListener('click', () => {
  changeRoomPhase('locked', 'モニターを待機に戻しました。');
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
