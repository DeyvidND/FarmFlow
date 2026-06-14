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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AvailabilityService } from './availability.service';
import { CreateWindowDto } from './dto/create-window.dto';
import { UpdateWindowDto } from './dto/update-window.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('availability')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('availability-windows')
export class AvailabilityController {
  constructor(private readonly svc: AvailabilityService) {}

  @Get()
  list(@CurrentTenant() tenantId: string, @Query('productId') productId?: string) {
    return this.svc.list(tenantId, productId);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateWindowDto) {
    return this.svc.create(tenantId, dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateWindowDto,
  ) {
    return this.svc.update(id, tenantId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.svc.remove(id, tenantId);
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
