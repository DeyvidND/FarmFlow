import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NewsletterService } from './newsletter.service';
import { NewsletterDraftService } from './newsletter-draft.service';
import { NewsletterCopyService } from './auto-draft.ai';
import { NewsletterDraftProcessor } from './newsletter-draft.processor';
import { NewsletterController } from './newsletter.controller';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { NEWSLETTER_DRAFT_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  imports: [
    AuthModule,
    BillingModule,
    BullModule.registerQueue({
      name: NEWSLETTER_DRAFT_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    }),
  ],
  controllers: [NewsletterController],
  providers: [
    NewsletterService,
    NewsletterDraftService,
    NewsletterCopyService,
    ...(RUN_WORKERS ? [NewsletterDraftProcessor] : []),
  ],
})
export class NewsletterModule {}
