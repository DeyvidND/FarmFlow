import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RoutingService, parseEndModes, type RouteEndMode } from './routing.service';
import { CourierAssignmentService } from './courier-assignment.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { TenantRequestUser } from '@fermeribg/types';
import { SetStopLocationDto } from './dto/set-stop-location.dto';
import { ReverseGeocodeQueryDto } from './dto/reverse-geocode-query.dto';
import { SuggestDaysDto } from './dto/suggest-days.dto';
import { MeasureOrderDto } from './dto/measure-order.dto';
import { SetOrderCourierDto } from './dto/set-order-courier.dto';
import { SetOrderSequenceDto } from './dto/set-order-sequence.dto';
import { RebalanceRouteDto } from './dto/rebalance-route.dto';
import { AssignmentsQueryDto, SetAssignmentsDto } from './dto/courier-assignment.dto';
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
    private readonly courierAssignmentService: CourierAssignmentService,
  ) {}

  // Task C3 — opened to role='driver'. A driver has no business choosing courier
  // count or overriding end modes (operator-only route-shape decisions), so those
  // query params are ignored for them and the result is filtered to their own leg.
  @Get('route')
  @UseGuards(ActiveSubscriptionGuard)
  @Roles('admin', 'driver')
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'end', required: false, enum: ['home', 'last', 'custom'] })
  @ApiQuery({ name: 'ends', required: false, description: 'Per-courier end modes, csv e.g. home,last' })
  @ApiQuery({ name: 'couriers', required: false, description: '1–10; default 1' })
  async getRoute(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Query('date') date?: string,
    @Query('end') end?: string,
    @Query('couriers') couriers?: string,
    @Query('ends') ends?: string,
  ) {
    const isDriver = user.role === 'driver';
    const endMode: RouteEndMode | undefined =
      end === 'home' || end === 'last' || end === 'custom' ? end : undefined;
    const parsed = couriers ? parseInt(couriers, 10) : undefined;
    const endModes = parseEndModes(ends);
    const result = await this.routingService.getRoute(
      tenantId,
      date,
      endMode,
      isDriver ? undefined : (Number.isFinite(parsed) ? parsed : undefined),
      isDriver ? undefined : endModes,
    );
    if (!isDriver) return result;
    // Task A3 — the driver's leg is resolved per DATE via the per-day
    // assignment board (Task A2's resolveMyLeg), replacing the JWT's global,
    // date-less `user.courierIndex`. A driver not assigned on `date` (or no
    // date given) gets the "не участва днес" empty state; `couriers` is kept
    // in sync with the filtered `routes.length` — it's documented as the
    // effective count of `routes`, and a client trusting that invariant
    // (Task C4/C5) shouldn't see a stale tenant-wide count here.
    const myLeg = date
      ? await this.courierAssignmentService.resolveMyLeg(tenantId, user.userId, date)
      : null;
    if (myLeg == null) return { ...result, routes: [], couriers: 0 };
    const routes = result.routes.filter((r) => r.courierIndex === myLeg);
    return { ...result, routes, couriers: routes.length };
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
  // Task C3 — opened to role='driver'. dto.courierIndex is ignored for them and
  // forced to their own. dto.stopIds is also checked against the driver's own
  // leg (via getRoute) — courierIndex alone only picks which saved end config
  // applies, it doesn't scope which orders' coords get measured, so without
  // this check a driver could pass another courier's order ids and read back
  // that leg's polyline/distance.
  // Task A3 — the driver's own leg is now resolved per DATE via
  // resolveMyLeg(tenantId, user.userId, dto.date) (Task A2), not the JWT's
  // global `user.courierIndex`. A driver with no date, or unassigned on that
  // date, resolves to null: they own no stops that day, so any non-empty
  // stopIds is rejected below and the resolved courierIndex passed downstream
  // is undefined.
  @Post('route/measure')
  @UseGuards(ActiveSubscriptionGuard)
  @Roles('admin', 'driver')
  async measure(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: MeasureOrderDto,
  ) {
    const isDriver = user.role === 'driver';
    const myLeg =
      isDriver && dto.date
        ? await this.courierAssignmentService.resolveMyLeg(tenantId, user.userId, dto.date)
        : null;
    const courierIndex = isDriver ? myLeg ?? undefined : dto.courierIndex;
    if (isDriver && dto.stopIds.length > 0) {
      const own = await this.routingService.getRoute(tenantId, dto.date, dto.endMode);
      const ownIds = new Set(
        own.routes.filter((r) => r.courierIndex === myLeg).flatMap((r) => r.stops.map((s) => s.id)),
      );
      if (dto.stopIds.some((id) => !ownIds.has(id))) {
        throw new ForbiddenException('Не може да измервате чужд маршрут.');
      }
    }
    return this.routingService.measureExplicitOrder(
      tenantId,
      dto.date,
      dto.stopIds,
      courierIndex,
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

  // Reset the day to full auto-distribution — clears every manual courier pin
  // and manual stop order for the date, so the next route fetch re-splits by
  // geography. Admin-only by default (no @Roles), like the pin/sequence
  // endpoints above. Multi-segment path so OrdersModule's `:id` can't catch it.
  @Patch('route/rebalance')
  @UseGuards(ActiveSubscriptionGuard)
  rebalanceRoute(@CurrentTenant() tenantId: string, @Body() dto: RebalanceRouteDto) {
    return this.routingService.resetDayOverrides(tenantId, dto.date);
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

  // Task A2 — the per-day leg board: which account (driver login or the
  // owner's own account) runs which leg on a given date. Multi-segment path
  // so OrdersModule's `:id` can't capture it (mirrors the other route/* routes).
  @Get('route/assignments')
  @Roles('admin')
  getAssignments(@CurrentTenant() tenantId: string, @Query() q: AssignmentsQueryDto) {
    return this.courierAssignmentService.getAssignmentsForDay(tenantId, q.date);
  }

  @Put('route/assignments')
  @Roles('admin')
  setAssignments(@CurrentTenant() tenantId: string, @Body() dto: SetAssignmentsDto) {
    return this.courierAssignmentService.setAssignmentsForDay(tenantId, dto.date, dto.assignments);
  }

  // Read-only roster for the farmer: drivers + own account. Feeds the
  // read-only courier-homes view and the assignment board. Deliberately a
  // NEW tenant-scoped endpoint, NOT the platform listAccess (which is behind
  // PlatformAdminGuard + takes an explicit tenantId — a farmer session can't
  // and shouldn't reach it; cross-tenant foot-gun).
  @Get('route/couriers')
  @Roles('admin')
  listCouriers(@CurrentTenant() tenantId: string, @CurrentUser() user: TenantRequestUser) {
    return this.courierAssignmentService.listTenantCouriers(tenantId, user.userId);
  }
}
