import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

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

/**
 * The operator's vendor-finance switches. Every field optional: the settings card
 * PATCHes only what changed, and the service path-merges each key on its own.
 *
 * `defaultCommissionRateBps` is capped at 10000 (100%) to match the per-producer
 * override in `create-farmer.dto` — the two are read as alternatives for the same
 * multiplication, so a cap on one and not the other would be a hole.
 */
export class UpdateVendorFinanceDto {
  @ApiPropertyOptional({ description: 'Прилага ли се комисиона върху поръчките.' })
  @IsOptional()
  @IsBoolean()
  commissionEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 10000, description: 'Комисиона по подразбиране в базисни точки (500 = 5%).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  defaultCommissionRateBps?: number;

  @ApiPropertyOptional({ description: 'Начисляват ли се месечни абонаментни такси.' })
  @IsOptional()
  @IsBoolean()
  subscriptionEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 0, description: 'Месечна такса по подразбиране в стотинки/евроценти.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  defaultSubscriptionFeeStotinki?: number;
}

export class UpdateChargeDto {
  @IsIn(['due', 'paid', 'waived'])
  status!: 'due' | 'paid' | 'waived';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
