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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
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

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.farmersService.findOne(id, tenantId);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateFarmerDto) {
    return this.farmersService.create(tenantId, dto);
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
