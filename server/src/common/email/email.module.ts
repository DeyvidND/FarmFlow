import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EmailService } from './email.service';
import { SuppressionService } from './suppression.service';
import { EmailWebhookController } from './email-webhook.controller';
import { EmailProcessor } from './email.processor';
import { EMAIL_QUEUE } from '../queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
import { OrderProtocolEmailModule } from '../../modules/order-protocol-email/order-protocol-email.module';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({
      name: EMAIL_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    }),
    // Makes PROTOCOL_ATTACHMENT_RESOLVER visible to EmailService's @Optional()
    // injection (Phase 2, 2026-07-22) — see order-protocol-email.module.ts.
    OrderProtocolEmailModule,
  ],
  controllers: [EmailWebhookController],
  providers: [EmailService, SuppressionService, ...(RUN_WORKERS ? [EmailProcessor] : [])],
  exports: [EmailService, SuppressionService],
})
export class EmailModule {}
