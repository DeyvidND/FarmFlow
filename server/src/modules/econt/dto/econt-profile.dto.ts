import { Type } from 'class-transformer';
import {
  IsOptional, IsString, IsNumber, IsBoolean, IsIn, ValidateNested, MaxLength, Min,
} from 'class-validator';

/** The Econt sender/package/COD profile, editable from the standalone delivery app
 *  (dostavki). Credentials are NOT here — those go through POST /shipping/credentials.
 *  Mirrors the panel's econt-section fields so the dostavki editor is a 1:1 move. */
class EcontSenderDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsNumber() cityId?: number;
  @IsOptional() @IsString() @MaxLength(120) cityName?: string;
  @IsOptional() @IsIn(['office', 'address']) mode?: 'office' | 'address';
  @IsOptional() @IsString() @MaxLength(40) officeCode?: string;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
}
class EcontPackageDto {
  @IsOptional() @IsNumber() @Min(0) weightKg?: number;
  @IsOptional() @IsString() @MaxLength(120) contents?: string;
  @IsOptional() @IsString() @MaxLength(40) dimensions?: string;
}
class EcontCodDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['customer', 'farm']) feePayer?: 'customer' | 'farm';
}
class EcontLabelDto {
  @IsOptional() @IsIn(['A4', 'A6']) paper?: 'A4' | 'A6';
  @IsOptional() @IsBoolean() autoCreate?: boolean;
}

export class EcontProfileDto {
  @IsOptional() @ValidateNested() @Type(() => EcontSenderDto) sender?: EcontSenderDto;
  @IsOptional() @ValidateNested() @Type(() => EcontPackageDto) defaultPackage?: EcontPackageDto;
  @IsOptional() @ValidateNested() @Type(() => EcontCodDto) cod?: EcontCodDto;
  @IsOptional() @ValidateNested() @Type(() => EcontLabelDto) label?: EcontLabelDto;
}
