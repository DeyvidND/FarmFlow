import { IsUUID, IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
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
}
