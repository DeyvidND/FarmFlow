import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/** Query params for GET /orders — numbered page + status tab + free-text search.
 *  Unlike the keyset endpoints this screen paginates by page number (the panel shows
 *  a numbered footer), so it carries `page` instead of `cursor`. */
export class OrdersQueryDto extends PaginationQueryDto {
  /** 1-based page number. Defaults to 1. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Status tab. Omit for «Всички». */
  @IsOptional()
  @IsIn(['pending', 'confirmed', 'delivered', 'cancelled'])
  status?: 'pending' | 'confirmed' | 'delivered' | 'cancelled';

  /** Free-text search over customer name / phone / email / order number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Optional delivery-day filter (YYYY-MM-DD). Scopes to orders scheduled for
   *  that day — slot day, falling back to creation day for slotless orders, the
   *  same `scheduledForDay` rule as production / payments / digests. Omit for
   *  «Всички дни». */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date трябва да е във формат YYYY-MM-DD' })
  date?: string;
}
