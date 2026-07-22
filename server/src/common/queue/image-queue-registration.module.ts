import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IMAGE_QUEUE } from './queue.constants';

const imageQueue = BullModule.registerQueue({
  name: IMAGE_QUEUE,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: true,
    removeOnFail: 200,
  },
});

/** Single source of truth for the producer-side IMAGE_QUEUE job options.
 *  (image-queue.module / platform.module keep their bare registrations deliberately.) */
@Module({ imports: [imageQueue], exports: [imageQueue] })
export class ImageQueueRegistrationModule {}
