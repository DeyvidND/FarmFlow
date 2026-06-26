import { mergeAi, ImportAiService } from './import.ai';
import type { RowValidation, AiVerdict } from './import.types';
import { ConfigService } from '@nestjs/config';

describe('mergeAi', () => {
  const okValidation: RowValidation = { status: 'ok', issues: [] };

  it('returns deterministic validation unchanged when there is no AI verdict', () => {
    expect(mergeAi(okValidation, undefined)).toEqual(okValidation);
  });

  it('AI can raise ok → warn and append its issues', () => {
    const ai: AiVerdict = { index: 0, status: 'warn', issues: [{ field: 'city', message: 'Неясен град' }] };
    const out = mergeAi(okValidation, ai);
    expect(out.status).toBe('warn');
    expect(out.issues).toHaveLength(1);
  });

  it('AI cannot downgrade a hard error to ok', () => {
    const errValidation: RowValidation = { status: 'error', issues: [{ field: 'receiverName', message: 'Липсва' }] };
    const ai: AiVerdict = { index: 0, status: 'ok', issues: [] };
    const out = mergeAi(errValidation, ai);
    expect(out.status).toBe('error');
  });

  it('keeps the more severe of the two statuses', () => {
    const warnValidation: RowValidation = { status: 'warn', issues: [] };
    const ai: AiVerdict = { index: 0, status: 'error', issues: [{ field: 'phone', message: 'грешен' }] };
    expect(mergeAi(warnValidation, ai).status).toBe('error');
  });
});

describe('ImportAiService.repairAddresses', () => {
  it('returns [] when no OpenAI key is configured (degrade)', async () => {
    const svc = new ImportAiService({ get: () => undefined } as unknown as ConfigService);
    const out = await svc.repairAddresses([{ index: 1, address: 'ул Граф Игнатиев', city: 'София' }]);
    expect(out).toEqual([]);
  });
});
