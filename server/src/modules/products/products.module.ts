import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ProductsService } from './products.service';
import { ProductsController, PublicProductsController } from './products.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';
import { AvailabilityModule } from '../availability/availability.module';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';

@Module({
  imports: [
    CatalogCacheModule,
    AvailabilityModule,
    BullModule.registerQueue({
      name: IMAGE_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [ProductsController, PublicProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
