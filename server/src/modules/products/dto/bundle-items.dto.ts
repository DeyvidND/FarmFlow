import { IsArray, IsInt, IsOptional, IsUUID, Max, Min, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One member product of a bundle („Фермерска кошница" / готов пакет). */
export class BundleItemDto {
  @ApiProperty({ description: 'Member product id (must be in the same tenant, not a bundle, not itself)' })
  @IsUUID()
  productId: string;

  @ApiPropertyOptional({ description: 'How many of this product the bundle contains', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  quantity?: number;
}

/** Full-replace payload for a bundle's contents — mirrors the variants "set" pattern:
 *  the service upserts these and drops any member not in the list. Empty array = clear. */
export class SetBundleItemsDto {
  @ApiProperty({ type: [BundleItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMaxSize(50)
  @Type(() => BundleItemDto)
  items: BundleItemDto[];
}
