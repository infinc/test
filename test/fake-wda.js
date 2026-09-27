import http from 'node:http';

export const MJPEG_BOUNDARY = '--BoundaryString';

// Minimal stand-in for WebDriverAgent that records every request it receives.
export async function startFakeWda({ size = { width: 390, height: 844 }, screenshot = Buffer.from('fake-png') } = {}) {
  const requests = [];
  const validSessions = new Set();
  let sessionCounter = 0;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, body });

    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value }));
    };

    if (req.method === 'GET' && req.url === '/mjpeg') {
      res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}` });
      res.end(`${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\nJPEG\r\n`);
      return;
    }
    if (req.method === 'GET' && req.url === '/status') return send(200, { ready: true });
    if (req.method === 'GET' && req.url === '/screenshot') return send(200, screenshot.toString('base64'));
    if (req.method === 'POST' && req.url === '/session') {
      const sessionId = `session-${++sessionCounter}`;
      validSessions.add(sessionId);
      return send(200, { sessionId, capabilities: {} });
    }
    if (req.method === 'POST' && ['/wda/homescreen', '/wda/lock', '/wda/unlock'].includes(req.url)) {
      return send(200, null);
    }
    const match = req.url.match(/^\/session\/([^/]+)(\/.*)$/);
    if (match) {
      const [, sessionId, rest] = match;
      if (!validSessions.has(sessionId)) {
        return send(404, { error: 'invalid session id', message: 'Session does not exist' });
      }
      if (req.method === 'GET' && rest === '/window/size') return send(200, size);
      if (req.method === 'POST' && rest === '/wda/keys' && body.value.join('') === 'FAIL') {
        return send(500, { error: 'invalid element state', message: 'Keyboard is not present' });
      }
      if (req.method === 'POST') return send(200, null);
    }
    return send(404, { error: 'unknown command', message: `Unhandled ${req.method} ${req.url}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    mjpegUrl: `${url}/mjpeg`,
    requests,
    invalidateSessions: () => validSessions.clear(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
