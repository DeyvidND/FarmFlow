import { IsBoolean, IsEmail, IsOptional, IsString, MinLength, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Super-admin edit of a farm's core profile + feature flags. All fields optional
 *  (partial update) — only provided keys are written. */
export class UpdateTenantDto {
  @ApiPropertyOptional({ example: 'Ферма Петрови', minLength: 2 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: 'ferma-petrovi', description: 'малки букви, цифри, тирета' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'Невалиден slug (малки букви, цифри, тирета)' })
  slug?: string;

  @ApiPropertyOptional({ example: 'ivan@ferma.bg' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '+359 88 123 4567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  deliveryEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  multiFarmer?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  multiSubcat?: boolean;
}
