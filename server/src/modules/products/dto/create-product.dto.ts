import {
  IsString, IsInt, IsOptional, IsBoolean, IsUrl, IsUUID, Min, Max, MaxLength, ValidateIf, ValidateNested,
  IsArray, IsDateString, ArrayMaxSize, IsNotEmpty,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CoverCropDto } from '../../../common/dto/cover-crop.dto';
import { VariantDto } from './variant.dto';

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  // A blank name silently drops out of the order-line label (product name +
  // weight/variant, `.filter(Boolean).join(' ')` in resolveLineUnit) — orders end
  // up snapshotted as just "1кг" with no way to tell which product it was.
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiProperty({ description: 'Price in stotinki (integer)', example: 350 })
  @IsInt()
  @Min(0)
  priceStotinki: number;

  @ApiProperty({ example: 'kg' })
  @IsString()
  @MaxLength(40)
  unit: string;

  @ApiPropertyOptional({ example: '500 г' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  weight?: string;

  @ApiPropertyOptional({ example: 'Плодове' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional({ example: '#D94A4A', description: 'Hex accent for the thumbnail' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tint?: string;

  @ApiPropertyOptional({ description: 'NULL = unlimited stock' })
  @IsOptional()
  @IsInt()
  @Min(0)
  stockQuantity?: number;

  // Virtual field (not a products column): the „Наличност" number from the product
  // dialog. A number upserts the product's open-ended availability window; `null`
  // clears it (→ unlimited); absent leaves stock untouched. Stripped before the
  // products row is written; the window write happens in ProductsService.
  @ApiPropertyOptional({
    description: 'Stock count → availability window. number = set, null = unlimited, absent = untouched',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  stock?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Pickup-only: never ship this product by courier (perishable/fragile)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  courierDisabled?: boolean;

  // Companion rule (generalized „кайсии" combo): the product can't be ordered alone —
  // the cart must also hold >=1 OTHER product. See companionMinPriceStotinki for the
  // optional value gate. Enforced server-side + storefront pre-check.
  @ApiPropertyOptional({
    description: 'Companion rule: require >=1 other product in the cart (не се доставя самостоятелно)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  requiresCompanion?: boolean;

  // Optional EUR-cents threshold (same unit as priceStotinki) for the companion rule:
  // the required other product must cost at least this much. null/absent = any other
  // product qualifies. A blank number field posts '' → normalize to null (the
  // @IsOptional/@IsInt gotcha: '' is not stopped by @IsOptional alone).
  @ApiPropertyOptional({
    description: 'Companion min price in stotinki (EUR cents); the other product must cost >= this. null = any',
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? null : value))
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  companionMinPriceStotinki?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  imageUrl?: string;

  // Cover framing (focal point + zoom) for the storefront card. `null` clears it
  // back to centered. The service spreads this straight into the row, so the jsonb
  // column follows it.
  @ApiPropertyOptional({ type: CoverCropDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoverCropDto)
  coverCrop?: CoverCropDto | null;

  @ApiPropertyOptional({ description: 'Linked farmer (multi-producer mode); null to unlink' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  farmerId?: string | null;

  @ApiPropertyOptional({ description: 'Linked subcategory section; null to unlink' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  subcategoryId?: string | null;

  @ApiPropertyOptional({ description: 'Promotion: discount percent 1..99 (null clears)', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(99)
  salePercent?: number | null;

  @ApiPropertyOptional({ description: 'Promotion end date ISO; null = no end (manual removal)', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  saleEndsAt?: string | null;

  // Product-level fixed promo price (stotinki) for a plain product. Must be below
  // priceStotinki (enforced in the service). Setting it clears salePercent
  // (mutually exclusive). null = no fixed promo.
  @ApiPropertyOptional({ description: 'Fixed promo price in stotinki; null = none', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  salePriceStotinki?: number | null;

  // Full replace: the variants the product should have after the write. The
  // service upserts these (by id when present) and soft-deletes any omitted rows.
  // Empty array / absent = no variants (product sells at its own priceStotinki).
  @ApiPropertyOptional({ type: [VariantDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMaxSize(50)
  @Type(() => VariantDto)
  variants?: VariantDto[];
}
