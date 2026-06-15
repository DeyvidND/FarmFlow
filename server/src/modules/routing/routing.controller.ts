import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RoutingService, type RouteEndMode, type RouteOrderMode } from './routing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { SetStopLocationDto } from './dto/set-stop-location.dto';

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
  @ApiQuery({ name: 'order', required: false, enum: ['slots', 'distance'] })
  getRoute(
    @CurrentTenant() tenantId: string,
    @Query('date') date?: string,
    @Query('end') end?: string,
    @Query('order') order?: string,
  ) {
    const endMode: RouteEndMode | undefined =
      end === 'home' || end === 'last' || end === 'custom' ? end : undefined;
    const orderMode: RouteOrderMode = order === 'distance' ? 'distance' : 'slots';
    return this.routingService.getRoute(tenantId, date, endMode, orderMode);
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
}
