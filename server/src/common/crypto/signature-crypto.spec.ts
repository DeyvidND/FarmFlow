import { encryptSignature, decryptSignature, looksEncrypted, SignatureKeyMissingError } from './signature-crypto';

const KEY = 'test-key-123';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('signature-crypto', () => {
  it('round-trips with a key', () => {
    const enc = encryptSignature(PNG, KEY);
    expect(enc).not.toEqual(PNG);
    expect(looksEncrypted(enc)).toBe(true);
    expect(decryptSignature(enc, KEY)).toEqual(PNG);
  });

  it('REFUSES to encrypt without a key (never stores plaintext)', () => {
    expect(() => encryptSignature(PNG, undefined)).toThrow(SignatureKeyMissingError);
    expect(() => encryptSignature(PNG, '')).toThrow(SignatureKeyMissingError);
  });

  it('passes legacy plaintext data-URL through decrypt unchanged', () => {
    expect(decryptSignature(PNG, KEY)).toEqual(PNG);
    expect(looksEncrypted(PNG)).toBe(false);
  });

  it('returns null for empty', () => {
    expect(decryptSignature(null, KEY)).toBeNull();
    expect(decryptSignature('', KEY)).toBeNull();
  });

  it('returns null for ciphertext when no key is configured', () => {
    const enc = encryptSignature(PNG, KEY);
    expect(decryptSignature(enc, undefined)).toBeNull();
  });

  it('returns null for a malformed ciphertext-shaped value', () => {
    expect(decryptSignature('aa:bb:cc', KEY)).toBeNull();
  });

  it('returns null when the key does not match (rotated key)', () => {
    const enc = encryptSignature(PNG, KEY);
    expect(decryptSignature(enc, 'a-different-key')).toBeNull();
  });
});
