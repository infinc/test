import { classifyGesture } from './gesture.js';

const POLL_INTERVAL_MS = 1000;
const REFRESH_AFTER_ACTION_MS = 300;
const STATUS_INTERVAL_MS = 10000;

const screenEl = document.getElementById('screen');
const img = document.getElementById('screen-img');
const messageEl = document.getElementById('screen-msg');
const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');
const typeForm = document.getElementById('type-form');
const typeInput = document.getElementById('type-text');

class UnauthorizedError extends Error {}

let mode = 'poll';
let pollTimer = null;
let pollGeneration = 0;
let frameWatcher = null;
let currentBlobUrl = null;
let actionQueue = Promise.resolve();
let toastTimer = null;
let pointerStart = null;

async function api(path, body) {
  const options =
    body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, options);
  if (res.status === 401) {
    location.href = '/login';
    throw new UnauthorizedError();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.dataset.error = String(isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 4000);
}

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.hidden = !text;
}

function setStatus(state, label, detail = '') {
  statusEl.dataset.state = state;
  statusEl.textContent = label;
  statusEl.title = detail;
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    if (status.connected) {
      setStatus('ok', status.driver === 'mock' ? '接続中(モック)' : '接続中');
    } else {
      setStatus('error', 'iPhone 未接続', status.error);
    }
    return status;
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) setStatus('error', 'サーバー応答なし', err.message);
    return null;
  }
}

function markFrame() {
  screenEl.classList.toggle('has-frame', img.naturalWidth > 0);
}

function stopDisplay() {
  pollGeneration += 1;
  clearTimeout(pollTimer);
  clearInterval(frameWatcher);
  img.onerror = null;
  img.removeAttribute('src');
  screenEl.classList.remove('has-frame');
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = null;
}

function startMjpeg() {
  showMessage('画面を読み込み中…');
  img.onerror = () => {
    toast('MJPEG 配信に接続できないため、静止画の定期更新に切り替えます', true);
    mode = 'poll';
    startDisplay();
  };
  frameWatcher = setInterval(() => {
    markFrame();
    if (img.naturalWidth > 0) {
      showMessage('');
      clearInterval(frameWatcher);
    }
  }, 300);
  img.src = `/stream?t=${Date.now()}`;
}

function schedulePoll(delayMs) {
  const generation = ++pollGeneration;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => pollOnce(generation), delayMs);
}

async function pollOnce(generation) {
  try {
    const res = await fetch(`/api/screenshot?t=${Date.now()}`);
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const url = URL.createObjectURL(await res.blob());
    if (generation !== pollGeneration) {
      URL.revokeObjectURL(url);
      return;
    }
    img.src = url;
    await img.decode().catch(() => {});
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = url;
    markFrame();
    showMessage('');
  } catch (err) {
    if (generation === pollGeneration) showMessage(`画面を取得できません: ${err.message}`);
  }
  if (generation === pollGeneration) {
    pollTimer = setTimeout(() => pollOnce(generation), POLL_INTERVAL_MS);
  }
}

function startDisplay() {
  stopDisplay();
  if (document.hidden) return;
  if (mode === 'mjpeg') startMjpeg();
  else schedulePoll(0);
}

function refreshSoon() {
  if (mode === 'poll' && !document.hidden) schedulePoll(REFRESH_AFTER_ACTION_MS);
}

function send(path, body = {}) {
  const run = actionQueue.then(async () => {
    screenEl.classList.add('busy');
    try {
      await api(path, body);
      refreshSoon();
      return true;
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) toast(err.message, true);
      return false;
    } finally {
      screenEl.classList.remove('busy');
    }
  });
  actionQueue = run;
  return run;
}

function ripple(clientX, clientY, kind) {
  const rect = screenEl.getBoundingClientRect();
  const el = document.createElement('span');
  el.className = `ripple ripple-${kind}`;
  el.style.left = `${clientX - rect.left}px`;
  el.style.top = `${clientY - rect.top}px`;
  el.addEventListener('animationend', () => el.remove());
  screenEl.append(el);
}

img.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (pointerStart || img.naturalWidth === 0) return;
  event.preventDefault();
  img.setPointerCapture(event.pointerId);
  pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, t: performance.now() };
});

img.addEventListener('pointerup', (event) => {
  if (!pointerStart || event.pointerId !== pointerStart.id) return;
  const start = pointerStart;
  pointerStart = null;
  const end = { x: event.clientX, y: event.clientY };
  const { type, ...payload } = classifyGesture({
    start,
    end,
    elapsedMs: performance.now() - start.t,
    rect: img.getBoundingClientRect(),
  });
  ripple(start.x, start.y, type);
  if (type === 'swipe') ripple(end.x, end.y, 'swipe-end');
  send(`/api/${type}`, payload);
});

img.addEventListener('pointercancel', () => {
  pointerStart = null;
});
img.addEventListener('contextmenu', (event) => event.preventDefault());
img.addEventListener('dragstart', (event) => event.preventDefault());

const BUTTON_ACTIONS = {
  home: ['/api/home'],
  lock: ['/api/lock'],
  unlock: ['/api/unlock'],
  volumeUp: ['/api/button', { name: 'volumeUp' }],
  volumeDown: ['/api/button', { name: 'volumeDown' }],
};

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => send(...BUTTON_ACTIONS[button.dataset.action]));
}

typeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = typeInput.value;
  if (!text) return;
  if (await send('/api/type', { text })) typeInput.value = '';
});

document.getElementById('reload-stream').addEventListener('click', async () => {
  const status = await refreshStatus();
  if (status) mode = status.streamMode;
  startDisplay();
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('/logout', {}).catch(() => {});
  location.href = '/login';
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopDisplay();
  else startDisplay();
});

const initialStatus = await refreshStatus();
if (initialStatus) mode = initialStatus.streamMode;
startDisplay();
setInterval(refreshStatus, STATUS_INTERVAL_MS);
