import { Type } from 'class-transformer';
import { IsArray, IsInt, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';

/**
 * Task A2 — per-day courier leg board. `date` is Europe/Sofia ISO `YYYY-MM-DD`
 * (matches `deliverySlots.date` / `routeCourierAssignments.date`). `legIndex`
 * uses the same 0-based range as `GrantCourierAccessDto.courierIndex`
 * (orders.courierIndex / settings.routing.couriers[] indexing, 1–10 couriers).
 */
class AssignmentRowDto {
  @IsUUID()
  accountId!: string;

  @IsInt()
  @Min(0)
  @Max(9)
  legIndex!: number;
}

export class SetAssignmentsDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssignmentRowDto)
  assignments!: AssignmentRowDto[];
}

export class AssignmentsQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;
}
