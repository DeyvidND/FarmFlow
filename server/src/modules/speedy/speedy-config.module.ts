import { Module } from '@nestjs/common';
import { SpeedyCoreModule } from './speedy-core.module';
import { SpeedyConfigController } from './speedy-config.controller';

/**
 * Main-API-only module: the controller-less {@link SpeedyCoreModule} plus the
 * farmer credential-management controller.  Only imported by {@link AppModule}.
 *
 * The dostavki backend ({@link EcontAppModule}) imports {@link SpeedyCoreModule}
 * directly (for SpeedyService) and mounts {@link SpeedyStandaloneController}
 * on the same `@Controller('speedy')` prefix — keeping the two processes'
 * route sets fully disjoint.
 */
@Module({
  imports: [SpeedyCoreModule],
  controllers: [SpeedyConfigController],
  exports: [SpeedyCoreModule],
})
export class SpeedyConfigModule {}
