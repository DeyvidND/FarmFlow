import { Module } from '@nestjs/common';
import { FarmersService } from './farmers.service';
import { FarmersController, PublicFarmersController } from './farmers.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [CatalogCacheModule, AuthModule],
  controllers: [FarmersController, PublicFarmersController],
  providers: [FarmersService],
  exports: [FarmersService],
})
export class FarmersModule {}
