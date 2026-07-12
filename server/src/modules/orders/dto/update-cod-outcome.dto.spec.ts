import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateCodOutcomeDto } from './update-cod-outcome.dto';

const errs = (obj: unknown) => validateSync(plainToInstance(UpdateCodOutcomeDto, obj));

describe('UpdateCodOutcomeDto', () => {
  it('accepts outcome: received', () => {
    expect(errs({ outcome: 'received' })).toHaveLength(0);
  });
  it('accepts outcome: refused (+ optional reason)', () => {
    expect(errs({ outcome: 'refused', reason: 'не вдигна' })).toHaveLength(0);
  });
  // Task #3 — revert a resolved COD outcome back to «Очаквано».
  it('accepts outcome: pending (the revert value)', () => {
    expect(errs({ outcome: 'pending' })).toHaveLength(0);
  });
  it('rejects an unknown outcome', () => {
    expect(errs({ outcome: 'cancelled' }).length).toBeGreaterThan(0);
  });
  it('rejects a missing outcome', () => {
    expect(errs({}).length).toBeGreaterThan(0);
  });
});
