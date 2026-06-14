import { IsDateString, IsInt, IsUUID, Matches, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWindowDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  // Date-only ISO strings ('YYYY-MM-DD'). @Matches enforces date-only on top of
  // @IsDateString (which would otherwise accept full datetimes that corrupt the
  // in-memory string-comparison overlap/end<start checks).
  @ApiProperty({ example: '2026-06-14' })
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Датата трябва да е във формат ГГГГ-ММ-ДД' })
  startsAt: string;

  @ApiProperty({ example: '2026-06-20' })
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Датата трябва да е във формат ГГГГ-ММ-ДД' })
  endsAt: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  quantity: number;
}
