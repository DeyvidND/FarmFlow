import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

export class AddressSuggestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  query!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  sessionToken?: string;
}
