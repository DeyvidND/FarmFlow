import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BroadcastDto {
  @ApiProperty({ example: 'Новини от фермата', minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  subject: string;

  @ApiProperty({ example: 'Здравейте! Имаме нови продукти...', minLength: 1, maxLength: 5000 })
  @IsString()
  @Length(1, 5000)
  body: string;
}
