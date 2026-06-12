'use client';

import { useState } from 'react';
import { X, Check, ChevronLeft, ChevronRight, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { OrderDetailBody } from './order-panel';
import type { Order } from '@/lib/types';

export function CodReviewDrawer({
  orders,
  busy,
  onConfirm,
  onReject,
  onConfirmRemaining,
  onClose,
}: {
  orders: Order[];
  busy: boolean;
  onConfirm: (order: Order) => void;
  onReject: (order: Order) => void;
  onConfirmRemaining: (orders: Order[]) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [confirmingReject, setConfirmingReject] = useState(false);

  const safeIndex = Math.min(index, orders.length - 1);
  const current = orders[safeIndex];

  if (orders.length === 0) return null;

  return (
    <>
      <div onClick={onClose} className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.32)]" />
      <aside className="animate-ff-slide-in fixed right-0 top-0 z-[41] flex h-full w-[460px] max-w-[94vw] flex-col bg-ff-surface shadow-ff-lg max-[680px]:w-full max-[680px]:max-w-full">
        {/* header */}
        <div className="flex items-center justify-between border-b border-ff-border-2 px-6 py-[18px]">
          <div>
            <div className="mb-0.5 text-[12.5px] font-bold text-ff-muted">НАЛОЖЕН ПЛАТЕЖ</div>
            <h2 className="text-[22px] font-extrabold tracking-[-0.015em]">{current.customerName ?? 'Клиент'}</h2>
            <div className="text-[12.5px] text-ff-muted">
              {current.orderNumber != null ? `#${current.orderNumber}` : `#${current.id.slice(0, 8)}`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-ff-muted">
              {safeIndex + 1} / {orders.length}
            </span>
            <button
              onClick={onClose}
              aria-label="Затвори"
              className="grid h-10 w-10 place-items-center rounded-[11px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* body */}
        <OrderDetailBody order={current} />

        {/* footer */}
        <div className="flex flex-col gap-2.5 border-t border-ff-border-2 px-6 py-5">
          {/* navigation row */}
          <div className="flex justify-between">
            <Button
              variant="ghost"
              disabled={busy || safeIndex === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              aria-label="Предишна"
            >
              <ChevronLeft size={18} /> Предишна
            </Button>
            <Button
              variant="ghost"
              disabled={busy || safeIndex >= orders.length - 1}
              onClick={() => setIndex((i) => Math.min(orders.length - 1, i + 1))}
              aria-label="Следваща"
            >
              Следваща <ChevronRight size={18} />
            </Button>
          </div>

          <Button
            variant="primary"
            disabled={busy}
            onClick={() => onConfirm(current)}
            className="w-full rounded-sm"
          >
            <Check size={18} /> Потвърди поръчката
          </Button>

          <Button
            variant="danger"
            disabled={busy}
            onClick={() => setConfirmingReject(true)}
            className="w-full rounded-sm"
          >
            <X size={18} /> Откажи поръчката
          </Button>

          <div className="border-t border-ff-border-2" />

          <Button
            variant="ghost"
            disabled={busy || orders.length === 0}
            onClick={() => onConfirmRemaining(orders)}
            className="w-full"
          >
            <CheckCheck size={16} /> Потвърди всички останали ({orders.length})
          </Button>
        </div>
      </aside>

      {confirmingReject && (
        <ConfirmDialog
          tone="danger"
          title="Отказване на поръчката?"
          message={
            <>
              Поръчката на <b>{current.customerName ?? 'клиента'}</b> ще бъде отказана.
            </>
          }
          confirmLabel="Откажи поръчката"
          cancelLabel="Назад"
          onCancel={() => setConfirmingReject(false)}
          onConfirm={() => {
            setConfirmingReject(false);
            onReject(current);
          }}
        />
      )}
    </>
  );
}
