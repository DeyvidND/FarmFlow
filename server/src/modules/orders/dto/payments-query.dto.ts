import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/** Query params for GET /orders/payments — keyset page + tab filter + search. */
export class PaymentsQueryDto extends PaginationQueryDto {
  /** 'all' (both channels) or 'cod' (наложен платеж only). Defaults to 'all'. */
  @IsOptional()
  @IsIn(['all', 'cod'])
  method?: 'all' | 'cod';

  /** Free-text search over customer name / phone / email / order number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Owner-only: scope the list to one producer's line items. Ignored for a
   *  producer token (a producer is always forced to its own farmerId server-side). */
  @IsOptional()
  @IsUUID()
  farmerId?: string;
}
