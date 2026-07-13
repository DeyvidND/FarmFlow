import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SmsReminderService, type ReminderChannel } from './sms-reminder.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('sms-reminder')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sms-reminder')
export class SmsReminderController {
  constructor(private readonly reminder: SmsReminderService) {}

  /**
   * Fire the day-of reminder for the caller's OWN tenant now (testing / re-send).
   * `channel` overrides the send channel for this run ('email' default, 'sms'
   * to test the gateway); `date` overrides the day (default today).
   */
  @Post('run')
  run(
    @CurrentTenant() tenantId: string,
    @Body() body: { channel?: ReminderChannel; date?: string },
  ) {
    return this.reminder.sendForTenant(tenantId, body.channel ?? 'email', body.date);
  }
}
