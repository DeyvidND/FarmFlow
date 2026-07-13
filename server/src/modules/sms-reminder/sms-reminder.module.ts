import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SmsReminderService } from './sms-reminder.service';
import { SmsReminderController } from './sms-reminder.controller';
import { SmsReminderProcessor } from './sms-reminder.processor';
import { SMS_QUEUE } from '../../common/queue/queue.constants';
import { SmsModule } from '../../common/sms/sms.module';
import { OrderEmailModule } from '../order-email/order-email.module';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  imports: [
    SmsModule,
    OrderEmailModule,
    BullModule.registerQueue({
      name: SMS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [SmsReminderController],
  providers: [SmsReminderService, ...(RUN_WORKERS ? [SmsReminderProcessor] : [])],
})
export class SmsReminderModule {}
