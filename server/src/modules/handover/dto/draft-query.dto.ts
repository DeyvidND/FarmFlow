import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class DraftQueryDto {
  @IsIn(['farmer_to_operator', 'operator_to_customer']) kind!: string;
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @IsOptional() @IsUUID() farmerId?: string;
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @IsOptional() @IsUUID() orderId?: string;
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @IsOptional() @IsUUID() slotId?: string;
}
