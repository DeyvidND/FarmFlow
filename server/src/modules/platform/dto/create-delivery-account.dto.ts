import { IsEmail, IsString, MinLength, MaxLength, IsOptional, IsBoolean } from 'class-validator';

export class CreateDeliveryAccountDto {
  @IsEmail()
  email!: string;

  // No password: the account is created password-less and the invitee sets their
  // own via the emailed/shared 7-day invite link (see PlatformService.createDeliveryAccount).

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
