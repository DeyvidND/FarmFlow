import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/** Products list query: pagination + optional review-queue filter. */
export class ListProductsQueryDto extends PaginationQueryDto {
  /** 'pending' = only rows awaiting review (the «Провери продукти» queue). */
  @IsOptional()
  @IsIn(['pending'])
  review?: 'pending';
}
