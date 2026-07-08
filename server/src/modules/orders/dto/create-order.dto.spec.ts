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

  it('accepts a note of exactly 120 chars (boundary)', async () => {
    const errs = await errorsFor({ deliveryNote: 'я'.repeat(120) });
    expect(errs.find((e) => e.property === 'deliveryNote')).toBeUndefined();
  });

  it('rejects a note longer than 120 chars', async () => {
    const errs = await errorsFor({ deliveryNote: 'я'.repeat(121) });
    const noteErr = errs.find((e) => e.property === 'deliveryNote');
    expect(noteErr?.constraints?.maxLength).toBeDefined();
  });
});

describe('CreateOrderDto.customerEmail', () => {
  // The storefront always sends customerEmail (an empty string when the buyer
  // leaves the optional field blank). @IsOptional() alone skips only null/
  // undefined, so a bare @IsEmail() used to 400 on '' — the field is advertised
  // as optional but rejected an empty value. It must accept a blank email.
  it('accepts an empty-string email (optional field left blank)', async () => {
    const errs = await errorsFor({ customerEmail: '' });
    expect(errs.find((e) => e.property === 'customerEmail')).toBeUndefined();
  });

  it('accepts a whitespace-only email as blank', async () => {
    const errs = await errorsFor({ customerEmail: '   ' });
    expect(errs.find((e) => e.property === 'customerEmail')).toBeUndefined();
  });

  it('accepts a valid email', async () => {
    const errs = await errorsFor({ customerEmail: 'ivan@example.bg' });
    expect(errs.find((e) => e.property === 'customerEmail')).toBeUndefined();
  });

  it('still rejects a non-empty malformed email', async () => {
    const errs = await errorsFor({ customerEmail: 'not-an-email' });
    expect(errs.find((e) => e.property === 'customerEmail')?.constraints?.isEmail).toBeDefined();
  });
});
