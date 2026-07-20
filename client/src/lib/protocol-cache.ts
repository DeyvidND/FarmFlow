/**
 * Offline cache for the fullscreen „Проверка" check view (Task 12) — a
 * courier stopped mid-delivery, often with no signal, must be able to show
 * the day's signed handover protocols immediately. On a successful online
 * load of `GET /handover/check?date=`, the view calls {@link saveCheckCache}
 * to persist the day's payload (including decrypted signature data-URLs,
 * which is why this is IndexedDB and not `localStorage` — those blow past
 * localStorage's ~5MB cap). The view then reads cache-first via
 * {@link readCheckCache} so it still renders something with no network.
 *
 * Caching here is best-effort and must NEVER throw or reject: private
 * browsing, disabled storage, and quota-exceeded are all normal conditions
 * a courier may hit, and a crash in the cache layer is worse than a cache
 * miss on a screen that's about to be shown to police. Every IndexedDB call
 * is wrapped so a failure degrades to "no cache".
 */

/**
 * Client mirror of the server's `CheckRow` (see
 * `server/src/modules/handover/handover.service.ts` → `listForCheck`).
 * Deliberately narrower than the full protocol shape used elsewhere in this
 * app (`ProtocolRow`/`DayProtocolRow` in `./types.ts`): the server itself
 * strips `priceStotinki`/`orderNumber` from `items` for this endpoint, and
 * `fromSnapshot`/`toSnapshot` only ever need the fields the printed
 * protocol/PDF actually shows (name, legal id, address, contact) — never
 * `vatNumber`/`kind`/`confirmedAt`, which the check view has no use for.
 */
export interface CheckProtocol {
  id: string;
  protocolNumber: number | null;
  kind: string;
  status: string;
  /** ISO string — the server's `Date` is JSON-serialized over the wire. */
  signedAt: string | null;
  fromSnapshot: { name?: string; eik?: string; regNo?: string; address?: string; phone?: string; email?: string };
  toSnapshot: { name?: string; eik?: string; regNo?: string; address?: string; phone?: string; email?: string };
  items: { productName: string; variantLabel?: string; quantity: number; unit?: string }[];
  fromSignaturePng: string | null;
  toSignaturePng: string | null;
}

/** One cached day, keyed by date in the object store. */
interface CachedDay {
  rows: CheckProtocol[];
  cachedAt: number;
}

const DB_NAME = 'ff-protocols';
const DB_VERSION = 1;
const STORE = 'check';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Persist the day's check payload, keyed by date. Overwrites any previous
 * save for the same date. Never throws — offline caching is best-effort;
 * storage unavailable / quota-exceeded / private mode all resolve quietly.
 */
export async function saveCheckCache(date: string, rows: CheckProtocol[], now: number): Promise<void> {
  try {
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const value: CachedDay = { rows, cachedAt: now };
        tx.objectStore(STORE).put(value, date);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // storage unavailable / quota exceeded / private mode — ignore, the
    // check view simply has no cache for this date.
  }
}

/**
 * Read the cached day payload, or `null` if absent or storage is
 * unavailable for any reason. Never throws.
 */
export async function readCheckCache(date: string): Promise<{ rows: CheckProtocol[]; cachedAt: number } | null> {
  try {
    const db = await open();
    try {
      const val = await new Promise<CachedDay | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(date);
        req.onsuccess = () => resolve(req.result as CachedDay | undefined);
        req.onerror = () => reject(req.error);
      });
      return val ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
