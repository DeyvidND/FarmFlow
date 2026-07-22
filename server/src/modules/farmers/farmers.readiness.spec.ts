import { FarmersService } from './farmers.service';

const TENANT = 'tenant-1';

/** Thenable chainable Drizzle mock (mirrors farmers.signature.spec.ts's second
 *  describe / farmers.public-fields.spec.ts): builder methods return `this`;
 *  awaiting the chain resolves the next queued row set. */
function makeDb() {
  const queue: unknown[] = [];
  const db: any = { queue: (v: unknown) => queue.push(v) };
  const chain = () => db;
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) db[m] = jest.fn(chain);
  db.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    const v = queue.shift();
    if (v instanceof Error) reject(v);
    else resolve(v);
  };
  return db;
}

function make(db: ReturnType<typeof makeDb>) {
  return new FarmersService(db as any, {} as any, {} as any, {} as any, {} as any, {} as any, { enabled: false } as any);
}

describe('FarmersService.listReadiness', () => {
  it('is NOT ready for an individual who filled ЕИК instead of Рег.№ (wrong identifier for the kind)', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'Иван', email: null,
      legal: { kind: 'individual', name: 'Иван Петров', address: 'гр. Варна', eik: '203912345' }, // no regNo
      signaturePng: 'cipher',
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row.ready).toBe(false);
    expect(row.missing).toContain('identifier');
  });

  it('is NOT ready for a company who filled Рег.№ instead of ЕИК (wrong identifier for the kind)', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'ЕООД', email: null,
      legal: { kind: 'company', name: 'ЕООД „Петров"', address: 'гр. Варна', regNo: '123456789' }, // no eik
      signaturePng: 'cipher',
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row.ready).toBe(false);
    expect(row.missing).toContain('identifier');
  });

  it('is NOT ready when legal data is complete but no signature is on file', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'ЕООД', email: null,
      legal: { kind: 'company', name: 'ЕООД „Петров"', address: 'гр. Варна', eik: '203912345' },
      signaturePng: null,
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row.ready).toBe(false);
    expect(row.missing).toEqual(['signature']);
  });

  it('is ready only when BOTH the kind-correct legal identity AND a signature are present', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'ЕООД', email: 'f@x.bg',
      legal: { kind: 'company', name: 'ЕООД „Петров"', address: 'гр. Варна', eik: '203912345' },
      signaturePng: 'cipher',
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row.ready).toBe(true);
    expect(row.missing).toEqual([]);
  });

  it('never decrypts or exposes the signature blob — only its presence is checked', async () => {
    const db = makeDb();
    db.queue([{
      id: 'f1', name: 'ЕООД', email: null,
      legal: { kind: 'company', name: 'ЕООД „Петров"', address: 'гр. Варна', eik: '203912345' },
      signaturePng: 'super-secret-ciphertext',
    }]);
    const svc = make(db);
    const [row] = await svc.listReadiness(TENANT);
    expect(row).not.toHaveProperty('signaturePng');
    expect(JSON.stringify(row)).not.toContain('super-secret-ciphertext');
  });
});
