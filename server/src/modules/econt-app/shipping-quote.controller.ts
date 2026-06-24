import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ShippingQuoteService } from './shipping-quote.service';
import { CompareShipmentDto } from './dto/compare-shipment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@UseGuards(JwtAuthGuard)
@Controller('shipping')
export class ShippingQuoteController {
  constructor(private readonly quote: ShippingQuoteService) {}

  // Pre-purchase price comparison — JWT only (NOT activation-gated; showing prices
  // to unactivated accounts drives conversion). Throttled — hits two courier APIs.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('compare')
  compare(@CurrentTenant() t: string, @Body() dto: CompareShipmentDto) {
    return this.quote.compare(t, dto);
  }
}
