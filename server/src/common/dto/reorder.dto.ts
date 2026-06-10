import { IsArray, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/** One `{ id, position }` pair in a reorder payload. */
export class ReorderItemDto {
  @ApiProperty()
  @IsUUID()
  id: string;

  @ApiProperty({ example: 0 })
  @IsInt()
  @Min(0)
  position: number;
}

/** Shared reorder payload — a flat list of `{ id, position }` pairs. Used for
 *  catalog entity ordering (products / farmers / subcategories) and the
 *  per-resource media galleries. */
export class ReorderDto {
  @ApiProperty({ type: [ReorderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items: ReorderItemDto[];
}
