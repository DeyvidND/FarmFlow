import { BadRequestException } from '@nestjs/common';
import { sniffMime, assertContentMatchesMime } from './magic-mime';

// Minimal valid signatures (padded to >=12 bytes).
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 1, 0, 0, 0, 0, 0, 0, 0]);
// HTML masquerading as a PNG (the attack the guard blocks).
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

describe('sniffMime', () => {
  it('detects each accepted format from its magic bytes', () => {
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(WEBP)).toBe('image/webp');
    expect(sniffMime(WEBM)).toBe('video/webm');
    expect(sniffMime(MP4)).toBe('video/mp4');
    expect(sniffMime(ICO)).toBe('image/x-icon');
  });

  it('returns null for unknown / too-short content', () => {
    expect(sniffMime(HTML)).toBeNull();
    expect(sniffMime(Buffer.from([0x00, 0x01]))).toBeNull();
  });
});

describe('assertContentMatchesMime', () => {
  it('passes when bytes match the declared type', () => {
    expect(() => assertContentMatchesMime(PNG, 'image/png')).not.toThrow();
    expect(() => assertContentMatchesMime(JPEG, 'image/jpeg')).not.toThrow();
  });

  it('rejects HTML spoofing an image MIME', () => {
    expect(() => assertContentMatchesMime(HTML, 'image/png')).toThrow(BadRequestException);
  });

  it('rejects a real image declared as a different image type', () => {
    expect(() => assertContentMatchesMime(PNG, 'image/jpeg')).toThrow(BadRequestException);
  });
});
