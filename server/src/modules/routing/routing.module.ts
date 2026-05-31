import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { RoutingController } from './routing.controller';

@Module({
  controllers: [RoutingController],
  providers: [RoutingService],
})
export class RoutingModule {}
