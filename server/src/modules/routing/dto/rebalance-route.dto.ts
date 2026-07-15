import { IsOptional, Matches } from 'class-validator';

/**
 * Reset a delivery day to full auto-distribution: clears every manual courier
 * pin and manual stop order for `date` (default: today, Europe/Sofia), so the
 * next route fetch re-runs the geographic sweep-split from scratch.
 */
export class RebalanceRouteDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date трябва да е YYYY-MM-DD' })
  date?: string;
}
