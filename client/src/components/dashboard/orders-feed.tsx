'use client';

import { ChevronRight } from 'lucide-react';
import { StatusBadge } from '@/components/status-badge';
import { moneyFromStotinki, timeFromIso } from '@/lib/utils';
import type { Order } from '@/lib/types';

interface OrdersFeedProps {
  orders: Order[];
  onOpen: (id: string) => void;
  onSeeAll: () => void;
}

export function OrdersFeed({ orders, onOpen, onSeeAll }: OrdersFeedProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <div className="flex items-center justify-between border-b border-ff-border-2 px-5 pb-3.5 pt-[18px]">
        <h2 className="whitespace-nowrap text-[16.5px] font-extrabold">Поръчки за днес</h2>
        <button
          onClick={onSeeAll}
          className="inline-flex items-center gap-[3px] text-[13.5px] font-bold text-ff-green-700 hover:underline"
        >
          Всички <ChevronRight size={15} />
        </button>
      </div>

      {orders.length === 0 ? (
        <p className="px-5 py-12 text-center text-sm text-ff-muted">Няма поръчки за днес.</p>
      ) : (
        orders.map((o, i) => (
          <button
            key={o.id}
            onClick={() => onOpen(o.id)}
            className={`grid w-full grid-cols-[52px_1fr_auto_auto] items-center gap-3.5 px-5 py-[13px] text-left transition-colors hover:bg-ff-surface-2 ${
              i < orders.length - 1 ? 'border-b border-ff-border-2' : ''
            }`}
          >
            <div className="text-[13px] font-bold text-ff-muted">{timeFromIso(o.createdAt)}</div>
            <div className="min-w-0">
              <div className="text-[14.5px] font-bold text-ff-ink">{o.customerName}</div>
              <div className="truncate text-[12.5px] text-ff-muted">
                {o.items.map((it) => `${it.productName} ×${it.quantity}`).join(', ')}
              </div>
            </div>
            <StatusBadge status={o.status} size="sm" />
            <div className="ff-fig min-w-[76px] text-right text-[14.5px] font-extrabold text-ff-ink">
              {moneyFromStotinki(o.totalStotinki)}
            </div>
          </button>
        ))
      )}
    </div>
  );
}
