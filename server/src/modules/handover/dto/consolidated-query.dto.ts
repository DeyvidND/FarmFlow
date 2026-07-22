import { IsOptional, IsString, Matches } from 'class-validator';

export class ConsolidatedQueryDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;

  // §4.4 "Прати на непратените" resend flag (send-to-couriers?onlyFailed=true),
  // read via @Query('onlyFailed') in the controller. It MUST be declared here or
  // the whole-query ValidationPipe (forbidNonWhitelisted, global in main.ts) 400s
  // the request as "property onlyFailed should not exist" — the resend was broken.
  @IsOptional() @IsString() onlyFailed?: string;
}
