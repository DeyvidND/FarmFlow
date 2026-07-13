import { smsSegments } from './sms-segments';

describe('smsSegments', () => {
  it('counts a short Latin message as 1 segment', () => {
    expect(smsSegments('Hello')).toBe(1);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
  });

  it('counts Cyrillic (UCS-2) at 70/67 chars per segment', () => {
    expect(smsSegments('Здравей')).toBe(1); // 7 chars
    expect(smsSegments('я'.repeat(70))).toBe(1);
    expect(smsSegments('я'.repeat(71))).toBe(2); // >70 → multipart → 67/seg
  });

  it('empty string is 1 segment', () => {
    expect(smsSegments('')).toBe(1);
  });
});
