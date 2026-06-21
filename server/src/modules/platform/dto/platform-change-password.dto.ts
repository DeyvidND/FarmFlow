import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Super-admin password change. The new-password floor is 12 — matching the
 * bootstrap requirement (`SUPER_ADMIN_PASSWORD`, env.validation + bootstrap.ts) —
 * so the single most-privileged account can't be rotated down to the weaker 8-char
 * tenant floor in `ChangePasswordDto`. The current-password check stays lenient
 * (it only verifies what the admin already has, must not lock out a legacy secret).
 */
export class PlatformChangePasswordDto {
  @ApiProperty({ minLength: 6 })
  @IsString()
  @MinLength(6)
  currentPassword: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  newPassword: string;
}
