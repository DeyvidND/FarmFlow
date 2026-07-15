import { describe, expect, it } from 'vitest';
import { assignmentErrorMessage, deriveLegCount, isBoardActive } from './courier-assignment';

describe('deriveLegCount', () => {
  it('uses the dropdown count when the board is empty (dropdown wins)', () => {
    expect(deriveLegCount([], 3)).toBe(3);
  });

  it('uses the number of distinct assigned legs when the board has entries, ignoring the dropdown', () => {
    const assignments = [
      { accountId: 'a', legIndex: 0 },
      { accountId: 'b', legIndex: 1 },
    ];
    expect(deriveLegCount(assignments, 5)).toBe(2);
  });

  it('dedupes legIndex values (defensive — the server already forbids duplicate legs per day)', () => {
    const assignments = [
      { accountId: 'a', legIndex: 0 },
      { accountId: 'b', legIndex: 0 },
    ];
    expect(deriveLegCount(assignments, 5)).toBe(1);
  });

  it('a single assignment yields exactly 1 leg regardless of the dropdown', () => {
    expect(deriveLegCount([{ accountId: 'a', legIndex: 3 }], 1)).toBe(1);
  });
});

describe('isBoardActive', () => {
  it('is false for an empty board', () => {
    expect(isBoardActive([])).toBe(false);
  });

  it('is true once any assignment exists for the date', () => {
    expect(isBoardActive([{ accountId: 'a', legIndex: 0 }])).toBe(true);
  });
});

describe('assignmentErrorMessage', () => {
  it('surfaces the server message on a 409 double-book', () => {
    const err = { status: 409, message: 'Този курс вече има куриер за деня.' };
    expect(assignmentErrorMessage(err)).toBe('Този курс вече има куриер за деня.');
  });

  it('falls back to a generic message for a non-409 error', () => {
    expect(assignmentErrorMessage({ status: 500, message: 'boom' })).toBe('Неуспешно запазване — опитай пак');
  });

  it('falls back to a generic message for a non-error value', () => {
    expect(assignmentErrorMessage(new Error('network'))).toBe('Неуспешно запазване — опитай пак');
  });

  it('falls back to a generic message when status is 409 but the message is empty', () => {
    expect(assignmentErrorMessage({ status: 409, message: '' })).toBe('Неуспешно запазване — опитай пак');
  });
});
