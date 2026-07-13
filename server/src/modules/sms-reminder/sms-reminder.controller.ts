import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SmsReminderService } from './sms-reminder.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('sms-reminder')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sms-reminder')
export class SmsReminderController {
  constructor(private readonly reminder: SmsReminderService) {}

  /** Fire the day-of SMS send for the caller's OWN tenant now (testing / re-send). */
  @Post('run')
  run(@CurrentTenant() tenantId: string, @Body() body: { date?: string }) {
    return this.reminder.sendForTenant(tenantId, body.date);
  }
}
