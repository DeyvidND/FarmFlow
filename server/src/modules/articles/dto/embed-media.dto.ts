import { IsString, IsOptional, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EmbedMediaDto {
  @ApiProperty({ example: 'https://www.youtube.com/watch?v=ScMzIvxBSi4' })
  @IsString()
  @IsUrl()
  url: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  caption?: string;
}
