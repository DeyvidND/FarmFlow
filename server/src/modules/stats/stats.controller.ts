import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';

@ApiTags('stats')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles('admin', 'farmer')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  @ApiQuery({ name: 'range', required: false, enum: ['7d', '30d', '90d', '1y'] })
  @ApiQuery({ name: 'from', required: false, description: 'Custom range start (BG date YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: 'Custom range end (BG date YYYY-MM-DD)' })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  stats(
    @CurrentUser() user: TenantRequestUser,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('farmerId') farmerId?: string,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, farmerId);
    const opts = { range, from, to };
    return scope
      ? this.statsService.statsForFarmer(user.tenantId, scope, opts)
      : this.statsService.stats(user.tenantId, opts);
  }

  /** Task #9/#10: turnover on an explicit switchable basis + to-date / platform
   *  income / undelivered split. Separate from GET / (above) — that endpoint's
   *  shape and basis (implicitly order-placed) are unchanged for existing callers. */
  @Get('turnover')
  @ApiQuery({ name: 'range', required: false, enum: ['7d', '30d', '90d', '1y'] })
  @ApiQuery({ name: 'from', required: false, description: 'Custom range start (BG date YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: 'Custom range end (BG date YYYY-MM-DD)' })
  @ApiQuery({
    name: 'basis',
    required: false,
    enum: ['placed', 'delivery', 'delivered'],
    description: 'Which calendar day the order counts on (default: placed)',
  })
  @ApiQuery({
    name: 'includeUndelivered',
    required: false,
    description: '"false" excludes not-yet-delivered orders from the money figures (default: included)',
  })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  turnover(
    @CurrentUser() user: TenantRequestUser,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('basis') basis?: string,
    @Query('includeUndelivered') includeUndelivered?: string,
    @Query('farmerId') farmerId?: string,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, farmerId);
    return this.statsService.turnoverBreakdown(user.tenantId, {
      range,
      from,
      to,
      basis,
      includeUndelivered: includeUndelivered === undefined ? undefined : includeUndelivered !== 'false',
      farmerId: scope ?? undefined,
    });
  }
}
