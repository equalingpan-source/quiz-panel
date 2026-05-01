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
let isDirty = false;
let wasSelfLocked = false;

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
  const charCount = Array.from(String(text || '')).length;
  charCounter.textContent = `${charCount} / 24`;
}

function applyRoom(room) {
  currentRoom = room;

  const myName = room.me?.name || playerName || '';
  playerNameDisplay.textContent = myName;

  const isInputLockedByHost = !room.inputEnabled;
  const isSelfLocked = !!room.me?.locked;
  const isLocked = isInputLockedByHost || isSelfLocked;
  const serverDraft = room.me?.draftText || '';

  // Stability-first:
  // while the field is editable, keep the local draft untouched.
  // only reflect server state after submit, unlock reset, or before editing starts.
  if (isSelfLocked || (wasSelfLocked && !isSelfLocked) || !isDirty) {
    answerInput.value = serverDraft;
    isDirty = false;
  }

  syncCounter(answerInput.value);

  answerInput.disabled = isLocked;
  clearAnswerBtn.disabled = isLocked;
  submitAnswerBtn.disabled = isLocked;
  playerCompose.classList.toggle('is-locked', isLocked);
  wasSelfLocked = isSelfLocked;

  const result = room.me?.result || 'pending';
  const shouldShowCorrect = result === 'correct' && room.revealMode === 2;
  playerCompose.classList.toggle('result-correct', shouldShowCorrect);
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
  isDirty = true;
  syncCounter(answerInput.value);
});

clearAnswerBtn.addEventListener('click', () => {
  answerInput.value = '';
  isDirty = true;
  syncCounter(answerInput.value);
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
    answerInput.value = text;
    syncCounter(text);

    socket.emit('player:submitAnswer', { roomCode: currentRoom.code, text }, (response) => {
      if (response.ok) {
        isDirty = false;
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
