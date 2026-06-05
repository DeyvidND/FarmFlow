import {
  Controller, Get, Post, Patch,
  Param, Body, Query, UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'deliveryType', required: false })
  @ApiQuery({ name: 'search', required: false })
  findAll(
    @CurrentTenant() tenantId: string,
    @Query('date') date?: string,
    @Query('status') status?: string,
    @Query('deliveryType') deliveryType?: string,
    @Query('search') search?: string,
  ) {
    return this.ordersService.findAll(tenantId, { date, status, deliveryType, search });
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

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenantId: string) {
    return this.ordersService.findOne(id, tenantId);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateStatus(id, tenantId, dto);
  }
}

@ApiTags('public')
@Controller('public/:slug/orders')
export class PublicOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // Anonymous order creation — 15/min/IP (matches public checkout).
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post()
  create(@Param('slug') slug: string, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(slug, dto);
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
