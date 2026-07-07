import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CompareShipmentDto } from './compare-shipment.dto';

const make = (over: Partial<CompareShipmentDto>) =>
  plainToInstance(CompareShipmentDto, { deliveryMode: 'address', ...over });

describe('CompareShipmentDto', () => {
  it('accepts destinationCity alone (admin panel path)', async () => {
    expect(await validate(make({ destinationCity: 'Sofia' }))).toHaveLength(0);
  });
  it('accepts destinationAddress alone (public typed-address path)', async () => {
    expect(await validate(make({ destinationAddress: 'ул. Дунав 5, Варна' }))).toHaveLength(0);
  });
  it('accepts both destinationCity and destinationAddress', async () => {
    expect(
      await validate(make({ destinationCity: 'Sofia', destinationAddress: 'ул. Дунав 5' })),
    ).toHaveLength(0);
  });
  it('rejects neither destinationCity nor destinationAddress', async () => {
    const errors = await validate(make({}));
    const props = errors.map((e) => e.property);
    expect(props).toEqual(expect.arrayContaining(['destinationCity', 'destinationAddress']));
  });
  it('rejects a destinationAddress over 250 chars', async () => {
    const errors = await validate(make({ destinationAddress: 'a'.repeat(251) }));
    expect(errors.some((e) => e.property === 'destinationAddress')).toBe(true);
  });
});
