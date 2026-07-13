import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class BatchDto {
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @IsOptional() @IsUUID() slotId?: string;
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @IsOptional() @IsString() date?: string; // YYYY-MM-DD (Europe/Sofia)
  // Narrow the batch to one leg — «Печат фермери» / «Печат поръчки». Absent = both.
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @IsOptional() @IsIn(['farmer_to_operator', 'operator_to_customer']) kind?: string;
}
