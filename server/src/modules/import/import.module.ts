import { Module } from '@nestjs/common';
import { DrizzleModule } from '../../common/drizzle/drizzle.module';
import { MapsModule } from '../../common/maps/maps.module';
import { EcontCoreModule } from '../econt/econt-core.module';
import { SpeedyCoreModule } from '../speedy/speedy-core.module';
import { ImportService } from './import.service';
import { ImportAiService } from './import.ai';
import { ImportResolveService } from './import.resolve';
import { ImportController } from './import.controller';
import { ActivationGuard } from '../econt-app/activation.guard';
import { AddressGeoService } from './address-geo.service';

@Module({
  // MapsModule (@Global, but only loaded where imported): AddressGeoService needs
  // MapsService. The api gets it via AppModule, but the standalone econt app
  // (main.econt.ts → EcontAppModule → ImportModule) never imports MapsModule, so
  // without this econt crash-loops on boot ("can't resolve AddressGeoService").
  imports: [DrizzleModule, MapsModule, EcontCoreModule, SpeedyCoreModule],
  controllers: [ImportController],
  providers: [ImportService, ImportAiService, ImportResolveService, ActivationGuard, AddressGeoService],
})
export class ImportModule {}
