import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

/** Body for the per-day close/open actions — just the calendar date. */
export class SlotDayActionDto {
  @ApiProperty({ example: '2026-06-15' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Невалидна дата (ГГГГ-ММ-ДД)' })
  date!: string;
}
