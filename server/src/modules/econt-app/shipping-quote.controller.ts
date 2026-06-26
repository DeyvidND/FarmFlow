import { Controller, Post, Body, UseGuards, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ShippingQuoteService } from './shipping-quote.service';
import { CompareShipmentDto } from './dto/compare-shipment.dto';
import { AddressSuggestDto } from './dto/address-suggest.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { MapsService } from '../../common/maps/maps.service';

@UseGuards(JwtAuthGuard)
@Controller('shipping')
export class ShippingQuoteController {
  constructor(
    private readonly quote: ShippingQuoteService,
    private readonly maps: MapsService,
  ) {}

  // Pre-purchase price comparison — JWT only (NOT activation-gated; showing prices
  // to unactivated accounts drives conversion). Throttled — hits two courier APIs.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('compare')
  compare(@CurrentTenant() t: string, @Body() dto: CompareShipmentDto) {
    return this.quote.compare(t, dto);
  }

  // Address autocomplete for the import editor — JWT only, throttled. Proxies Google
  // Places so the key stays server-side and billing is session-grouped on the client.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @Post('address-suggest')
  addressSuggest(@Body() dto: AddressSuggestDto) {
    return this.maps.placeAutocomplete(dto.query, dto.sessionToken ?? '');
  }
}
