import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DigestService } from './digest.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('digest')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('digest')
export class DigestController {
  constructor(private readonly digestService: DigestService) {}

  /** Trigger a digest email for today — for manual SMTP testing without waiting for the cron. */
  @Post('test')
  testDigest(
    @CurrentTenant() tenantId: string,
  ): Promise<{ sent: boolean; reason?: string; farmersSent: number }> {
    return this.digestService.sendTestDigest(tenantId);
  }
}
