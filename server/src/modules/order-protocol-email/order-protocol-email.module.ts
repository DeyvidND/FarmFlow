import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HandoverModule } from '../handover/handover.module';
import { OrderProtocolEmailService } from './order-protocol-email.service';
import { OrderProtocolEmailProcessor } from './order-protocol-email.processor';
import { HandoverProtocolAttachmentResolver } from './handover-protocol-attachment.resolver';
import { PROTOCOL_ATTACHMENT_RESOLVER } from '../../common/email/protocol-attachment.types';
import { PROTOCOL_EMAIL_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

/**
 * forwardRef on HandoverModule: HandoverModule -> RoutingModule -> (forwardRef)
 * OrdersModule -> (this module, once Task 6/7 wire it) -> HandoverModule closes
 * a long cycle through 4 modules. forwardRef here is cheap insurance — mirrors
 * OrdersModule's own forwardRef(() => RoutingModule) for the same reason.
 *
 * BullModule.registerQueue + the RUN_WORKERS-gated processor provider mirror
 * EmailModule's EMAIL_QUEUE registration exactly (same defaultJobOptions
 * shape) — see OrderProtocolEmailProcessor's rationale comment.
 */
@Module({
  imports: [
    forwardRef(() => HandoverModule),
    BullModule.registerQueue({
      name: PROTOCOL_EMAIL_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    }),
  ],
  providers: [
    OrderProtocolEmailService,
    HandoverProtocolAttachmentResolver,
    { provide: PROTOCOL_ATTACHMENT_RESOLVER, useExisting: HandoverProtocolAttachmentResolver },
    ...(RUN_WORKERS ? [OrderProtocolEmailProcessor] : []),
  ],
  exports: [OrderProtocolEmailService, PROTOCOL_ATTACHMENT_RESOLVER],
})
export class OrderProtocolEmailModule {}
