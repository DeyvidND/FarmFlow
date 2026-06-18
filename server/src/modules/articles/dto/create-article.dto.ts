import { IsString, IsOptional, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateArticleDto {
  @ApiProperty({ example: 'Ягодите узряха' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ description: 'Auto-derived from the title when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  excerpt?: string;

  // Rich HTML body — sanitized on write. Cap matches the ~100kb JSON body limit so
  // an oversized payload fails validation cleanly instead of at the body parser.
  @ApiPropertyOptional({ description: 'Sanitized HTML body (WYSIWYG)' })
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  body?: string;
}
