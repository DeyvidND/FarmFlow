import { IsUUID, IsInt, Min, Max, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateOrderItemDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  // Upper bound guards against absurd quantities (amount-overflow / amplification);
  // real stock limits still apply downstream in the intake transaction.
  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(10_000)
  @Type(() => Number)
  quantity: number;

  @ApiPropertyOptional({ description: 'Chosen variant (required when the product has variants)' })
  @IsOptional()
  @IsUUID()
  variantId?: string;
}
