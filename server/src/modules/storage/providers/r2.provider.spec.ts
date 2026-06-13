import { ConfigService } from '@nestjs/config';
import { R2StorageProvider } from './r2.provider';

describe('R2StorageProvider.deleteByPrefix (stub mode)', () => {
  it('is a no-op when unconfigured', async () => {
    const provider = new R2StorageProvider(new ConfigService({}));
    await expect(provider.deleteByPrefix('tenants/x/articles/y/')).resolves.toBeUndefined();
  });
});

describe('R2StorageProvider.deleteByPrefix (live, mocked S3)', () => {
  function liveProvider(send: jest.Mock): R2StorageProvider {
    const provider = new R2StorageProvider(new ConfigService({}));
    // Force out of stub mode and inject a mock S3 client.
    (provider as unknown as { stubMode: boolean }).stubMode = false;
    (provider as unknown as { bucket: string }).bucket = 'bucket';
    (provider as unknown as { client: { send: jest.Mock } }).client = { send };
    return provider;
  }

  it('paginates listing and deletes every page in batches', async () => {
    const pages = [
      { Contents: [{ Key: 'a' }, { Key: 'b' }], IsTruncated: true, NextContinuationToken: 'tok1' },
      { Contents: [{ Key: 'c' }], IsTruncated: false },
    ];
    let listIdx = 0;
    const tokens: (string | undefined)[] = [];
    const deletedKeys: string[][] = [];
    const send = jest.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      if (name === 'ListObjectsV2Command') {
        tokens.push(cmd.input.ContinuationToken as string | undefined);
        return pages[listIdx++];
      }
      if (name === 'DeleteObjectsCommand') {
        const objs = (cmd.input.Delete as { Objects: { Key: string }[] }).Objects;
        deletedKeys.push(objs.map((o) => o.Key));
        return {};
      }
      return {};
    });

    await liveProvider(send).deleteByPrefix('tenants/t/articles/x/');

    // Two list calls: first with no token, second driven by NextContinuationToken.
    expect(tokens).toEqual([undefined, 'tok1']);
    // One delete batch per non-empty page, with the right keys.
    expect(deletedKeys).toEqual([['a', 'b'], ['c']]);
  });

  it('skips the delete call when a page is empty', async () => {
    const send = jest.fn(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [], IsTruncated: false };
      }
      return {};
    });

    await liveProvider(send).deleteByPrefix('tenants/t/articles/x/');

    const deleteCalls = send.mock.calls.filter(
      ([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === 'DeleteObjectsCommand',
    );
    expect(deleteCalls).toHaveLength(0);
  });
});
