import { IsBoolean, IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetProductFeaturedDto {
  @ApiProperty()
  @IsBoolean()
  featured: boolean;
}

export class SetFarmerTierDto {
  @ApiProperty({ minimum: 1, maximum: 3 })
  @IsInt()
  @Min(1)
  @Max(3)
  tier: number;
}

export class SetFarmerOfWeekDto {
  @ApiProperty({ description: 'true → make this farmer the tenant’s фермер на седмицата; false → clear it' })
  @IsBoolean()
  enabled: boolean;
}
