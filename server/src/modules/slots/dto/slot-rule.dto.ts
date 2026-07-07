import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SlotWindowDto {
  @ApiProperty({ example: '10:00' }) @IsString() @Matches(/^\d{2}:\d{2}$/) timeFrom: string;

  @ApiProperty({ example: '12:00' }) @IsString() @Matches(/^\d{2}:\d{2}$/) timeTo: string;
}

export class SlotDayDto extends SlotWindowDto {
  @ApiProperty({ example: 1, description: '0=Sun..6=Sat' }) @IsInt() @Min(0) @Max(6) dow: number;
}

export class SaveSlotRuleDto {
  @ApiProperty() @IsBoolean() active: boolean;

  @ApiProperty({ enum: ['weekdays', 'interval'] })
  @IsIn(['weekdays', 'interval'])
  repeat: 'weekdays' | 'interval';

  @ApiProperty({ type: [SlotDayDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlotDayDto)
  days: SlotDayDto[];

  @ApiProperty({ example: 3 }) @IsInt() @Min(1) intervalDays: number;

  @ApiProperty({ type: SlotWindowDto })
  @ValidateNested()
  @Type(() => SlotWindowDto)
  intervalWindow: SlotWindowDto;

  @ApiProperty({ example: '2026-06-08' }) @IsDateString() anchorDate: string;

  @ApiProperty({ example: 28 }) @IsInt() @Min(1) @Max(60) horizonDays: number;

  @ApiPropertyOptional({
    example: 60,
    description: 'Колко минути трае една доставка; >0 разделя прозореца на слотове с тази дължина. 0/липсва = един слот.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(480)
  slotMinutes?: number;

  @ApiPropertyOptional({
    example: 2,
    description: 'Колко поръчки приема всеки автоматичен слот (1–20). По подразбиране 1.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  defaultCapacity?: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(280) customerNote?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) driverNote?: string;
}
