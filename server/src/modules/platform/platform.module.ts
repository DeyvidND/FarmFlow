import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { PlatformService } from './platform.service';
import { PlatformController, PlatformAuthController } from './platform.controller';

@Module({
  imports: [AuthModule, BillingModule], // JwtModule (signing) + jwt strategy; billing for premium toggle
  controllers: [PlatformAuthController, PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}
