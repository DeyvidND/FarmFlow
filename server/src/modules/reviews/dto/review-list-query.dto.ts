import { IsOptional, IsIn } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/** Admin review list: pagination + optional status filter. */
export class ReviewListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['pending', 'published', 'hidden'])
  status?: 'pending' | 'published' | 'hidden';
}
