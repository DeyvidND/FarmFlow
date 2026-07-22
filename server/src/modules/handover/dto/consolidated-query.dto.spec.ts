import { ValidationPipe } from '@nestjs/common';
import { ConsolidatedQueryDto } from './consolidated-query.dto';

/**
 * Runs the DTO through the SAME global ValidationPipe config as main.ts
 * (whitelist + forbidNonWhitelisted + transform). The controller-method unit
 * tests bypass the pipe, so a query param that isn't whitelisted sails through
 * them but 400s in production — exactly what happened to send-to-couriers'
 * ?onlyFailed=true resend. This guards the whole query shape at the pipe level.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = { type: 'query' as const, metatype: ConsolidatedQueryDto };

describe('ConsolidatedQueryDto (through the global ValidationPipe)', () => {
  it('accepts date alone', async () => {
    const out = await pipe.transform({ date: '2026-07-21' }, meta);
    expect(out.date).toBe('2026-07-21');
  });

  it('accepts ?onlyFailed=true — the §4.4 resend must NOT be rejected as a non-whitelisted property', async () => {
    const out = await pipe.transform({ date: '2026-07-21', onlyFailed: 'true' }, meta);
    expect(out.date).toBe('2026-07-21');
    expect(out.onlyFailed).toBe('true');
  });

  it('still rejects a genuinely unknown property (forbidNonWhitelisted stays on)', async () => {
    await expect(pipe.transform({ date: '2026-07-21', bogus: 'x' }, meta)).rejects.toThrow();
  });

  it('still rejects a malformed date', async () => {
    await expect(pipe.transform({ date: 'not-a-date' }, meta)).rejects.toThrow();
  });
});
