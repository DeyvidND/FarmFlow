/** DI token for the resolved SmsProvider (Http or LogOnly). */
export const SMS_PROVIDER = 'SMS_PROVIDER';
// Note: the BullMQ queue name lives in common/queue/queue.constants.ts (SMS_QUEUE);
// don't re-declare it here — every consumer imports it from there.
