import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'ime@ferma.bg' })
  @IsEmail({}, { message: 'Невалиден имейл' })
  email: string;
}
