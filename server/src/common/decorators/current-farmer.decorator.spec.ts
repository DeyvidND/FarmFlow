import { ExecutionContext } from '@nestjs/common';
import { currentFarmerFactory } from './current-farmer.decorator';

function ctx(user: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as never;
}

describe('currentFarmerFactory', () => {
  it('returns farmerId when present', () => {
    expect(currentFarmerFactory(undefined, ctx({ tenantId: 't1', farmerId: 'f1' }))).toBe('f1');
  });
  it('returns undefined when absent', () => {
    expect(currentFarmerFactory(undefined, ctx({ tenantId: 't1' }))).toBeUndefined();
  });
});
