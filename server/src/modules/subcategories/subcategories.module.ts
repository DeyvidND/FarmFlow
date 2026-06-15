import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SubcategoriesService } from './subcategories.service';
import {
  SubcategoriesController,
  PublicSubcategoriesController,
} from './subcategories.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';

@Module({
  imports: [
    CatalogCacheModule,
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
  controllers: [SubcategoriesController, PublicSubcategoriesController],
  providers: [SubcategoriesService],
  exports: [SubcategoriesService],
})
export class SubcategoriesModule {}
