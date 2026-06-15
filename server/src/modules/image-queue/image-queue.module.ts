import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
import { ImageProcessor } from './image.processor';
import { ProductsModule } from '../products/products.module';
import { FarmersModule } from '../farmers/farmers.module';
import { SubcategoriesModule } from '../subcategories/subcategories.module';

// One-directional imports (these modules export their services; none import this
// one → no cycle). Processor loads only on worker-role copies.
@Module({
  imports: [
    BullModule.registerQueue({ name: IMAGE_QUEUE }),
    ProductsModule,
    FarmersModule,
    SubcategoriesModule,
  ],
  providers: [...(RUN_WORKERS ? [ImageProcessor] : [])],
})
export class ImageQueueModule {}
