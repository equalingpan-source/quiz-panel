const socket = io({
  transports: ['websocket'],
  upgrade: false,
});

const params = new URLSearchParams(window.location.search);
const roomCode = String(params.get('room') || '').trim().toUpperCase();

const monitorRoomCode = document.getElementById('monitorRoomCode');
const monitorState = document.getElementById('monitorState');
const monitorBoard = document.getElementById('monitorBoard');

let roomState = null;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createTileMarkup(player, answerRevealAll) {
  const isCorrect = answerRevealAll && player.result === 'correct';
  const isHiddenState = !answerRevealAll;
  const classes = ['board-tile', 'board-tile-waiting'];

  if (isCorrect) classes.push('is-correct');
  if (isHiddenState) classes.push('is-hidden-state');

  const bodyContent = answerRevealAll
    ? `<div class="board-tile-answer-text">${escapeHtml(player.displayText || ' ')}</div>`
    : `<img class="board-tile-logo" src="/assets/logo-flat.png" alt="flat" />`;

  return `
    <div class="${classes.join(' ')}">
      <div class="board-tile-head">
        <span></span>
        <span class="board-tile-result">${isCorrect ? '正解' : ''}</span>
      </div>
      <div class="board-tile-body">${bodyContent}</div>
      <div class="board-tile-name">${escapeHtml(player.name)}</div>
    </div>
  `;
}

function applyRoom(room) {
  roomState = room;
  monitorRoomCode.textContent = room.code;
  monitorState.textContent = room.answerRevealAll ? '答え表示中' : '回答パネル';
  monitorBoard.innerHTML = '';

  if (!room.board.length) {
    const empty = document.createElement('div');
    empty.className = 'board-empty-message board-empty-dark';
    empty.textContent = '参加者を待っています';
    monitorBoard.appendChild(empty);
    return;
  }

  room.board
    .slice()
    .sort((left, right) => left.slot - right.slot)
    .forEach((player) => {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = createTileMarkup(player, room.answerRevealAll);
      monitorBoard.appendChild(wrapper.firstElementChild);
    });
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
  monitorState.textContent = '接続終了';
  monitorBoard.innerHTML = '<div class="board-empty-message board-empty-dark">親機との接続が終了しました</div>';
});
