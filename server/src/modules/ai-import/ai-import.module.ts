import { Module } from '@nestjs/common';
import { ProductExtractService } from './product-extract.service';

/**
 * AI product import: turns a pasted price list, an uploaded file, or (vision) a
 * PHOTO of a price list into clean product rows. Shared by the super-admin
 * onboarding import and the tenant-facing "add from photo" flow.
 */
@Module({
  providers: [ProductExtractService],
  exports: [ProductExtractService],
})
export class AiImportModule {}
