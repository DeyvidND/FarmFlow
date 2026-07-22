import { describe, expect, it } from 'vitest';
import { courierRecipientLine, sendableCourierCount, sendResultSummary } from './consolidated-protocol-couriers';

describe('courierRecipientLine', () => {
  it('shows name + email for a courier with an email on file', () => {
    expect(courierRecipientLine({ legIndex: 0, name: 'Лег 1', email: 'a@x.bg' })).toBe('Лег 1 — a@x.bg');
  });

  it('flags a courier with NO email — never silently drops the missing-email fact', () => {
    const line = courierRecipientLine({ legIndex: 1, name: 'Лег 2', email: null });
    expect(line).toContain('Лег 2');
    expect(line.toLowerCase()).toContain('няма имейл');
  });
});

describe('sendableCourierCount', () => {
  it('counts only recipients WITH an email', () => {
    const recipients = [
      { legIndex: 0, name: 'Лег 1', email: 'a@x.bg' },
      { legIndex: 1, name: 'Лег 2', email: null },
      { legIndex: 2, name: 'Лег 3', email: 'c@x.bg' },
    ];
    expect(sendableCourierCount(recipients)).toBe(2);
  });

  it('is 0 for an empty list, and 0 when nobody has an email', () => {
    expect(sendableCourierCount([])).toBe(0);
    expect(sendableCourierCount([{ legIndex: 0, name: 'Лег 1', email: null }])).toBe(0);
  });
});

describe('sendResultSummary', () => {
  it('reports a clean all-sent send', () => {
    expect(sendResultSummary({ sent: [{}, {}], failed: [] })).toBe('Изпратено на 2 куриери.');
  });

  it('singularizes for exactly one recipient', () => {
    expect(sendResultSummary({ sent: [{}], failed: [] })).toBe('Изпратено на 1 куриер.');
  });

  it('surfaces the failed count when some sends failed', () => {
    expect(sendResultSummary({ sent: [{}], failed: [{}, {}] })).toBe('Изпратено на 1, неуспешно за 2.');
  });
});
