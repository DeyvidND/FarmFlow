import { parseSmsSettings } from './sms-settings';

describe('parseSmsSettings', () => {
  it('defaults to dayOfReminder=false on absent/garbage input', () => {
    expect(parseSmsSettings(null)).toEqual({ dayOfReminder: false });
    expect(parseSmsSettings({})).toEqual({ dayOfReminder: false });
    expect(parseSmsSettings({ sms: 'nope' })).toEqual({ dayOfReminder: false });
    expect(parseSmsSettings({ sms: { dayOfReminder: 'yes' } })).toEqual({ dayOfReminder: false });
  });

  it('reads a real boolean', () => {
    expect(parseSmsSettings({ sms: { dayOfReminder: true } })).toEqual({ dayOfReminder: true });
  });
});
