import { IsOptional, IsBoolean } from 'class-validator';

export class ImportPrefsDto {
  @IsOptional()
  @IsBoolean()
  aiAudit?: boolean;

  @IsOptional()
  @IsBoolean()
  addressCheck?: boolean;
}
