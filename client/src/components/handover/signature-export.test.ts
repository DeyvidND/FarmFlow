import { describe, it, expect } from 'vitest';
import { signatureIsBlank } from './signature-export';

describe('signatureIsBlank', () => {
  it('treats a non-data-url as blank', () => {
    expect(signatureIsBlank('')).toBe(true);
    expect(signatureIsBlank('nope')).toBe(true);
  });
  it('treats a tiny/short data-url as blank', () => {
    expect(signatureIsBlank('data:image/png;base64,AAAA')).toBe(true);
  });
  it('treats a substantial data-url as non-blank', () => {
    expect(signatureIsBlank('data:image/png;base64,' + 'A'.repeat(3000))).toBe(false);
  });
});
