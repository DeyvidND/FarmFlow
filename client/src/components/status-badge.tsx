import { cn, statusMeta, type OrderStatus } from '@/lib/utils';

const PALETTE: Record<
  OrderStatus,
  { bg: string; ink: string; dot: string; outline?: boolean; strike?: boolean }
> = {
  pending: { bg: 'bg-ff-amber-soft', ink: 'text-ff-amber-600', dot: 'bg-ff-amber' },
  confirmed: { bg: 'bg-ff-green-100', ink: 'text-ff-green-700', dot: 'bg-ff-green-500' },
  preparing: { bg: 'bg-ff-green-50', ink: 'text-ff-green-700', dot: 'bg-ff-green-500' },
  out_for_delivery: { bg: 'bg-ff-green-100', ink: 'text-ff-green-800', dot: 'bg-ff-green-700' },
  delivered: { bg: 'bg-ff-badge-bg', ink: 'text-ff-badge-ink', dot: 'bg-ff-muted-2' },
  cancelled: { bg: 'bg-transparent', ink: 'text-ff-muted', dot: 'bg-ff-muted-2', outline: true, strike: true },
};

export function StatusBadge({
  status,
  size = 'sm',
}: {
  status: OrderStatus;
  size?: 'sm' | 'md';
}) {
  const meta = statusMeta[status];
  const pal = PALETTE[status];
  const sm = size === 'sm';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-bold whitespace-nowrap',
        sm ? 'px-2.5 py-[3px] text-xs' : 'px-[11px] py-[5px] text-[13px]',
        pal.bg,
        pal.ink,
        pal.outline ? 'border border-dashed border-ff-muted-2' : 'border border-transparent',
      )}
    >
      <span className={cn('h-[7px] w-[7px] rounded-full', pal.dot)} />
      <span className={pal.strike ? 'line-through' : undefined}>{meta.label}</span>
    </span>
  );
}
