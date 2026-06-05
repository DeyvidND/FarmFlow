import { IsArray, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/** One `{ id, position }` pair in a gallery reorder payload. */
export class ReorderMediaItemDto {
  @ApiProperty()
  @IsUUID()
  id: string;

  @ApiProperty({ example: 0 })
  @IsInt()
  @Min(0)
  position: number;
}

/** Shared reorder payload for the per-resource media galleries
 *  (products / farmers / subcategories). */
export class ReorderMediaDto {
  @ApiProperty({ type: [ReorderMediaItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderMediaItemDto)
  items: ReorderMediaItemDto[];
}
