import { ForbiddenException } from '@nestjs/common';
import type { TenantRole } from '@fermeribg/types';

/**
 * Decide which producer a stats/scoped request applies to.
 * - role 'farmer': always their own token id (a producer can never widen scope;
 *   any query override is ignored). Missing id ⇒ malformed token ⇒ 403.
 * - any other role (owner 'admin'): the optional query id, or null = whole tenant.
 */
export function effectiveFarmerId(
  role: TenantRole,
  tokenFarmerId: string | undefined,
  queryFarmerId: string | undefined,
): string | null {
  if (role === 'farmer') {
    if (!tokenFarmerId) throw new ForbiddenException('Невалиден достъп');
    return tokenFarmerId;
  }
  return queryFarmerId ?? null;
}
