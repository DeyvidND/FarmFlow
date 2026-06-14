import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantsService } from '../tenants/tenants.service';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';
import { ReviewsService } from '../reviews/reviews.service';
import { AvailabilityService } from '../availability/availability.service';
import { resolveProductOfWeek } from './product-of-week';

/**
 * One-shot storefront bootstrap: profile + catalog + farmers + sections in a
 * single round trip. Each underlying read is Redis-cached, so a warm hit costs
 * no Postgres queries. Lets a remotely-hosted storefront paint its home page
 * from one request instead of four (round-trip latency dominates over the wire).
 */
@ApiTags('public')
@Controller('public/:slug/bootstrap')
export class PublicBootstrapController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly products: ProductsService,
    private readonly farmers: FarmersService,
    private readonly subcategories: SubcategoriesService,
    private readonly reviews: ReviewsService,
    private readonly availability: AvailabilityService,
  ) {}

  @ApiOperation({
    summary: 'Storefront bootstrap bundle (profile + products + farmers + subcategories)',
  })
  @Get()
  async bootstrap(@Param('slug') slug: string) {
    const [storefront, products, farmers, subcategories, homeReviews, availability] =
      await Promise.all([
        this.tenants.findPublicProfileBySlug(slug),
        this.products.findPublicBySlug(slug),
        this.farmers.findPublicBySlug(slug),
        this.subcategories.findPublicBySlug(slug),
        this.reviews.findHomeReviews(slug),
        this.availability.findPublicActiveBySlug(slug),
      ]);
    // Resolve the optional «Продукт на седмицата» highlight from the tenant config
    // against the (already active, ordered) public catalog.
    const productOfWeek = resolveProductOfWeek(storefront, products, new Date());
    return { storefront, products, farmers, subcategories, productOfWeek, homeReviews, availability };
  }
}
