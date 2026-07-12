import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional,
  IsString, IsUUID, MaxLength, Min, ValidateNested,
} from 'class-validator';

/** One reviewed row from the AI-extract preview. Mirrors ExtractedProduct. */
export class AiImportProductDto {
  @IsString()
  @IsNotEmpty({ message: 'Името на продукта е задължително.' })
  @MaxLength(200)
  name!: string;

  @IsInt()
  @Min(0)
  priceStotinki!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  unit!: string;

  @IsOptional() @IsString() @MaxLength(100)
  weight?: string;

  @IsOptional() @IsString() @MaxLength(100)
  category?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class CommitAiImportDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => AiImportProductDto)
  products!: AiImportProductDto[];

  /** Owner-only: attach the rows to one producer. A producer token is always
   *  forced to its own farmerId regardless of this field. */
  @IsOptional()
  @IsUUID()
  farmerId?: string;
}
