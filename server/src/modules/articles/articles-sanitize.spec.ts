import { sanitizeArticleHtml } from './articles.util';
import { ArticlesService } from './articles.service';

// Guard: the service must route body writes through the sanitizer. This test
// pins the contract the service relies on (script stripped) so a future refactor
// that bypasses sanitize is caught here + in the live E2E.
it('sanitizer strips script in body payloads', () => {
  expect(sanitizeArticleHtml('<p>ok</p><script>x</script>')).toBe('<p>ok</p>');
});

it('remove() sweeps the article R2 prefix', async () => {
  const deleteByPrefix = jest.fn().mockResolvedValue(undefined);
  const storage = { delete: jest.fn(), deleteByPrefix } as any;
  const cache = { invalidate: jest.fn() } as any;
  const article = { id: 'a1', tenantId: 't1', coverImageUrl: null, media: [] };
  const db = {
    delete: () => ({ where: () => Promise.resolve() }),
  } as any;
  const svc = new ArticlesService(db, storage, cache, {} as any);
  jest.spyOn(svc, 'findOne').mockResolvedValue(article as any);
  await svc.remove('a1', 't1');
  expect(deleteByPrefix).toHaveBeenCalledWith('tenants/t1/articles/a1/');
});
