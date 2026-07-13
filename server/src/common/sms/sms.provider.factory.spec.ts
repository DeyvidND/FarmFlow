import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSmsProvider } from './sms.provider.factory';

function cfg(map: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

describe('createSmsProvider', () => {
  const logger = new Logger('test');

  it('returns SmsApiProvider when url + token are set', () => {
    const p = createSmsProvider(
      cfg({ SMS_GATEWAY_URL: 'https://gw', SMS_GATEWAY_TOKEN: 't' }),
      logger,
    );
    expect(p.name).toBe('smsapi');
  });

  it('falls back to LogOnlySmsProvider when creds are missing', () => {
    expect(createSmsProvider(cfg({}), logger).name).toBe('log-only');
    expect(createSmsProvider(cfg({ SMS_GATEWAY_URL: 'https://gw' }), logger).name).toBe(
      'log-only',
    );
  });
});
