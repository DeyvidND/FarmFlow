import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsProvider } from './sms.types';
import { HttpSmsProvider } from './http-sms.provider';
import { LogOnlySmsProvider } from './log-only-sms.provider';

export function createSmsProvider(config: ConfigService, logger: Logger): SmsProvider {
  const url = config.get<string>('SMS_GATEWAY_URL');
  const token = config.get<string>('SMS_GATEWAY_TOKEN');
  const senderId = config.get<string>('SMS_SENDER_ID') ?? 'ФермериБГ';
  if (url && token) {
    return new HttpSmsProvider({ url, token, senderId }, logger);
  }
  logger.warn('[sms] no gateway creds — using LogOnlySmsProvider (no real sends)');
  return new LogOnlySmsProvider(logger);
}
