import { IsDateString, IsInt, IsOptional, Matches, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateWindowDto {
  // Date-only ('YYYY-MM-DD'): @Matches guards against full datetimes slipping
  // past @IsDateString into the string-comparison overlap/end<start checks.
  @ApiPropertyOptional({ example: '2026-06-14' })
  @IsOptional()
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Датата трябва да е във формат ГГГГ-ММ-ДД' })
  startsAt?: string;

  @ApiPropertyOptional({ example: '2026-06-20' })
  @IsOptional()
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Датата трябва да е във формат ГГГГ-ММ-ДД' })
  endsAt?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;
}
