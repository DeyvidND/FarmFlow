import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateMediaDto {
  @ApiPropertyOptional({ description: 'Caption shown under the media block' })
  @IsOptional()
  @IsString()
  caption?: string;
}
