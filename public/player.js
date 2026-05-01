const socket = io({
  transports: ['websocket'],
  upgrade: false,
});

const PLAYER_ENTRY_KEY = 'quizPanelEntry';

const playerNameDisplay = document.getElementById('playerNameDisplay');
const answerInput = document.getElementById('answerInput');
const playerCompose = document.getElementById('playerCompose');
const clearAnswerBtn = document.getElementById('clearAnswerBtn');
const submitAnswerBtn = document.getElementById('submitAnswerBtn');
const charCounter = document.getElementById('charCounter');

const params = new URLSearchParams(window.location.search);
const presetRoomCode = String(params.get('room') || '').trim().toUpperCase();
const queryName = String(params.get('name') || '').trim();

let currentRoom = null;
let syncTimer = null;
let lastSyncedText = '';
let pendingDraftText = '';
let isComposing = false;

let entry = null;
try {
  entry = JSON.parse(sessionStorage.getItem(PLAYER_ENTRY_KEY) || 'null');
} catch (_error) {
  entry = null;
}

const hasMatchingEntry = String(entry?.roomCode || '').trim().toUpperCase() === presetRoomCode;
const playerName = String((hasMatchingEntry ? entry?.name : '') || queryName).trim();

if (!presetRoomCode || !playerName) {
  const fallbackUrl = new URL('/player-entry.html', window.location.origin);
  if (presetRoomCode) {
    fallbackUrl.searchParams.set('room', presetRoomCode);
  }
  window.location.replace(fallbackUrl.toString());
}

if (!hasMatchingEntry || entry?.name !== playerName) {
  try {
    sessionStorage.setItem(
      PLAYER_ENTRY_KEY,
      JSON.stringify({
        roomCode: presetRoomCode,
        name: playerName,
      })
    );
  } catch (_error) {
    // fallback remains the query string for this tab
  }
}

if (queryName) {
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('name');
  window.history.replaceState({}, '', cleanUrl.toString());
}

function normalizeAnswer(value) {
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, 24).join('');
}

function syncCounter(text) {
  const charCount = Array.from(text || '').length;
  charCounter.textContent = `${charCount} / 24`;
}

function applyRoom(room) {
  currentRoom = room;

  const myName = room.me?.name || playerName || '';
  playerNameDisplay.textContent = myName;

  const draftText = room.me?.draftText || '';
  lastSyncedText = draftText;
  const localText = normalizeAnswer(answerInput.value);
  const isActivelyEditing = document.activeElement === answerInput;
  const shouldKeepLocalDraft = !isComposing
    && !!pendingDraftText
    && pendingDraftText !== draftText
    && localText === pendingDraftText
    && isActivelyEditing;

  if (!shouldKeepLocalDraft && answerInput.value !== draftText) {
    answerInput.value = draftText;
  }

  const displayText = shouldKeepLocalDraft ? pendingDraftText : draftText;
  syncCounter(displayText);

  const isInputLockedByHost = !room.inputEnabled;
  const isSelfLocked = !!room.me?.locked;
  const isLocked = isInputLockedByHost || isSelfLocked;

  answerInput.disabled = isLocked;
  clearAnswerBtn.disabled = isLocked;
  submitAnswerBtn.disabled = isLocked;
  playerCompose.classList.toggle('is-locked', isLocked);

  if (isLocked || draftText === pendingDraftText) {
    pendingDraftText = '';
  }

  const result = room.me?.result || 'pending';
  const shouldShowCorrect = result === 'correct' && room.revealMode === 2;
  playerCompose.classList.toggle('result-correct', shouldShowCorrect);
}

function scheduleSync() {
  if (!currentRoom) return;
  if (isComposing) return;

  const nextText = normalizeAnswer(answerInput.value);
  if (answerInput.value !== nextText) {
    answerInput.value = nextText;
  }
  syncCounter(nextText);
  pendingDraftText = nextText;

  if (!currentRoom.inputEnabled || nextText === lastSyncedText) {
    return;
  }

  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    socket.emit('player:updateDraft', { roomCode: currentRoom.code, text: nextText }, (response) => {
      if (response.ok) {
        lastSyncedText = response.me?.draftText || '';
        if (lastSyncedText === pendingDraftText) {
          pendingDraftText = '';
        }
      }
    });
  }, 80);
}

function joinRoom() {
  socket.emit('player:join', { roomCode: presetRoomCode, name: playerName }, (response) => {
    if (!response.ok) {
      const fallbackUrl = new URL('/player-entry.html', window.location.origin);
      fallbackUrl.searchParams.set('room', presetRoomCode);
      sessionStorage.removeItem(PLAYER_ENTRY_KEY);
      window.location.replace(fallbackUrl.toString());
      return;
    }

    applyRoom(response.room);
  });
}

answerInput.addEventListener('input', () => {
  scheduleSync();
});

answerInput.addEventListener('compositionstart', () => {
  isComposing = true;
});

answerInput.addEventListener('compositionend', () => {
  isComposing = false;
  scheduleSync();
});

clearAnswerBtn.addEventListener('click', () => {
  answerInput.value = '';
  scheduleSync();
  answerInput.focus();
});

submitAnswerBtn.addEventListener('click', () => {
  if (!currentRoom || !currentRoom.inputEnabled) return;
  
  const text = normalizeAnswer(answerInput.value);
  if (!text) {
    alert('回答を入力してください。');
    return;
  }

  if (confirm('回答を送信して確定しますか？\n送信後は修正できません。')) {
    socket.emit('player:submitAnswer', { roomCode: currentRoom.code, text }, (response) => {
      if (response.ok) {
        applyRoom(response.room);
      } else {
        alert(response.error || '送信に失敗しました。');
      }
    });
  }
});

socket.on('player:room', (room) => {
  applyRoom(room);
});

socket.on('room:closed', () => {
  answerInput.disabled = true;
  clearAnswerBtn.disabled = true;
  submitAnswerBtn.disabled = true;
  playerCompose.classList.add('is-locked');
});

joinRoom();
