import { Controller, Post, Param, Body, Inject, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { MapsService } from '../../common/maps/maps.service';
import { ShippingQuoteService } from './shipping-quote.service';
import { CompareShipmentDto } from './dto/compare-shipment.dto';

/** Whether a hand-typed address looks like a real street line — a street name
 *  (≥3 letters after stripping digits/punctuation) plus a house/block number —
 *  rather than a bare city or garbage. Mirrors the storefront's identically-named
 *  guard (chaika checkout-page.ts) so the geocoded quote matches what the order
 *  will actually submit, and so a geocode is never spent on ungeocodable input. */
function looksLikeStreetAddress(s: string): boolean {
  const hasNumber = /\d/.test(s);
  const hasName = s.replace(/[\s\d.,№#/\\-]/g, '').length >= 3;
  return hasNumber && hasName;
}

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
    private readonly maps: MapsService,
  ) {}

  // Hits two courier APIs + (typed-address path only) a billable Google geocode —
  // throttle hard. 15/min/IP (tighter than the JWT admin /shipping/compare, which
  // never geocodes and stays at 30/min).
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @HttpCode(200)
  @Post('compare')
  async compare(@Param('slug') slug: string, @Body() dto: CompareShipmentDto) {
    const meta = await this.tenantCache.resolveTenant(this.db, slug);
    const empty = { quotes: [], cheapest: null, policy: meta.carrierPolicy, selected: null };
    if (!meta.comparisonActive) return empty;

    let city = dto.destinationCity?.trim() || null;
    if (!city && dto.destinationAddress) {
      city = await this.resolveCityFromAddress(meta.id, dto.destinationAddress.trim());
    }
    if (!city) return empty; // garbage input / geocode miss → storefront keeps its flat estimate

    return this.quote.compare(meta.id, { ...dto, destinationCity: city }, meta.carrierPolicy, meta.courierMarkupStotinki);
  }

  /** Resolve a settlement name from a hand-typed address, biased to the farm's
   *  region — same `MapsService.geocodeCity()` + 30-day Redis cache OrdersService
   *  already uses for a no-pick econt_address/courier order. A shape gate runs
   *  first so ungeocodable garbage never reaches (billable) Google Geocoding. */
  private async resolveCityFromAddress(tenantId: string, address: string): Promise<string | null> {
    if (!looksLikeStreetAddress(address)) return null;
    const [row] = await this.db
      .select({ farmLat: tenants.farmLat, farmLng: tenants.farmLng })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const fLat = row?.farmLat == null ? null : Number(row.farmLat);
    const fLng = row?.farmLng == null ? null : Number(row.farmLng);
    const bias = fLat != null && fLng != null ? { lat: fLat, lng: fLng } : undefined;
    return this.maps.geocodeCity(address, bias);
  }
}
