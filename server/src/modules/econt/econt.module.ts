import { Module } from '@nestjs/common';
import { EcontService } from './econt.service';
import { EcontController, PublicEcontController } from './econt.controller';

@Module({
  controllers: [EcontController, PublicEcontController],
  providers: [EcontService],
  exports: [EcontService],
})
export class EcontModule {}
