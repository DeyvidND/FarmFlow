import { IsOptional, IsString, IsUUID } from 'class-validator';

export class BatchDto {
  @IsOptional() @IsUUID() slotId?: string;
  @IsOptional() @IsString() date?: string; // YYYY-MM-DD (Europe/Sofia)
}
