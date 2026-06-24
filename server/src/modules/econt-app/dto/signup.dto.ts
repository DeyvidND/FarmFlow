import { IsEmail, IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

export class EcontSignupDto {
  @IsEmail()
  email!: string;

  // Floor of 12 to match the platform password policy.
  @IsString() @MinLength(12) @MaxLength(128)
  password!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  farmName!: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;
}
