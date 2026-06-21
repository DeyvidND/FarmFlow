import { Module } from '@nestjs/common';
import { DemoRequestController } from './demo-request.controller';
import { DemoRequestService } from './demo-request.service';

// EmailService is @Global and ConfigService is global — no imports needed.
@Module({
  controllers: [DemoRequestController],
  providers: [DemoRequestService],
})
export class DemoRequestModule {}
