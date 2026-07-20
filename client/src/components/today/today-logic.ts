import type { TodayPipeline } from '@/lib/types';

/** A countable pipeline bucket (everything on TodayPipeline except the derived
 *  `total`). `markDelivered`'s source is one of these. */
export type PipelineBucket = Exclude<keyof TodayPipeline, 'total'>;

/** Optimistic transform for «Потвърди всички»: every «Нови» order becomes
 *  «Потвърдена». `total` is unchanged (both buckets are active). Immutable. */
export function applyConfirmAll(pipeline: TodayPipeline): TodayPipeline {
  return { ...pipeline, confirmed: pipeline.confirmed + pipeline.new, new: 0 };
}

/** Optimistic transform for an inline «Достави»: move one order from its current
 *  bucket into `delivered`. Source bucket clamps at 0; `total` is untouched
 *  (a move between active buckets). Immutable. */
export function markDelivered(pipeline: TodayPipeline, from: PipelineBucket): TodayPipeline {
  const next = { ...pipeline };
  next[from] = Math.max(0, next[from] - 1);
  next.delivered += 1;
  return next;
}

/** Map a client `Order.status` onto its pipeline bucket, so the feed's
 *  mark-delivered action can drive `markDelivered`. */
export function bucketForStatus(status: string): PipelineBucket {
  switch (status) {
    case 'pending':
      return 'new';
    case 'preparing':
      return 'preparing';
    case 'out_for_delivery':
      return 'outForDelivery';
    case 'delivered':
      return 'delivered';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'confirmed';
  }
}
