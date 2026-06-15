import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FarmersService } from './farmers.service';
import { FarmersController, PublicFarmersController } from './farmers.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';
import { AuthModule } from '../auth/auth.module';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';

@Module({
  imports: [
    CatalogCacheModule,
    AuthModule,
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
  controllers: [FarmersController, PublicFarmersController],
  providers: [FarmersService],
  exports: [FarmersService],
})
export class FarmersModule {}
