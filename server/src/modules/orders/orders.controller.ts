import {
  Controller, Get, Post, Patch,
  Param, Body, Query, UseGuards,
  ParseUUIDPipe, BadRequestException, ForbiddenException,
  Inject, forwardRef,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { CheckoutService } from './checkout.service';
import { RoutingService } from '../routing/routing.service';
import { bgDateOf } from '../../common/time/bg-time';
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
  ) {}

  /**
   * Own-leg ownership check for a driver (role='driver'), reusing the same
   * recompute+check pattern as POST /orders/route/measure: recompute the
   * driver's own leg for the order's day and verify the order is on it.
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
    const own = await this.routingService.getRoute(
      tenantId,
      day,
      undefined,
      undefined,
      undefined,
      ['confirmed', 'delivered'],
    );
    const ownIds = new Set(
      own.routes.filter((r) => r.courierIndex === user.courierIndex).flatMap((r) => r.stops.map((s) => s.id)),
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
  @Get('prep')
  @Roles('admin', 'farmer')
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  prep(
    @CurrentUser() user: TenantRequestUser,
    @Query('date') date?: string,
    @Query('farmerId') farmerId?: string,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, farmerId);
    if (!scope) throw new BadRequestException('farmerId required for admin');
    return this.ordersService.prepSummary(user.tenantId, scope, date);
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
    return order;
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
