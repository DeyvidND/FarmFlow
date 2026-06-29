import { Type } from 'class-transformer';
import {
  IsArray, IsString, IsNotEmpty, IsOptional, IsIn, IsNumber, MaxLength,
  ValidateNested, ArrayMaxSize,
} from 'class-validator';

/** One Speedy pickup point: the sender fields (contactName-based) + id + label. */
export class SpeedyPickupPointDto {
  @IsString() @IsNotEmpty() @MaxLength(40) id!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) label!: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsIn(['office', 'address']) mode?: 'office' | 'address';
  @IsOptional() @IsNumber() officeId?: number;
  @IsOptional() @IsNumber() siteId?: number;
  @IsOptional() @IsString() @MaxLength(120) siteName?: string;
  @IsOptional() @IsNumber() streetId?: number;
  @IsOptional() @IsString() @MaxLength(40) streetNo?: string;
}

export class SpeedySaveSendersDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => SpeedyPickupPointDto)
  senders!: SpeedyPickupPointDto[];
  @IsString() @IsNotEmpty() @MaxLength(40) activeId!: string;
}
