import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateReviewDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Името е задължително' })
  @MaxLength(120)
  authorName: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  authorLocation?: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1, { message: 'Оценката е между 1 и 5' })
  @Max(5, { message: 'Оценката е между 1 и 5' })
  rating: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Ревюто не може да е празно' })
  @MaxLength(2000)
  body: string;

  @ApiPropertyOptional({ description: 'Optional product the review is about.' })
  @IsOptional()
  @IsUUID()
  productId?: string;
}
