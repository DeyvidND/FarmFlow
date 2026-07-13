import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Task #14: a farmer self-marks each of tomorrow's orders as they work through
 *  prep. 'pending' (default, nothing marked yet) → 'in_production' → 'fulfilled'. */
export class UpdateFulfillmentDto {
  @ApiProperty({ enum: ['pending', 'in_production', 'fulfilled'] })
  @IsEnum(['pending', 'in_production', 'fulfilled'])
  state: 'pending' | 'in_production' | 'fulfilled';
}
