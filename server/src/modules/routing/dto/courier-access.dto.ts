import { IsEmail } from 'class-validator';

/**
 * Task B1 — grant (or re-invite) a `role='driver'` login for a tenant, from the
 * super-admin console. No `courierIndex` here: leg assignment now happens on
 * the per-day assignment board (Task A2/C2), not at account-grant time — the
 * account is created with `courierIndex` NULL.
 */
export class GrantCourierAccessDto {
  @IsEmail({}, { message: 'Невалиден имейл' })
  email!: string;
}
