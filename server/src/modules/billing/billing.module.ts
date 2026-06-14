import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { BillingProcessor } from './billing.processor';
import { BILLING_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

// EmailModule is @Global, so EmailService is injectable without importing it here.
@Module({
  imports: [
    BullModule.registerQueue({
      name: BILLING_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [BillingController],
  providers: [BillingService, ...(RUN_WORKERS ? [BillingProcessor] : [])],
  exports: [BillingService],
})
export class BillingModule {}
