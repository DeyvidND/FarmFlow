import { clampLimit, buildPage, DEFAULT_LIMIT, MAX_LIMIT } from './keyset';

describe('clampLimit', () => {
  it('defaults when absent / NaN', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(NaN)).toBe(DEFAULT_LIMIT);
  });
  it('clamps to [1, MAX_LIMIT]', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(9999)).toBe(MAX_LIMIT);
    expect(clampLimit(25)).toBe(25);
  });
});

describe('buildPage', () => {
  const cursorOf = (r: { createdAt: Date; id: string }) => r;
  const rows = Array.from({ length: 4 }, (_, i) => ({
    createdAt: new Date(2026, 0, i + 1),
    id: `id-${i}`,
  }));

  it('trims the +1 sentinel and emits a nextCursor when more exist', () => {
    const page = buildPage(rows, 3, cursorOf); // 4 rows, limit 3 → hasMore
    expect(page.items).toHaveLength(3);
    expect(page.items[2].id).toBe('id-2');
    expect(page.nextCursor).not.toBeNull();
  });

  it('null cursor at the tail', () => {
    const page = buildPage(rows.slice(0, 2), 3, cursorOf); // 2 rows, limit 3 → no more
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('exactly `limit` rows → no more', () => {
    const page = buildPage(rows.slice(0, 3), 3, cursorOf);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });
});
