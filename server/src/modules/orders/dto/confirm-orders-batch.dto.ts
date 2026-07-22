import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** Bulk-confirm a set of pending orders by id (tenant-scoped). */
export class ConfirmOrdersBatchDto {
  @ApiProperty({ type: [String], description: 'Order ids to confirm (tenant-scoped, pending only).' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids!: string[];
}
