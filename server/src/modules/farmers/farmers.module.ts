import { Module } from '@nestjs/common';
import { FarmersService } from './farmers.service';
import { FarmersController, PublicFarmersController } from './farmers.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';

@Module({
  imports: [CatalogCacheModule],
  controllers: [FarmersController, PublicFarmersController],
  providers: [FarmersService],
})
export class FarmersModule {}
