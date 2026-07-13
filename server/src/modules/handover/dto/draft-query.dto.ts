import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class DraftQueryDto {
  @IsIn(['farmer_to_operator', 'operator_to_customer']) kind!: string;
  @IsOptional() @IsUUID() farmerId?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() slotId?: string;
}
