import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsUUID, ValidateNested } from 'class-validator';

export class CourierBatchItem {
  @IsUUID()
  id!: string;

  @IsBoolean()
  courierDisabled!: boolean;
}

export class UpdateCourierBatchDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CourierBatchItem)
  updates!: CourierBatchItem[];
}
