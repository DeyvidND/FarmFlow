import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantsService } from '../tenants/tenants.service';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';
import { ReviewsService } from '../reviews/reviews.service';
import { AvailabilityService } from '../availability/availability.service';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { PublicCacheService, publicCacheKeys, BOOTSTRAP_BUNDLE_TTL } from '../../common/cache/public-cache.service';
import { resolveProductOfWeek } from './product-of-week';
import { resolveFarmerOfWeek } from './farmer-of-week';

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
    private readonly recommendations: RecommendationsService,
    private readonly cache: PublicCacheService,
  ) {}

  @ApiOperation({
    summary: 'Storefront bootstrap bundle (profile + products + farmers + subcategories)',
  })
  // The handler returns a pre-serialized JSON *string* (from cache or freshly
  // stringified), so set the content type explicitly — otherwise Nest sends it as
  // text/plain. The compression middleware still gzips the body and Express still
  // computes the ETag, so conditional 304s and the wire savings are unaffected.
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Get()
  async bootstrap(@Param('slug') slug: string): Promise<string> {
    // Warm hit: return the assembled bundle bytes directly — no sub-cache fan-out,
    // no parse, no re-stringify. This is the dominant cost at the saturation point.
    const cacheKey = publicCacheKeys.bootstrap(slug);
    const cached = await this.cache.getString(cacheKey);
    if (cached !== null) return cached;

    const [storefront, products, farmers, subcategories, homeReviews, availability, bestSellerIds] =
      await Promise.all([
        this.tenants.findPublicProfileBySlug(slug),
        this.products.findPublicBySlug(slug),
        this.farmers.findPublicBySlug(slug),
        this.subcategories.findPublicBySlug(slug),
        this.reviews.findHomeReviews(slug),
        this.availability.findPublicActiveBySlug(slug),
        // Sales-ranked ids for the „Най-продавани" chip — self-gated on the
        // merchandising toggle (returns [] when the chip is off).
        this.recommendations.bestSellerIdsBySlug(slug),
      ]);
    // Resolve the optional «Продукт на седмицата» highlight from the tenant config
    // against the (already active, ordered) public catalog.
    const productOfWeek = resolveProductOfWeek(storefront, products, new Date());
    const farmerOfWeek = resolveFarmerOfWeek(storefront.farmerOfWeek, farmers);
    const json = JSON.stringify({
      storefront,
      products,
      farmers,
      subcategories,
      productOfWeek,
      farmerOfWeek,
      homeReviews,
      availability,
      bestSellerIds,
    });
    // Self-expiring short TTL (see BOOTSTRAP_BUNDLE_TTL). An unknown slug throws
    // 404 from findPublicProfileBySlug above, so only real bundles are cached.
    await this.cache.setString(cacheKey, json, BOOTSTRAP_BUNDLE_TTL);
    return json;
  }
}
