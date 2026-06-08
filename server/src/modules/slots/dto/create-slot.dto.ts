import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSlotDto {
  @ApiProperty({ example: '2026-06-01', description: 'Slot date (or range start when bulk)' })
  @IsDateString()
  date: string;

  @ApiProperty({ example: '09:00' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'timeFrom must be HH:MM' })
  timeFrom: string;

  @ApiProperty({ example: '12:00' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'timeTo must be HH:MM' })
  timeTo: string;

  @ApiProperty({ example: 20 })
  @IsInt()
  @Min(1)
  maxOrders: number;

  @ApiPropertyOptional({
    example: '2026-06-30',
    description: 'Range end — set together with weekdays to bulk-create across [date, dateTo].',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    example: [1, 2, 3, 4, 5],
    description: 'Weekdays to include in the range (0=Sun … 6=Sat) when bulk-creating.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays?: number[];

  @ApiPropertyOptional({
    example: 'Ще се обадя преди доставка',
    description: 'Shown to the customer in the storefront slot picker.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  customerNote?: string;

  @ApiPropertyOptional({
    example: 'Маршрут Чайка→Левски, тел. 0888…',
    description: 'Private note for the driver — never exposed to the storefront.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  driverNote?: string;
}
