import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HelpController } from './help.controller';
import { HelpAiService } from './help-ai.service';

@Module({
  imports: [AuthModule],
  controllers: [HelpController],
  providers: [HelpAiService],
})
export class HelpModule {}
