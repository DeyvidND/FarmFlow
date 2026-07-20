import {
  Controller, Get, Post, Patch, Put, Delete,
  Param, Body, UseGuards, UploadedFile, UseInterceptors,
  ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { FarmersService } from './farmers.service';
import { CreateFarmerDto } from './dto/create-farmer.dto';
import { UpdateFarmerDto } from './dto/update-farmer.dto';
import { GrantAccessDto } from './dto/grant-access.dto';
import { SignatureDto } from './dto/signature.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
import { ReorderDto } from '../../common/dto/reorder.dto';
import {
  UploadImageDto, PRODUCT_IMAGE_MIME_REGEX, PRODUCT_IMAGE_MAX_BYTES,
} from '../storage/dto/upload-image.dto';

@ApiTags('farmers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('farmers')
export class FarmersController {
  constructor(private readonly farmersService: FarmersService) {}

  // Producers see only themselves (scoped by token, query overrides ignored); the
  // owner sees the whole tenant. Opened to `farmer` so a sub-account's own carrier
  // connection status reaches the products screens.
  @Get()
  @Roles('admin', 'farmer')
  async findAll(@CurrentTenant() tenantId: string, @CurrentUser() user: TenantRequestUser) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    const rows = await this.farmersService.findAll(tenantId, scope);
    // commissionRateBps / subscriptionFeeStotinki are the operator's commercial terms,
    // and internalNotes / payout are operator-only profile fields — all owner/admin-only.
    // A producer sub-account may read its own row here, so strip them for the farmer role
    // (the panel calls this as admin, unstripped).
    if (user.role === 'farmer') {
      return rows.map(({
        commissionRateBps: _c,
        subscriptionFeeStotinki: _s,
        internalNotes: _n,
        payout: _p,
        ...rest
      }) => rest);
    }
    return rows;
  }

  // Literal route — must precede `:id` so "access" isn't captured as a farmer id.
  @Get('access')
  listAccess(@CurrentTenant() tenantId: string) {
    return this.farmersService.listAccess(tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.farmersService.findOne(id, tenantId);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateFarmerDto) {
    return this.farmersService.create(tenantId, dto);
  }

  // Literal route — must precede `:id` so "reorder" isn't captured as a farmer id.
  @Patch('reorder')
  reorder(@CurrentTenant() tenantId: string, @Body() dto: ReorderDto) {
    return this.farmersService.reorder(tenantId, dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateFarmerDto,
  ) {
    return this.farmersService.update(id, tenantId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.farmersService.remove(id, tenantId);
  }

  // ---- Reusable signature (encrypted at rest) — admin-only, no @Roles ----

  @Get(':id/signature')
  getSignature(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.farmersService.getSignature(id, tenantId);
  }

  @Put(':id/signature')
  setSignature(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: SignatureDto,
  ) {
    return this.farmersService.setSignature(id, tenantId, dto.signaturePng ?? null);
  }

  // ---- Farmer sub-account access (admin-only — no @Roles) ----

  // Tight cap -- each call sends an invite email; limits invite-spam / probing.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':id/access')
  grantAccess(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: GrantAccessDto,
  ) {
    return this.farmersService.grantAccess(tenantId, id, dto.email);
  }

  @Delete(':id/access')
  revokeAccess(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.farmersService.revokeAccess(tenantId, id);
  }

  @Post(':id/image')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadImageDto })
  @UseInterceptors(FileInterceptor('image'))
  uploadImage(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: PRODUCT_IMAGE_MIME_REGEX }),
          new MaxFileSizeValidator({ maxSize: PRODUCT_IMAGE_MAX_BYTES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.farmersService.uploadImage(id, tenantId, file);
  }

  // ---- Gallery (multi-image) ----

  @Get(':id/media')
  listMedia(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.farmersService.listMedia(id, tenantId);
  }

  @Post(':id/media')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadImageDto })
  @UseInterceptors(FileInterceptor('image'))
  addMedia(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: PRODUCT_IMAGE_MIME_REGEX }),
          new MaxFileSizeValidator({ maxSize: PRODUCT_IMAGE_MAX_BYTES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.farmersService.addMedia(id, tenantId, file);
  }

  @Patch(':id/media/reorder')
  reorderMedia(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: ReorderMediaDto,
  ) {
    return this.farmersService.reorderMedia(id, tenantId, dto);
  }

  @Delete(':id/media/:mediaId')
  removeMedia(
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.farmersService.removeMedia(id, mediaId, tenantId);
  }
}

@ApiTags('public')
@Controller('public/:slug/farmers')
export class PublicFarmersController {
  constructor(private readonly farmersService: FarmersService) {}

  @Get()
  findPublic(@Param('slug') slug: string) {
    return this.farmersService.findPublicBySlug(slug);
  }
}
