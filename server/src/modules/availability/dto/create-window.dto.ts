import { IsInt, IsUUID, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** A product's available stock count. No date window — the stock is live until
 *  depleted or deleted. */
export class CreateWindowDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  quantity: number;
}
