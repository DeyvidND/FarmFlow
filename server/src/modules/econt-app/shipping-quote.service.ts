import { Injectable } from '@nestjs/common';
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';
import { CompareShipmentDto } from './dto/compare-shipment.dto';
import { buildQuoteResult, type QuoteResult } from './shipping-quote.helpers';

// Shared default weight (grams) when the producer leaves it blank. Applied to BOTH
// carriers so the compare always prices the SAME parcel — otherwise each carrier
// would fall back to its own stored default package weight and the prices wouldn't
// be like-for-like.
const DEFAULT_WEIGHT_GRAMS = 1000;

/**
 * Cross-carrier price comparison. Estimates Econt + Speedy in parallel for one
 * courier-neutral destination and returns sorted quotes + the cheapest carrier.
 * Each estimate degrades to null independently (never throws), so one carrier
 * being down still returns the other's price. v1 prices at city level, and always
 * at the same weight for both carriers (a fair compare).
 */
@Injectable()
export class ShippingQuoteService {
  constructor(
    private readonly econt: EcontService,
    private readonly speedy: SpeedyService,
  ) {}

  async compare(tenantId: string, input: CompareShipmentDto): Promise<QuoteResult> {
    // Resolve one weight up front and price both carriers at it (fair compare).
    const weightGrams = input.weightGrams ?? DEFAULT_WEIGHT_GRAMS;
    const [econtRes, speedyRes] = await Promise.allSettled([
      this.econtEstimate(tenantId, input, weightGrams),
      this.speedyEstimate(tenantId, input, weightGrams),
    ]);
    const econtStotinki = econtRes.status === 'fulfilled' ? econtRes.value : null;
    const speedyStotinki = speedyRes.status === 'fulfilled' ? speedyRes.value : null;
    return buildQuoteResult(econtStotinki, speedyStotinki);
  }

  /** Econt city-level estimate (door-to-city), priced at the shared weight. */
  private async econtEstimate(tenantId: string, input: CompareShipmentDto, weightGrams: number): Promise<number | null> {
    const order = {
      customerName: '—',
      customerPhone: '—',
      // City-level estimate for both modes (no office code needed → always prices).
      deliveryType: 'econt_address' as const,
      econtOffice: null,
      deliveryAddress: input.destinationCity,
      deliveryCity: input.destinationCity,
      totalStotinki: null,
    };
    return this.econt.estimateShipping(tenantId, order, [], weightGrams / 1000);
  }

  /** Speedy city-level estimate: resolve the typed city → siteId, then /calculate. */
  private async speedyEstimate(tenantId: string, input: CompareShipmentDto, weightGrams: number): Promise<number | null> {
    try {
      const sites = await this.speedy.searchSites(tenantId, input.destinationCity);
      const siteId = sites[0]?.id;
      if (!siteId) return null;
      return await this.speedy.estimateShipping(tenantId, { siteId, weightGrams });
    } catch {
      // searchSites throws when Speedy isn't configured for this tenant → unavailable.
      return null;
    }
  }
}
