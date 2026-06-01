import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ContactDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Името е задължително' })
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'ime@example.bg' })
  @IsEmail({}, { message: 'Невалиден имейл адрес' })
  email: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Съобщението е задължително' })
  @MaxLength(4000)
  message: string;
}
