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
import { Roles } from '../../common/decorators/roles.decorator';
import {
  UploadImageDto,
  PRODUCT_IMAGE_MIME_REGEX,
  PRODUCT_IMAGE_MAX_BYTES,
  FaviconUploadDto,
  FAVICON_MIME_REGEX,
  FAVICON_MAX_BYTES,
} from '../storage/dto/upload-image.dto';
import { SiteContactDto } from './dto/site-contact.dto';
import { SiteMarketingDto } from './dto/site-marketing.dto';
import { LandingDto } from './dto/landing.dto';

@ApiTags('tenants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @ApiOperation({ summary: 'Current tenant profile' })
  @Roles('admin', 'farmer')
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

  // ---- Site contact + website icon ----

  @ApiOperation({ summary: 'Contact block + favicon + theme color' })
  @Get('me/site-contact')
  getSiteContact(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getSiteContact(tenantId);
  }

  @ApiOperation({ summary: 'Update contact block + theme color' })
  @Patch('me/site-contact')
  updateSiteContact(@CurrentTenant() tenantId: string, @Body() dto: SiteContactDto) {
    return this.tenantsService.updateSiteContact(tenantId, dto);
  }

  // ---- Marketing / tracking IDs ----

  @ApiOperation({ summary: 'Storefront tracking IDs (GA4/Ads/Meta/GTM/TikTok)' })
  @Get('me/site-marketing')
  getSiteMarketing(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getMarketing(tenantId);
  }

  @ApiOperation({ summary: 'Update storefront tracking IDs' })
  @Patch('me/site-marketing')
  updateSiteMarketing(@CurrentTenant() tenantId: string, @Body() dto: SiteMarketingDto) {
    return this.tenantsService.updateMarketing(tenantId, dto);
  }

  // ---- Landing-page blocks ----

  @ApiOperation({ summary: 'Storefront landing blocks (show + count)' })
  @Get('me/landing')
  getLanding(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getLanding(tenantId);
  }

  @ApiOperation({ summary: 'Update storefront landing blocks' })
  @Patch('me/landing')
  updateLanding(@CurrentTenant() tenantId: string, @Body() dto: LandingDto) {
    return this.tenantsService.updateLanding(tenantId, dto);
  }

  @ApiOperation({ summary: 'Upload/replace the website icon (PNG or ICO)' })
  @Post('me/favicon')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: FaviconUploadDto })
  @UseInterceptors(FileInterceptor('image'))
  uploadFavicon(
    @CurrentTenant() tenantId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: FAVICON_MIME_REGEX }),
          new MaxFileSizeValidator({ maxSize: FAVICON_MAX_BYTES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.tenantsService.setFavicon(tenantId, file);
  }

  @ApiOperation({ summary: 'Remove the website icon' })
  @Delete('me/favicon')
  deleteFavicon(@CurrentTenant() tenantId: string) {
    return this.tenantsService.deleteFavicon(tenantId);
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
