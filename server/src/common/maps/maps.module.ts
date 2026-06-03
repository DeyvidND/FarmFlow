import { Global, Module } from '@nestjs/common';
import { MapsService } from './maps.service';

/** Global so any module (orders, routing) can inject MapsService directly. */
@Global()
@Module({
  providers: [MapsService],
  exports: [MapsService],
})
export class MapsModule {}
