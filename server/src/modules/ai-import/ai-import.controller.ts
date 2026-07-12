import { Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';
import { ProductsService } from '../products/products.service';
import type { CreateProductDto } from '../products/dto/create-product.dto';
import { ProductExtractService, isImageFile, type ExtractedProduct } from './product-extract.service';
import { CommitAiImportDto } from './dto/commit-ai-import.dto';

/**
 * Tenant-facing AI product import: photo / pasted list → preview rows → commit.
 * Same extraction engine as the super-admin onboarding import; the difference is
 * auth (tenant JWT) and scoping (a producer commits only into their own catalog).
 */
@ApiTags('ai-import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('products/ai-import')
export class AiImportController {
  constructor(
    private readonly extractSvc: ProductExtractService,
    private readonly productsSvc: ProductsService,
  ) {}

  // Foreground OpenAI call — throttled so one user can't burn the API budget.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('extract')
  @Roles('admin', 'farmer')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async extract(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('text') text: string | undefined,
  ): Promise<{ products: ExtractedProduct[] }> {
    if (file && isImageFile(file)) {
      return { products: await this.extractSvc.extractFromImage(file) };
    }
    const content = await this.extractSvc.parseToText(file, text);
    return { products: await this.extractSvc.extract(content) };
  }

  /** Publish the reviewed rows. Row-by-row through the SAME validated create path
   *  a manual product create uses — a malformed row fails like a manual one would. */
  @Post('commit')
  @Roles('admin', 'farmer')
  async commit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: CommitAiImportDto,
  ): Promise<{ created: number }> {
    const scope = effectiveFarmerId(user.role, user.farmerId, dto.farmerId);
    let created = 0;
    for (const p of dto.products) {
      const productDto: CreateProductDto = {
        name: p.name,
        priceStotinki: p.priceStotinki,
        unit: p.unit,
        weight: p.weight,
        category: p.category,
        description: p.description,
        isActive: p.isActive ?? true,
        farmerId: scope ?? undefined,
      };
      await this.productsSvc.create(tenantId, productDto, scope, {
        needsReview: user.role === 'farmer',
      });
      created++;
    }
    return { created };
  }
}
