import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
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
}
