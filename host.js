const socket = io({
  transports: ['websocket'],
  upgrade: false,
});

const createSection = document.getElementById('createSection');
const controlSection = document.getElementById('controlSection');
const createRoomBtn = document.getElementById('createRoomBtn');
const createMessage = document.getElementById('createMessage');
const controlMessage = document.getElementById('controlMessage');

const roomCodeEl = document.getElementById('roomCode');
const toggleInputBtn = document.getElementById('toggleInputBtn');
const toggleDisplayBtn = document.getElementById('toggleDisplayBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
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

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_error) {
      // HTTP / LAN 環境では失敗することがあるため、下のフォールバックを試す。
    }
  }

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
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch (_error) {
    document.body.removeChild(textarea);
    return false;
  }
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
      card.className = 'host-answer-card';
      card.setAttribute('aria-label', `${player.name} の回答カード`);

      if (player.result === 'correct') card.classList.add('is-correct');
      if (!room.inputEnabled) card.classList.add('is-locked');
      if (room.answerRevealAll) card.classList.add('is-revealed');

      const resultLabel = player.result === 'correct' ? '<div class="host-answer-result">正解</div>' : '';

      card.innerHTML = `
        ${resultLabel}
        <div class="host-answer-tile-body">
          <div class="host-answer-text">${escapeHtml(player.draftText || '未入力')}</div>
        </div>
        <div class="host-answer-tile-name">${escapeHtml(player.name)}</div>
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
              nextResult === 'correct' ? `${player.name} を正解にしました。` : `${player.name} を判定なしに戻しました。`,
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
  const selectedBaseUrl = urlCandidates[0] || window.location.origin;
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
      (payload?.lanAddresses || []).forEach(({ address }) => {
        if (address) {
          candidateSet.add(`http://${address}:${port}`);
        }
      });
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

function renderRoom(room) {
  currentRoom = room;
  createSection.classList.add('hidden');
  controlSection.classList.remove('hidden');
  controlSection.classList.toggle('is-input-locked', !room.inputEnabled);
  controlSection.classList.toggle('is-answer-revealed', room.answerRevealAll);

  roomCodeEl.textContent = room.code;
  toggleInputBtn.textContent = room.inputEnabled ? '入力を締め切る' : '入力を再開する';
  toggleInputBtn.classList.toggle('button-primary', room.inputEnabled);
  toggleInputBtn.classList.toggle('button-success', !room.inputEnabled);

  toggleDisplayBtn.textContent = room.answerRevealAll ? '表示を隠す' : '回答を表示する';
  toggleDisplayBtn.classList.toggle('button-primary', !room.answerRevealAll);
  toggleDisplayBtn.classList.toggle('button-success', room.answerRevealAll);

  toggleDisplayBtn.disabled = !room.playerCount;
  clearAllBtn.disabled = !room.playerCount;

  renderPlayerCards(room);
  renderUrlOptions(room);
}

createRoomBtn.addEventListener('click', () => {
  socket.emit('host:create', {}, (response) => {
    if (!response.ok) {
      setMessage(createMessage, response.message, 'warn');
      return;
    }

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

      setMessage(controlMessage, nextState ? '入力を再開しました。' : '入力を締め切りました。', 'ok');
    }
  );
});

toggleDisplayBtn.addEventListener('click', () => {
  if (!currentRoom) return;

  const nextState = !currentRoom.answerRevealAll;
  socket.emit(
    'host:setAnswerRevealAll',
    { roomCode: currentRoom.code, visible: nextState },
    (response) => {
      if (!response.ok) {
        setMessage(controlMessage, response.message, 'warn');
        return;
      }

      setMessage(controlMessage, nextState ? 'モニター表示を開始しました。' : 'モニター表示を隠しました。', 'ok');
    }
  );
});

clearAllBtn.addEventListener('click', () => {
  if (!currentRoom) return;

  const confirmed = window.confirm(
    '現在の回答をすべてリセットします。\nこの操作は元に戻せません。よろしいですか？'
  );

  if (!confirmed) return;

  socket.emit('host:clearAll', { roomCode: currentRoom.code }, (response) => {
    if (!response.ok) {
      setMessage(controlMessage, response.message, 'warn');
      return;
    }

    setMessage(controlMessage, '回答をリセットしました。', 'ok');
  });
});

playerUrlSelect.addEventListener('change', () => {
  playerQrImage.src = `/api/qr?text=${encodeURIComponent(playerUrlSelect.value)}`;
});

copyPlayerUrlBtn.addEventListener('click', async () => {
  if (!playerUrlSelect.value) return;

  const copied = await copyTextToClipboard(playerUrlSelect.value);
  if (copied) {
    setMessage(controlMessage, '参加URLをコピーしました。', 'ok');
  } else {
    setMessage(controlMessage, '参加URLをコピーできませんでした。URL欄を選択して手動でコピーしてください。', 'warn');
  }
});

copyMonitorUrlBtn.addEventListener('click', async () => {
  if (!monitorUrlInput.value) return;

  const copied = await copyTextToClipboard(monitorUrlInput.value);
  if (copied) {
    setMessage(controlMessage, 'モニターURLをコピーしました。', 'ok');
  } else {
    setMessage(controlMessage, 'モニターURLをコピーできませんでした。URL欄を選択して手動でコピーしてください。', 'warn');
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
  setMessage(controlMessage, '部屋が終了しました。ページを開き直してください。', 'warn');
});

loadNetworkCandidates();
