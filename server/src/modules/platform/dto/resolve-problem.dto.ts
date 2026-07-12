import { IsUUID, IsString, IsNotEmpty, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Marks a server-error problem group (tenantId+path) as resolved. `tenantId` is
 *  null for platform-wide (no-tenant) errors. */
export class ResolveProblemDto {
  @ApiProperty({ example: null, nullable: true })
  @ValidateIf((o) => o.tenantId !== null && o.tenantId !== undefined)
  @IsUUID()
  tenantId: string | null;

  @ApiProperty({ example: '/orders' })
  @IsString()
  @IsNotEmpty()
  path: string;
}
