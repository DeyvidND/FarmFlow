import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
} from 'class-validator';

export class SaveSlotRuleDto {
  @ApiProperty() @IsBoolean() active: boolean;

  @ApiProperty({ enum: ['weekdays', 'interval'] })
  @IsIn(['weekdays', 'interval'])
  repeat: 'weekdays' | 'interval';

  @ApiProperty({ example: [1, 3, 5] })
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays: number[];

  @ApiProperty({ example: 3 }) @IsInt() @Min(1) intervalDays: number;

  @ApiProperty({ example: '2026-06-08' }) @IsDateString() anchorDate: string;

  @ApiProperty({ example: '10:00' }) @IsString() @Matches(/^\d{2}:\d{2}$/) timeFrom: string;

  @ApiProperty({ example: '12:00' }) @IsString() @Matches(/^\d{2}:\d{2}$/) timeTo: string;

  @ApiProperty({ example: 5 }) @IsInt() @Min(1) maxOrders: number;

  @ApiProperty({ example: 28 }) @IsInt() @Min(1) @Max(60) horizonDays: number;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(280) customerNote?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) driverNote?: string;
}
