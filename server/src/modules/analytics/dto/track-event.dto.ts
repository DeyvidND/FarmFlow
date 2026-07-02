import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

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
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  value?: number;
}
