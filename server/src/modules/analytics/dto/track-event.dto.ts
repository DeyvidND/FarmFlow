import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

const TYPES = ['page_view', 'product_view', 'add_to_cart', 'checkout_start', 'purchase'] as const;

export class TrackEventDto {
  @IsIn(TYPES)
  type!: (typeof TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  referrer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  orderId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number;
}
