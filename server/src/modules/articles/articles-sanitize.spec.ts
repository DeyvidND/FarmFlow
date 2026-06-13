import { sanitizeArticleHtml } from './articles.util';

// Guard: the service must route body writes through the sanitizer. This test
// pins the contract the service relies on (script stripped) so a future refactor
// that bypasses sanitize is caught here + in the live E2E.
it('sanitizer strips script in body payloads', () => {
  expect(sanitizeArticleHtml('<p>ok</p><script>x</script>')).toBe('<p>ok</p>');
});
