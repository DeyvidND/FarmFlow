import { SetMetadata } from '@nestjs/common';
import type { TenantRole } from '@farmflow/types';

export const ROLES_KEY = 'roles';

/**
 * Restrict a tenant route/controller to specific roles. Tenant routes are
 * admin-only BY DEFAULT (see TenantRolesGuard) — use this only to OPEN a route to
 * additional roles, e.g. `@Roles('admin', 'driver')` for a future driver view.
 */
export const Roles = (...roles: TenantRole[]) => SetMetadata(ROLES_KEY, roles);
