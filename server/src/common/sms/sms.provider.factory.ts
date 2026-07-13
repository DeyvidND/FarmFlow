import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsProvider } from './sms.types';
import { SmsApiProvider } from './smsapi.provider';
import { LogOnlySmsProvider } from './log-only-sms.provider';

export function createSmsProvider(config: ConfigService, logger: Logger): SmsProvider {
  const url = config.get<string>('SMS_GATEWAY_URL');
  const token = config.get<string>('SMS_GATEWAY_TOKEN');
  // Default to EMPTY (SMSAPI ECO / numeric sender — no A2P registration, no
  // company needed). Set SMS_SENDER_ID to a registered alphanumeric ("ФермериБГ")
  // to brand it later — env change only, no code change.
  const senderId = config.get<string>('SMS_SENDER_ID') ?? '';
  if (url && token) {
    return new SmsApiProvider({ url, token, senderId }, logger);
  }
  logger.warn('[sms] no gateway creds — using LogOnlySmsProvider (no real sends)');
  return new LogOnlySmsProvider(logger);
}
