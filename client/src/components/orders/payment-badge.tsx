import { cn } from '@/lib/utils';
import type { PaymentStatus } from '@/lib/types';

const META: Record<PaymentStatus, { label: string; bg: string; ink: string; dot: string }> = {
  paid: { label: 'Платена', bg: 'bg-ff-green-100', ink: 'text-ff-green-700', dot: 'bg-ff-green-500' },
  pending_online: {
    label: 'Неплатена',
    bg: 'bg-ff-amber-soft',
    ink: 'text-ff-amber-600',
    dot: 'bg-ff-amber',
  },
  cash: { label: 'При доставка', bg: 'bg-ff-badge-bg', ink: 'text-ff-badge-ink', dot: 'bg-ff-muted-2' },
};

/** Coarse payment state pill (paid online / awaiting online / cash on delivery). */
export function PaymentBadge({ status, size = 'sm' }: { status: PaymentStatus; size?: 'sm' | 'md' }) {
  const m = META[status];
  const sm = size === 'sm';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent font-bold',
        sm ? 'px-2.5 py-[3px] text-xs' : 'px-[11px] py-[5px] text-[13px]',
        m.bg,
        m.ink,
      )}
    >
      <span className={cn('h-[7px] w-[7px] rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}
