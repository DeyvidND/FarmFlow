import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { R2StorageProvider } from './providers/r2.provider';

@Global()
@Module({
  providers: [
    {
      provide: StorageService,
      useClass: R2StorageProvider,
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
