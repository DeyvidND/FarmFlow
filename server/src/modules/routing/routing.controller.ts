import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RoutingService } from './routing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

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
  getRoute(@CurrentTenant() tenantId: string, @Query('date') date?: string) {
    return this.routingService.getRoute(tenantId, date);
  }
}
