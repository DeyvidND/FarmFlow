import { IsString, IsNotEmpty, IsIn, IsOptional, IsInt, Min } from 'class-validator';

/** Speedy API credentials for a tenant. Auth is userName/password in each request
 *  body; clientSystemId is optional (identifies the integrating system). */
export class SpeedyCredentialsDto {
  // Speedy has no separate sandbox host; 'demo' vs 'prod' only flags which
  // credentials/contract the tenant is using (both hit api.speedy.bg).
  @IsOptional() @IsIn(['demo', 'prod'])
  env?: 'demo' | 'prod';

  @IsString() @IsNotEmpty()
  userName!: string;

  @IsString() @IsNotEmpty()
  password!: string;

  @IsOptional() @IsInt()
  clientSystemId?: number;

  // The producer's usual Speedy courier-service code; used as the default for
  // price estimates (the quote endpoint) when no per-shipment service is given.
  @IsOptional() @IsInt() @Min(1)
  defaultServiceId?: number;
}
