import { IsArray, IsIn, IsOptional, IsUUID, Matches, ArrayNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Which BG days (in a window around `anchor`) have orders for the selected
 *  farmers/statuses — feeds the day-picker indicator on the farmer-orders send modal. */
export class FarmerOrderDaysDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  farmerIds!: string[];

  @ApiProperty({ type: [String], example: ['confirmed'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['pending', 'confirmed', 'delivered'], { each: true })
  statuses!: string[];

  @ApiProperty({ required: false, example: '2026-07-23' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'anchor трябва да е YYYY-MM-DD' })
  anchor?: string;
}
