import { DeviceError } from '../errors.js';

const DEFAULT_MJPEG_SETTINGS = {
  mjpegServerFramerate: 10,
  mjpegServerScreenshotQuality: 50,
  mjpegScalingFactor: 50,
};

const TAP_HOLD_MS = 50;

const pointerActions = (steps) => ({
  actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: steps }],
});

const moveTo = (x, y, duration = 0) => ({ type: 'pointerMove', duration, x, y });
const down = { type: 'pointerDown', button: 0 };
const up = { type: 'pointerUp', button: 0 };
const pause = (duration) => ({ type: 'pause', duration });

function isInvalidSession(err) {
  return (
    err instanceof DeviceError &&
    (err.code === 'invalid session id' || /session does not exist/i.test(err.message))
  );
}

export function createWdaDriver({
  baseUrl = 'http://127.0.0.1:8100',
  mjpegUrl = 'http://127.0.0.1:9100',
  timeoutMs = 15000,
  sizeCacheMs = 3000,
  mjpegSettings = DEFAULT_MJPEG_SETTINGS,
} = {}) {
  let sessionId = null;
  let pendingSession = null;
  let sizeCache = null;

  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new DeviceError(`WebDriverAgent (${baseUrl}) に接続できません`, { cause });
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON bodies are handled by the status check below.
    }
    const value = json?.value;
    const errorCode = value && typeof value === 'object' ? value.error : undefined;
    if (!res.ok || errorCode) {
      const detail = (value && typeof value === 'object' && (value.message || value.error)) || `HTTP ${res.status}`;
      throw new DeviceError(`WebDriverAgent エラー: ${detail}`, { status: res.status, code: errorCode });
    }
    return value;
  }

  async function createSession() {
    const value = await request('POST', '/session', {
      capabilities: { alwaysMatch: {}, firstMatch: [{}] },
    });
    const id = value?.sessionId;
    if (!id) throw new DeviceError('WebDriverAgent がセッション ID を返しませんでした');
    try {
      await request('POST', `/session/${id}/appium/settings`, { settings: mjpegSettings });
    } catch (err) {
      console.warn(`[wda] MJPEG 設定の適用に失敗しました: ${err.message}`);
    }
    return id;
  }

  async function ensureSession() {
    if (sessionId) return sessionId;
    pendingSession ??= createSession().finally(() => {
      pendingSession = null;
    });
    sessionId = await pendingSession;
    return sessionId;
  }

  async function withSession(fn) {
    const id = await ensureSession();
    try {
      return await fn(id);
    } catch (err) {
      if (!isInvalidSession(err)) throw err;
      if (sessionId === id) sessionId = null;
      sizeCache = null;
      return fn(await ensureSession());
    }
  }

  const performActions = (steps) =>
    withSession((id) => request('POST', `/session/${id}/actions`, pointerActions(steps)));

  return {
    name: 'wda',

    async status() {
      return request('GET', '/status');
    },

    async windowSize() {
      if (sizeCache && Date.now() - sizeCache.at < sizeCacheMs) return sizeCache.size;
      const value = await withSession((id) => request('GET', `/session/${id}/window/size`));
      const size = { width: value.width, height: value.height };
      sizeCache = { size, at: Date.now() };
      return size;
    },

    tap(x, y) {
      return performActions([moveTo(x, y), down, pause(TAP_HOLD_MS), up]);
    },

    longPress(x, y, durationMs) {
      return performActions([moveTo(x, y), down, pause(durationMs), up]);
    },

    swipe(x1, y1, x2, y2, durationMs) {
      return performActions([moveTo(x1, y1), down, moveTo(x2, y2, durationMs), up]);
    },

    home() {
      return request('POST', '/wda/homescreen');
    },

    lock() {
      return request('POST', '/wda/lock');
    },

    unlock() {
      return request('POST', '/wda/unlock');
    },

    pressButton(name) {
      return withSession((id) => request('POST', `/session/${id}/wda/pressButton`, { name: name.toLowerCase() }));
    },

    typeText(text) {
      return withSession((id) => request('POST', `/session/${id}/wda/keys`, { value: [...text] }));
    },

    async screenshot() {
      const base64 = await request('GET', '/screenshot');
      return { data: Buffer.from(base64, 'base64'), contentType: 'image/png' };
    },

    mjpegUrl() {
      return mjpegUrl || null;
    },
  };
}
