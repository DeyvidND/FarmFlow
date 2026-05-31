import { Module } from '@nestjs/common';
import { SlotsService } from './slots.service';
import { SlotsController, PublicSlotsController } from './slots.controller';

@Module({
  controllers: [SlotsController, PublicSlotsController],
  providers: [SlotsService],
})
export class SlotsModule {}
