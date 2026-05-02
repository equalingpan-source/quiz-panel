const params = new URLSearchParams(window.location.search);
const presetRoomCode = String(params.get('room') || '').trim().toUpperCase();

const roomCodeInput = document.getElementById('roomCodeInput');
const playerNameInput = document.getElementById('playerNameInput');
const joinBtn = document.getElementById('joinBtn');
const joinMessage = document.getElementById('joinMessage');
const PLAYER_ENTRY_KEY = 'quizPanelEntry';

roomCodeInput.value = presetRoomCode;

function setMessage(target, text, type = '') {
  target.textContent = text || '';
  target.className = 'status-text';
  if (type) target.classList.add(type);
}

function makePlayerToken() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `player-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readStoredEntry() {
  try {
    const sessionEntry = JSON.parse(sessionStorage.getItem(PLAYER_ENTRY_KEY) || 'null');
    if (sessionEntry && typeof sessionEntry === 'object') {
      return sessionEntry;
    }
  } catch (_error) {
    // ignore storage failures
  }

  try {
    const localEntry = JSON.parse(localStorage.getItem(PLAYER_ENTRY_KEY) || 'null');
    if (localEntry && typeof localEntry === 'object') {
      return localEntry;
    }
  } catch (_error) {
    // ignore storage failures
  }

  return null;
}

function writeStoredEntry(entry) {
  const payload = JSON.stringify(entry);
  sessionStorage.setItem(PLAYER_ENTRY_KEY, payload);
  localStorage.setItem(PLAYER_ENTRY_KEY, payload);
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

  const existingToken = String(readStoredEntry()?.playerToken || '').trim();
  writeStoredEntry({
    roomCode: presetRoomCode,
    name,
    playerToken: existingToken || makePlayerToken(),
  });

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
