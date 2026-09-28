export const COOKIE_NAME = 'mirror_session';
export const SESSION_TTL_SEC = 12 * 60 * 60;

const encoder = new TextEncoder();

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sha256 = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

export async function createWorkerAuth({ password, secret, now = Date.now }) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const passwordDigest = await sha256(password);
  const sign = async (payload) => toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));

  async function issueToken() {
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    const payload = `${now() + SESSION_TTL_SEC * 1000}.${nonce}`;
    return `${payload}.${await sign(payload)}`;
  }

  async function verifyToken(token) {
    if (typeof token !== 'string') return false;
    const lastDot = token.lastIndexOf('.');
    if (lastDot === -1) return false;
    const payload = token.slice(0, lastDot);
    const expected = encoder.encode(await sign(payload));
    if (!constantTimeEqual(encoder.encode(token.slice(lastDot + 1)), expected)) return false;
    const expiresAt = Number(payload.split('.')[0]);
    return Number.isFinite(expiresAt) && expiresAt > now();
  }

  const checkPassword = async (input) => constantTimeEqual(await sha256(String(input ?? '')), passwordDigest);

  const isAuthenticated = (request) => verifyToken(parseCookies(request.headers.get('Cookie'))[COOKIE_NAME]);

  return { issueToken, verifyToken, checkPassword, isAuthenticated };
}
