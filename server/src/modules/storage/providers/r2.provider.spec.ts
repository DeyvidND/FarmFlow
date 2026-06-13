import { ConfigService } from '@nestjs/config';
import { R2StorageProvider } from './r2.provider';

describe('R2StorageProvider.deleteByPrefix (stub mode)', () => {
  it('is a no-op when unconfigured', async () => {
    const provider = new R2StorageProvider(new ConfigService({}));
    await expect(provider.deleteByPrefix('tenants/x/articles/y/')).resolves.toBeUndefined();
  });
});
