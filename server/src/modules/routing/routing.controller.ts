import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RoutingService, parseEndModes, type RouteEndMode } from './routing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { SetStopLocationDto } from './dto/set-stop-location.dto';
import { ReverseGeocodeQueryDto } from './dto/reverse-geocode-query.dto';

// NOTE: RoutingModule is imported before OrdersModule in app.module so this
// literal `/orders/route` route registers before OrdersModule's `/orders/:id`.
@ApiTags('routing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class RoutingController {
  constructor(private readonly routingService: RoutingService) {}

  @Get('route')
  @UseGuards(ActiveSubscriptionGuard)
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'end', required: false, enum: ['home', 'last', 'custom'] })
  @ApiQuery({ name: 'ends', required: false, description: 'Per-courier end modes, csv e.g. home,last' })
  @ApiQuery({ name: 'couriers', required: false, description: '1–10; default 1' })
  getRoute(
    @CurrentTenant() tenantId: string,
    @Query('date') date?: string,
    @Query('end') end?: string,
    @Query('couriers') couriers?: string,
    @Query('ends') ends?: string,
  ) {
    const endMode: RouteEndMode | undefined =
      end === 'home' || end === 'last' || end === 'custom' ? end : undefined;
    const parsed = couriers ? parseInt(couriers, 10) : undefined;
    const endModes = parseEndModes(ends);
    return this.routingService.getRoute(
      tenantId,
      date,
      endMode,
      Number.isFinite(parsed) ? parsed : undefined,
      endModes,
    );
  }

  // Fix a stop with no map pin: re-geocode a corrected address, or save a manual
  // pin. Multi-segment path so it can't be captured by OrdersModule's `:id`.
  @Patch('route/stop/:id')
  @UseGuards(ActiveSubscriptionGuard)
  setStopLocation(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() dto: SetStopLocationDto,
  ) {
    return this.routingService.setStopLocation(tenantId, id, dto);
  }

  // Reverse geocode a map point to an address — used by the route stop editor's
  // embedded pick-map. No tenant-scoped data involved (pure Google passthrough);
  // gated the same way as the sibling route endpoints to avoid an open proxy.
  @Get('route/reverse-geocode')
  @UseGuards(ActiveSubscriptionGuard)
  reverseGeocode(@Query() dto: ReverseGeocodeQueryDto) {
    return this.routingService.reverseGeocode(dto.lat, dto.lng);
  }
}
