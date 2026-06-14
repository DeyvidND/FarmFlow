import { IsDateString, IsInt, IsUUID, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWindowDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  // Date-only ISO strings ('YYYY-MM-DD').
  @ApiProperty({ example: '2026-06-14' })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ example: '2026-06-20' })
  @IsDateString()
  endsAt: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  quantity: number;
}
