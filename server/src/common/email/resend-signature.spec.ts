import * as crypto from 'crypto';
import { verifyResendSignature } from './resend-signature';

// A valid Svix secret is `whsec_<base64>`; use a fixed base64 key for tests.
const KEY_B64 = Buffer.from('test-resend-signing-key').toString('base64');
const SECRET = `whsec_${KEY_B64}`;
const NOW = 1_700_000_000; // fixed "now" in unix-seconds

/** Build a valid svix-signature header for id/timestamp/payload. */
function sign(id: string, timestamp: string, payload: string, secret = SECRET) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');
  return `v1,${sig}`;
}

const ID = 'msg_123';
const BODY = '{"type":"email.bounced","data":{"to":["x@y.com"]}}';

describe('verifyResendSignature', () => {
  it('accepts a fresh, correctly-signed message', () => {
    const signature = sign(ID, String(NOW), BODY);
    expect(verifyResendSignature({ id: ID, timestamp: String(NOW), signature }, BODY, SECRET, NOW)).toBe(true);
  });

  it('accepts when one of several signatures matches', () => {
    const good = sign(ID, String(NOW), BODY);
    const signature = `v1,AAAA ${good}`;
    expect(verifyResendSignature({ id: ID, timestamp: String(NOW), signature }, BODY, SECRET, NOW)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const signature = sign(ID, String(NOW), BODY, `whsec_${Buffer.from('other').toString('base64')}`);
    expect(verifyResendSignature({ id: ID, timestamp: String(NOW), signature }, BODY, SECRET, NOW)).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const signature = sign(ID, String(NOW), BODY);
    expect(
      verifyResendSignature({ id: ID, timestamp: String(NOW), signature }, BODY + 'x', SECRET, NOW),
    ).toBe(false);
  });

  it('rejects a stale timestamp (replay)', () => {
    const signature = sign(ID, String(NOW - 1000), BODY);
    expect(verifyResendSignature({ id: ID, timestamp: String(NOW - 1000), signature }, BODY, SECRET, NOW)).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    const signature = sign(ID, String(NOW), BODY);
    expect(verifyResendSignature({ id: ID, timestamp: String(NOW), signature }, BODY, '', NOW)).toBe(false);
  });

  it('rejects missing / malformed headers', () => {
    expect(verifyResendSignature({}, BODY, SECRET, NOW)).toBe(false);
    expect(verifyResendSignature({ id: ID, timestamp: String(NOW) }, BODY, SECRET, NOW)).toBe(false);
    expect(
      verifyResendSignature({ id: ID, timestamp: String(NOW), signature: 'garbage-no-comma' }, BODY, SECRET, NOW),
    ).toBe(false);
  });
});
