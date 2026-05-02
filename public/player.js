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
const textInputPanel = document.getElementById('textInputPanel');
const handwritingInputPanel = document.getElementById('handwritingInputPanel');
const playerWaitPanel = document.getElementById('playerWaitPanel');
const playerWaitText = document.getElementById('playerWaitText');
const handwritingCanvas = document.getElementById('handwritingCanvas');
const handwritingContext = handwritingCanvas.getContext('2d');

const params = new URLSearchParams(window.location.search);
const presetRoomCode = String(params.get('room') || '').trim().toUpperCase();
const queryName = String(params.get('name') || '').trim();

let currentRoom = null;
let isDirty = false;
let wasSelfLocked = false;
let currentMode = 'text';
let hasHandwritingInk = false;
let isDrawing = false;
let activePointerId = null;
let handwritingSurfaceTone = 'default';

const LEGACY_HANDWRITING_BLUE = { r: 47, g: 87, b: 216 };

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

function clearStoredEntry() {
  sessionStorage.removeItem(PLAYER_ENTRY_KEY);
  localStorage.removeItem(PLAYER_ENTRY_KEY);
}

const entry = readStoredEntry();
const hasMatchingEntry = String(entry?.roomCode || '').trim().toUpperCase() === presetRoomCode;
const playerName = String((hasMatchingEntry ? entry?.name : '') || queryName).trim();
const playerToken = String(entry?.playerToken || '').trim();

if (!presetRoomCode || !playerName || !playerToken) {
  const fallbackUrl = new URL('/player-entry.html', window.location.origin);
  if (presetRoomCode) {
    fallbackUrl.searchParams.set('room', presetRoomCode);
  }
  window.location.replace(fallbackUrl.toString());
}

