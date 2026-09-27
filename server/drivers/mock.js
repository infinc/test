const WIDTH = 390;
const HEIGHT = 844;
const MAX_EVENTS = 8;

const APPS = ['電話', 'メッセージ', 'カメラ', '写真', '設定', 'メール', 'マップ', '時計', 'メモ', '天気', 'カレンダー', 'App Store'];
const APP_COLORS = ['#34c759', '#30d158', '#8e8e93', '#ff9f0a', '#636366', '#0a84ff', '#64d2ff', '#1c1c1e', '#ffd60a', '#5ac8fa', '#ff453a', '#0a84ff'];

const escapeXml = (value) =>
  String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function createMockDriver() {
  const events = [];
  let locked = false;
  let typed = '';
  let volume = 50;
  let actionCount = 0;

  function record(event) {
    actionCount += 1;
    events.push({ ...event, at: Date.now() });
    if (events.length > MAX_EVENTS) events.shift();
  }

  function renderEvents() {
    return events
      .map((e, i) => {
        const opacity = ((i + 1) / events.length).toFixed(2);
        if (e.type === 'tap') {
          return `<circle cx="${e.x}" cy="${e.y}" r="18" fill="#ff375f" fill-opacity="${opacity}"/>`;
        }
        if (e.type === 'longpress') {
          return `<circle cx="${e.x}" cy="${e.y}" r="26" fill="none" stroke="#ff9f0a" stroke-width="6" stroke-opacity="${opacity}"/>`;
        }
        if (e.type === 'swipe') {
          return `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="#bf5af2" stroke-width="8" stroke-linecap="round" stroke-opacity="${opacity}" marker-end="url(#arrow)"/>`;
        }
        return '';
      })
      .join('');
  }

  function renderApps() {
    return APPS.map((label, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const x = 30 + col * 88;
      const y = 150 + row * 110;
      return `<rect x="${x}" y="${y}" width="62" height="62" rx="14" fill="${APP_COLORS[i]}"/>` +
        `<text x="${x + 31}" y="${y + 82}" font-size="12" fill="#fff" text-anchor="middle">${escapeXml(label)}</text>`;
    }).join('');
  }

  function renderSvg() {
    const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    const last = events.at(-1);
    const lastLabel = last ? `${last.type}${last.x !== undefined ? ` (${last.x}, ${last.y})` : ''}` : 'まだ操作はありません';
    const lockLayer = locked
      ? `<rect width="${WIDTH}" height="${HEIGHT}" fill="#000" fill-opacity="0.85"/>` +
        `<text x="${WIDTH / 2}" y="${HEIGHT / 2}" font-size="28" fill="#fff" text-anchor="middle">ロック中</text>`
      : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="-apple-system, 'Hiragino Sans', sans-serif">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#7c3aed"/></linearGradient>
<marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#bf5af2"/></marker>
</defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
<text x="24" y="40" font-size="16" fill="#fff">${escapeXml(time)}</text>
<text x="${WIDTH - 24}" y="40" font-size="14" fill="#fff" text-anchor="end">モック iPhone</text>
<text x="${WIDTH / 2}" y="100" font-size="22" fill="#fff" text-anchor="middle">操作回数: ${actionCount}</text>
${renderApps()}
<rect x="20" y="620" width="${WIDTH - 40}" height="130" rx="16" fill="#000" fill-opacity="0.35"/>
<text x="36" y="652" font-size="14" fill="#fff">最後の操作: ${escapeXml(lastLabel)}</text>
<text x="36" y="682" font-size="14" fill="#fff">入力文字: ${escapeXml(typed.slice(-24) || '(なし)')}</text>
<text x="36" y="712" font-size="14" fill="#fff">音量: ${volume}</text>
<rect x="100" y="702" width="${(WIDTH - 160) * (volume / 100)}" height="12" rx="6" fill="#30d158"/>
<rect x="${WIDTH / 2 - 67}" y="${HEIGHT - 20}" width="134" height="5" rx="2.5" fill="#fff"/>
${renderEvents()}
${lockLayer}
</svg>`;
  }

  return {
    name: 'mock',
    getEvents: () => events.map((e) => ({ ...e })),

    async status() {
      return { ready: true };
    },
    async windowSize() {
      return { width: WIDTH, height: HEIGHT };
    },
    async tap(x, y) {
      record({ type: 'tap', x, y });
    },
    async longPress(x, y, durationMs) {
      record({ type: 'longpress', x, y, durationMs });
    },
    async swipe(x1, y1, x2, y2, durationMs) {
      record({ type: 'swipe', x1, y1, x2, y2, durationMs });
    },
    async home() {
      record({ type: 'home' });
    },
    async lock() {
      locked = true;
      record({ type: 'lock' });
    },
    async unlock() {
      locked = false;
      record({ type: 'unlock' });
    },
    async pressButton(name) {
      volume = Math.max(0, Math.min(100, volume + (name === 'volumeUp' ? 10 : -10)));
      record({ type: name });
    },
    async typeText(text) {
      typed += text;
      record({ type: 'type', text });
    },
    async screenshot() {
      return { data: Buffer.from(renderSvg()), contentType: 'image/svg+xml' };
    },
    mjpegUrl() {
      return null;
    },
  };
}
