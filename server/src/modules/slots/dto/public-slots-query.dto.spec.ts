import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PublicSlotsQueryDto } from './public-slots-query.dto';

function badProps(obj: unknown): string[] {
  const dto = plainToInstance(PublicSlotsQueryDto, obj);
  return validateSync(dto as object, { whitelist: true }).map((e) => e.property);
}

describe('PublicSlotsQueryDto', () => {
  it('accepts well-formed YYYY-MM-DD date/from/to', () => {
    expect(badProps({ date: '2026-05-30', from: '2026-05-25', to: '2026-05-31' })).toEqual([]);
  });

  it('accepts an empty query (all three optional)', () => {
    expect(badProps({})).toEqual([]);
  });

  it.each(['date', 'from', 'to'])('rejects a garbage %s before it reaches the date column', (field) => {
    // The public /slots endpoint is unauthenticated; a raw string here otherwise
    // hits eq/gte/lte(deliverySlots.date, ...) and 500s with a pg 22007.
    expect(badProps({ [field]: 'garbage' })).toEqual([field]);
  });

  it('rejects a partial / non-ISO date shape', () => {
    expect(badProps({ date: '2026-5-1' })).toEqual(['date']);
    expect(badProps({ from: '05/25/2026' })).toEqual(['from']);
  });
});
