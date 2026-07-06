import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/** Query params for GET /orders/mine — keyset page + status filter + search.
 *  Unlike PaymentsQueryDto's implicit «counted statuses only» scope, this
 *  screen shows every status, so it needs the full enum (not the 4-value
 *  enum on OrdersQueryDto, which is missing 'preparing'/'out_for_delivery'). */
export class MyOrdersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'])
  status?: 'pending' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled';

  /** Free-text search over customer name / phone / email / order number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Owner-only: scope the list to one producer. Ignored for a producer token
   *  (a producer is always forced to its own farmerId server-side). */
  @IsOptional()
  @IsUUID()
  farmerId?: string;
}
