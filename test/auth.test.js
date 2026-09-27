import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAuth } from '../server/auth.js';

const PASSWORD = 'correct-horse-battery';

function makeAuth() {
  const clock = { t: 1_700_000_000_000 };
  const auth = createAuth({ password: PASSWORD, now: () => clock.t });
  return { auth, clock };
}

describe('createAuth', () => {
  it('rejects missing or short passwords', () => {
    assert.throws(() => createAuth({}), /12 文字以上/);
    assert.throws(() => createAuth({ password: 'short' }), /12 文字以上/);
  });

  it('issues tokens that verify until they expire', () => {
    const { auth, clock } = makeAuth();
    const token = auth.issueToken();
    assert.equal(auth.verifyToken(token), true);
    clock.t += 12 * 60 * 60 * 1000 + 1;
    assert.equal(auth.verifyToken(token), false);
  });

  it('rejects tampered or foreign tokens', () => {
    const { auth } = makeAuth();
    const token = auth.issueToken();
    const [expiresAt, nonce, sig] = token.split('.');
    assert.equal(auth.verifyToken(`${Number(expiresAt) + 1000}.${nonce}.${sig}`), false);
    const flipped = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
    assert.equal(auth.verifyToken(`${expiresAt}.${nonce}.${flipped}`), false);
    assert.equal(auth.verifyToken('garbage'), false);
    assert.equal(auth.verifyToken(undefined), false);
    assert.equal(makeAuth().auth.verifyToken(token), false);
  });

  it('accepts the right password and rejects wrong ones', () => {
    const { auth } = makeAuth();
    assert.equal(auth.attemptLogin('wrong').ok, false);
    const result = auth.attemptLogin(PASSWORD);
    assert.equal(result.ok, true);
    assert.equal(auth.verifyToken(result.token), true);
  });

  it('locks out after 5 failures within 15 minutes, even for the right password', () => {
    const { auth, clock } = makeAuth();
    for (let i = 0; i < 5; i += 1) assert.equal(auth.attemptLogin('wrong').locked, false);
    const locked = auth.attemptLogin(PASSWORD);
    assert.equal(locked.ok, false);
    assert.equal(locked.locked, true);
    assert.ok(locked.retryAfterSec > 0);

    clock.t += 15 * 60 * 1000;
    assert.equal(auth.attemptLogin(PASSWORD).ok, true);
  });
});
