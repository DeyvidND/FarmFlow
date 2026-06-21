import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Public marketing-site "request a demo" lead. Email-only (no persistence).
 * `honey` is a honeypot — kept whitelisted (so the global forbidNonWhitelisted
 * pipe doesn't 400 on it) but dropped silently in the service when filled.
 */
export class DemoRequestDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Името е задължително' })
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  farm?: string;

  @ApiProperty({ example: 'ime@example.bg' })
  @IsEmail({}, { message: 'Невалиден имейл адрес' })
  email: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  honey?: string;
}
