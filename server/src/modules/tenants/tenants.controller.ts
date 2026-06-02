import { Controller, Get, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TenantsService } from './tenants.service';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('tenants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @ApiOperation({ summary: 'Current tenant profile' })
  @Get('me')
  me(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getMe(tenantId);
  }

  @ApiOperation({ summary: 'Update current tenant profile' })
  @Patch('me')
  update(@CurrentTenant() tenantId: string, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.updateMe(tenantId, dto);
  }
}

@ApiTags('public')
@Controller('public/:slug')
export class PublicTenantController {
  constructor(private readonly tenantsService: TenantsService) {}

  @ApiOperation({ summary: 'Public storefront profile (toggles + contact)' })
  @Get()
  profile(@Param('slug') slug: string) {
    return this.tenantsService.findPublicProfileBySlug(slug);
  }
}
