import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DigestService } from './digest.service';
import { DigestController } from './digest.controller';
import { DigestProcessor } from './digest.processor';
import { DIGEST_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  imports: [BullModule.registerQueue({ name: DIGEST_QUEUE })],
  controllers: [DigestController],
  providers: [DigestService, ...(RUN_WORKERS ? [DigestProcessor] : [])],
})
export class DigestModule {}
