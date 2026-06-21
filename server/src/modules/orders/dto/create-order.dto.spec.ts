import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderDto } from './create-order.dto';

const base = {
  items: [{ productId: '11111111-1111-1111-1111-111111111111', quantity: 1 }],
  deliveryType: 'address',
  deliveryAddress: 'ул. Шипка 5',
};

async function errorsFor(extra: Record<string, unknown>) {
  const dto = plainToInstance(CreateOrderDto, { ...base, ...extra });
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('CreateOrderDto.deliveryNote', () => {
  it('accepts an order with no deliveryNote (optional)', async () => {
    const errs = await errorsFor({});
    expect(errs.find((e) => e.property === 'deliveryNote')).toBeUndefined();
  });

  it('accepts a normal block/entrance note', async () => {
    const errs = await errorsFor({ deliveryNote: 'бл. 12, вх. А, ет. 3, ап. 9' });
    expect(errs.find((e) => e.property === 'deliveryNote')).toBeUndefined();
  });

  it('rejects a note longer than 120 chars', async () => {
    const errs = await errorsFor({ deliveryNote: 'я'.repeat(121) });
    const noteErr = errs.find((e) => e.property === 'deliveryNote');
    expect(noteErr?.constraints?.maxLength).toBeDefined();
  });
});
