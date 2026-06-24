import { IsEmail, IsString, MinLength, MaxLength, IsOptional, IsBoolean } from 'class-validator';

export class CreateDeliveryAccountDto {
  @IsEmail()
  email!: string;

  // Platform password floor of 12.
  @IsString() @MinLength(12) @MaxLength(128)
  password!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  // Capabilities. At least one must be true (enforced in the service).
  @IsBoolean()
  shop!: boolean;

  @IsBoolean()
  delivery!: boolean;

  // Whether the delivery service starts enabled (paid gate). Defaults true.
  @IsOptional() @IsBoolean()
  active?: boolean;
}
