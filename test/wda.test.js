import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createWdaDriver } from '../server/drivers/wda.js';
import { DeviceError } from '../server/errors.js';
import { startFakeWda } from './fake-wda.js';

describe('WDA driver', () => {
  let wda;
  let driver;

  beforeEach(async () => {
    wda = await startFakeWda({ screenshot: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    driver = createWdaDriver({ baseUrl: wda.url, mjpegUrl: wda.mjpegUrl });
  });

  afterEach(() => wda.close());

  const paths = () => wda.requests.map((r) => `${r.method} ${r.path}`);

  it('creates a session, applies MJPEG settings, then taps via W3C actions', async () => {
    await driver.tap(100, 200);
    assert.deepEqual(paths(), [
      'POST /session',
      'POST /session/session-1/appium/settings',
      'POST /session/session-1/actions',
    ]);
    assert.deepEqual(wda.requests[0].body, { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
    assert.deepEqual(Object.keys(wda.requests[1].body.settings).sort(), [
      'mjpegScalingFactor',
      'mjpegServerFramerate',
      'mjpegServerScreenshotQuality',
    ]);
    const [pointer] = wda.requests[2].body.actions;
    assert.equal(pointer.type, 'pointer');
    assert.equal(pointer.parameters.pointerType, 'touch');
    assert.deepEqual(pointer.actions.map((a) => a.type), ['pointerMove', 'pointerDown', 'pause', 'pointerUp']);
    assert.deepEqual(pointer.actions[0], { type: 'pointerMove', duration: 0, x: 100, y: 200 });
  });

  it('reuses the session and shares a single creation between concurrent calls', async () => {
    await Promise.all([driver.tap(1, 1), driver.tap(2, 2)]);
    await driver.typeText('a');
    assert.equal(paths().filter((p) => p === 'POST /session').length, 1);
  });

  it('builds swipe and long-press gestures with the requested duration', async () => {
    await driver.swipe(10, 20, 30, 40, 400);
    await driver.longPress(50, 60, 800);
    const [swipe, longPress] = wda.requests
      .filter((r) => r.path.endsWith('/actions'))
      .map((r) => r.body.actions[0].actions);
    assert.deepEqual(swipe, [
      { type: 'pointerMove', duration: 0, x: 10, y: 20 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 400, x: 30, y: 40 },
      { type: 'pointerUp', button: 0 },
    ]);
    assert.deepEqual(longPress[2], { type: 'pause', duration: 800 });
  });

  it('recreates the session once when WDA reports it as invalid', async () => {
    await driver.tap(1, 1);
    wda.invalidateSessions();
    await driver.tap(2, 2);
    assert.deepEqual(paths().slice(3), [
      'POST /session/session-1/actions',
      'POST /session',
      'POST /session/session-2/appium/settings',
      'POST /session/session-2/actions',
    ]);
  });

  it('uses session-less endpoints for home, lock and unlock', async () => {
    await driver.home();
    await driver.lock();
    await driver.unlock();
    assert.deepEqual(paths(), ['POST /wda/homescreen', 'POST /wda/lock', 'POST /wda/unlock']);
  });

  it('sends hardware buttons in lowercase and text as individual characters', async () => {
    await driver.pressButton('volumeUp');
    await driver.typeText('aあ😀');
    const button = wda.requests.find((r) => r.path.endsWith('/wda/pressButton'));
    const keys = wda.requests.find((r) => r.path.endsWith('/wda/keys'));
    assert.deepEqual(button.body, { name: 'volumeup' });
    assert.deepEqual(keys.body, { value: ['a', 'あ', '😀'] });
  });

  it('decodes screenshots and caches the window size', async () => {
    const shot = await driver.screenshot();
    assert.equal(shot.contentType, 'image/png');
    assert.deepEqual([...shot.data], [0x89, 0x50, 0x4e, 0x47]);

    assert.deepEqual(await driver.windowSize(), { width: 390, height: 844 });
    await driver.windowSize();
    assert.equal(paths().filter((p) => p.endsWith('/window/size')).length, 1);
    assert.equal(driver.mjpegUrl(), wda.mjpegUrl);
  });

  it('surfaces WDA error messages as DeviceError', async () => {
    await assert.rejects(driver.typeText('FAIL'), (err) => {
      assert.ok(err instanceof DeviceError);
      assert.match(err.message, /Keyboard is not present/);
      assert.equal(err.status, 500);
      return true;
    });
  });

  it('reports an unreachable WDA as DeviceError', async () => {
    await wda.close();
    await assert.rejects(driver.status(), (err) => {
      assert.ok(err instanceof DeviceError);
      assert.match(err.message, /接続できません/);
      return true;
    });
  });

  it('treats an empty MJPEG URL as disabled', () => {
    assert.equal(createWdaDriver({ baseUrl: wda.url, mjpegUrl: '' }).mjpegUrl(), null);
  });
});
