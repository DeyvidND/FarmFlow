import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOrderDto } from './update-order.dto';

async function errsFor(payload: unknown): Promise<string[]> {
  const dto = plainToInstance(UpdateOrderDto, payload);
  const errors = await validate(dto as object, { whitelist: true });
  return errors.map((e) => e.property);
}

describe('UpdateOrderDto', () => {
  it('accepts an empty patch (all fields optional)', async () => {
    expect(await errsFor({})).toEqual([]);
  });
  it('accepts a contact-only patch', async () => {
    expect(await errsFor({ customerName: 'Иван', customerPhone: '0888000000' })).toEqual([]);
  });
  it('accepts slotId: null (clear the slot)', async () => {
    expect(await errsFor({ slotId: null })).toEqual([]);
  });
  it('rejects a non-uuid slotId', async () => {
    expect(await errsFor({ slotId: 'not-a-uuid' })).toContain('slotId');
  });
  it('rejects an item with quantity < 1', async () => {
    expect(await errsFor({ items: [{ productId: '11111111-1111-1111-1111-111111111111', quantity: 0 }] })).toContain('items');
  });
  it('rejects an empty items array', async () => {
    expect(await errsFor({ items: [] })).toContain('items');
  });
});
