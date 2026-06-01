import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTenantDto {
  @ApiPropertyOptional({ example: 'Ферма Петрови' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: '+359 88 123 4567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'ivan@ferma-petrovi.bg' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: true, description: 'Farmer offers self-delivery (shows slots on storefront)' })
  @IsOptional()
  @IsBoolean()
  deliveryEnabled?: boolean;

  @ApiPropertyOptional({ example: false, description: 'Multiple producers share this storefront' })
  @IsOptional()
  @IsBoolean()
  multiFarmer?: boolean;

  @ApiPropertyOptional({ example: false, description: 'Group products into subcategory sections' })
  @IsOptional()
  @IsBoolean()
  multiSubcat?: boolean;
}
