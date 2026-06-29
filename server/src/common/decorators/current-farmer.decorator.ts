import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Extracts the optional farmerId from the authenticated delivery/farmer session.
 *  Undefined for marketplace-admin (tenant-level) sessions. Pairs with
 *  @CurrentTenant() — the two together scope delivery storage to a farmer
 *  sub-namespace when farmerId is set. */
export function currentFarmerFactory(_data: unknown, ctx: ExecutionContext): string | undefined {
  const req = ctx.switchToHttp().getRequest();
  return req.user?.farmerId;
}

export const CurrentFarmer = createParamDecorator(currentFarmerFactory);
