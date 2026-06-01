import {
  Controller, Get, Post, Patch,
  Param, Body, Query, UseGuards, HttpCode, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewStatusDto } from './dto/update-review-status.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

/** Public: read published reviews, submit a new one (lands `pending`). */
@ApiTags('public')
@Controller('public/:slug/reviews')
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  findPublic(@Param('slug') slug: string) {
    return this.reviews.findPublic(slug);
  }

  @Post()
  @HttpCode(201)
  create(@Param('slug') slug: string, @Body() dto: CreateReviewDto) {
    return this.reviews.create(slug, dto);
  }
}

/** Admin moderation (tenant-scoped, Bearer). */
@ApiTags('reviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'published', 'hidden'] })
  list(@CurrentTenant() tenantId: string, @Query('status') status?: string) {
    return this.reviews.listForTenant(tenantId, status);
  }

  @Patch(':id/status')
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateReviewStatusDto,
  ) {
    return this.reviews.setStatus(id, tenantId, dto);
  }
}
