'use client';

import { CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TodayPipeline } from '@/lib/types';
import { showConfirmAll, confirmAllLabel } from './tiles-logic';

/** One status bucket of the day's pipeline, coloured like its stage. */
const CHIPS: { key: keyof TodayPipeline; label: string; dot: string; ink: string }[] = [
  { key: 'new', label: 'Нови', dot: 'bg-ff-amber', ink: 'text-ff-amber-600' },
  { key: 'confirmed', label: 'Потвърдени', dot: 'bg-ff-green-500', ink: 'text-ff-green-700' },
  { key: 'preparing', label: 'За подготовка', dot: 'bg-ff-green-500', ink: 'text-ff-green-700' },
  { key: 'outForDelivery', label: 'На път', dot: 'bg-ff-green-600', ink: 'text-ff-green-800' },
  { key: 'delivered', label: 'Доставени', dot: 'bg-ff-muted-2', ink: 'text-ff-muted' },
];

export function PipelineStrip({
  pipeline,
  onConfirmAll,
  confirming,
}: {
  pipeline: TodayPipeline;
  onConfirmAll: () => void;
  confirming: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        {CHIPS.map((c) => (
          <div key={c.key} className="flex items-center gap-2">
            <span className={cn('h-[7px] w-[7px] shrink-0 rounded-full', c.dot)} />
            <span className="ff-fig text-[19px] font-extrabold tracking-[-0.01em] text-ff-ink">{pipeline[c.key]}</span>
            <span className={cn('text-[13px] font-semibold', c.ink)}>{c.label}</span>
          </div>
        ))}
      </div>

      {showConfirmAll(pipeline) && (
        <Button variant="amber" size="sm" onClick={onConfirmAll} disabled={confirming}>
          <CheckCheck size={16} /> {confirmAllLabel(pipeline)}
        </Button>
      )}
    </div>
  );
}
