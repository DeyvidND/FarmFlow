import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, UseGuards,
  UploadedFile, UseInterceptors,
  ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import {
  UploadImageDto,
  PRODUCT_IMAGE_MIME_REGEX,
  PRODUCT_IMAGE_MAX_BYTES,
} from '../storage/dto/upload-image.dto';

@ApiTags('products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll(@CurrentTenant() tenantId: string) {
    return this.productsService.findAll(tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.productsService.findOne(id, tenantId);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateProductDto) {
    return this.productsService.create(tenantId, dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productsService.update(id, tenantId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.productsService.remove(id, tenantId);
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
    return this.productsService.uploadImage(id, tenantId, file);
  }
}

@ApiTags('public')
@Controller('public/:slug/products')
export class PublicProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findPublic(@Param('slug') slug: string) {
    // Caching (Redis, keyed by tenantId) lives in the service.
    return this.productsService.findPublicBySlug(slug);
  }

  @Get(':productSlug')
  findPublicOne(
    @Param('slug') slug: string,
    @Param('productSlug') productSlug: string,
  ) {
    return this.productsService.findPublicProductBySlug(slug, productSlug);
  }
}
