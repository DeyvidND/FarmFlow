import { IsString, IsNotEmpty } from 'class-validator';

/** Body for the delivery-app handoff exchange (dostavki `?handoff=` login). */
export class HandoffDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}
