import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsInt, IsUUID, Matches, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Set one availability window (same dates + quantity) on many products at once —
 *  the «Задай за всички» bulk action. Per-product overlaps are skipped, not fatal. */
export class CreateWindowsBulkDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  productIds: string[];

  // Date-only ISO strings ('YYYY-MM-DD') — same constraint as CreateWindowDto so the
  // in-memory string overlap/end<start checks stay correct.
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
