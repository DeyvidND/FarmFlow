import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { HelpAiService } from './help-ai.service';

function makeSvc(key: string | null = null) {
  const config = { get: (k: string, d?: unknown) => (k === 'OPENAI_API_KEY' ? key : d) } as any;
  return new HelpAiService(config);
}

describe('HelpAiService.ask', () => {
  it('rejects an empty question', async () => {
    await expect(makeSvc().ask('panel', '   ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a question over 500 chars', async () => {
    await expect(makeSvc().ask('panel', 'a'.repeat(501))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is unavailable when no API key is configured', async () => {
    await expect(makeSvc().ask('panel', 'Как добавям продукт?')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns the model answer, grounded via the surface corpus', async () => {
    const svc = makeSvc('key');
    (svc as any).client = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: 'Отвори „Продукти" → „Добави продукт".' } }] }) } },
    };
    const answer = await svc.ask('panel', 'Как добавям продукт?');
    expect(answer).toContain('Добави продукт');
  });

  it('surfaces an OpenAI failure as ServiceUnavailable', async () => {
    const svc = makeSvc('key');
    (svc as any).client = {
      chat: { completions: { create: async () => { throw new Error('timeout'); } } },
    };
    await expect(svc.ask('panel', 'Как добавям продукт?')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
