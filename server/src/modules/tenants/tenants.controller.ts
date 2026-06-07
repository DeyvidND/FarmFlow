import {
  Controller, Get, Patch, Post, Delete, Body, Param, UseGuards,
  UploadedFile, UseInterceptors,
  ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantsService } from './tenants.service';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import {
  UploadImageDto,
  PRODUCT_IMAGE_MIME_REGEX,
  PRODUCT_IMAGE_MAX_BYTES,
} from '../storage/dto/upload-image.dto';

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

  // ---- Site media (editable storefront photos) ----

  @ApiOperation({ summary: 'Editable site-photo slots: catalog + current values' })
  @Get('me/media')
  getMedia(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getSiteMedia(tenantId);
  }

  @ApiOperation({ summary: 'Upload/replace the photo for one site slot' })
  @Post('me/media/:slotKey')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadImageDto })
  @UseInterceptors(FileInterceptor('image'))
  uploadMedia(
    @CurrentTenant() tenantId: string,
    @Param('slotKey') slotKey: string,
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
    return this.tenantsService.setSiteMedia(tenantId, slotKey, file);
  }

  @ApiOperation({ summary: 'Remove the photo for one site slot' })
  @Delete('me/media/:slotKey')
  deleteMedia(@CurrentTenant() tenantId: string, @Param('slotKey') slotKey: string) {
    return this.tenantsService.deleteSiteMedia(tenantId, slotKey);
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
