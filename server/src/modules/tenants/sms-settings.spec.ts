import { parseSmsSettings } from './sms-settings';

describe('parseSmsSettings', () => {
  it('defaults to dayOfReminder=false + channel=email + sendHour=8 on absent/garbage input', () => {
    expect(parseSmsSettings(null)).toEqual({ dayOfReminder: false, channel: 'email', sendHour: 8 });
    expect(parseSmsSettings({})).toEqual({ dayOfReminder: false, channel: 'email', sendHour: 8 });
    expect(parseSmsSettings({ sms: 'nope' })).toEqual({
      dayOfReminder: false,
      channel: 'email',
      sendHour: 8,
    });
    expect(parseSmsSettings({ sms: { dayOfReminder: 'yes' } })).toEqual({
      dayOfReminder: false,
      channel: 'email',
      sendHour: 8,
    });
  });

  it('reads a real boolean', () => {
    expect(parseSmsSettings({ sms: { dayOfReminder: true } })).toEqual({
      dayOfReminder: true,
      channel: 'email',
      sendHour: 8,
    });
  });

  it('reads channel=sms only when explicitly set to "sms"', () => {
    expect(parseSmsSettings({ sms: { dayOfReminder: true, channel: 'sms' } })).toEqual({
      dayOfReminder: true,
      channel: 'sms',
      sendHour: 8,
    });
    // anything other than the literal 'sms' → email
    expect(parseSmsSettings({ sms: { dayOfReminder: true, channel: 'viber' } }).channel).toBe(
      'email',
    );
    expect(parseSmsSettings({ sms: { dayOfReminder: true, channel: 42 } }).channel).toBe('email');
  });

  it('reads a valid sendHour (0–23) and falls back to 8 otherwise', () => {
    expect(parseSmsSettings({ sms: { sendHour: 6 } }).sendHour).toBe(6);
    // 0 (midnight) is valid, not treated as "unset"
    expect(parseSmsSettings({ sms: { sendHour: 0 } }).sendHour).toBe(0);
    expect(parseSmsSettings({ sms: { sendHour: 23 } }).sendHour).toBe(23);
    // out of range / non-integer / garbage → default 8
    expect(parseSmsSettings({ sms: { sendHour: 24 } }).sendHour).toBe(8);
    expect(parseSmsSettings({ sms: { sendHour: -1 } }).sendHour).toBe(8);
    expect(parseSmsSettings({ sms: { sendHour: 9.5 } }).sendHour).toBe(8);
    expect(parseSmsSettings({ sms: { sendHour: 'noon' } }).sendHour).toBe(8);
  });
});
