import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../server/app.js';
import { createAuth } from '../server/auth.js';
import { createMockDriver } from '../server/drivers/mock.js';
import { createWdaDriver } from '../server/drivers/wda.js';
import { MJPEG_BOUNDARY, startFakeWda } from './fake-wda.js';

const PASSWORD = 'correct-horse-battery';
const ORIGIN_SECRET = 'shared-origin-secret-123';

async function startApp(driver, authOptions = {}) {
  const auth = createAuth({ password: PASSWORD, ...authOptions });
  const server = createApp({ driver, auth }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function login(base) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie');
}

function client(base, cookie) {
  const headers = { Cookie: cookie.split(';')[0] };
  return {
    get: (path) => fetch(base + path, { headers, redirect: 'manual' }),
    post: (path, body = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

describe('API with mock driver', () => {
  let app;
  let driver;
  let api;
  let setCookie;

  before(async () => {
    driver = createMockDriver();
    app = await startApp(driver);
    setCookie = await login(app.base);
    api = client(app.base, setCookie);
  });

  after(() => app.close());

  it('issues a hardened session cookie', () => {
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Secure/i);
  });

  it('blocks unauthenticated access', async () => {
    const page = await fetch(`${app.base}/`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login');
    assert.equal((await fetch(`${app.base}/api/status`)).status, 401);
    assert.equal((await fetch(`${app.base}/api/screenshot`)).status, 401);
    assert.equal((await fetch(`${app.base}/stream`)).status, 401);
    const tap = await fetch(`${app.base}/api/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 0.5, y: 0.5 }),
    });
    assert.equal(tap.status, 401);
    assert.equal(driver.getEvents().length, 0);
  });

  it('serves the login page and assets without authentication, with security headers', async () => {
    const page = await fetch(`${app.base}/login`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`${app.base}/assets/style.css`)).status, 200);
  });

  it('rejects wrong passwords and non-JSON logins', async () => {
    const wrong = await fetch(`${app.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);
    const form = await fetch(`${app.base}/login`, { method: 'POST', body: `password=${PASSWORD}` });
    assert.equal(form.status, 415);
  });

  it('reports status and serves the main page after login', async () => {
    const status = await (await api.get('/api/status')).json();
    assert.deepEqual(status, {
      driver: 'mock',
      streamMode: 'poll',
      connected: true,
      size: { width: 390, height: 844 },
    });
    assert.equal((await api.get('/')).status, 200);
    assert.equal((await api.get('/login')).status, 302);
  });

  it('converts normalized coordinates to device points and clamps the edges', async () => {
    assert.equal((await api.post('/api/tap', { x: 0.5, y: 0.5 })).status, 200);
    assert.equal((await api.post('/api/tap', { x: 1, y: 1 })).status, 200);
    const taps = driver.getEvents().filter((e) => e.type === 'tap');
    assert.deepEqual(taps.slice(-2).map(({ x, y }) => [x, y]), [
      [195, 422],
      [389, 843],
    ]);
  });

  it('forwards swipes and long presses', async () => {
    await api.post('/api/swipe', { x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, durationMs: 300 });
    await api.post('/api/longpress', { x: 0.1, y: 0.1, durationMs: 800 });
    const [swipe, longPress] = driver.getEvents().slice(-2);
    assert.deepEqual(
      { ...swipe, at: undefined },
      { type: 'swipe', x1: 195, y1: 675, x2: 195, y2: 169, durationMs: 300, at: undefined },
    );
    assert.deepEqual({ ...longPress, at: undefined }, { type: 'longpress', x: 39, y: 84, durationMs: 800, at: undefined });
  });

  it('validates input', async () => {
    for (const body of [{}, { x: 2, y: 0.5 }, { x: '0.5', y: 0.5 }, { x: -0.1, y: 0 }]) {
      assert.equal((await api.post('/api/tap', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await api.post('/api/longpress', { x: 0, y: 0, durationMs: 60_000 })).status, 400);
    assert.equal((await api.post('/api/button', { name: 'power' })).status, 400);
    assert.equal((await api.post('/api/type', { text: '' })).status, 400);
    assert.equal((await api.post('/api/type', { text: 'a'.repeat(501) })).status, 400);

    const notJson = await fetch(`${app.base}/api/home`, {
      method: 'POST',
      headers: { Cookie: setCookie.split(';')[0], 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(notJson.status, 415);
    assert.equal((await api.post('/api/nope')).status, 404);
  });

  it('runs hardware actions and escapes typed text in the mock screen', async () => {
    for (const path of ['/api/home', '/api/lock', '/api/unlock']) {
      assert.equal((await api.post(path)).status, 200);
    }
    assert.equal((await api.post('/api/button', { name: 'volumeUp' })).status, 200);
    assert.equal((await api.post('/api/type', { text: '<script>x</script>' })).status, 200);

    const shot = await api.get('/api/screenshot');
    assert.match(shot.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(shot.headers.get('cache-control'), 'no-store');
    const svg = await shot.text();
    assert.match(svg, /&lt;script&gt;x&lt;\/script&gt;/);
    assert.doesNotMatch(svg, /<script/);
    assert.match(svg, /音量: 60/);
  });

  it('has no MJPEG stream in mock mode', async () => {
    assert.equal((await api.get('/stream')).status, 404);
  });
});

describe('API with WDA driver', () => {
  let wda;
  let app;
  let api;

  before(async () => {
    wda = await startFakeWda();
    app = await startApp(createWdaDriver({ baseUrl: wda.url, mjpegUrl: wda.mjpegUrl }));
    api = client(app.base, await login(app.base));
  });

  after(async () => {
    await app.close();
    await wda.close();
  });

  it('proxies the MJPEG stream', async () => {
    const res = await api.get('/stream');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`);
    assert.match(await res.text(), /JPEG/);
  });

  it('reports mjpeg mode and maps taps to WDA actions', async () => {
    const status = await (await api.get('/api/status')).json();
    assert.equal(status.streamMode, 'mjpeg');
    assert.equal(status.connected, true);

    assert.equal((await api.post('/api/tap', { x: 0.25, y: 0.5 })).status, 200);
    const actions = wda.requests.filter((r) => r.path.endsWith('/actions')).at(-1);
    assert.deepEqual(actions.body.actions[0].actions[0], { type: 'pointerMove', duration: 0, x: 98, y: 422 });
  });

  it('returns 502 with the WDA message when the device fails', async () => {
    const res = await api.post('/api/type', { text: 'FAIL' });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Keyboard is not present/);
  });

  it('reports a disconnected device without failing the status endpoint', async () => {
    await wda.close();
    const status = await (await api.get('/api/status')).json();
    assert.equal(status.connected, false);
    assert.match(status.error, /接続できません/);
    assert.equal((await api.post('/api/home')).status, 502);
    assert.equal((await api.get('/stream')).status, 502);
  });
});

describe('API behind the Cloudflare Worker (origin shared secret)', () => {
  let app;
  let driver;

  before(async () => {
    driver = createMockDriver();
    app = await startApp(driver, { originSecret: ORIGIN_SECRET });
  });

  after(() => app.close());

  const tap = (headers) =>
    fetch(`${app.base}/api/tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ x: 0.5, y: 0.5 }),
    });

  it('accepts API calls carrying the shared secret without a session cookie', async () => {
    assert.equal((await tap({ 'X-Mirror-Origin-Secret': ORIGIN_SECRET })).status, 200);
    assert.equal(driver.getEvents().length, 1);
  });

  it('rejects a missing or wrong secret', async () => {
    assert.equal((await tap({})).status, 401);
    assert.equal((await tap({ 'X-Mirror-Origin-Secret': 'wrong-secret-wrong-secret' })).status, 401);
    assert.equal(driver.getEvents().length, 1);
  });

  it('does not let the secret open non-API pages', async () => {
    const res = await fetch(`${app.base}/`, { headers: { 'X-Mirror-Origin-Secret': ORIGIN_SECRET }, redirect: 'manual' });
    assert.equal(res.status, 302);
  });

  it('refuses short shared secrets', () => {
    assert.throws(() => createAuth({ password: PASSWORD, originSecret: 'short' }), /16 文字以上/);
  });
});
