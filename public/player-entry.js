const params = new URLSearchParams(window.location.search);
const presetRoomCode = String(params.get('room') || '').trim().toUpperCase();

const roomCodeInput = document.getElementById('roomCodeInput');
const playerNameInput = document.getElementById('playerNameInput');
const joinBtn = document.getElementById('joinBtn');
const joinMessage = document.getElementById('joinMessage');

roomCodeInput.value = presetRoomCode;

function setMessage(target, text, type = '') {
  target.textContent = text || '';
  target.className = 'status-text';
  if (type) target.classList.add(type);
}

if (!presetRoomCode) {
  setMessage(joinMessage, 'ルーム情報がありません。親機のQRから入り直してください。', 'warn');
  joinBtn.disabled = true;
} else {
  setTimeout(() => playerNameInput.focus(), 60);
}

joinBtn.addEventListener('click', () => {
  const name = playerNameInput.value.trim();

  if (!presetRoomCode) {
    setMessage(joinMessage, 'ルーム情報がありません。', 'warn');
    return;
  }
  if (!name) {
    setMessage(joinMessage, '名前を入力してください。', 'warn');
    playerNameInput.focus();
    return;
  }

  sessionStorage.setItem(
    'quizPanelEntry',
    JSON.stringify({
      roomCode: presetRoomCode,
      name,
    })
  );

  const nextUrl = new URL('/player.html', window.location.origin);
  nextUrl.searchParams.set('room', presetRoomCode);
  nextUrl.searchParams.set('name', name);
  window.location.assign(nextUrl.toString());
});

playerNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    joinBtn.click();
  }
});
