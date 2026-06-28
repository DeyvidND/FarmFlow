import { Controller, Post, Param, Body, Inject, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type Database } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { ShippingQuoteService } from './shipping-quote.service';
import { CompareShipmentDto } from './dto/compare-shipment.dto';

/**
 * Public, slug-scoped carrier price comparison for the storefront checkout.
 * Anonymous + throttled. Only quotes when the farm runs BOTH carriers
 * (comparisonActive); otherwise returns empty quotes so the storefront falls
 * back to its single-carrier flat fee. Keeps the feature dark for single-carrier farms.
 */
@ApiTags('public')
@Controller('public/:slug/shipping')
export class PublicShippingQuoteController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly tenantCache: PublicCacheService,
    private readonly quote: ShippingQuoteService,
  ) {}

  // Hits two courier APIs — throttle hard. 30/min/IP.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('compare')
  async compare(@Param('slug') slug: string, @Body() dto: CompareShipmentDto) {
    const meta = await this.tenantCache.resolveTenant(this.db, slug);
    if (!meta.comparisonActive) {
      return { quotes: [], cheapest: null, policy: meta.carrierPolicy, selected: null };
    }
    return this.quote.compare(meta.id, dto, meta.carrierPolicy);
  }
}
