import { Module } from '@nestjs/common';
import { CodRiskService } from './cod-risk.service';
import { NekorektenClient } from './nekorekten.client';
import { NekorektenRateLimiter } from './nekorekten-rate-limiter';

@Module({
  providers: [CodRiskService, NekorektenClient, NekorektenRateLimiter],
  exports: [CodRiskService],
})
export class CodRiskModule {}
