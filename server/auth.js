import crypto from 'node:crypto';

export const COOKIE_NAME = 'mirror_session';
export const MIN_PASSWORD_LENGTH = 12;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

export function createAuth({
  password,
  secureCookie = true,
  secret = crypto.randomBytes(32),
  now = Date.now,
} = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ACCESS_PASSWORD を ${MIN_PASSWORD_LENGTH} 文字以上で設定してください`);
  }
  const passwordDigest = sha256(password);
  let failures = [];

  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  function issueToken() {
    const payload = `${now() + SESSION_TTL_MS}.${crypto.randomBytes(16).toString('base64url')}`;
    return `${payload}.${sign(payload)}`;
  }

  function verifyToken(token) {
    if (typeof token !== 'string') return false;
    const lastDot = token.lastIndexOf('.');
    if (lastDot === -1) return false;
    const payload = token.slice(0, lastDot);
    const given = Buffer.from(token.slice(lastDot + 1));
    const expected = Buffer.from(sign(payload));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    const expiresAt = Number(payload.split('.')[0]);
    return Number.isFinite(expiresAt) && expiresAt > now();
  }

  function attemptLogin(input) {
    const current = now();
    failures = failures.filter((t) => current - t < FAILURE_WINDOW_MS);
    if (failures.length >= MAX_FAILURES) {
      const retryAfterSec = Math.ceil((failures[0] + FAILURE_WINDOW_MS - current) / 1000);
      return { ok: false, locked: true, retryAfterSec };
    }
    const ok = crypto.timingSafeEqual(sha256(String(input ?? '')), passwordDigest);
    if (ok) {
      failures = [];
      return { ok: true, token: issueToken() };
    }
    failures.push(current);
    return { ok: false, locked: false };
  }

  const isAuthenticated = (req) => verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);

  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: secureCookie, path: '/' };

  function login(req, res) {
    const result = attemptLogin(req.body?.password);
    if (result.ok) {
      res.cookie(COOKIE_NAME, result.token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
      return res.json({ ok: true });
    }
    if (result.locked) {
      res.set('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({
        error: `ログイン失敗が続いたためロック中です。約 ${Math.ceil(result.retryAfterSec / 60)} 分後に再試行してください`,
      });
    }
    console.warn(`[auth] ログイン失敗 (${new Date(now()).toISOString()})`);
    return res.status(401).json({ error: 'パスワードが違います' });
  }

  function logout(req, res) {
    res.clearCookie(COOKIE_NAME, cookieOptions);
    res.json({ ok: true });
  }

  function requireAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    if (req.path.startsWith('/api/') || req.path === '/stream') {
      return res.status(401).json({ error: 'ログインが必要です' });
    }
    return res.redirect('/login');
  }

  return { issueToken, verifyToken, attemptLogin, isAuthenticated, login, logout, requireAuth };
}
