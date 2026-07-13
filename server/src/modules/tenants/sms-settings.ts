/** SMS config, stored per tenant in `tenants.settings.sms`. */
export interface SmsSettings {
  dayOfReminder: boolean;
}

/** Defensive parse of the untyped settings jsonb — absent/garbage → off. */
export function parseSmsSettings(settings: unknown): SmsSettings {
  const sms = (settings as { sms?: unknown } | null)?.sms;
  const dayOfReminder =
    typeof (sms as { dayOfReminder?: unknown })?.dayOfReminder === 'boolean'
      ? ((sms as { dayOfReminder: boolean }).dayOfReminder)
      : false;
  return { dayOfReminder };
}
