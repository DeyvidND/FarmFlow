import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards,
  UploadedFile, UseInterceptors,
  ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody, ApiQuery } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArticlesService } from './articles.service';
import { CreateArticleDto } from './dto/create-article.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { EmbedMediaDto } from './dto/embed-media.dto';
import { ReorderMediaDto } from './dto/reorder-media.dto';
import { UpdateMediaDto } from './dto/update-media.dto';
import {
  UploadArticleMediaDto,
  ARTICLE_COVER_MIME_REGEX,
  ARTICLE_COVER_MAX_BYTES,
  ARTICLE_MEDIA_MIME_REGEX,
  ARTICLE_MEDIA_MAX_BYTES,
} from './dto/upload-media.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('articles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('articles')
export class ArticlesController {
  constructor(private readonly articlesService: ArticlesService) {}

  @Get()
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findAll(@CurrentTenant() tenantId: string, @Query() q: PaginationQueryDto) {
    return this.articlesService.findAll(tenantId, { cursor: q.cursor, limit: q.limit });
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.articlesService.findOne(id, tenantId);
  }

  @Post()
  @UseGuards(ActiveSubscriptionGuard)
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateArticleDto) {
    return this.articlesService.create(tenantId, dto);
  }

  @Patch(':id')
  @UseGuards(ActiveSubscriptionGuard)
  update(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateArticleDto,
  ) {
    return this.articlesService.update(id, tenantId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.articlesService.remove(id, tenantId);
  }

  @Post(':id/cover')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadArticleMediaDto })
  @UseInterceptors(FileInterceptor('file'))
  uploadCover(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: ARTICLE_COVER_MIME_REGEX }),
          new MaxFileSizeValidator({ maxSize: ARTICLE_COVER_MAX_BYTES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.articlesService.uploadCover(id, tenantId, file);
  }

  @Post(':id/media')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadArticleMediaDto })
  @UseInterceptors(FileInterceptor('file'))
  addMedia(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: ARTICLE_MEDIA_MIME_REGEX }),
          new MaxFileSizeValidator({ maxSize: ARTICLE_MEDIA_MAX_BYTES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.articlesService.addMedia(id, tenantId, file);
  }

  @Post(':id/media/embed')
  addEmbed(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: EmbedMediaDto,
  ) {
    return this.articlesService.addEmbed(id, tenantId, dto);
  }

  @Patch(':id/media/reorder')
  reorderMedia(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: ReorderMediaDto,
  ) {
    return this.articlesService.reorderMedia(id, tenantId, dto);
  }

  // NOTE: declared after /media/reorder so the literal route wins over :mediaId.
  @Patch(':id/media/:mediaId')
  updateMedia(
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateMediaDto,
  ) {
    return this.articlesService.updateMedia(id, mediaId, tenantId, dto);
  }

  @Delete(':id/media/:mediaId')
  removeMedia(
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @CurrentTenant() tenantId: string,
  ) {
    return this.articlesService.removeMedia(id, mediaId, tenantId);
  }
}

@ApiTags('public')
@Controller('public/:slug/articles')
export class PublicArticlesController {
  constructor(private readonly articlesService: ArticlesService) {}

  @Get()
  findPublic(@Param('slug') slug: string) {
    return this.articlesService.findPublicBySlug(slug);
  }

  @Get(':articleSlug')
  findPublicOne(@Param('slug') slug: string, @Param('articleSlug') articleSlug: string) {
    return this.articlesService.findPublicArticleBySlug(slug, articleSlug);
  }
}
