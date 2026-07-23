import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One reusable transport (vehicle + driver identity) for the consolidated
 * protocol's В.Транспорт form — `tenants.settings.transportPresets[]`. Times
 * are deliberately absent: they're per-day (prefilled by the draft seed).
 * `id` is server-assigned when missing, so the client can PUT new entries
 * without inventing ids.
 */
export class TransportPresetDto {
  @ApiPropertyOptional({ description: 'Stable id — omitted for a new preset.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @ApiPropertyOptional({ example: 'Форд Транзит (хладилен)' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  vehicle?: string;

  @ApiPropertyOptional({ example: 'В1234КХ' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate?: string;

  @ApiPropertyOptional({ example: 'Иван Иванов' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  driverName?: string;

  @ApiPropertyOptional({ example: 'склад Варна' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  startPlace?: string;
}

/** PUT body — the FULL list (the server replaces the stored array wholesale,
 *  same convention as settings.routing.couriers[]). */
export class TransportPresetsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TransportPresetDto)
  presets!: TransportPresetDto[];
}
