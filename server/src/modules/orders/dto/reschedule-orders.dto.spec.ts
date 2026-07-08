import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RescheduleOrdersDto } from './reschedule-orders.dto';

const UUID = '11111111-1111-1111-8111-111111111111';
const errs = (obj: unknown) => validateSync(plainToInstance(RescheduleOrdersDto, obj));

describe('RescheduleOrdersDto', () => {
  it('accepts a non-empty uuid list + a YYYY-MM-DD date', () => {
    expect(errs({ orderIds: [UUID], toDate: '2026-07-10' })).toHaveLength(0);
  });
  it('rejects an empty orderIds array', () => {
    expect(errs({ orderIds: [], toDate: '2026-07-10' }).length).toBeGreaterThan(0);
  });
  it('rejects a non-uuid id', () => {
    expect(errs({ orderIds: ['nope'], toDate: '2026-07-10' }).length).toBeGreaterThan(0);
  });
  it('rejects a malformed date', () => {
    expect(errs({ orderIds: [UUID], toDate: '10.07.2026' }).length).toBeGreaterThan(0);
  });
  it('rejects a missing date', () => {
    expect(errs({ orderIds: [UUID] }).length).toBeGreaterThan(0);
  });
});
