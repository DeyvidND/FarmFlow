import { encodeCursor, decodeCursor } from './cursor';

describe('cursor codec', () => {
  it('round-trips a micro-precision timestamp + id', () => {
    const pos = { createdAt: '2026-06-05T10:20:30.123456', id: 'abc-123' };
    const decoded = decodeCursor(encodeCursor(pos));
    expect(decoded?.id).toBe('abc-123');
    expect(decoded?.createdAt).toBe('2026-06-05T10:20:30.123456');
  });

  it('preserves the microseconds verbatim (never truncates to ms)', () => {
    // The whole point of the fix: the boundary must survive at full precision, so
    // two cursors that differ only in the micro digits stay distinct.
    const a = decodeCursor(encodeCursor({ createdAt: '2026-06-05T10:20:30.123000', id: 'x' }));
    const b = decodeCursor(encodeCursor({ createdAt: '2026-06-05T10:20:30.123999', id: 'x' }));
    expect(a?.createdAt).toBe('2026-06-05T10:20:30.123000');
    expect(b?.createdAt).toBe('2026-06-05T10:20:30.123999');
    expect(a?.createdAt).not.toBe(b?.createdAt);
  });

  it('still accepts a pre-fix `…Z` (millisecond) cursor', () => {
    // In-flight cursors issued before this fix must not reset to page 1.
    const decoded = decodeCursor(encodeCursor({ createdAt: '2026-01-01T00:00:00.000Z', id: 'a-b-c' }));
    expect(decoded?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(decoded?.id).toBe('a-b-c');
  });

  it('preserves an id that contains the separator char', () => {
    // indexOf('|') splits on the FIRST pipe; ids are UUIDs (no pipe) but guard anyway.
    const pos = { createdAt: '2026-01-01T00:00:00.000000', id: 'a-b-c' };
    expect(decodeCursor(encodeCursor(pos))?.id).toBe('a-b-c');
  });

  it('returns null on malformed input (never throws)', () => {
    expect(decodeCursor('not-base64-$$$')).toBeNull();
    expect(decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('bad-date|x', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('2026-01-01T00:00:00.000Z|', 'utf8').toString('base64url'))).toBeNull();
  });
});
