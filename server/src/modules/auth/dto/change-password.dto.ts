import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ minLength: 6 })
  @IsString()
  @MinLength(6)
  currentPassword: string;

  // New password floor is higher than the current-password check above: the latter
  // only verifies what the user already has, so it must not lock out legacy
  // accounts; the former is a creation gate and sets the strength minimum.
  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword: string;
}
