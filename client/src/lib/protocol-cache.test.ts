import { describe, it, expect } from 'vitest';

// Minimal fake-indexeddb: install BEFORE importing the module under test —
// this app's vitest runs Node-only (no jsdom), so IndexedDB doesn't exist
// without this shim.
import 'fake-indexeddb/auto';
import { saveCheckCache, readCheckCache, type CheckProtocol } from './protocol-cache';

const rows: CheckProtocol[] = [
  {
    id: 'p1',
    protocolNumber: 1,
    kind: 'farmer_to_operator',
    status: 'signed',
    signedAt: null,
    fromSnapshot: { name: 'A' },
    toSnapshot: { name: 'B' },
    items: [],
    fromSignaturePng: null,
    toSignaturePng: null,
  },
];

describe('protocol-cache', () => {
  it('round-trips a day payload', async () => {
    await saveCheckCache('2026-07-20', rows, 1000);
    const got = await readCheckCache('2026-07-20');
    expect(got?.cachedAt).toBe(1000);
    expect(got?.rows[0].id).toBe('p1');
    expect(got?.rows).toEqual(rows);
  });

  it('returns null for an uncached date', async () => {
    expect(await readCheckCache('1999-01-01')).toBeNull();
  });

  it('overwrites a previous save for the same date', async () => {
    await saveCheckCache('2026-07-21', rows, 1000);
    const updatedRows: CheckProtocol[] = [...rows, { ...rows[0], id: 'p2', protocolNumber: 2 }];
    await saveCheckCache('2026-07-21', updatedRows, 2000);

    const got = await readCheckCache('2026-07-21');
    expect(got?.cachedAt).toBe(2000);
    expect(got?.rows).toHaveLength(2);
    expect(got?.rows.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it('keeps different dates isolated', async () => {
    await saveCheckCache('2026-07-22', rows, 1000);
    await saveCheckCache('2026-07-23', [], 2000);

    expect((await readCheckCache('2026-07-22'))?.rows).toHaveLength(1);
    expect((await readCheckCache('2026-07-23'))?.rows).toHaveLength(0);
  });

  // Private mode, disabled storage, quota-exceeded — all normal conditions
  // for this cache. Simulate "indexedDB doesn't exist" as a stand-in for any
  // of them: neither function may throw, and a read must degrade to a miss.
  it('never throws and degrades to a miss when indexedDB is unavailable', async () => {
    const realIndexedDB = globalThis.indexedDB;
    // @ts-expect-error - deliberately breaking global storage for this test
    globalThis.indexedDB = undefined;
    try {
      await expect(saveCheckCache('2026-07-24', rows, 1000)).resolves.toBeUndefined();
      await expect(readCheckCache('2026-07-24')).resolves.toBeNull();
    } finally {
      globalThis.indexedDB = realIndexedDB;
    }
  });
});
