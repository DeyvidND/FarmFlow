/** When the day-of reminder cron fires if the tenant hasn't set an hour. */
export const DEFAULT_REMINDER_SEND_HOUR = 8;

/** Day-of delivery reminder config, stored per tenant in `tenants.settings.sms`. */
export interface SmsSettings {
  /** Master on/off for the day-of delivery-window reminder. */
  dayOfReminder: boolean;
  /**
   * Which channel the reminder goes out on. 'email' (default) reuses the free
   * transactional email; 'sms' uses the SMS gateway (needs creds + a sender).
   * Flip to 'sms' once the gateway is wired — no code change.
   */
  channel: 'email' | 'sms';
  /**
   * The Europe/Sofia hour (0–23) at which the morning reminder is sent. The
   * cron ticks hourly and only fans out the tenants whose hour matches the
   * current one. Defaults to 8 (the historical fixed 08:00 send).
   */
  sendHour: number;
}

/** Defensive parse of the untyped settings jsonb — absent/garbage → off, email, 8. */
export function parseSmsSettings(settings: unknown): SmsSettings {
  const sms = (settings as { sms?: unknown } | null)?.sms;
  const dayOfReminder =
    typeof (sms as { dayOfReminder?: unknown })?.dayOfReminder === 'boolean'
      ? (sms as { dayOfReminder: boolean }).dayOfReminder
      : false;
  const channel = (sms as { channel?: unknown })?.channel === 'sms' ? 'sms' : 'email';
  const rawHour = Number((sms as { sendHour?: unknown })?.sendHour);
  const sendHour =
    Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : DEFAULT_REMINDER_SEND_HOUR;
  return { dayOfReminder, channel, sendHour };
}
