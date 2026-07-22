import { describe, expect, it } from 'vitest';
import {
  courierRecipientLine,
  courierStatusLabel,
  sendableCourierCount,
  sendResultSummary,
  unsentCourierCount,
} from './consolidated-protocol-couriers';

describe('courierRecipientLine', () => {
  it('shows name + email for a courier with an email on file', () => {
    expect(courierRecipientLine({ name: 'Лег 1', email: 'a@x.bg' })).toBe('Лег 1 — a@x.bg');
  });

  it('flags a courier with NO email — never silently drops the missing-email fact', () => {
    const line = courierRecipientLine({ name: 'Лег 2', email: null });
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
    expect(sendableCourierCount([{ email: null }])).toBe(0);
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

describe('courierStatusLabel', () => {
  it('labels each send state for an emailable courier', () => {
    expect(courierStatusLabel({ email: 'a@x.bg', emailStatus: 'sent' })).toBe('Изпратено');
    expect(courierStatusLabel({ email: 'a@x.bg', emailStatus: 'failed' })).toBe('Неуспешно');
    expect(courierStatusLabel({ email: 'a@x.bg', emailStatus: null })).toBe('Непратено');
  });

  it('is blank for a no-email courier — the line already flags "няма имейл"', () => {
    expect(courierStatusLabel({ email: null, emailStatus: null })).toBe('');
  });
});

describe('unsentCourierCount', () => {
  it('counts emailable couriers not yet successfully sent (failed or never)', () => {
    const recipients = [
      { email: 'a@x.bg', emailStatus: 'sent' as const },
      { email: 'b@x.bg', emailStatus: 'failed' as const },
      { email: 'c@x.bg', emailStatus: null },
      { email: null, emailStatus: null }, // no email → not resendable, not counted
    ];
    expect(unsentCourierCount(recipients)).toBe(2);
  });

  it('is 0 when every emailable courier is already sent', () => {
    expect(
      unsentCourierCount([
        { email: 'a@x.bg', emailStatus: 'sent' as const },
        { email: null, emailStatus: null },
      ]),
    ).toBe(0);
  });
});
