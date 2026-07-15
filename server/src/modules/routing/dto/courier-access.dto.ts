import { IsEmail, IsInt, Max, Min } from 'class-validator';

/**
 * Task C2 — grant (or re-invite) a `role='driver'` login bound to one courier
 * leg. `courierIndex` uses the same 0-based range as `SetOrderCourierDto`
 * (orders.courierIndex / settings.routing.couriers[] indexing, 1–10 couriers).
 */
export class GrantCourierAccessDto {
  @IsInt()
  @Min(0)
  @Max(9)
  courierIndex!: number;

  @IsEmail({}, { message: 'Невалиден имейл' })
  email!: string;
}
