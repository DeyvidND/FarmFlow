import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'Ферма Петрови', description: 'Име на фермата' })
  @IsString()
  @MinLength(2)
  farmName: string;

  @ApiProperty({ example: 'ivan@ferma-petrovi.bg' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: '+359 88 123 4567' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ minLength: 6 })
  @IsString()
  @MinLength(6)
  password: string;
}
