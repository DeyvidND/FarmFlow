import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AnalyticsService } from './analytics.service';
import { TrackEventDto } from './dto/track-event.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { TenantRequestUser } from '@fermeribg/types';

/** Public storefront beacon. High-volume, cheap: 120 events/min/IP. Always 204 —
 *  the browser beacon ignores the body; a bad/bot/unknown event is a silent no-op. */
@ApiTags('public')
@Controller('public/:slug/track')
export class TrackController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post()
  @HttpCode(204)
  async track(
    @Param('slug') slug: string,
    @Body() dto: TrackEventDto,
    @Ip() ip: string,
    @Headers('user-agent') ua: string,
  ): Promise<void> {
    await this.analytics.track(slug, dto, ip ?? '', ua ?? '');
  }
}

/** Panel read side. Same auth/role shape as StatsController — the tenant's
 *  traffic is shared across admin and any farmer sub-account (storefront
 *  traffic isn't attributable to a single producer, unlike sales). */
@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles('admin', 'farmer')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @ApiQuery({ name: 'range', required: false, enum: ['7d', '30d', '90d', '1y'] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  summary(
    @CurrentUser() user: TenantRequestUser,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analytics.summary(user.tenantId, { range, from, to });
  }
}
