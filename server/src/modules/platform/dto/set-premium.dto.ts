import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Super-admin toggles a farm's premium (free) billing plan. */
export class SetPremiumDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  premium: boolean;
}
