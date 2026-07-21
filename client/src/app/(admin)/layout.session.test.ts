import { describe, it, expect } from 'vitest';
import { sessionVerdict } from './layout.session';

describe('sessionVerdict', () => {
  it('null (network never completed) → unreachable', () => {
    expect(sessionVerdict(null)).toBe('unreachable');
  });

  it('200 ok → ok', () => {
    expect(sessionVerdict({ ok: true, status: 200 })).toBe('ok');
  });

  it('401 → reject', () => {
    expect(sessionVerdict({ ok: false, status: 401 })).toBe('reject');
  });

  it('403 → reject', () => {
    expect(sessionVerdict({ ok: false, status: 403 })).toBe('reject');
  });

  it('500 → unreachable (API broken, not a bad token)', () => {
    expect(sessionVerdict({ ok: false, status: 500 })).toBe('unreachable');
  });

  it('502 → unreachable (API broken, not a bad token)', () => {
    expect(sessionVerdict({ ok: false, status: 502 })).toBe('unreachable');
  });
});
