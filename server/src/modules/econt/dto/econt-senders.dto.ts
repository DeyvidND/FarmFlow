import { Type } from 'class-transformer';
import {
  IsArray, IsString, IsNotEmpty, IsOptional, IsIn, IsNumber, MaxLength,
  ValidateNested, ArrayMaxSize,
} from 'class-validator';

/** One Еcont pickup point: the sender fields + id + label. */
export class EcontPickupPointDto {
  @IsString() @IsNotEmpty() @MaxLength(40) id!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) label!: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsNumber() cityId?: number;
  @IsOptional() @IsString() @MaxLength(120) cityName?: string;
  @IsOptional() @IsIn(['office', 'address']) mode?: 'office' | 'address';
  @IsOptional() @IsString() @MaxLength(40) officeCode?: string;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
}

export class EcontSaveSendersDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => EcontPickupPointDto)
  senders!: EcontPickupPointDto[];
  @IsString() @IsNotEmpty() @MaxLength(40) activeId!: string;
}
