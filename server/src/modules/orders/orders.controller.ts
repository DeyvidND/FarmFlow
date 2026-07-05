import {
  Controller, Get, Post, Patch,
  Param, Body, Query, UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { CheckoutService } from './checkout.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateCodOutcomeDto } from './dto/update-cod-outcome.dto';
import { PaymentsQueryDto } from './dto/payments-query.dto';
import { OrdersQueryDto } from './dto/orders-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
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
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'q', required: false })
  findAll(@CurrentTenant() tenantId: string, @Query() q: OrdersQueryDto) {
    return this.ordersService.findAll(tenantId, {
      page: q.page,
      limit: q.limit,
      status: q.status,
      q: q.q,
    });
  }

  // Declared before `:id` routes so the literal segment wins.
  @Patch('confirm-pending')
  @ApiQuery({ name: 'date', required: false })
  confirmPending(@CurrentTenant() tenantId: string, @Query('date') date?: string) {
    return this.ordersService.confirmPending(tenantId, date);
  }

  // Literal route — must precede `:id` so it isn't captured as an order id.
  @Get('production')
  @UseGuards(ActiveSubscriptionGuard)
  @ApiQuery({ name: 'date', required: false })
  production(@CurrentTenant() tenantId: string, @Query('date') date?: string) {
    return this.ordersService.production(tenantId, date);
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

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenantId: string) {
    return this.ordersService.findOne(id, tenantId);
  }

  // Opened to producer sub-accounts (role='farmer') so they can mark their OWN COD
  // order as «доставена» (= cash received) from the Плащания screen. Owner edits
  // any order; a producer is forced to its own farmerId and routed to the
  // IDOR-scoped method (verifies ownership + restricts to the delivered transition).
  @Patch(':id/status')
  @Roles('admin', 'farmer')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: UpdateOrderStatusDto,
  ) {
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
  @Get(':id')
  getPublicSummary(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.findPublicOrderSummary(slug, id);
  }
}
