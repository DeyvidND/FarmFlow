import { IsInt, Min, IsOptional, IsString, MaxLength } from 'class-validator';

/** Address to dry-run against Speedy /validation/address before creating a label. */
export class SpeedyValidateAddressDto {
  @IsInt() @Min(1)
  siteId!: number;

  @IsOptional() @IsInt() @Min(1)
  streetId?: number;
  @IsOptional() @IsString() @MaxLength(20)
  streetNo?: string;
  @IsOptional() @IsInt() @Min(1)
  officeId?: number;
}
