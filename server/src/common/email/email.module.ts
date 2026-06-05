import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { SuppressionService } from './suppression.service';
import { EmailWebhookController } from './email-webhook.controller';

@Global()
@Module({
  controllers: [EmailWebhookController],
  providers: [EmailService, SuppressionService],
  exports: [EmailService, SuppressionService],
})
export class EmailModule {}
