import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { CourierAccessService } from '../routing/courier-access.service';
import { GrantCourierAccessDto } from '../routing/dto/courier-access.dto';

/**
 * Task B1 — courier-account CREATE/LIST/REVOKE moved from the farmer panel to
 * the super-admin console.
 *
 * ⚠️ `@UseGuards(PlatformAdminGuard)`, NEVER `@Roles('admin')`/`TenantRolesGuard`.
 * TenantRole `'admin'` (`type:'tenant', role:'admin'`) is the farm OWNER —
 * a tenant-scoped principal — and is NOT the same as the platform session
 * (`type:'platform'`) this guard requires. Swapping the two guards here would
 * silently re-grant farmer-panel account creation: the exact capability this
 * task removes. See the plan's Global Constraints ("the sharpest edge in this
 * feature") and `docs/superpowers/specs/2026-07-15-courier-assignment-board-design.md` §2.2.
 */
@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller('platform/tenants/:tenantId/courier-access')
export class PlatformCourierController {
  constructor(private readonly courierAccess: CourierAccessService) {}

  @Get()
  list(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.courierAccess.listAccess(tenantId);
  }

  @Post()
  grant(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() dto: GrantCourierAccessDto) {
    return this.courierAccess.grantAccess(tenantId, dto.email);
  }

  @Delete(':accountId')
  revoke(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.courierAccess.revokeAccess(tenantId, accountId);
  }
}
