import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StatCardProps {
  Icon: LucideIcon;
  label: string;
  value: string | number;
  sub: string;
  tone: 'green' | 'amber';
  /** Stagger index for the fade-up entrance. */
  index?: number;
}

const TONES = {
  green: 'bg-ff-green-50 text-ff-green-700',
  amber: 'bg-ff-amber-softer text-ff-amber-600',
} as const;

export function StatCard({ Icon, label, value, sub, tone, index = 0 }: StatCardProps) {
  return (
    <div
      className="animate-ff-fade-up rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-[18px] shadow-ff-sm"
      style={{ animationDelay: `${index * 0.04}s` }}
    >
      <div className="flex items-start justify-between">
        <div className={cn('grid h-[42px] w-[42px] place-items-center rounded-[11px]', TONES[tone])}>
          <Icon size={22} />
        </div>
      </div>
      <div className="ff-fig mt-3.5 text-[32px] font-extrabold tracking-[-0.02em] text-ff-ink">{value}</div>
      <div className="mt-0.5 text-[13.5px] font-bold text-ff-ink-2">{label}</div>
      <div className="mt-[3px] text-[13.5px] text-ff-muted">{sub}</div>
    </div>
  );
}
