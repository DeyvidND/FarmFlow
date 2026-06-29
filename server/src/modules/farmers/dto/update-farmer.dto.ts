import { PartialType } from '@nestjs/swagger';
import { IsOptional, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateFarmerDto } from './create-farmer.dto';

export class UpdateFarmerDto extends PartialType(CreateFarmerDto) {
  @ApiPropertyOptional({ description: 'Enable/disable courier delivery for this farmer' })
  @IsOptional()
  @IsBoolean()
  courierEnabled?: boolean;
}
