import { COOKIE_NAME, SESSION_TTL_SEC, createWorkerAuth } from './auth.js';

const ORIGIN_SECRET_HEADER = 'X-Mirror-Origin-Secret';
const MIN_PASSWORD_LENGTH = 12;
const MIN_ORIGIN_SECRET_LENGTH = 16;
const MAX_BODY_BYTES = 10 * 1024;
const PASSTHROUGH_RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after'];

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' blob:",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const redirect = (location) => new Response(null, { status: 302, headers: { Location: location } });

const isJson = (request) => (request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json');

const sessionCookie = (value, maxAge) =>
  `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

let cachedAuth = null;

async function getAuth(env) {
  if (cachedAuth?.password !== env.ACCESS_PASSWORD || cachedAuth?.secret !== env.SESSION_SECRET) {
    cachedAuth = {
      password: env.ACCESS_PASSWORD,
      secret: env.SESSION_SECRET,
      auth: await createWorkerAuth({ password: env.ACCESS_PASSWORD, secret: env.SESSION_SECRET }),
    };
  }
  return cachedAuth.auth;
}

function configProblem(env) {
  if (typeof env.ACCESS_PASSWORD !== 'string' || env.ACCESS_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    return `ACCESS_PASSWORD を ${MIN_PASSWORD_LENGTH} 文字以上で設定してください`;
  }
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) {
    return 'SESSION_SECRET を 32 文字以上で設定してください';
  }
  if (typeof env.ORIGIN_SECRET !== 'string' || env.ORIGIN_SECRET.length < MIN_ORIGIN_SECRET_LENGTH) {
    return `ORIGIN_SECRET を ${MIN_ORIGIN_SECRET_LENGTH} 文字以上で設定してください`;
  }
  if (!URL.canParse(env.ORIGIN_URL ?? '')) return 'ORIGIN_URL に Mac サーバー(Cloudflare Tunnel)の URL を設定してください';
  return null;
}

const serveAsset = (request, env, path) => env.ASSETS.fetch(new Request(new URL(path, request.url), request));

async function login(request, env, auth) {
  if (!isJson(request)) return json(415, { error: 'Content-Type: application/json で送信してください' });
  if (env.LOGIN_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.LOGIN_LIMITER.limit({ key: ip });
    if (!success) return json(429, { error: 'ログイン試行が多すぎます。1 分ほど待ってから再試行してください' });
  }
  const body = await request.json().catch(() => null);
  if (!(await auth.checkPassword(body?.password))) {
    console.warn('[auth] ログイン失敗');
    return json(401, { error: 'パスワードが違います' });
  }
  return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(await auth.issueToken(), SESSION_TTL_SEC) });
}

async function proxyToOrigin(request, env, url) {
  const headers = new Headers({ [ORIGIN_SECRET_HEADER]: env.ORIGIN_SECRET });
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method === 'POST') {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return json(413, { error: 'リクエストが大きすぎます' });
    init.body = body;
  }

  let response;
  try {
    response = await fetch(new URL(url.pathname + url.search, env.ORIGIN_URL), init);
  } catch {
    return json(502, { error: 'Mac のサーバーに接続できません(Mac のサーバーと Cloudflare Tunnel が起動しているか確認してください)' });
  }
  if (response.status === 401) {
    return json(502, { error: 'Mac のサーバーが Worker を拒否しました(ORIGIN_SECRET と ORIGIN_SHARED_SECRET が一致しているか確認してください)' });
  }
  const outHeaders = new Headers();
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) outHeaders.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: outHeaders });
}

async function handle(request, env) {
  const problem = configProblem(env);
  if (problem) return json(500, { error: `Worker の設定エラー: ${problem}` });

  const url = new URL(request.url);
  const { pathname: path } = url;
  const method = request.method;
  const auth = await getAuth(env);

  if (path === '/login') {
    if (method === 'POST') return login(request, env, auth);
    if (method === 'GET') return (await auth.isAuthenticated(request)) ? redirect('/') : serveAsset(request, env, '/login');
  }
  if (path.startsWith('/assets/') && method === 'GET') return env.ASSETS.fetch(request);

  const isApi = path.startsWith('/api/') || path === '/stream';
  if (!(await auth.isAuthenticated(request))) {
    return isApi ? json(401, { error: 'ログインが必要です' }) : redirect('/login');
  }

  if (path === '/logout' && method === 'POST') {
    if (!isJson(request)) return json(415, { error: 'Content-Type: application/json で送信してください' });
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (path === '/' && method === 'GET') return serveAsset(request, env, '/');
  if (isApi && (method === 'GET' || method === 'POST')) {
    if (method === 'POST' && !isJson(request)) {
      return json(415, { error: 'Content-Type: application/json で送信してください' });
    }
    return proxyToOrigin(request, env, url);
  }
  return json(404, { error: 'Not Found' });
}

export default {
  async fetch(request, env) {
    const response = await handle(request, env);
    const secured = new Response(response.body, response);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) secured.headers.set(name, value);
    return secured;
  },
};
