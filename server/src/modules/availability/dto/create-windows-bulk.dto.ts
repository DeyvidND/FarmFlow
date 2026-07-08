import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/** One product + its own stock quantity. */
export class BulkWindowItemDto {
  @ApiProperty()
  @IsUUID('all')
  productId: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(0)
  quantity: number;
}

/** Set stock on many products at once — the «Задай за всички» bulk action. Each
 *  product carries its own quantity. Products that already have stock (or aren't
 *  owned by the caller) are skipped, not fatal. */
export class CreateWindowsBulkDto {
  @ApiProperty({ type: [BulkWindowItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BulkWindowItemDto)
  items: BulkWindowItemDto[];
}
