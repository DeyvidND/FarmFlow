import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateOrderStatusDto {
  @ApiProperty({
    enum: ['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'],
  })
  @IsEnum(['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'])
  status: string;
}
