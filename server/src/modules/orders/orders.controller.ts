import {
  Controller, Get, Post, Patch,
  Param, Body, Query, UseGuards,
  ParseUUIDPipe, BadRequestException, ForbiddenException,
  Inject, forwardRef,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OrdersService, applyRouteOrder, type PrepSummary } from './orders.service';
import { CheckoutService } from './checkout.service';
import { RoutingService } from '../routing/routing.service';
import { CourierAssignmentService } from '../routing/courier-assignment.service';
import { bgDateOf, bgToday, bgAddDays } from '../../common/time/bg-time';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateCodOutcomeDto } from './dto/update-cod-outcome.dto';
import { UpdateFulfillmentDto } from './dto/update-fulfillment.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { PaymentsQueryDto } from './dto/payments-query.dto';
import { OrdersQueryDto } from './dto/orders-query.dto';
import { MyOrdersQueryDto } from './dto/my-orders-query.dto';
import { RescheduleOrdersDto } from './dto/reschedule-orders.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    @Inject(forwardRef(() => RoutingService)) private readonly routingService: RoutingService,
    @Inject(forwardRef(() => CourierAssignmentService))
    private readonly courierAssignmentService: CourierAssignmentService,
  ) {}

  /**
   * Own-leg ownership check for a driver (role='driver'), reusing the same
   * recompute+check pattern as POST /orders/route/measure: resolve the
   * driver's leg for the order's day via CourierAssignmentService.resolveMyLeg
   * (Task A2's date-scoped assignment board — NOT the JWT's frozen
   * `user.courierIndex`, retired from auth by Task A4), then recompute the
   * route for that day and verify the order is on the resolved leg. A driver
   * with no assignment for that date (`resolveMyLeg` → null) owns no stops
   * and is denied before the route is even recomputed.
   * `statuses: ['confirmed', 'delivered']` (not the route screen's
   * 'confirmed'-only default) so a driver can still revert an order they just
   * marked delivered — which would otherwise have already dropped off a
   * 'confirmed'-only recompute, wrongly 403ing the undo-accidental-finish flow.
   */
  private async assertDriverOwnsOrder(
    tenantId: string,
    user: TenantRequestUser,
    order: { id: string; slotDate: string | null; createdAt: Date | string | null },
  ): Promise<void> {
    const day = order.slotDate ?? bgDateOf(new Date(order.createdAt ?? Date.now()));
    const myLeg = await this.courierAssignmentService.resolveMyLeg(tenantId, user.userId, day);
    if (myLeg == null) {
      throw new ForbiddenException('Нямате достъп до тази поръчка.');
    }
    // 'all' — an order the driver just marked delivered must still resolve to
    // their own leg. (The partition no longer depends on this: it is always the
    // day's confirmed+delivered basis. This only asks to SEE the finished stops.)
    const own = await this.routingService.getRoute(tenantId, day, undefined, undefined, undefined, 'all');
    const ownIds = new Set(
      own.routes.filter((r) => r.courierIndex === myLeg).flatMap((r) => r.stops.map((s) => s.id)),
    );
    if (!ownIds.has(order.id)) {
      throw new ForbiddenException('Нямате достъп до тази поръчка.');
    }
  }

  @Get()
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'date', required: false })
  findAll(@CurrentTenant() tenantId: string, @Query() q: OrdersQueryDto) {
    return this.ordersService.findAll(tenantId, {
      page: q.page,
      limit: q.limit,
      status: q.status,
      q: q.q,
      date: q.date,
    });
  }

  // Declared before `:id` routes so the literal segment wins.
  @Patch('confirm-pending')
  @ApiQuery({ name: 'date', required: false })
  confirmPending(@CurrentTenant() tenantId: string, @Query('date') date?: string) {
    return this.ordersService.confirmPending(tenantId, date);
  }

  // Literal route — declared before `:id` so it isn't captured as an order id.
  // All order money (наложен платеж + card) for the Плащания screen: keyset page
  // + method filter (all/cod) + free-text search. Opened to producer sub-accounts
  // (role='farmer'), who see only the payments attributable to THEIR line items —
  // mirroring how /stats scopes turnover (effectiveFarmerId + a producer-scoped
  // service method). A producer is always forced to its own farmerId; the owner
  // may optionally narrow to one producer via ?farmerId.
  @Get('payments')
  @Roles('admin', 'farmer')
  @ApiQuery({ name: 'method', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  payments(@CurrentUser() user: TenantRequestUser, @Query() query: PaymentsQueryDto) {
    const scope = effectiveFarmerId(user.role, user.farmerId, query.farmerId);
    return scope
      ? this.ordersService.paymentsForFarmer(user.tenantId, scope, query)
      : this.ordersService.payments(user.tenantId, query);
  }

  // Literal route — must precede `:id` so it isn't captured as an order id.
  // Every status (incl. pending/cancelled) containing this farmer's own
  // products — the «Моите поръчки» fulfillment screen. A producer is always
  // forced to its own farmerId; an owner MUST pass ?farmerId (there is no
  // tenant-wide "mine" — that's what plain /orders already is).
  @Get('mine')
  @Roles('admin', 'farmer')
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  mine(@CurrentUser() user: TenantRequestUser, @Query() query: MyOrdersQueryDto) {
    const scope = effectiveFarmerId(user.role, user.farmerId, query.farmerId);
    if (!scope) throw new BadRequestException('farmerId required for admin');
    return this.ordersService.ordersForFarmer(user.tenantId, scope, query);
  }

  // Literal route — declared before `:id`. «Подготовка» feed: one farmer's confirmed
  // orders for a day (default tomorrow) with fulfillment state + contact, plus the
  // day's pending count. Same scope rule as /mine — a producer is forced to its own
  // farmerId; an owner MUST pass ?farmerId. Not gated (every farmer preps).
  // Opened to courier logins (role='driver'): a driver has no farmerId at all, so
  // it's routed to prepForDriver instead — packing list for their OWN route leg
  // (any farmer's items), not one producer's harvest.
  @Get('prep')
  @Roles('admin', 'farmer', 'driver')
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  async prep(
    @CurrentUser() user: TenantRequestUser,
    @Query('date') date?: string,
    @Query('farmerId') farmerId?: string,
  ): Promise<PrepSummary> {
    if (user.role === 'driver') {
      return this.prepForDriver(user.tenantId, user, date);
    }
    const scope = effectiveFarmerId(user.role, user.farmerId, farmerId);
    if (!scope) throw new BadRequestException('farmerId required for admin');
    const summary = await this.ordersService.prepSummary(user.tenantId, scope, date);
    // Order the feed to match the delivery route (pin #1 = first order) and stamp
    // each order's courier + visit position, so the client can show the stop
    // number and optionally group by courier. getRoute on the SAME resolved day
    // (summary.date), so the split/pins/optimized order line up with the route
    // screen. A best-effort enrichment — if the route can't be built, fall back
    // to the unordered feed rather than failing the whole prep load.
    try {
      const route = await this.routingService.getRoute(user.tenantId, summary.date);
      return { ...summary, orders: applyRouteOrder(summary.orders, route) };
    } catch {
      return summary;
    }
  }

  /**
   * «Подготовка» for a courier login (role='driver'): defaults to TODAY, not
   * the farmer feed's tomorrow — a courier preps for the route they're about
   * to drive, not tomorrow's. Resolves the driver's leg the same way as
   * assertDriverOwnsOrder (CourierAssignmentService.resolveMyLeg, the
   * date-scoped board — not the JWT's retired courierIndex), then recomputes
   * the route to collect that leg's stop/order ids. No assignment for the
   * day → empty summary (nothing to load yet), same as an unassigned driver
   * owning no stops in assertDriverOwnsOrder.
   */
  private async prepForDriver(
    tenantId: string,
    user: TenantRequestUser,
    date?: string,
  ): Promise<PrepSummary> {
    const day = date ?? bgToday();
    const myLeg = await this.courierAssignmentService.resolveMyLeg(tenantId, user.userId, day);
    if (myLeg == null) {
      return { date: day, confirmedOrders: 0, pendingOrders: 0, orders: [] };
    }
    // 'all' — the packing list is the day's whole load for this leg; it must not
    // shrink as the courier delivers, and it is prepared before they set off.
    const route = await this.routingService.getRoute(tenantId, day, undefined, undefined, undefined, 'all');
    const orderIds = route.routes
      .filter((r) => r.courierIndex === myLeg)
      .flatMap((r) => r.stops.map((s) => s.id));
    const summary = await this.ordersService.prepForCourierLeg(tenantId, orderIds, day);
    // Same route-ordering as the operator feed, but the courier only ever sees
    // their own leg — so their list is purely the visit order (stop 1, 2, 3…).
    return { ...summary, orders: applyRouteOrder(summary.orders, route) };
  }

  // Literal route — declared before `:id`. The best default day for «Подготовка»:
  // tomorrow when it has confirmed orders, else the nearest day within ±2 that
  // does — so an empty tomorrow doesn't hide a Thursday full of orders. Owner
  // «Всички» = tenant-wide (no farmerId); a producer is scoped to their own
  // products; a driver keeps their own anchor (they prep their leg for the day
  // they drive, so hopping to another day's orders wouldn't match their leg).
  @Get('prep/default-day')
  @Roles('admin', 'farmer', 'driver')
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  async prepDefaultDay(
    @CurrentUser() user: TenantRequestUser,
    @Query('date') date?: string,
    @Query('farmerId') farmerId?: string,
  ): Promise<{ date: string }> {
    if (user.role === 'driver') {
      return { date: date ?? bgToday() };
    }
    const anchor = date ?? bgAddDays(bgToday(), 1);
    const scope = user.role === 'farmer' ? user.farmerId ?? null : farmerId ?? null;
    return { date: await this.ordersService.nearestPrepDay(user.tenantId, scope, anchor) };
  }

  // Literal route — declared before `:id`. Own-delivery orders that can be moved to
  // another day, grouped client-side by their slot date.
  @Get('reschedulable')
  @Roles('admin')
  reschedulable(@CurrentTenant() tenantId: string) {
    return this.ordersService.reschedulable(tenantId);
  }

  // Bulk-move the given own-delivery orders onto a target day.
  @Post('reschedule')
  @Roles('admin')
  reschedule(@CurrentTenant() tenantId: string, @Body() dto: RescheduleOrdersDto) {
    return this.ordersService.rescheduleOrders(tenantId, dto);
  }

  // Task C3 — opened to role='driver' (OrderPanel is used from the route screen
  // too). Fast-follow (ledger finding #1): tenant-scoping alone let a driver
  // holding another leg's order UUID read full customer PII — now gated by the
  // same own-leg recompute+check as POST /orders/route/measure.
  @Get(':id')
  @Roles('admin', 'farmer', 'driver')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
  ) {
    const order = await this.ordersService.findOne(id, tenantId);
    if (user.role === 'driver') await this.assertDriverOwnsOrder(tenantId, user, order);
    else if (user.role === 'farmer') await this.assertFarmerOwnsOrder(tenantId, user, order);
    return order;
  }

  /**
   * Producer sub-accounts (role='farmer') may open only orders they're a party
   * to — i.e. that contain at least one of their own products. Tenant-scoping
   * alone (findOne) let any producer read any order's full customer PII and its
   * co-producers' line items by UUID; this gates that, mirroring the driver
   * own-leg check above. Scope is ALWAYS the token's farmerId (effectiveFarmerId
   * ignores any client-supplied id and 403s a malformed token).
   */
  private async assertFarmerOwnsOrder(
    tenantId: string,
    user: TenantRequestUser,
    order: { id: string },
  ): Promise<void> {
    const farmerId = effectiveFarmerId(user.role, user.farmerId, undefined);
    if (!farmerId || !(await this.ordersService.orderHasFarmerItems(order.id, tenantId, farmerId))) {
      throw new ForbiddenException('Нямате достъп до тази поръчка.');
    }
  }

  // Opened to producer sub-accounts (role='farmer') so they can mark their OWN COD
  // order as «доставена» (= cash received) from the Плащания screen. Opened to
  // role='driver' (Task C3) so a courier can finish a delivery / undo an accidental
  // finish from the route screen. Owner edits any order; a producer is forced to
  // its own farmerId and routed to the IDOR-scoped method (verifies ownership +
  // restricts to the delivered transition); a driver is routed to the
  // transition-restricted (delivered/confirmed) courier method, gated (fast-follow,
  // ledger finding #1) by the same own-leg recompute+check as route/measure —
  // previously any same-tenant order id could be flipped by a driver.
  @Patch(':id/status')
  @Roles('admin', 'farmer', 'driver')
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    if (user.role === 'driver') {
      const order = await this.ordersService.findOne(id, user.tenantId);
      await this.assertDriverOwnsOrder(user.tenantId, user, order);
      return this.ordersService.updateStatusForCourier(id, user.tenantId, dto);
    }
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return scope
      ? this.ordersService.updateStatusForFarmer(id, user.tenantId, scope, dto)
      : this.ordersService.updateStatus(id, user.tenantId, dto);
  }

  // Set the наложен-платеж money outcome (received / refused). Owner edits any
  // order; a producer is forced to its own farmerId (same IDOR scope as status).
  @Patch(':id/cod-outcome')
  @Roles('admin', 'farmer')
  setCodOutcome(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: UpdateCodOutcomeDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return scope
      ? this.ordersService.setCodOutcomeForFarmer(id, user.tenantId, scope, dto)
      : this.ordersService.setCodOutcome(id, user.tenantId, dto);
  }

  // Task #14: a farmer self-marks their own prep state (pending / in_production /
  // fulfilled) for one of tomorrow's orders — no money/status side-effect, so
  // (unlike /status and /cod-outcome) a producer only needs to own AT LEAST ONE
  // line item on the order, not the whole thing (see setFulfillment). An owner
  // MUST pass ?farmerId (this is inherently per-producer state).
  @Patch(':id/fulfillment')
  @Roles('admin', 'farmer')
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: which producer is marking' })
  setFulfillment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: UpdateFulfillmentDto,
    @Query('farmerId') farmerId?: string,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, farmerId);
    if (!scope) throw new BadRequestException('farmerId required for admin');
    return this.ordersService.setFulfillment(id, user.tenantId, scope, dto.state);
  }

  // "Прати пак" (§4.3) — re-send the bilateral protocol email. Idempotent: a
  // no-op if it already sent. Same role scope as the sibling :id/cod-outcome
  // and :id/fulfillment action routes. See OrdersService.resendProtocolEmail.
  @Post(':id/resend-protocol-email')
  @Roles('admin', 'farmer')
  resendProtocolEmail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantRequestUser) {
    return this.ordersService.resendProtocolEmail(id, user.tenantId);
  }

  // Owner-only full order edit (contact / delivery values / slot / notes / items).
  // Unlike /status and /cod-outcome this is NOT opened to producer sub-accounts.
  @Patch(':id')
  @Roles('admin')
  updateOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.ordersService.updateOrder(id, tenantId, dto);
  }
}

@ApiTags('public')
@Controller('public/:slug/orders')
export class PublicOrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly checkout: CheckoutService,
  ) {}

  // Anonymous order creation — 15/min/IP (matches public checkout). Routed through
  // CheckoutService so the delivery fee is folded into the total (same as
  // /checkout); this endpoint just doesn't open a Stripe session.
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post()
  create(@Param('slug') slug: string, @Body() dto: CreateOrderDto) {
    return this.checkout.placeOrder(slug, dto);
  }

  // Public order recap for the confirmation page (UUID + slug gated).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':id')
  getPublicSummary(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.findPublicOrderSummary(slug, id);
  }
}
