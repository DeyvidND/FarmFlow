import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';
import { SMS_PROVIDER } from './sms.constants';
import { createSmsProvider } from './sms.provider.factory';
import { SmsProvider } from './sms.types';

@Module({
  providers: [
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SmsProvider =>
        createSmsProvider(config, new Logger('SmsProvider')),
    },
    SmsService,
  ],
  exports: [SmsService],
})
export class SmsModule {}
