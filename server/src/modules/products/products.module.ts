import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController, PublicProductsController } from './products.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';

@Module({
  imports: [CatalogCacheModule],
  controllers: [ProductsController, PublicProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
