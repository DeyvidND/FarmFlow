import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, Matches, Max, Min, ValidateNested } from 'class-validator';

export class SuggestDayDto {
  /** Delivery day (YYYY-MM-DD). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date трябва да е YYYY-MM-DD' })
  date!: string;

  /** Couriers running this day (1..10). */
  @IsInt()
  @Min(1)
  @Max(10)
  couriers!: number;
}

export class SuggestDaysDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => SuggestDayDto)
  days!: SuggestDayDto[];
}
