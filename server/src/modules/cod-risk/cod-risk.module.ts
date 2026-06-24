import { Module } from '@nestjs/common';
import { CodRiskService } from './cod-risk.service';
import { NekorektenClient } from './nekorekten.client';

@Module({
  providers: [CodRiskService, NekorektenClient],
  exports: [CodRiskService],
})
export class CodRiskModule {}
