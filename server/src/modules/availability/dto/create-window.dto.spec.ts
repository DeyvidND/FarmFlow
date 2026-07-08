import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateWindowDto } from './create-window.dto';
import { UpdateWindowDto } from './update-window.dto';

const make = (over: Partial<CreateWindowDto>) =>
  plainToInstance(CreateWindowDto, {
    productId: '11111111-1111-4111-a111-111111111111',
    quantity: 10,
    ...over,
  });

describe('CreateWindowDto', () => {
  it('accepts a valid stock entry', async () => {
    expect(await validate(make({}))).toHaveLength(0);
  });
  it('accepts quantity 0 (marks the product sold out)', async () => {
    expect(await validate(make({ quantity: 0 }))).toHaveLength(0);
  });
  it('rejects quantity < 0', async () => {
    expect((await validate(make({ quantity: -1 }))).length).toBeGreaterThan(0);
  });
  it('rejects a non-uuid productId', async () => {
    expect((await validate(make({ productId: 'x' as any }))).length).toBeGreaterThan(0);
  });
});

describe('UpdateWindowDto', () => {
  it('accepts an empty body (quantity optional)', async () => {
    const dto = plainToInstance(UpdateWindowDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });
  it('accepts quantity 0 (marks the product sold out)', async () => {
    const dto = plainToInstance(UpdateWindowDto, { quantity: 0 });
    expect(await validate(dto)).toHaveLength(0);
  });
  it('rejects quantity < 0', async () => {
    const dto = plainToInstance(UpdateWindowDto, { quantity: -1 });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
