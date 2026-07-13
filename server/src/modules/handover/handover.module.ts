import { Module } from '@nestjs/common';

// HandoverService/HandoverController land in later tasks (4/6, 10). Empty
// arrays keep this module registrable now without placeholder classes to
// discard later — DrizzleModule is @Global() so DB_TOKEN needs no import here.
@Module({
  controllers: [],
  providers: [],
})
export class HandoverModule {}
