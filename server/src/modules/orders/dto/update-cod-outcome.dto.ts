import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCodOutcomeDto {
  @ApiProperty({ enum: ['received', 'refused'] })
  @IsEnum(['received', 'refused'])
  outcome: 'received' | 'refused';

  @ApiPropertyOptional({ description: 'Причина при отказ (свободен текст)' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
