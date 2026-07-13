import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/**
 * Persist the operator's manual stop order for one courier leg (route_seq,
 * migration 0095) so slot generation honours it instead of always
 * re-optimizing. `stopIds` is the FULL desired visit order for `courierIndex`
 * on `date` — position in the array becomes each order's route_seq. An empty
 * array clears the override for that courier (falls back to auto order).
 */
export class SetOrderSequenceDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date трябва да е YYYY-MM-DD' })
  date?: string;

  @IsInt()
  @Min(0)
  @Max(9)
  courierIndex!: number;

  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  stopIds!: string[];
}
