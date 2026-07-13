import { parseSmsSettings } from './sms-settings';

describe('parseSmsSettings', () => {
  it('defaults to dayOfReminder=false + channel=email on absent/garbage input', () => {
    expect(parseSmsSettings(null)).toEqual({ dayOfReminder: false, channel: 'email' });
    expect(parseSmsSettings({})).toEqual({ dayOfReminder: false, channel: 'email' });
    expect(parseSmsSettings({ sms: 'nope' })).toEqual({ dayOfReminder: false, channel: 'email' });
    expect(parseSmsSettings({ sms: { dayOfReminder: 'yes' } })).toEqual({
      dayOfReminder: false,
      channel: 'email',
    });
  });

  it('reads a real boolean', () => {
    expect(parseSmsSettings({ sms: { dayOfReminder: true } })).toEqual({
      dayOfReminder: true,
      channel: 'email',
    });
  });

  it('reads channel=sms only when explicitly set to "sms"', () => {
    expect(parseSmsSettings({ sms: { dayOfReminder: true, channel: 'sms' } })).toEqual({
      dayOfReminder: true,
      channel: 'sms',
    });
    // anything other than the literal 'sms' → email
    expect(parseSmsSettings({ sms: { dayOfReminder: true, channel: 'viber' } }).channel).toBe(
      'email',
    );
    expect(parseSmsSettings({ sms: { dayOfReminder: true, channel: 42 } }).channel).toBe('email');
  });
});
