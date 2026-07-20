import { encryptSignature, decryptSignature, looksEncrypted } from './signature-crypto';

const KEY = 'test-key-123';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('signature-crypto', () => {
  it('round-trips with a key', () => {
    const enc = encryptSignature(PNG, KEY);
    expect(enc).not.toEqual(PNG);
    expect(looksEncrypted(enc)).toBe(true);
    expect(decryptSignature(enc, KEY)).toEqual(PNG);
  });

  it('degrades to plaintext when no key', () => {
    expect(encryptSignature(PNG, undefined)).toEqual(PNG);
  });

  it('passes legacy plaintext data-URL through decrypt unchanged', () => {
    expect(decryptSignature(PNG, KEY)).toEqual(PNG);
    expect(looksEncrypted(PNG)).toBe(false);
  });

  it('returns null for empty', () => {
    expect(decryptSignature(null, KEY)).toBeNull();
    expect(decryptSignature('', KEY)).toBeNull();
  });

  it('tolerates a malformed ciphertext-shaped value', () => {
    expect(decryptSignature('aa:bb:cc', KEY)).toBe('aa:bb:cc');
  });
});
