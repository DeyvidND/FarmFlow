import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const PERIOD_MSG = 'Невалиден период — очаква се формат YYYY-MM.';

export class CommissionSummaryQueryDto {
  /** Owner-only narrowing; a producer token is always forced to its own farmerId. */
  @IsOptional()
  @IsUUID()
  farmerId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class GenerateChargesDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: PERIOD_MSG })
  period!: string;
}

export class ListChargesQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: PERIOD_MSG })
  period?: string;
}

export class UpdateChargeDto {
  @IsIn(['due', 'paid', 'waived'])
  status!: 'due' | 'paid' | 'waived';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
