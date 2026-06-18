import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateProductDto } from './create-product.dto';

const make = (over: Record<string, unknown>) =>
  plainToInstance(CreateProductDto, {
    name: 'Домати',
    priceStotinki: 350,
    unit: 'kg',
    ...over,
  });

describe('CreateProductDto', () => {
  it('accepts a minimal valid product', async () => {
    expect(await validate(make({}))).toHaveLength(0);
  });

  it('rejects a negative price', async () => {
    expect((await validate(make({ priceStotinki: -1 }))).length).toBeGreaterThan(0);
  });
});

describe('CreateProductDto — string length caps', () => {
  it('accepts strings within bounds', async () => {
    const errs = await validate(make({
      name: 'Н'.repeat(200),
      description: 'О'.repeat(4000),
      unit: 'u'.repeat(40),
      weight: 'w'.repeat(40),
      category: 'К'.repeat(120),
      tint: '#'.repeat(40),
    }));
    expect(errs).toHaveLength(0);
  });

  it.each([
    ['name', 201],
    ['description', 4001],
    ['unit', 41],
    ['weight', 41],
    ['category', 121],
    ['tint', 41],
  ])('rejects an over-long %s', async (field, len) => {
    const errs = await validate(make({ [field]: 'x'.repeat(len) }));
    expect(errs.some((e) => e.property === field)).toBe(true);
  });
});

describe('CreateProductDto — stock (availability window)', () => {
  it('accepts a non-negative integer stock', async () => {
    expect(await validate(make({ stock: 20 }))).toHaveLength(0);
  });

  it('accepts stock = 0 (out of stock)', async () => {
    expect(await validate(make({ stock: 0 }))).toHaveLength(0);
  });

  it('accepts stock = null (clear → unlimited)', async () => {
    expect(await validate(make({ stock: null }))).toHaveLength(0);
  });

  it('accepts an absent stock (untouched)', async () => {
    expect(await validate(make({}))).toHaveLength(0);
  });

  it('rejects a negative stock', async () => {
    const errs = await validate(make({ stock: -1 }));
    expect(errs.some((e) => e.property === 'stock')).toBe(true);
  });

  it('rejects a non-integer stock', async () => {
    const errs = await validate(make({ stock: 2.5 }));
    expect(errs.some((e) => e.property === 'stock')).toBe(true);
  });
});
