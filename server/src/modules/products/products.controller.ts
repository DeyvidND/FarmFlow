import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards,
  UploadedFile, UseInterceptors,
  ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody, ApiQuery } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { AssignProductsDto } from './dto/assign-products.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
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
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findAll(@CurrentTenant() tenantId: string, @Query() q: PaginationQueryDto) {
    return this.productsService.findAll(tenantId, { cursor: q.cursor, limit: q.limit });
  }

  // Literal route — must precede `:id` so "options" isn't captured as a product id.
  @Get('options')
  listOptions(@CurrentTenant() tenantId: string) {
    return this.productsService.listOptions(tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.productsService.findOne(id, tenantId);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateProductDto) {
    return this.productsService.create(tenantId, dto);
  }

  // Literal route — must precede `:id` so "assign" isn't captured as a product id.
  @Patch('assign')
  assign(@CurrentTenant() tenantId: string, @Body() dto: AssignProductsDto) {
    return this.productsService.assignProducts(tenantId, dto);
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

  // ---- Gallery (multi-image) ----

  @Get(':id/media')
  listMedia(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.productsService.listMedia(id, tenantId);
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
    return this.productsService.addMedia(id, tenantId, file);
  }

  @Patch(':id/media/reorder')
  reorderMedia(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: ReorderMediaDto,
  ) {
    return this.productsService.reorderMedia(id, tenantId, dto);
  }

  @Delete(':id/media/:mediaId')
  removeMedia(
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.productsService.removeMedia(id, mediaId, tenantId);
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
