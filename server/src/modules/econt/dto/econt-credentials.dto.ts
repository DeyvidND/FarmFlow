import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EcontCredentialsDto {
  @ApiPropertyOptional({ enum: ['demo', 'prod'], default: 'demo' })
  @IsOptional()
  @IsIn(['demo', 'prod'])
  env?: 'demo' | 'prod';

  @ApiProperty({ example: 'iasp-dev' })
  @IsString()
  @MinLength(2)
  username: string;

  @ApiProperty({ example: '1Asp-dev' })
  @IsString()
  @MinLength(3)
  password: string;
}
