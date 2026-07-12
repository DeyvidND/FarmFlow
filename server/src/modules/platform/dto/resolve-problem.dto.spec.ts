import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResolveProblemDto } from './resolve-problem.dto';

describe('ResolveProblemDto', () => {
  it('accepts a valid tenantId + path', async () => {
    const dto = plainToInstance(ResolveProblemDto, { tenantId: '9d3b1f4a-1b2c-4d3e-8f9a-0b1c2d3e4f5a', path: '/orders' });
    const errs = await validate(dto);
    expect(errs).toHaveLength(0);
  });

  it('accepts a null tenantId for platform-wide errors', async () => {
    const dto = plainToInstance(ResolveProblemDto, { tenantId: null, path: '/public/bootstrap' });
    const errs = await validate(dto);
    expect(errs).toHaveLength(0);
  });

  it('rejects a non-UUID tenantId', async () => {
    const dto = plainToInstance(ResolveProblemDto, { tenantId: 'not-a-uuid', path: '/orders' });
    const errs = await validate(dto);
    expect(errs.some((e) => e.property === 'tenantId')).toBe(true);
  });

  it('rejects a missing/blank path', async () => {
    const dto = plainToInstance(ResolveProblemDto, { tenantId: null, path: '' });
    const errs = await validate(dto);
    expect(errs.some((e) => e.property === 'path')).toBe(true);
  });
});
