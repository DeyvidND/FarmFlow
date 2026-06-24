import { IsString, IsIn, IsOptional, IsInt, Min, MaxLength } from 'class-validator';

/** Editable fields of a draft row. All optional — only sent fields are updated, then the
 *  row is re-validated + re-resolved. */
export class PatchRowDto {
  @IsOptional() @IsString() @MaxLength(120) receiverName?: string;
  @IsOptional() @IsString() @MaxLength(40) receiverPhone?: string;
  @IsOptional() @IsIn(['office', 'address']) deliveryMode?: 'office' | 'address';
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) office?: string;
  @IsOptional() @IsString() @MaxLength(240) address?: string;
  @IsOptional() @IsString() @MaxLength(20) streetNo?: string;
  @IsOptional() @IsInt() @Min(0) weightGrams?: number;
  @IsOptional() @IsString() @MaxLength(120) contents?: string;
  @IsOptional() @IsInt() @Min(0) codAmountStotinki?: number;
  @IsOptional() @IsInt() @Min(0) declaredValueStotinki?: number;
  @IsOptional() @IsIn(['econt', 'speedy']) carrier?: 'econt' | 'speedy';
  // When the user picks an ambiguity candidate, the chosen ids ride here.
  @IsOptional() @IsInt() siteId?: number;
  @IsOptional() @IsInt() officeId?: number;
  @IsOptional() @IsInt() streetId?: number;
  @IsOptional() @IsString() @MaxLength(20) econtOfficeCode?: string;
}
