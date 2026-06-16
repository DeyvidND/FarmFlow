import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RecommendationsService } from './recommendations.service';

/**
 * Storefront „Често купувано заедно" picks for the cart screen. The cart lives in
 * the browser's localStorage, so the client passes its product ids in `?ids=` and
 * gets back up to 3 full public products to render as add-to-cart cards. Returns
 * an empty list when the farm has the recommendations feature toggled off.
 */
@ApiTags('public')
@Controller('public/:slug/recommendations')
export class PublicRecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @ApiOperation({ summary: 'Bought-together picks for the items in the cart' })
  @ApiQuery({ name: 'ids', required: false, description: 'Comma-separated cart product ids' })
  @Get()
  async forCart(@Param('slug') slug: string, @Query('ids') ids?: string) {
    const cartIds = (ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.recommendations.boughtTogetherBySlug(slug, cartIds);
  }
}
