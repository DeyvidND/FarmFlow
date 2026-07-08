import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SpeedyCourierRequestDto } from './speedy-courier-request.dto';

// RFC4122-shaped (version nibble '4', variant nibble '8') so IsUUID accepts it.
const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n.toString(16)}`;

async function errorsFor(extra: Record<string, unknown>) {
  const dto = plainToInstance(SpeedyCourierRequestDto, extra);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('SpeedyCourierRequestDto.shipmentIds', () => {
  it('accepts a normal list of shipment UUIDs', async () => {
    const errs = await errorsFor({ shipmentIds: [uuid(1), uuid(2)] });
    expect(errs.find((e) => e.property === 'shipmentIds')).toBeUndefined();
  });

  it('rejects more than 50 ids (unbounded IN(...) query guard)', async () => {
    const many = Array.from({ length: 51 }, (_, i) => uuid(i % 9));
    const errs = await errorsFor({ shipmentIds: many });
    expect(errs.find((e) => e.property === 'shipmentIds')).toBeDefined();
  });

  it('accepts exactly 50 ids (boundary)', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => uuid(i % 9));
    const errs = await errorsFor({ shipmentIds: fifty });
    expect(errs.find((e) => e.property === 'shipmentIds')).toBeUndefined();
  });

  it('rejects a non-UUID entry', async () => {
    const errs = await errorsFor({ shipmentIds: ['not-a-uuid'] });
    expect(errs.find((e) => e.property === 'shipmentIds')).toBeDefined();
  });
});
