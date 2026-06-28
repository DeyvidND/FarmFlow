import { Type } from 'class-transformer';
import {
  IsOptional, IsString, IsInt, IsNumber, IsBoolean, IsIn, ValidateNested, MaxLength, Min,
} from 'class-validator';

/** The Speedy sender/package/COD profile, editable from the standalone delivery
 *  app (dostavki). Credentials go through POST /speedy/credentials, not here.
 *  Mirrors the panel's speedy-section fields (id-based addresses). */
class SpeedySenderDto {
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsIn(['office', 'address']) mode?: 'office' | 'address';
  @IsOptional() @IsInt() @Min(1) officeId?: number;
  @IsOptional() @IsInt() @Min(1) siteId?: number;
  @IsOptional() @IsInt() @Min(1) streetId?: number;
  @IsOptional() @IsString() @MaxLength(20) streetNo?: string;
}
class SpeedyPackageDto {
  @IsOptional() @IsInt() @Min(1) parcelsCount?: number;
  @IsOptional() @IsNumber() @Min(0) weightKg?: number;
  @IsOptional() @IsString() @MaxLength(120) contents?: string;
}
class SpeedyCodDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['CASH', 'POSTAL_MONEY_TRANSFER']) processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER';
}
class SpeedyLabelDto {
  @IsOptional() @IsBoolean() autoCreate?: boolean;
}

export class SpeedyProfileDto {
  @IsOptional() @ValidateNested() @Type(() => SpeedySenderDto) sender?: SpeedySenderDto;
  @IsOptional() @ValidateNested() @Type(() => SpeedyPackageDto) defaultPackage?: SpeedyPackageDto;
  @IsOptional() @ValidateNested() @Type(() => SpeedyCodDto) cod?: SpeedyCodDto;
  @IsOptional() @ValidateNested() @Type(() => SpeedyLabelDto) label?: SpeedyLabelDto;
}
