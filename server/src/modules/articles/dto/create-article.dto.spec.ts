import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateArticleDto } from './create-article.dto';

function errorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreateArticleDto, payload));
}

describe('CreateArticleDto', () => {
  it('accepts a minimal valid article', async () => {
    const errs = await errorsFor({ title: 'Ягодите узряха' });
    expect(errs).toHaveLength(0);
  });

  it('rejects an empty title', async () => {
    const errs = await errorsFor({ title: '' });
    expect(errs.some((e) => e.property === 'title')).toBe(true);
  });
});

describe('CreateArticleDto — string length caps', () => {
  it('accepts strings within bounds', async () => {
    const errs = await errorsFor({
      title: 'Т'.repeat(200),
      slug: 's'.repeat(200),
      excerpt: 'Е'.repeat(500),
      body: '<p>x</p>'.repeat(12_000), // ~96k chars, under the 100k cap
    });
    expect(errs).toHaveLength(0);
  });

  it.each([
    ['title', 201],
    ['slug', 201],
    ['excerpt', 501],
    ['body', 100_001],
  ])('rejects an over-long %s', async (field, len) => {
    const errs = await errorsFor({ title: 'Заглавие', [field]: 'x'.repeat(len) });
    expect(errs.some((e) => e.property === field)).toBe(true);
  });
});
