import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformService } from './platform.service';
import { PlatformController, PlatformAuthController } from './platform.controller';

@Module({
  imports: [AuthModule], // JwtModule (signing) + the jwt passport strategy
  controllers: [PlatformAuthController, PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}
