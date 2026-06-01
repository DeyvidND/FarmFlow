import { Module } from '@nestjs/common';
import { IntakeService } from './intake.service';
import { PublicIntakeController } from './intake.controller';

@Module({
  controllers: [PublicIntakeController],
  providers: [IntakeService],
})
export class IntakeModule {}
