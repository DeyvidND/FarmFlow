import { IsInt, IsISO8601, IsOptional, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateWindowDto {
  @ApiPropertyOptional({ example: '2026-06-14' })
  @IsOptional()
  @IsISO8601({ strict: true })
  startsAt?: string;

  @ApiPropertyOptional({ example: '2026-06-20' })
  @IsOptional()
  @IsISO8601({ strict: true })
  endsAt?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;
}
