const socket = io({
  transports: ['websocket'],
  upgrade: false,
});

const params = new URLSearchParams(window.location.search);
const roomCode = String(params.get('room') || '').trim().toUpperCase();

const monitorBoard = document.getElementById('monitorBoard');
const monitorShell = document.querySelector('.monitor-shell');
let refitFrame = 0;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fitAnswerText(element, container) {
  if (!element || !container) return;

  const width = container.clientWidth;
  const height = container.clientHeight;
  if (!width || !height) return;

  const safeWidth = Math.max(0, width - 24);
  const safeHeight = Math.max(0, height - 28);
  const minPx = 24;
  let low = minPx;
  let high = Math.max(minPx, Math.min(safeWidth * 0.92, safeHeight * 1.18));
  let best = minPx;

  element.style.maxWidth = `${safeWidth}px`;
  element.style.maxHeight = `${safeHeight}px`;

  while (high - low > 1) {
    const mid = (low + high) / 2;
    element.style.fontSize = `${mid}px`;

    const fitsHeight = element.scrollHeight <= safeHeight + 1;
    const fitsWidth = element.scrollWidth <= safeWidth + 1;

    if (fitsHeight && fitsWidth) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }

  element.style.fontSize = `${Math.max(minPx, best - 2)}px`;
}

function refitMonitorAnswerText() {
  monitorBoard.querySelectorAll('.board-tile').forEach((card) => {
    const container = card.querySelector('.board-tile-body');
    const answer = card.querySelector('.board-tile-answer-text');
    fitAnswerText(answer, container);
  });
}

function scheduleRefit() {
  if (refitFrame) {
    window.cancelAnimationFrame(refitFrame);
  }

  refitFrame = window.requestAnimationFrame(() => {
    refitFrame = 0;
    refitMonitorAnswerText();
  });
}

function applyRoom(room) {
  const mode = room.revealMode || 0;

  if (monitorShell) {
    monitorShell.classList.toggle('mode-answers', mode === 1);
    monitorShell.classList.toggle('mode-correct', mode === 2);
  }

  const showAnswers = mode > 0;
  const playerCount = room.board.length;
  const isSingleLayout = playerCount === 1;

  let cols = 1;
  let rows = 1;
  if (playerCount > 1) {
    cols = Math.ceil(Math.sqrt(playerCount * 1.6));
    rows = Math.ceil(playerCount / cols);
  }

  monitorBoard.classList.toggle('is-single-layout', isSingleLayout);
  monitorBoard.style.gridTemplateColumns = isSingleLayout ? 'minmax(320px, 1120px)' : `repeat(${cols}, 1fr)`;
  monitorBoard.style.gridTemplateRows = isSingleLayout ? 'auto' : `repeat(${rows}, 1fr)`;

  const currentIds = new Set(room.board.map((player) => `player-${player.id}`));
  Array.from(monitorBoard.children).forEach((child) => {
    if (!currentIds.has(child.id) && !child.classList.contains('board-empty-message')) {
      child.remove();
    }
  });

  if (!room.board.length) {
    if (!monitorBoard.querySelector('.board-empty-message')) {
      monitorBoard.innerHTML = '<div class="board-empty-message board-empty-dark">参加者を待っています</div>';
    }
    return;
  }

  const emptyMsg = monitorBoard.querySelector('.board-empty-message');
  if (emptyMsg) emptyMsg.remove();

  room.board
    .slice()
    .sort((left, right) => left.slot - right.slot)
    .forEach((player) => {
      let card = document.getElementById(`player-${player.id}`);
      if (!card) {
        card = document.createElement('div');
        card.id = `player-${player.id}`;
        card.className = 'board-tile';
        monitorBoard.appendChild(card);
      }

      const shouldShowRed = player.result === 'correct' && mode === 2;
      const isLockedVisual = !room.inputEnabled || !!player.locked;

      card.classList.toggle('is-correct', shouldShowRed);
      card.classList.toggle('is-locked-visual', isLockedVisual);
      card.classList.toggle('is-hidden-state', mode === 0);

      const text = player.displayText || ' ';
      const isHandwriting = player.displayMode === 'handwriting' && !!player.displayImage;

      const bodyContent = showAnswers
        ? (
          isHandwriting
            ? `<div class="board-tile-answer-art"><img class="board-tile-answer-image" src="${player.displayImage}" alt="手書き回答" /></div>`
            : `<div class="board-tile-answer-text">${escapeHtml(text)}</div>`
        )
        : `<div class="board-tile-placeholder-name">${escapeHtml(player.name)}</div>`;

      const nextHtml = `
        <div class="board-tile-body">${bodyContent}</div>
        ${showAnswers ? `<div class="board-tile-name">${escapeHtml(player.name)}</div>` : ''}
      `;

      if (card.innerHTML !== nextHtml) {
        card.innerHTML = nextHtml;
      }
    });

  if (showAnswers) {
    scheduleRefit();
  }
}

if (!roomCode) {
  monitorBoard.innerHTML = '<div class="board-empty-message board-empty-dark">ルーム情報がありません</div>';
} else {
  socket.emit('monitor:join', { roomCode }, (response) => {
    if (!response.ok) {
      monitorBoard.innerHTML = `<div class="board-empty-message board-empty-dark">${escapeHtml(
        response.message || '接続できませんでした'
      )}</div>`;
      return;
    }

    applyRoom(response.room);
  });
}

socket.on('monitor:room', (room) => {
  applyRoom(room);
});

socket.on('room:closed', () => {
  monitorBoard.innerHTML = '<div class="board-empty-message board-empty-dark">親機との接続が終了しました</div>';
  if (monitorShell) {
    monitorShell.classList.remove('mode-answers', 'mode-correct');
  }
});

window.addEventListener('resize', () => {
  scheduleRefit();
});
