import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsUUID, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Set the same stock quantity on many products at once — the «Задай за всички»
 *  bulk action. Products that already have stock are skipped, not fatal. */
export class CreateWindowsBulkDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  productIds: string[];

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  quantity: number;
}