if (!hasMatchingEntry || entry?.name !== playerName) {
  try {
    writeStoredEntry({
      roomCode: presetRoomCode,
      name: playerName,
      playerToken,
    });
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

function normalizeAnswerMode(value) {
  return value === 'handwriting' ? 'handwriting' : 'text';
}

function getRoomPhase(room) {
  return room?.phase || 'setup';
}

function getHandwritingSurfaceColor() {
  return handwritingSurfaceTone === 'correct' ? '#d62d2d' : '#2f57d8';
}

function hexToRgb(hexColor) {
  const normalized = String(hexColor || '').replace('#', '');
  if (normalized.length !== 6) {
    return null;
  }

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function isNearColor(red, green, blue, target, tolerance = 20) {
  return Math.abs(red - target.r) <= tolerance
    && Math.abs(green - target.g) <= tolerance
    && Math.abs(blue - target.b) <= tolerance;
}

function replaceCanvasBackground(targetColor) {
  const imageData = handwritingContext.getImageData(0, 0, handwritingCanvas.width, handwritingCanvas.height);
  const pixels = imageData.data;
  const targetRgb = hexToRgb(targetColor);

  if (!targetRgb) {
    return;
  }

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const alpha = pixels[index + 3];

    if (alpha < 220) {
      continue;
    }

    if (isNearColor(red, green, blue, LEGACY_HANDWRITING_BLUE)) {
      pixels[index] = targetRgb.r;
      pixels[index + 1] = targetRgb.g;
      pixels[index + 2] = targetRgb.b;
    }
  }

  handwritingContext.putImageData(imageData, 0, 0);
}

function syncCounter() {
  if (currentMode === 'handwriting') {
    charCounter.textContent = hasHandwritingInk ? '手書き入力あり' : '手書き入力待ち';
    return;
  }

  const charCount = Array.from(String(answerInput.value || '')).length;
  charCounter.textContent = `${charCount} / 24`;
}

function updateModeUi() {
  const isHandwriting = currentMode === 'handwriting';
  textInputPanel.classList.toggle('hidden', isHandwriting);
  handwritingInputPanel.classList.toggle('hidden', !isHandwriting);
  playerCompose.classList.toggle('mode-handwriting', isHandwriting);
  playerCompose.classList.toggle('mode-text', !isHandwriting);
  syncCounter();
}

function paintCanvasSurface() {
  const rect = handwritingCanvas.getBoundingClientRect();
  const scaleX = handwritingCanvas.width / Math.max(rect.width, 1);
  const scaleY = handwritingCanvas.height / Math.max(rect.height, 1);

  handwritingContext.setTransform(1, 0, 0, 1, 0, 0);
  handwritingContext.clearRect(0, 0, handwritingCanvas.width, handwritingCanvas.height);
  handwritingContext.fillStyle = getHandwritingSurfaceColor();
  handwritingContext.fillRect(0, 0, handwritingCanvas.width, handwritingCanvas.height);
  handwritingContext.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  handwritingContext.strokeStyle = '#ffffff';
  handwritingContext.lineWidth = 4;
  handwritingContext.lineCap = 'round';
  handwritingContext.lineJoin = 'round';
}

function clearHandwritingCanvas(markDirty = true) {
  paintCanvasSurface();
  hasHandwritingInk = false;
  if (markDirty) {
    isDirty = true;
  }
  syncCounter();
}

function loadHandwritingFromDataUrl(dataUrl) {
  paintCanvasSurface();
  if (!dataUrl) {
    hasHandwritingInk = false;
    syncCounter();
    return;
  }

  const image = new Image();
  image.onload = () => {
    const targetWidth = Math.max(handwritingCanvas.clientWidth, Math.round(handwritingCanvas.width / Math.max(1, window.devicePixelRatio || 1)));
    const targetHeight = Math.max(handwritingCanvas.clientHeight, Math.round(handwritingCanvas.height / Math.max(1, window.devicePixelRatio || 1)));
    paintCanvasSurface();
    handwritingContext.drawImage(image, 0, 0, targetWidth, targetHeight);
    replaceCanvasBackground(getHandwritingSurfaceColor());
    hasHandwritingInk = true;
    syncCounter();
  };
  image.src = dataUrl;
}

function exportHandwritingDataUrl() {
  if (!hasHandwritingInk) {
    return '';
  }

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = handwritingCanvas.width;
  exportCanvas.height = handwritingCanvas.height;
  const exportContext = exportCanvas.getContext('2d');

  exportContext.drawImage(handwritingCanvas, 0, 0);

  const imageData = exportContext.getImageData(0, 0, exportCanvas.width, exportCanvas.height);
  const pixels = imageData.data;
  const currentSurfaceRgb = hexToRgb(getHandwritingSurfaceColor());

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const alpha = pixels[index + 3];

    if (alpha < 220) {
      continue;
    }

    const isCurrentSurface = currentSurfaceRgb && isNearColor(red, green, blue, currentSurfaceRgb);
    const isLegacySurface = isNearColor(red, green, blue, LEGACY_HANDWRITING_BLUE);

    if (isCurrentSurface || isLegacySurface) {
      pixels[index + 3] = 0;
    }
  }

  exportContext.putImageData(imageData, 0, 0);
  return exportCanvas.toDataURL('image/png');
}

function resizeHandwritingCanvas() {
  const snapshot = exportHandwritingDataUrl();
  const rect = handwritingCanvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const nextWidth = Math.max(320, Math.round(rect.width * dpr));
  const nextHeight = Math.max(180, Math.round(rect.height * dpr));

  if (handwritingCanvas.width === nextWidth && handwritingCanvas.height === nextHeight) {
    return;
  }

  handwritingCanvas.width = nextWidth;
  handwritingCanvas.height = nextHeight;
  paintCanvasSurface();

  if (snapshot) {
    loadHandwritingFromDataUrl(snapshot);
  } else {
    hasHandwritingInk = false;
    syncCounter();
  }
}

function getCanvasPoint(event) {
  const rect = handwritingCanvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function setAnswerMode(mode, options = {}) {
  const { focus = true, force = false } = options;
  const nextMode = normalizeAnswerMode(mode);

  if (currentMode === nextMode && !force) {
    updateModeUi();
    return;
  }

  currentMode = nextMode;
  updateModeUi();

  if (currentMode === 'handwriting') {
    resizeHandwritingCanvas();
  }

  if (focus && currentMode === 'text' && !answerInput.disabled) {
    answerInput.focus();
  }
}

function hydrateFromServerDraft(room, me) {
  answerInput.value = me?.draftText || '';
  setAnswerMode(room.answerMode || me?.answerMode || 'text', { focus: false, force: true });
  loadHandwritingFromDataUrl(me?.drawingDataUrl || '');
  isDirty = false;
}

function getCurrentAnswerPayload() {
  if (currentMode === 'handwriting') {
    return {
      mode: 'handwriting',
      text: '',
      drawingDataUrl: exportHandwritingDataUrl(),
    };
  }

  return {
    mode: 'text',
    text: normalizeAnswer(answerInput.value),
    drawingDataUrl: '',
  };
}

function applyRoom(room) {
  currentRoom = room;

  const myName = room.me?.name || playerName || '';
  playerNameDisplay.textContent = myName;

  const phase = getRoomPhase(room);
  const hasModeSelection = room.answerMode === 'text' || room.answerMode === 'handwriting';
  const isInputLockedByHost = phase !== 'open';
  const isSelfLocked = !!room.me?.locked;
  const isLocked = !hasModeSelection || isInputLockedByHost || isSelfLocked;
  const modeChanged = normalizeAnswerMode(room.answerMode) !== currentMode;
  const result = room.me?.result || 'pending';
  const shouldShowCorrect = result === 'correct' && phase === 'revealResults';
  const isReceptionClosed = hasModeSelection && phase !== 'setup' && phase !== 'open' && !shouldShowCorrect;

  handwritingSurfaceTone = shouldShowCorrect ? 'correct' : 'default';
  playerCompose.classList.toggle('result-correct', shouldShowCorrect);
  playerCompose.classList.toggle('is-reception-closed', isReceptionClosed);

  if (isSelfLocked || (wasSelfLocked && !isSelfLocked) || !isDirty) {
    hydrateFromServerDraft(room, room.me);
  } else {
    if (modeChanged) {
      setAnswerMode(room.answerMode || 'text', { focus: false, force: true });
    }
  }

  answerInput.disabled = isLocked;
  clearAnswerBtn.disabled = isLocked;
  submitAnswerBtn.disabled = isLocked;
  playerWaitPanel.classList.toggle('hidden', hasModeSelection);
  if (!hasModeSelection) {
    textInputPanel.classList.add('hidden');
    handwritingInputPanel.classList.add('hidden');
    playerWaitText.textContent = '親機の準備が終わるまでお待ちください。';
    charCounter.textContent = '準備中';
  } else if (phase !== 'open' && !isSelfLocked) {
    playerWaitPanel.classList.add('hidden');
  } else {
    playerWaitPanel.classList.add('hidden');
  }
  playerCompose.classList.toggle('is-locked', isLocked);
  wasSelfLocked = isSelfLocked;
  syncCounter();
}

function joinRoom() {
  socket.emit('player:join', { roomCode: presetRoomCode, name: playerName, playerToken }, (response) => {
    if (!response.ok) {
      const fallbackUrl = new URL('/player-entry.html', window.location.origin);
      fallbackUrl.searchParams.set('room', presetRoomCode);
      clearStoredEntry();
      window.location.replace(fallbackUrl.toString());
      return;
    }

    writeStoredEntry({
      roomCode: presetRoomCode,
      name: response.room?.me?.name || playerName,
      playerToken,
    });
    applyRoom(response.room);
  });
}

function lockCurrentAnswer() {
  if (!currentRoom || wasSelfLocked) return;

  const payload = getCurrentAnswerPayload();
  answerInput.value = payload.text;
  syncCounter();

  socket.emit('player:lockDraft', { roomCode: currentRoom.code, ...payload }, (response) => {
    if (response.ok) {
      isDirty = false;
      applyRoom(response.room);
    }
  });
}

answerInput.addEventListener('input', () => {
  isDirty = true;
  syncCounter();
});

clearAnswerBtn.addEventListener('click', () => {
  if (currentMode === 'handwriting') {
    clearHandwritingCanvas(true);
    return;
  }

  answerInput.value = '';
  isDirty = true;
  syncCounter();
  answerInput.focus();
});

submitAnswerBtn.addEventListener('click', () => {
  if (!currentRoom || getRoomPhase(currentRoom) !== 'open') return;

  const payload = getCurrentAnswerPayload();

  if (payload.mode === 'text' && !payload.text) {
    alert('回答を入力してください。');
    return;
  }

  if (payload.mode === 'handwriting' && !payload.drawingDataUrl) {
    alert('手書き回答を書いてください。');
    return;
  }

  if (confirm('この回答を送信しますか？\n送信後は修正できません。')) {
    answerInput.value = payload.text;
    syncCounter();

    socket.emit('player:submitAnswer', { roomCode: currentRoom.code, ...payload }, (response) => {
      if (response.ok) {
        isDirty = false;
        applyRoom(response.room);
      } else {
        alert(response.error || '送信に失敗しました。');
      }
    });
  }
});

handwritingCanvas.addEventListener('pointerdown', (event) => {
  if (playerCompose.classList.contains('is-locked') || currentMode !== 'handwriting') return;

  event.preventDefault();
  resizeHandwritingCanvas();
  const point = getCanvasPoint(event);
  activePointerId = event.pointerId;
  isDrawing = true;
  handwritingCanvas.setPointerCapture(event.pointerId);
  handwritingContext.beginPath();
  handwritingContext.moveTo(point.x, point.y);
  handwritingContext.lineTo(point.x, point.y);
  handwritingContext.stroke();
  hasHandwritingInk = true;
  isDirty = true;
  syncCounter();
});

handwritingCanvas.addEventListener('pointermove', (event) => {
  if (!isDrawing || event.pointerId !== activePointerId) return;

  const point = getCanvasPoint(event);
  handwritingContext.lineTo(point.x, point.y);
  handwritingContext.stroke();
});

function stopDrawing(event) {
  if (event.pointerId !== activePointerId) return;

  isDrawing = false;
  activePointerId = null;
  handwritingContext.closePath();
}

handwritingCanvas.addEventListener('pointerup', stopDrawing);
handwritingCanvas.addEventListener('pointercancel', stopDrawing);

socket.on('player:room', (room) => {
  applyRoom(room);
});

socket.on('player:forceLock', ({ roomCode }) => {
  if (!currentRoom || currentRoom.code !== roomCode) return;
  lockCurrentAnswer();
});

socket.on('room:closed', () => {
  answerInput.disabled = true;
  clearAnswerBtn.disabled = true;
  submitAnswerBtn.disabled = true;
  playerCompose.classList.add('is-locked');
});

socket.on('connect', () => {
  joinRoom();
});

window.addEventListener('resize', () => {
  resizeHandwritingCanvas();
});

resizeHandwritingCanvas();
updateModeUi();
