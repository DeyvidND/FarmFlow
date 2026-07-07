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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SlotDayDto {
  @ApiProperty({ example: 1, description: '0=Sun..6=Sat' }) @IsInt() @Min(0) @Max(6) dow: number;

  @ApiProperty({ example: 40, description: 'Колко поръчки приема денят (1–500)' })
  @IsInt()
  @Min(1)
  @Max(500)
  capacity: number;
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

  @ApiProperty({ example: 10, description: 'Колко поръчки приема всеки автоматичен ден (1–500)' })
  @IsInt()
  @Min(1)
  @Max(500)
  intervalCapacity: number;

  @ApiProperty({ example: '2026-06-08' }) @IsDateString() anchorDate: string;

  @ApiProperty({ example: 28 }) @IsInt() @Min(1) @Max(60) horizonDays: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(280) customerNote?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) driverNote?: string;
}
