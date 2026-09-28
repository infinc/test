import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import worker from '../worker/src/index.js';
import { createWorkerAuth } from '../worker/src/auth.js';

const PASSWORD = 'correct-horse-battery';
const SESSION_SECRET = 'x'.repeat(40);
const ORIGIN_SECRET = 'shared-origin-secret-123';
const BASE = 'https://mirror.example.workers.dev';

const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const files = { '/': 'INDEX PAGE', '/login': 'LOGIN PAGE', '/assets/app.js': 'APP JS' };
    return pathname in files ? new Response(files[pathname], { status: 200 }) : new Response('nope', { status: 404 });
  },
};

describe('Cloudflare Worker', () => {
  let origin;
  let originRequests;
  let env;
  let limiterAllowed;

  before(async () => {
    originRequests = [];
    origin = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      originRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/stream') {
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--BoundaryString', 'X-Internal': 'hide' });
        return res.end('--BoundaryString\r\n');
      }
      if (req.headers['x-mirror-origin-secret'] !== ORIGIN_SECRET) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"error":"ログインが必要です"}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
    limiterAllowed = true;
    env = {
      ACCESS_PASSWORD: PASSWORD,
      SESSION_SECRET,
      ORIGIN_SECRET,
      ORIGIN_URL: `http://127.0.0.1:${origin.address().port}`,
      ASSETS,
      LOGIN_LIMITER: { limit: async () => ({ success: limiterAllowed }) },
    };
  });

  after(() => {
    origin.closeAllConnections();
    origin.close();
  });

  const call = (path, init = {}, overrideEnv = env) => worker.fetch(new Request(BASE + path, init), overrideEnv);
  const postJson = (path, body, headers = {}) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  async function loginCookie() {
    const res = await postJson('/login', { password: PASSWORD });
    assert.equal(res.status, 200);
    return res.headers.get('Set-Cookie').split(';')[0];
  }

  it('refuses to run with missing or weak configuration', async () => {
    for (const patch of [{ ACCESS_PASSWORD: 'short' }, { SESSION_SECRET: '' }, { ORIGIN_SECRET: 'x' }, { ORIGIN_URL: '' }]) {
      const res = await call('/login', {}, { ...env, ...patch });
      assert.equal(res.status, 500, JSON.stringify(patch));
    }
  });

  it('serves the login page and assets without auth, with security headers', async () => {
    const page = await call('/login');
    assert.equal(await page.text(), 'LOGIN PAGE');
    assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.equal(await (await call('/assets/app.js')).text(), 'APP JS');
  });

  it('blocks unauthenticated access without touching the origin', async () => {
    const before = originRequests.length;
    const page = await call('/');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('Location'), '/login');
    assert.equal((await call('/api/status')).status, 401);
    assert.equal((await call('/stream')).status, 401);
    assert.equal((await postJson('/api/tap', { x: 0.5, y: 0.5 })).status, 401);
    assert.equal(originRequests.length, before);
  });

  it('logs in with the right password only', async () => {
    const wrong = await postJson('/login', { password: 'nope' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('Set-Cookie'), null);
    assert.equal((await call('/login', { method: 'POST', body: `password=${PASSWORD}` })).status, 415);

    const ok = await postJson('/login', { password: PASSWORD });
    const cookie = ok.headers.get('Set-Cookie');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=43200']) assert.match(cookie, new RegExp(flag));
  });

  it('rate-limits login attempts', async () => {
    limiterAllowed = false;
    try {
      assert.equal((await postJson('/login', { password: PASSWORD })).status, 429);
    } finally {
      limiterAllowed = true;
    }
  });

  it('rejects tampered and expired session cookies', async () => {
    const cookie = await loginCookie();
    const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    assert.equal((await call('/api/status', { headers: { Cookie: tampered } })).status, 401);

    const past = await createWorkerAuth({ password: PASSWORD, secret: SESSION_SECRET, now: () => Date.now() - 13 * 3600_000 });
    const expired = `mirror_session=${await past.issueToken()}`;
    assert.equal((await call('/api/status', { headers: { Cookie: expired } })).status, 401);
  });

  it('proxies API calls with the origin secret and without the browser cookie', async () => {
    const cookie = await loginCookie();
    assert.equal(await (await call('/', { headers: { Cookie: cookie } })).text(), 'INDEX PAGE');

    const res = await postJson('/api/tap', { x: 0.25, y: 0.5 }, { Cookie: cookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const forwarded = originRequests.at(-1);
    assert.equal(forwarded.url, '/api/tap');
    assert.equal(forwarded.headers['x-mirror-origin-secret'], ORIGIN_SECRET);
    assert.equal(forwarded.headers.cookie, undefined);
    assert.deepEqual(JSON.parse(forwarded.body), { x: 0.25, y: 0.5 });

    const notJson = await call('/api/home', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(notJson.status, 415);
  });

  it('streams MJPEG and only passes through safe response headers', async () => {
    const cookie = await loginCookie();
    const res = await call('/stream', { headers: { Cookie: cookie } });
    assert.equal(res.headers.get('Content-Type'), 'multipart/x-mixed-replace; boundary=--BoundaryString');
    assert.equal(res.headers.get('X-Internal'), null);
    assert.match(await res.text(), /BoundaryString/);
  });

  it('reports a mismatched origin secret and an unreachable origin as 502', async () => {
    const cookie = await loginCookie();
    const mismatch = await call('/api/status', { headers: { Cookie: cookie } }, { ...env, ORIGIN_SECRET: 'another-secret-value-123' });
    assert.equal(mismatch.status, 502);
    assert.match((await mismatch.json()).error, /ORIGIN_SECRET/);

    const down = await call('/api/status', { headers: { Cookie: cookie } }, { ...env, ORIGIN_URL: 'http://127.0.0.1:1' });
    assert.equal(down.status, 502);
  });

  it('clears the cookie on logout', async () => {
    const cookie = await loginCookie();
    const res = await postJson('/logout', {}, { Cookie: cookie });
    assert.match(res.headers.get('Set-Cookie'), /mirror_session=; .*Max-Age=0/);
  });
});
