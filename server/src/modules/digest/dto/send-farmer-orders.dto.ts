import { IsArray, IsIn, IsUUID, Matches, ArrayNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Organizer-triggered manual send of per-farmer order emails for a date range. */
export class SendFarmerOrdersDto {
  @ApiProperty({ example: '2026-07-10' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from трябва да е YYYY-MM-DD' })
  from!: string;

  @ApiProperty({ example: '2026-07-12' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to трябва да е YYYY-MM-DD' })
  to!: string;

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
}
