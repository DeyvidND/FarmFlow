import { IsInt, IsISO8601, IsUUID, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWindowDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  // Date-only ISO strings ('YYYY-MM-DD'). `strict` keeps them date-shaped.
  @ApiProperty({ example: '2026-06-14' })
  @IsISO8601({ strict: true })
  startsAt: string;

  @ApiProperty({ example: '2026-06-20' })
  @IsISO8601({ strict: true })
  endsAt: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  quantity: number;
}
