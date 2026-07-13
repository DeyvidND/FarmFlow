export interface SmsProviderResult {
  providerMessageId: string | null;
  segments: number;
}

export interface SmsProvider {
  /** Human-readable provider name, recorded in sms_log.provider. */
  readonly name: string;
  /** Send `body` to E.164 `to`. Throws on gateway failure. */
  send(to: string, body: string): Promise<SmsProviderResult>;
}

/** Extra context for the sms_log row. */
export interface SmsSendMeta {
  tenantId?: string | null;
  orderId?: string | null;
  kind?: string; // default 'delivery_window'
}

export interface SmsSendResult {
  status: 'sent' | 'failed';
  providerMessageId: string | null;
  segments: number;
}
