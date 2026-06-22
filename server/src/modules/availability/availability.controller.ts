import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { CreateWindowDto } from './dto/create-window.dto';
import { CreateWindowsBulkDto } from './dto/create-windows-bulk.dto';
import { UpdateWindowDto } from './dto/update-window.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';

@ApiTags('availability')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles('admin', 'farmer')
@Controller('availability-windows')
export class AvailabilityController {
  constructor(private readonly svc: AvailabilityService) {}

  @Get()
  @ApiQuery({ name: 'productId', required: false })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  list(
    @CurrentUser() user: TenantRequestUser,
    @Query('productId') productId?: string,
    @Query('farmerId') farmerId?: string,
  ) {
    const farmerScope = effectiveFarmerId(user.role, user.farmerId, farmerId);
    return this.svc.list(user.tenantId, { productId, farmerId: farmerScope });
  }

  /** Scoped product picker for the «Задай наличност» screen.
   *  Placed before `:id` routes to avoid Express route capture.
   *  Owner: all active products (or ?farmerId-filtered).
   *  Producer: only their own active products (server-enforced). */
  @Get('products')
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  listPickerProducts(
    @CurrentUser() user: TenantRequestUser,
    @Query('farmerId') farmerId?: string,
  ) {
    const farmerScope = effectiveFarmerId(user.role, user.farmerId, farmerId);
    return this.svc.listPickerProducts(user.tenantId, farmerScope);
  }

  @Post()
  create(@CurrentUser() user: TenantRequestUser, @Body() dto: CreateWindowDto) {
    const farmerScope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.svc.create(user.tenantId, dto, farmerScope);
  }

  /** «Задай за всички» — one window applied to many products at once. */
  @Post('bulk')
  createBulk(@CurrentUser() user: TenantRequestUser, @Body() dto: CreateWindowsBulkDto) {
    const farmerScope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.svc.createBulk(user.tenantId, dto, farmerScope);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: UpdateWindowDto,
  ) {
    const farmerScope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.svc.update(id, user.tenantId, dto, farmerScope);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: TenantRequestUser) {
    const farmerScope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.svc.remove(id, user.tenantId, farmerScope);
  }
}

@ApiTags('public')
@Controller('public/:slug/availability')
export class PublicAvailabilityController {
  constructor(private readonly svc: AvailabilityService) {}

  @Get()
  findPublic(@Param('slug') slug: string) {
    return this.svc.findPublicActiveBySlug(slug);
  }
}
