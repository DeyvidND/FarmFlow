import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Task #5 — road geometry + totals for an EXPLICIT, operator-chosen stop order.
 * The client sends the order ids in the exact sequence it wants driven (after a
 * manual reorder or a courier move); the server loads their coords, measures the
 * real road path in that order (no re-optimization) and returns the polyline so
 * the map draws streets instead of straight pin-to-pin lines.
 */
export class MeasureOrderDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date трябва да е YYYY-MM-DD' })
  date?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  stopIds!: string[];

  /** Which courier this leg belongs to — selects its saved home/end config. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9)
  courierIndex?: number;

  /** Override the courier's end mode for this measure (home/last/custom). */
  @IsOptional()
  @IsIn(['home', 'last', 'custom'])
  endMode?: 'home' | 'last' | 'custom';
}
