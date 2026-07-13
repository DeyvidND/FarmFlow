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
}

/** Defensive parse of the untyped settings jsonb — absent/garbage → off, email. */
export function parseSmsSettings(settings: unknown): SmsSettings {
  const sms = (settings as { sms?: unknown } | null)?.sms;
  const dayOfReminder =
    typeof (sms as { dayOfReminder?: unknown })?.dayOfReminder === 'boolean'
      ? (sms as { dayOfReminder: boolean }).dayOfReminder
      : false;
  const channel = (sms as { channel?: unknown })?.channel === 'sms' ? 'sms' : 'email';
  return { dayOfReminder, channel };
}
