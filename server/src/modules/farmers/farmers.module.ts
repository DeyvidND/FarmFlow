import { Module } from '@nestjs/common';
import { FarmersService } from './farmers.service';
import { FarmersController, PublicFarmersController } from './farmers.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';
import { AuthModule } from '../auth/auth.module';
import { ImageQueueRegistrationModule } from '../../common/queue/image-queue-registration.module';

@Module({
  imports: [CatalogCacheModule, AuthModule, ImageQueueRegistrationModule],
  controllers: [FarmersController, PublicFarmersController],
  providers: [FarmersService],
  exports: [FarmersService],
})
export class FarmersModule {}
