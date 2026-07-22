import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DigestService } from './digest.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { SendFarmerOrdersDto } from './dto/send-farmer-orders.dto';

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

  /** Task #14: trigger TOMORROW's per-farmer order email now — for manual SMTP
   *  testing without waiting for the 18:00 cron. */
  @Post('tomorrow-test')
  async testTomorrow(@CurrentTenant() tenantId: string): Promise<{ farmersSent: number }> {
    const farmersSent = await this.digestService.sendTomorrowFarmerEmails(tenantId, true);
    return { farmersSent };
  }

  /** Organizer manually emails selected farmers their orders for a date range. */
  @Post('farmers/send')
  sendFarmerOrders(
    @CurrentTenant() tenantId: string,
    @Body() dto: SendFarmerOrdersDto,
  ): Promise<{ sent: number; skipped: number }> {
    return this.digestService.sendFarmerOrderEmails(tenantId, dto);
  }

  /** Same selection as `farmers/send`, but only reports who would get an email — no send. */
  @Post('farmers/preview')
  previewFarmerOrders(
    @CurrentTenant() tenantId: string,
    @Body() dto: SendFarmerOrdersDto,
  ): Promise<{ recipients: { id: string; name: string; email: string; orderCount: number }[]; skipped: number }> {
    return this.digestService.previewFarmerOrderEmails(tenantId, dto);
  }
}
