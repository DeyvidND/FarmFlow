import { IsInt, Max, Min, ValidateIf } from 'class-validator';

/**
 * Task #6 — move an order onto a specific courier (0-based index) on the route
 * screen, or clear the pin back to auto (`courierIndex: null`). A pinned order
 * stays with its courier across reloads and route recomputes; an out-of-range
 * index is stored but ignored by the router (falls back to auto).
 */
export class SetOrderCourierDto {
  // null clears the pin; a number pins. ValidateIf lets `null` through the
  // Int/Min/Max checks (they'd otherwise reject null).
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(9)
  courierIndex!: number | null;
}
