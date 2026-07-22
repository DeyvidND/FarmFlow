import { IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ConsolidatedMetaDto {
  @IsOptional() @IsString() vehicle?: string;
  @IsOptional() @IsString() plate?: string;
  @IsOptional() @IsString() driverName?: string;
  @IsOptional() @IsString() startPlace?: string;
  @IsOptional() @IsString() startTime?: string;
  @IsOptional() @IsString() plannedEnd?: string;
}

export class ConsolidatedExtraRowDto {
  @IsIn(['A', 'B']) section!: 'A' | 'B';
  @IsString() label!: string;
  @IsOptional() @IsString() detail?: string;
}

export class ConsolidatedFieldOverrideDto {
  @IsOptional() @IsString() batch?: string;
  @IsOptional() @IsString() eDoc?: string;
  @IsOptional() @IsString() note?: string;
}

export class ConsolidatedOverridesDto {
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) excludedOrderIds?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ConsolidatedExtraRowDto) extraRows?: ConsolidatedExtraRowDto[];
  @IsOptional() @IsObject() fieldOverrides?: Record<string, ConsolidatedFieldOverrideDto>;
}

export class ConsolidatedUpdateDto {
  @IsOptional() @ValidateNested() @Type(() => ConsolidatedMetaDto) meta?: ConsolidatedMetaDto;
  @IsOptional() @ValidateNested() @Type(() => ConsolidatedOverridesDto) overrides?: ConsolidatedOverridesDto;
}
