import { NewsletterCopyService } from './auto-draft.ai';

function makeSvc(key: string | null = 'sk-test') {
  const config = { get: (k: string, d?: unknown) => (k === 'OPENAI_API_KEY' ? key : d) } as any;
  return new NewsletterCopyService(config);
}
const PRODUCTS = [{ id: 'a', name: 'Домати', priceStotinki: 250, imageUrl: null }];

describe('NewsletterCopyService.writeCopy', () => {
  it('falls back deterministically when no API key is configured', async () => {
    const copy = await makeSvc(null).writeCopy('Зелена Ферма', PRODUCTS);
    expect(copy.subject).toContain('Зелена Ферма');
    expect(copy.blurbs).toEqual({});
  });

  it('parses a well-formed model response', async () => {
    const svc = makeSvc();
    (svc as any).client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ subject: 'Свежо!', intro: 'Здравейте', blurbs: { Домати: 'Сочни' } }) } }] }) } } };
    const copy = await svc.writeCopy('Ферма', PRODUCTS);
    expect(copy).toEqual({ subject: 'Свежо!', intro: 'Здравейте', blurbs: { Домати: 'Сочни' } });
  });

  it('falls back on malformed JSON', async () => {
    const svc = makeSvc();
    (svc as any).client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'not json' } }] }) } } };
    const copy = await svc.writeCopy('Ферма Х', PRODUCTS);
    expect(copy.subject).toContain('Ферма Х');
    expect(copy.blurbs).toEqual({});
  });

  it('uses the fallback subject when the model omits one', async () => {
    const svc = makeSvc();
    (svc as any).client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ intro: 'само интро' }) } }] }) } } };
    const copy = await svc.writeCopy('Ферма Y', PRODUCTS);
    expect(copy.subject).toContain('Ферма Y');
    expect(copy.intro).toBe('само интро');
  });
});
