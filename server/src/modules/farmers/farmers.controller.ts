import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, UseGuards, UploadedFile, UseInterceptors,
  ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { FarmersService } from './farmers.service';
import { CreateFarmerDto } from './dto/create-farmer.dto';
import { UpdateFarmerDto } from './dto/update-farmer.dto';
import { GrantAccessDto } from './dto/grant-access.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
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

  @Get()
  findAll(@CurrentTenant() tenantId: string) {
    return this.farmersService.findAll(tenantId);
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

  // ---- Farmer sub-account access (admin-only — no @Roles) ----

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
