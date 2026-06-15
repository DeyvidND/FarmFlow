// server/src/modules/tenants/site-edit.controller.ts
import {
  Controller, Get, Patch, Post, Delete, Body, Param, UseGuards, Req,
  UploadedFile, UseInterceptors, ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantsService } from './tenants.service';
import { EditSessionGuard } from '../../common/guards/edit-session.guard';
import { SiteEditContentDto } from './dto/site-edit-content.dto';
import { UploadImageDto, PRODUCT_IMAGE_MIME_REGEX, PRODUCT_IMAGE_MAX_BYTES } from '../storage/dto/upload-image.dto';

/** Storefront inline-edit overlay endpoints. Authorized by a short-lived
 *  site-edit token (EditSessionGuard sets req.tenantId) — NOT the admin JWT. */
@ApiTags('site-edit')
@UseGuards(EditSessionGuard)
@Controller('tenants/me/site-edit')
export class SiteEditController {
  constructor(private readonly tenants: TenantsService) {}

  @ApiOperation({ summary: 'Current overrides (copy/media/faq) for the overlay' })
  @Get('data')
  data(@Req() req: { tenantId: string }) {
    return this.tenants.getSiteEditData(req.tenantId);
  }

  @ApiOperation({ summary: 'Save edited copy + FAQ' })
  @Patch('content')
  content(@Req() req: { tenantId: string }, @Body() dto: SiteEditContentDto) {
    return this.tenants.setSiteCopyContent(req.tenantId, dto);
  }

  @ApiOperation({ summary: 'Upload/replace a slot photo' })
  @Post('media/:slotKey')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadImageDto })
  @UseInterceptors(FileInterceptor('image'))
  upload(
    @Req() req: { tenantId: string },
    @Param('slotKey') slotKey: string,
    @UploadedFile(new ParseFilePipe({ validators: [
      new FileTypeValidator({ fileType: PRODUCT_IMAGE_MIME_REGEX }),
      new MaxFileSizeValidator({ maxSize: PRODUCT_IMAGE_MAX_BYTES }),
    ] })) file: Express.Multer.File,
  ) {
    return this.tenants.setSiteMedia(req.tenantId, slotKey, file);
  }

  @ApiOperation({ summary: 'Remove a slot photo' })
  @Delete('media/:slotKey')
  remove(@Req() req: { tenantId: string }, @Param('slotKey') slotKey: string) {
    return this.tenants.deleteSiteMedia(req.tenantId, slotKey);
  }
}
