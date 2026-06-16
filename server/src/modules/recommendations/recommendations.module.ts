import { Module } from '@nestjs/common';
import { RecommendationsService } from './recommendations.service';
import { PublicRecommendationsController } from './recommendations.controller';
import { ProductsModule } from '../products/products.module';
import { AvailabilityModule } from '../availability/availability.module';

/**
 * Sales-derived merchandising: the best-sellers ranking + the cart's
 * bought-together picks. Reuses the products + availability read services to map
 * sales data onto the cached public catalog; the Postgres handle and Redis cache
 * come from the global Drizzle / public-cache modules.
 */
@Module({
  imports: [ProductsModule, AvailabilityModule],
  controllers: [PublicRecommendationsController],
  providers: [RecommendationsService],
  exports: [RecommendationsService],
})
export class RecommendationsModule {}
