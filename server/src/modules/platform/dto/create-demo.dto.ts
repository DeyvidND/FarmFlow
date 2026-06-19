import { IsIn, IsInt, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Body for one-click demo creation. `days` = lifetime before auto-deletion. */
export class CreateDemoDto {
  @ApiPropertyOptional({ enum: [7, 14, 30], default: 14 })
  @IsOptional()
  @IsInt()
  @IsIn([7, 14, 30])
  days?: number;
}
