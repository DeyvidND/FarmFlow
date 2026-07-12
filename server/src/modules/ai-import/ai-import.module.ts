import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { ProductExtractService } from './product-extract.service';
import { AiImportController } from './ai-import.controller';

@Module({
  imports: [ProductsModule],
  controllers: [AiImportController],
  providers: [ProductExtractService],
  exports: [ProductExtractService],
})
export class AiImportModule {}
