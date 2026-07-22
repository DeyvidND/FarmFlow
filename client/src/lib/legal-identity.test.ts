import { describe, it, expect } from 'vitest';
import { buildLegalPayload, isLegalDirty, type LegalFormFields } from './legal-identity';

const form = (over: Partial<LegalFormFields> = {}): LegalFormFields => ({
  kind: '',
  name: '',
  eik: '',
  vatNumber: '',
  address: '',
  regNo: '',
  ...over,
});

describe('buildLegalPayload', () => {
  /**
   * The regression this exists for: one input, two backing states. A producer
   * types their number before picking a kind (→ lands in `eik`), then selects
   * „Физическо лице" and retypes (→ also in `regNo`). Both are populated, the
   * check screen prefers `eik`, and the protocol prints „ЕИК …" for someone who
   * has no ЕИК — the wrong legal identifier on a document read by police.
   */
  it('sends ONLY regNo for an individual, even when eik state is still populated', () => {
    const out = buildLegalPayload(
      form({ kind: 'individual', regNo: '1234567', eik: '203912345', vatNumber: 'BG203912345' }),
    );
    expect(out.regNo).toBe('1234567');
    expect(out.eik).toBeUndefined();
    expect(out.vatNumber).toBeUndefined(); // an individual has no VAT registration either
  });

  it('sends ONLY eik for a sole trader, even when regNo state is still populated', () => {
    const out = buildLegalPayload(form({ kind: 'sole_trader', eik: '203912345', regNo: '1234567' }));
    expect(out.eik).toBe('203912345');
    expect(out.regNo).toBeUndefined();
  });

  it('keeps vatNumber for a company but never for an individual', () => {
    expect(buildLegalPayload(form({ kind: 'company', vatNumber: 'BG203912345' })).vatNumber).toBe(
      'BG203912345',
    );
    expect(
      buildLegalPayload(form({ kind: 'individual', vatNumber: 'BG203912345' })).vatNumber,
    ).toBeUndefined();
  });

  it('treats an unchosen kind as non-individual — matching the „ЕИК / БУЛСТАТ" label shown', () => {
    const out = buildLegalPayload(form({ kind: '', eik: '203912345' }));
    expect(out.kind).toBeUndefined();
    expect(out.eik).toBe('203912345');
    expect(out.regNo).toBeUndefined();
  });

  it('normalises blank and whitespace-only fields to undefined, not empty strings', () => {
    const out = buildLegalPayload(form({ kind: 'company', name: '   ', address: '' }));
    expect(out.name).toBeUndefined();
    expect(out.address).toBeUndefined();
  });

  it('trims surrounding whitespace off values it does send', () => {
    const out = buildLegalPayload(form({ kind: 'company', name: '  ЕООД „Петров"  ', eik: ' 203912345 ' }));
    expect(out.name).toBe('ЕООД „Петров"');
    expect(out.eik).toBe('203912345');
  });

  it('never emits confirmedAt — that audit stamp is written server-side only', () => {
    const out = buildLegalPayload(form({ kind: 'company', eik: '203912345' }));
    expect(out).not.toHaveProperty('confirmedAt');
  });
});

describe('isLegalDirty', () => {
  /**
   * The regression this exists for: the Settings „Легални данни" card only renders
   * its SaveBar while `dirty`, and the old check was `JSON.stringify(a) === JSON.stringify(b)`
   * over two objects built with DIFFERENT key orders (`buildLegalPayload` emits
   * kind,name,address,eik,… while the saved-side literal emitted kind,name,eik,…,address).
   * JSON.stringify preserves insertion order, so an untouched company identity with
   * BOTH an address and an ЕИК compared unequal — the bar never went away after a
   * successful save and the operator read that as „не се записва".
   */
  it('is not dirty for an untouched company identity with both address and ЕИК', () => {
    const saved = {
      kind: 'company' as const,
      name: 'ЕООД Цанчев',
      eik: '203912345',
      address: 'Галата Варна',
      confirmedAt: '2026-07-21T18:03:23.910Z',
    };
    const untouched = form({
      kind: 'company',
      name: 'ЕООД Цанчев',
      eik: '203912345',
      address: 'Галата Варна',
    });
    expect(isLegalDirty(untouched, saved)).toBe(false);
  });

  it('ignores the server sending "" where the form holds an untouched blank', () => {
    const saved = { kind: 'company' as const, name: 'ЕООД Цанчев', vatNumber: '', address: 'Варна' };
    const untouched = form({ kind: 'company', name: 'ЕООД Цанчев', address: 'Варна' });
    expect(isLegalDirty(untouched, saved)).toBe(false);
  });

  it('ignores confirmedAt — an audit stamp is not an operator edit', () => {
    const saved = { kind: 'individual' as const, name: 'Дейвид Дончев', confirmedAt: '2026-07-13T17:47:49.900Z' };
    expect(isLegalDirty(form({ kind: 'individual', name: 'Дейвид Дончев' }), saved)).toBe(false);
  });

  it('still reports a real edit to any field', () => {
    const saved = { kind: 'company' as const, name: 'ЕООД Цанчев', eik: '203912345', address: 'Варна' };
    expect(isLegalDirty(form({ kind: 'company', name: 'ЕООД Цанчев', eik: '203912345', address: 'Бургас' }), saved)).toBe(true);
    expect(isLegalDirty(form({ kind: 'company', name: 'ООД Цанчев', eik: '203912345', address: 'Варна' }), saved)).toBe(true);
    expect(isLegalDirty(form({ kind: 'sole_trader', name: 'ЕООД Цанчев', eik: '203912345', address: 'Варна' }), saved)).toBe(true);
  });

  it('compares what would actually be SENT — a stale eik under „Физическо лице" is not an edit', () => {
    // The kind filter drops eik/vatNumber for an individual, so leftover state in
    // those inputs must not light up the SaveBar: saving would not change the row.
    const saved = { kind: 'individual' as const, name: 'Димка Четова', regNo: '1234567' };
    const stale = form({ kind: 'individual', name: 'Димка Четова', regNo: '1234567', eik: '203912345' });
    expect(isLegalDirty(stale, saved)).toBe(false);
  });

  it('is never dirty before the saved block has loaded', () => {
    expect(isLegalDirty(form({ kind: 'company', name: 'x' }), null)).toBe(false);
  });

  it('is dirty when the first value is typed into a farm with no legal block yet', () => {
    expect(isLegalDirty(form({ name: 'ЕООД Ново' }), {})).toBe(true);
  });
});
