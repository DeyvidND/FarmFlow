import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RoutingService, parseEndModes, type RouteEndMode } from './routing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SetStopLocationDto } from './dto/set-stop-location.dto';
import { ReverseGeocodeQueryDto } from './dto/reverse-geocode-query.dto';
import { SuggestDaysDto } from './dto/suggest-days.dto';
import { MeasureOrderDto } from './dto/measure-order.dto';
import { SetOrderCourierDto } from './dto/set-order-courier.dto';
import {
  DeliveryWindowDayDto,
  UpdateDeliveryWindowDto,
} from './dto/delivery-window.dto';

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

  // Task #5 — road geometry + totals for an EXPLICIT operator-chosen stop order
  // (after a manual reorder / courier move). No re-optimization: the map gets a
  // real street-following polyline for the given sequence instead of straight
  // pin-to-pin lines. Multi-segment path so OrdersModule's `:id` can't catch it.
  @Post('route/measure')
  @UseGuards(ActiveSubscriptionGuard)
  measure(@CurrentTenant() tenantId: string, @Body() dto: MeasureOrderDto) {
    return this.routingService.measureExplicitOrder(
      tenantId,
      dto.date,
      dto.stopIds,
      dto.courierIndex,
      dto.endMode,
    );
  }

  // Task #6 — pin an order to a courier (or clear the pin). The route recomputes
  // on the client's next fetch, honouring the pin.
  @Patch('route/order/:id/courier')
  @UseGuards(ActiveSubscriptionGuard)
  setOrderCourier(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() dto: SetOrderCourierDto,
  ) {
    return this.routingService.setOrderCourier(tenantId, id, dto.courierIndex);
  }

  // Task #13 — generate a draft delivery time-window per order for the day from
  // the optimized per-courier routes. Returns the proposal for review.
  @Post('route/windows/generate')
  @UseGuards(ActiveSubscriptionGuard)
  generateWindows(@CurrentTenant() tenantId: string, @Body() dto: DeliveryWindowDayDto) {
    return this.routingService.generateDeliveryWindows(
      tenantId,
      dto.date,
      dto.couriers,
      parseEndModes(dto.ends),
    );
  }

  // Task #13 — operator lightly edits one order's generated window.
  @Patch('route/window/:id')
  @UseGuards(ActiveSubscriptionGuard)
  updateWindow(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryWindowDto,
  ) {
    return this.routingService.updateDeliveryWindow(tenantId, id, { start: dto.start, end: dto.end });
  }

  // Task #13 — approve the day's draft windows (ready to notify).
  @Post('route/windows/approve')
  @UseGuards(ActiveSubscriptionGuard)
  approveWindows(@CurrentTenant() tenantId: string, @Body() dto: DeliveryWindowDayDto) {
    return this.routingService.approveDeliveryWindows(tenantId, dto.date);
  }

  // Task #13 — email each customer their approved delivery window.
  @Post('route/windows/notify')
  @UseGuards(ActiveSubscriptionGuard)
  notifyWindows(@CurrentTenant() tenantId: string, @Body() dto: DeliveryWindowDayDto) {
    return this.routingService.notifyDeliveryWindows(tenantId, dto.date);
  }

  // Geography-first proposal to spread pending address orders across the given
  // days. Read-only (no mutation) — the client applies it via /orders/reschedule.
  @Post('suggest-days')
  @UseGuards(ActiveSubscriptionGuard)
  @Roles('admin')
  suggestDays(@CurrentTenant() tenantId: string, @Body() dto: SuggestDaysDto) {
    return this.routingService.suggestDays(tenantId, dto.days);
  }
}
