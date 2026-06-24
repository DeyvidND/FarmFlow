import { Module } from '@nestjs/common';
import { DrizzleModule } from '../../common/drizzle/drizzle.module';
import { EcontCoreModule } from '../econt/econt-core.module';
import { SpeedyCoreModule } from '../speedy/speedy-core.module';
import { ImportService } from './import.service';
import { ImportAiService } from './import.ai';
import { ImportResolveService } from './import.resolve';
import { ImportController } from './import.controller';
import { ActivationGuard } from '../econt-app/activation.guard';

@Module({
  imports: [DrizzleModule, EcontCoreModule, SpeedyCoreModule],
  controllers: [ImportController],
  providers: [ImportService, ImportAiService, ImportResolveService, ActivationGuard],
})
export class ImportModule {}
