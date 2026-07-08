import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString, IsUUID, Matches } from 'class-validator';

/** Bulk-move a set of orders onto a target delivery day (own delivery). */
export class RescheduleOrdersDto {
  @ApiProperty({ type: [String], description: 'Order ids to move (all tenant-scoped).' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  orderIds!: string[];

  @ApiProperty({ example: '2026-07-10', description: 'Target delivery day (YYYY-MM-DD).' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'toDate трябва да е във формат YYYY-MM-DD' })
  toDate!: string;
}
