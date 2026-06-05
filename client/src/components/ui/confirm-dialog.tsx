'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * In-app confirmation modal — replaces native `window.confirm` so destructive or
 * bulk actions match the rest of the panel's styling. Render it conditionally
 * (mount only while asking); `onConfirm`/`onCancel` close it.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Потвърди',
  cancelLabel = 'Отказ',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` = red-accented destructive action (cancel order, delete). */
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="animate-ff-fade fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="animate-ff-pop w-[400px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label={title}
      >
        <div className="flex items-start gap-3">
          <span
            className={
              tone === 'danger'
                ? 'grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ff-amber-softer text-ff-red'
                : 'grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700'
            }
          >
            <AlertTriangle size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16.5px] font-extrabold leading-tight">{title}</h2>
            <div className="mt-1.5 text-[13.5px] leading-[1.5] text-ff-ink-2">{message}</div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy} className="rounded-sm">
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={
              tone === 'danger'
                ? 'rounded-sm !bg-ff-red text-white hover:brightness-105'
                : 'rounded-sm'
            }
          >
            {busy ? 'Момент…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
