import { describe, it, expect } from 'vitest';
import { buildLegalPayload, type LegalFormFields } from './legal-identity';

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
