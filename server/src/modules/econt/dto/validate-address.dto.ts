import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class ValidateAddressDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  city!: string;

  @IsString() @IsNotEmpty() @MaxLength(240)
  address!: string;
}
