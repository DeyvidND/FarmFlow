import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MyOrdersQueryDto } from './my-orders-query.dto';

async function validateDto(input: Record<string, unknown>) {
  const dto = plainToInstance(MyOrdersQueryDto, input);
  return validate(dto);
}

describe('MyOrdersQueryDto', () => {
  it('accepts every real order status', async () => {
    for (const status of ['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled']) {
      const errors = await validateDto({ status });
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects an unknown status', async () => {
    const errors = await validateDto({ status: 'bogus' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts an optional farmerId as a UUID', async () => {
    const errors = await validateDto({ farmerId: '9c6c6b0e-0000-4000-8000-000000000000' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-UUID farmerId', async () => {
    const errors = await validateDto({ farmerId: 'not-a-uuid' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('allows omitting every field', async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });
});
