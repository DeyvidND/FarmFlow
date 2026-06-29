import { Controller, Get, Post, Delete, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SpeedyService } from './speedy.service';
import { SpeedyCredentialsDto } from './dto/speedy-credentials.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentFarmer } from '../../common/decorators/current-farmer.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

/**
 * Farmer-aware Speedy credential + config endpoints on the MAIN API.
 *
 * The panel talks only to the main API (AppModule / api:3000).  This thin
 * controller gives farmers a way to connect Speedy from the inline "Доставки"
 * form without hitting the dostavki-backend process.
 *
 * Scope: only the three credential-management routes.  All shipment/label/
 * nomenclature routes remain on SpeedyStandaloneController (dostavki-backend).
 * The two controllers live in different NestJS application instances and never
 * load together, so the shared `@Controller('speedy')` prefix is safe.
 */
@ApiTags('speedy')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('speedy')
export class SpeedyConfigController {
  constructor(private readonly speedy: SpeedyService) {}

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
  saveCredentials(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: SpeedyCredentialsDto,
  ) {
    return this.speedy.saveCredentials(t, dto, f);
  }

  /** Remove Speedy credentials (disconnect). Farmer-scoped when farmerId present. */
  @Roles('admin', 'farmer')
  @Delete('credentials')
  disconnect(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
  ) {
    return this.speedy.disconnect(t, f);
  }
}
