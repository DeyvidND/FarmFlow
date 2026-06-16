import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTenantDto {
  @ApiProperty({ example: 'Ферма Петрови', minLength: 2 })
  @IsString()
  @MinLength(2)
  farmName: string;

  @ApiProperty({ example: 'ivan@ferma.bg' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 6 })
  @IsString()
  @MinLength(6)
  tempPassword: string;

  @ApiPropertyOptional({ example: '+359 88 123 4567' })
  @IsOptional()
  @IsString()
  phone?: string;

  /** Brand colour for the storefront theme — e.g. auto-extracted from the farm's
   *  logo during onboarding. Stored at settings.themeColor. */
  @ApiPropertyOptional({ example: '#2d6a4f' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'Цветът трябва да е HEX, напр. #2d6a4f' })
  themeColor?: string;
}
