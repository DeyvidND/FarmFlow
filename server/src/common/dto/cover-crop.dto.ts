import { IsNumber, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * How a catalog cover image is framed on the storefront: focal point (`x`/`y`,
 * fractions 0..1 of the source) plus `zoom` (1..3). Sent as a nested object on
 * the farmer / subcategory PATCH; `null` (or omitted) clears it → centered.
 */
export class CoverCropDto {
  @ApiProperty({ example: 0.5, minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  x: number;

  @ApiProperty({ example: 0.5, minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  y: number;

  @ApiProperty({ example: 1, minimum: 1, maximum: 3 })
  @IsNumber()
  @Min(1)
  @Max(3)
  zoom: number;
}
