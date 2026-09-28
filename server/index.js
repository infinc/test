import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { createMockDriver } from './drivers/mock.js';
import { createWdaDriver } from './drivers/wda.js';

try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const {
  PORT = '3000',
  HOST = '127.0.0.1',
  DRIVER = 'wda',
  WDA_URL = 'http://127.0.0.1:8100',
  WDA_MJPEG_URL = 'http://127.0.0.1:9100',
  COOKIE_SECURE = 'true',
  ACCESS_PASSWORD,
  ORIGIN_SHARED_SECRET,
} = process.env;

let auth;
try {
  auth = createAuth({
    password: ACCESS_PASSWORD,
    secureCookie: COOKIE_SECURE !== 'false',
    originSecret: ORIGIN_SHARED_SECRET || undefined,
  });
} catch (err) {
  console.error(`起動できません: ${err.message}(.env.example を参照)`);
  process.exit(1);
}

let driver;
if (DRIVER === 'mock') {
  driver = createMockDriver();
} else if (DRIVER === 'wda') {
  driver = createWdaDriver({ baseUrl: WDA_URL, mjpegUrl: WDA_MJPEG_URL });
} else {
  console.error(`起動できません: DRIVER は wda か mock を指定してください (現在: ${DRIVER})`);
  process.exit(1);
}

createApp({ driver, auth }).listen(Number(PORT), HOST, () => {
  console.log(`iPhone Mirror: http://${HOST}:${PORT} (driver=${driver.name})`);
  if (driver.name === 'wda') {
    console.log(`  WebDriverAgent: ${WDA_URL} / MJPEG: ${WDA_MJPEG_URL || '無効 (ポーリング表示)'}`);
  }
  if (ORIGIN_SHARED_SECRET) console.log('  Cloudflare Worker からの中継を受け付けます (ORIGIN_SHARED_SECRET 設定済み)');
});
