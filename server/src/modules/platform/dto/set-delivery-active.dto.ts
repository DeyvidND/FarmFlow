import { IsBoolean } from 'class-validator';

export class SetDeliveryActiveDto {
  @IsBoolean()
  active!: boolean;
}
