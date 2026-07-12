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
import { ProductExtractService, isImageFile, type ExtractedProduct } from './product-extract.service';

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
}
