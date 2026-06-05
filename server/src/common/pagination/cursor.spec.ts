import { encodeCursor, decodeCursor } from './cursor';

describe('cursor codec', () => {
  it('round-trips createdAt + id', () => {
    const pos = { createdAt: new Date('2026-06-05T10:20:30.123Z'), id: 'abc-123' };
    const decoded = decodeCursor(encodeCursor(pos));
    expect(decoded?.id).toBe('abc-123');
    expect(decoded?.createdAt.toISOString()).toBe('2026-06-05T10:20:30.123Z');
  });

  it('preserves an id that contains the separator char', () => {
    // indexOf('|') splits on the FIRST pipe; ids are UUIDs (no pipe) but guard anyway.
    const pos = { createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 'a-b-c' };
    expect(decodeCursor(encodeCursor(pos))?.id).toBe('a-b-c');
  });

  it('returns null on malformed input (never throws)', () => {
    expect(decodeCursor('not-base64-$$$')).toBeNull();
    expect(decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('bad-date|x', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('2026-01-01T00:00:00.000Z|', 'utf8').toString('base64url'))).toBeNull();
  });
});
