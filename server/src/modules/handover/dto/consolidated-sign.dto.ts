import { IsOptional, IsString } from 'class-validator';

export class ConsolidatedSignDto {
  @IsOptional() @IsString() receiverSignaturePng?: string | null;
}
