import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ProductsService } from './products.service';
import { ProductsController, PublicProductsController } from './products.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';
import { AvailabilityModule } from '../availability/availability.module';
import { PRODUCTS_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
import { ProductsProcessor } from './products.processor';
import { ImageSanityVisionClient } from './image-sanity-vision.client';
import { ImageQueueRegistrationModule } from '../../common/queue/image-queue-registration.module';

@Module({
  imports: [
    CatalogCacheModule,
    AvailabilityModule,
    ImageQueueRegistrationModule,
    BullModule.registerQueue({
      name: PRODUCTS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [ProductsController, PublicProductsController],
  providers: [ProductsService, ImageSanityVisionClient, ...(RUN_WORKERS ? [ProductsProcessor] : [])],
  exports: [ProductsService],
})
export class ProductsModule {}
