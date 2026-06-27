import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
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
}
