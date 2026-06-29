import { Controller, Get, Post, Delete, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SpeedyService } from './speedy.service';
import { SpeedyCredentialsDto } from './dto/speedy-credentials.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentFarmer } from '../../common/decorators/current-farmer.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';

/**
 * Farmer-aware Speedy credential + config endpoints on the MAIN API only.
 *
 * Loaded exclusively via {@link SpeedyConfigModule} → {@link AppModule}.
 * The dostavki backend ({@link EcontAppModule}) imports {@link SpeedyCoreModule}
 * directly and mounts {@link SpeedyStandaloneController} — so the two
 * `@Controller('speedy')` controllers are structurally in separate NestJS
 * application instances and never register in the same process.
 *
 * Scope: only the three credential-management routes.  All shipment/label/
 * nomenclature routes remain on SpeedyStandaloneController (dostavki-backend).
 */
@ApiTags('speedy')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('speedy')
export class SpeedyConfigController {
  constructor(
    private readonly speedy: SpeedyService,
    private readonly publicCache: PublicCacheService,
  ) {}

  /** Current Speedy config (no secrets). Farmer-scoped when farmerId present. */
  @Roles('admin', 'farmer')
  @Get('config')
  config(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
  ) {
    return this.speedy.getConfig(t, f);
  }

  /** Validate + store Speedy API credentials. Farmer-scoped when farmerId present. */
  @Roles('admin', 'farmer')
  @Post('credentials')
  async saveCredentials(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: SpeedyCredentialsDto,
  ) {
    const res = await this.speedy.saveCredentials(t, dto, f);
    if (f) await this.publicCache.del(publicCacheKeys.farmers(t));
    return res;
  }

  /** Remove Speedy credentials (disconnect). Farmer-scoped when farmerId present. */
  @Roles('admin', 'farmer')
  @Delete('credentials')
  async disconnect(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
  ) {
    const res = await this.speedy.disconnect(t, f);
    if (f) await this.publicCache.del(publicCacheKeys.farmers(t));
    return res;
  }
}
