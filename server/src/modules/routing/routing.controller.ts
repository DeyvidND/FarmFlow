import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RoutingService, parseEndModes, type RouteEndMode } from './routing.service';
import { CourierAccessService } from './courier-access.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SetStopLocationDto } from './dto/set-stop-location.dto';
import { ReverseGeocodeQueryDto } from './dto/reverse-geocode-query.dto';
import { SuggestDaysDto } from './dto/suggest-days.dto';
import { MeasureOrderDto } from './dto/measure-order.dto';
import { SetOrderCourierDto } from './dto/set-order-courier.dto';
import { SetOrderSequenceDto } from './dto/set-order-sequence.dto';
import { GrantCourierAccessDto } from './dto/courier-access.dto';
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
  constructor(
    private readonly routingService: RoutingService,
    private readonly courierAccessService: CourierAccessService,
  ) {}

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
      dto.startLat != null && dto.startLng != null
        ? { lat: dto.startLat, lng: dto.startLng }
        : undefined,
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

  // Persist the operator's manual stop order for one courier leg (route_seq)
  // so getRoute honours it instead of always re-optimizing. Empty stopIds
  // clears the override. Multi-segment path so OrdersModule's `:id` can't
  // catch it (mirrors route/measure and route/order/:id/courier above).
  @Patch('route/order/sequence')
  @UseGuards(ActiveSubscriptionGuard)
  setOrderSequence(@CurrentTenant() tenantId: string, @Body() dto: SetOrderSequenceDto) {
    return this.routingService.setOrderSequence(tenantId, dto.courierIndex, dto.stopIds);
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

  // Task C2 — admin-only grant/revoke/list of role='driver' logins bound to a
  // courier leg. Explicit @Roles('admin') even though that's already the
  // guard's default (mirrors suggestDays above) — this is a security-sensitive
  // account-management surface.
  @Get('route/courier-access')
  @Roles('admin')
  listCourierAccess(@CurrentTenant() tenantId: string) {
    return this.courierAccessService.listAccess(tenantId);
  }

  @Post('route/courier-access')
  @Roles('admin')
  grantCourierAccess(
    @CurrentTenant() tenantId: string,
    @Body() dto: GrantCourierAccessDto,
  ) {
    return this.courierAccessService.grantAccess(tenantId, dto.courierIndex, dto.email);
  }

  @Delete('route/courier-access/:index')
  @Roles('admin')
  revokeCourierAccess(
    @CurrentTenant() tenantId: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.courierAccessService.revokeAccess(tenantId, index);
  }
}
