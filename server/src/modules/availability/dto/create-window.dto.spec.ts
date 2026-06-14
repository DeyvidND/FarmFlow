import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateWindowDto } from './create-window.dto';

const make = (over: Partial<CreateWindowDto>) =>
  plainToInstance(CreateWindowDto, {
    productId: '11111111-1111-4111-a111-111111111111',
    startsAt: '2026-06-14',
    endsAt: '2026-06-20',
    quantity: 10,
    ...over,
  });

describe('CreateWindowDto', () => {
  it('accepts a valid window', async () => {
    expect(await validate(make({}))).toHaveLength(0);
  });
  it('rejects a non-date startsAt', async () => {
    expect((await validate(make({ startsAt: 'nope' as any }))).length).toBeGreaterThan(0);
  });
  it('rejects quantity < 1', async () => {
    expect((await validate(make({ quantity: 0 }))).length).toBeGreaterThan(0);
  });
  it('rejects a non-uuid productId', async () => {
    expect((await validate(make({ productId: 'x' as any }))).length).toBeGreaterThan(0);
  });
});
