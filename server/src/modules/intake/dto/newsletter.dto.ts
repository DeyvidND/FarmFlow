import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class NewsletterDto {
  @ApiProperty({ example: 'ime@example.bg' })
  @IsEmail({}, { message: 'Невалиден имейл адрес' })
  email: string;
}
