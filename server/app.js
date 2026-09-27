import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { DeviceError, HttpError } from './errors.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BUTTONS = new Set(['volumeUp', 'volumeDown']);
const MAX_TEXT_LENGTH = 500;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' blob:",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
}

function requireJson(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type: application/json で送信してください' });
  }
  next();
}

function numberIn(body, key, min, max) {
  const value = body?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, `${key} は ${min}〜${max} の数値で指定してください`);
  }
  return value;
}

export function createApp({ driver, auth }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '10kb' }));

  app.get('/login', (req, res) => {
    if (auth.isAuthenticated(req)) return res.redirect('/');
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });
  app.post('/login', requireJson, auth.login);
  app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));

  app.use(auth.requireAuth);

  app.post('/logout', requireJson, auth.logout);
  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  async function toPoint(nx, ny) {
    const { width, height } = await driver.windowSize();
    return [
      Math.max(0, Math.min(Math.round(nx * width), width - 1)),
      Math.max(0, Math.min(Math.round(ny * height), height - 1)),
    ];
  }

  app.get('/api/status', async (req, res) => {
    const result = { driver: driver.name, streamMode: driver.mjpegUrl() ? 'mjpeg' : 'poll', connected: false };
    try {
      await driver.status();
      result.size = await driver.windowSize();
      result.connected = true;
    } catch (err) {
      result.error = err.message;
    }
    res.set('Cache-Control', 'no-store').json(result);
  });

  app.get('/api/screenshot', async (req, res) => {
    const { data, contentType } = await driver.screenshot();
    res.set('Cache-Control', 'no-store').type(contentType).send(data);
  });

  app.get('/stream', async (req, res) => {
    const url = driver.mjpegUrl();
    if (!url) return res.status(404).json({ error: 'MJPEG 配信は無効です' });
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    let upstream;
    try {
      upstream = await fetch(url, { signal: controller.signal });
    } catch {
      return res.status(502).json({ error: 'MJPEG 配信に接続できません' });
    }
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `MJPEG 配信エラー: HTTP ${upstream.status}` });
    }
    res.set({
      'Content-Type': upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace',
      'Cache-Control': 'no-store',
    });
    await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
  });

  const api = express.Router();
  api.use(requireJson);

  api.post('/tap', async (req, res) => {
    const [x, y] = await toPoint(numberIn(req.body, 'x', 0, 1), numberIn(req.body, 'y', 0, 1));
    await driver.tap(x, y);
    res.json({ ok: true });
  });

  api.post('/longpress', async (req, res) => {
    const nx = numberIn(req.body, 'x', 0, 1);
    const ny = numberIn(req.body, 'y', 0, 1);
    const durationMs = numberIn(req.body, 'durationMs', 50, 5000);
    const [x, y] = await toPoint(nx, ny);
    await driver.longPress(x, y, Math.round(durationMs));
    res.json({ ok: true });
  });

  api.post('/swipe', async (req, res) => {
    const coords = ['x1', 'y1', 'x2', 'y2'].map((key) => numberIn(req.body, key, 0, 1));
    const durationMs = numberIn(req.body, 'durationMs', 50, 5000);
    const [x1, y1] = await toPoint(coords[0], coords[1]);
    const [x2, y2] = await toPoint(coords[2], coords[3]);
    await driver.swipe(x1, y1, x2, y2, Math.round(durationMs));
    res.json({ ok: true });
  });

  for (const action of ['home', 'lock', 'unlock']) {
    api.post(`/${action}`, async (req, res) => {
      await driver[action]();
      res.json({ ok: true });
    });
  }

  api.post('/button', async (req, res) => {
    const name = req.body?.name;
    if (!BUTTONS.has(name)) throw new HttpError(400, `name は ${[...BUTTONS].join(' / ')} のいずれかです`);
    await driver.pressButton(name);
    res.json({ ok: true });
  });

  api.post('/type', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LENGTH) {
      throw new HttpError(400, `text は 1〜${MAX_TEXT_LENGTH} 文字の文字列で指定してください`);
    }
    await driver.typeText(text);
    res.json({ ok: true });
  });

  app.use('/api', api);

  app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON の形式が不正です' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'リクエストが大きすぎます' });
    if (err instanceof DeviceError) {
      console.warn(`[device] ${err.message}`);
      return res.status(502).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: 'サーバー内部エラー' });
  });

  return app;
}
