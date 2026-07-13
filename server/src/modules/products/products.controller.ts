import {
  Controller, Get, Post, Patch, Put, Delete,
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
import { UpdateCourierBatchDto } from './dto/update-courier-batch.dto';
import { SetBundleItemsDto } from './dto/bundle-items.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
import { ReorderDto } from '../../common/dto/reorder.dto';
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

  // Producers see + manage only their own products; the service enforces the
  // farmer scope (a producer can never widen it — query overrides are ignored).
  @Get()
  @Roles('admin', 'farmer')
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'review', required: false })
  findAll(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Query() q: ListProductsQueryDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.findAll(
      tenantId,
      { cursor: q.cursor, limit: q.limit, review: q.review === 'pending' },
      scope,
    );
  }

  // Literal route — must precede `:id` so "options" isn't captured as a product id.
  @Get('options')
  @Roles('admin', 'farmer')
  listOptions(@CurrentTenant() tenantId: string, @CurrentUser() user: TenantRequestUser) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.listOptions(tenantId, scope);
  }

  // Review queue size for the «Провери продукти» badge. Admin only — farmers
  // see their own pending rows in the list, not the queue. Literal route —
  // must precede `:id` so "review" isn't captured as a product id.
  @Get('review/count')
  @Roles('admin')
  reviewCount(@CurrentTenant() tenantId: string) {
    return this.productsService.pendingReviewCount(tenantId);
  }

  @Get(':id')
  @Roles('admin', 'farmer')
  findOne(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.findOne(id, tenantId, scope);
  }

  @Post()
  @Roles('admin', 'farmer')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: CreateProductDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.create(tenantId, dto, scope, {
      needsReview: user.role === 'farmer',
    });
  }

  // Admin sign-off on a farmer-submitted product. Explicitly admin-only —
  // a producer must never clear their own review flag.
  @Post(':id/approve')
  @Roles('admin')
  approve(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.productsService.approve(id, tenantId);
  }

  // Literal route — must precede `:id` so "assign" isn't captured as a product id.
  @Patch('assign')
  assign(@CurrentTenant() tenantId: string, @Body() dto: AssignProductsDto) {
    return this.productsService.assignProducts(tenantId, dto);
  }

  // Literal route — must precede `:id`.
  @Patch('courier-batch')
  @Roles('admin', 'farmer')
  updateCourierBatch(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: UpdateCourierBatchDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.updateCourierBatch(tenantId, dto.updates, scope);
  }

  // Literal route — must precede `:id` so "reorder" isn't captured as a product id.
  @Patch('reorder')
  reorder(@CurrentTenant() tenantId: string, @Body() dto: ReorderDto) {
    return this.productsService.reorder(tenantId, dto);
  }

  @Patch(':id')
  @Roles('admin', 'farmer')
  update(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: UpdateProductDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.update(id, tenantId, dto, scope);
  }

  @Delete(':id')
  @Roles('admin', 'farmer')
  remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.remove(id, tenantId, scope);
  }

  @Post(':id/image')
  @Roles('admin', 'farmer')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadImageDto })
  @UseInterceptors(FileInterceptor('image'))
  uploadImage(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
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
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.uploadImage(id, tenantId, file, scope);
  }

  // ---- Gallery (multi-image) ----

  @Get(':id/media')
  @Roles('admin', 'farmer')
  listMedia(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.listMedia(id, tenantId, scope);
  }

  @Get(':id/variants')
  @Roles('admin', 'farmer')
  listVariants(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.listVariants(id, tenantId, scope);
  }

  // ---- Bundle contents („Фермерска кошница" / готови пакети, task #1) ----

  @Get(':id/bundle-items')
  @Roles('admin', 'farmer')
  listBundleItems(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.listBundleItems(id, tenantId, scope);
  }

  // Full replace — same guard/scoping as PATCH :id.
  @Put(':id/bundle-items')
  @Roles('admin', 'farmer')
  setBundleItems(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: SetBundleItemsDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.setBundleItems(id, tenantId, dto.items, scope);
  }

  @Post(':id/media')
  @Roles('admin', 'farmer')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadImageDto })
  @UseInterceptors(FileInterceptor('image'))
  addMedia(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
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
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.addMedia(id, tenantId, file, scope);
  }

  @Patch(':id/media/reorder')
  @Roles('admin', 'farmer')
  reorderMedia(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: ReorderMediaDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.reorderMedia(id, tenantId, dto, scope);
  }

  @Delete(':id/media/:mediaId')
  @Roles('admin', 'farmer')
  removeMedia(
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.removeMedia(id, mediaId, tenantId, scope);
  }

  /** Undo the image-sanity worker's auto rotate/crop — „върни оригинала". */
  @Post(':id/media/:mediaId/revert')
  @Roles('admin', 'farmer')
  revertMediaOriginal(
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, undefined);
    return this.productsService.revertMediaOriginal(id, mediaId, tenantId, scope);
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
