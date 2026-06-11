import { Module } from '@nestjs/common';
import { PublicBootstrapController } from './public-bootstrap.controller';
import { TenantsModule } from '../tenants/tenants.module';
import { ProductsModule } from '../products/products.module';
import { FarmersModule } from '../farmers/farmers.module';
import { SubcategoriesModule } from '../subcategories/subcategories.module';
import { ReviewsModule } from '../reviews/reviews.module';

/**
 * Composes the existing public read services behind a single `/bootstrap`
 * endpoint. Imports the feature modules (which export their services); adds no
 * data access of its own.
 */
@Module({
  imports: [TenantsModule, ProductsModule, FarmersModule, SubcategoriesModule, ReviewsModule],
  controllers: [PublicBootstrapController],
})
export class PublicBootstrapModule {}
