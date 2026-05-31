'use client';

import { useState } from 'react';
import { Search, MapPin, Package } from 'lucide-react';
import { toast } from 'sonner';
import { cn, moneyFromStotinki, timeFromIso, type OrderStatus } from '@/lib/utils';
import { StatusBadge } from '@/components/status-badge';
import { OrderPanel } from './order-panel';
import { ApiError, updateOrderStatus } from '@/lib/api-client';
import type { Order } from '@/lib/types';

const FILTERS: [string, string][] = [
  ['all', 'Всички'],
  ['pending', 'Чакащи'],
  ['confirmed', 'Потвърдени'],
  ['delivered', 'Доставени'],
  ['cancelled', 'Отказани'],
];
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function OrdersClient({ initial }: { initial: Order[] }) {
  const [orders, setOrders] = useState<Order[]>(initial);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = orders.filter(
    (o) =>
      (filter === 'all' || o.status === filter) &&
      (!q ||
        (o.customerName ?? '').toLowerCase().includes(q.toLowerCase()) ||
        o.id.toLowerCase().includes(q.toLowerCase())),
  );
  const active = orders.find((o) => o.id === activeId) ?? null;

  async function onAction(o: Order, status: OrderStatus) {
    setBusy(true);
    const prev = o.status;
    setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status } : x)));
    try {
      await updateOrderStatus(o.id, status);
      toast.success('Статусът е обновен');
      setActiveId(null);
    } catch (e) {
      setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status: prev } : x)));
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const itemsSummary = (o: Order) => o.items.map((i) => `${i.productName} × ${i.quantity}`).join(', ');
  const deliveryCell = (o: Order) =>
    o.deliveryType === 'econt' ? (
      <span className="inline-flex items-center gap-1.5 font-semibold text-ff-amber-600">
        <Package size={15} /> Еконт
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 font-semibold text-ff-green-700">
        <MapPin size={15} /> Адрес
      </span>
    );

  return (
    <div className="animate-ff-fade-up">
      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-[300px] max-[680px]:w-full">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ff-muted">
            <Search size={18} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Търси клиент или № поръчка…"
            className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface pl-11 pr-3 text-[14.5px] shadow-ff-sm outline-none focus:border-ff-green-500"
          />
        </div>
        <div className="ml-auto flex gap-1.5 rounded-xl border border-ff-border bg-ff-surface p-[5px] shadow-ff-sm max-[680px]:ml-0 max-[680px]:w-full max-[680px]:overflow-x-auto">
          {FILTERS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cn(
                'whitespace-nowrap rounded-[9px] px-3.5 py-[7px] text-[13.5px] font-bold transition-colors',
                filter === k ? 'bg-ff-green-700 text-white' : 'text-ff-ink-2 hover:bg-ff-surface-2',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        {/* table (desktop) */}
        <table className="w-full border-collapse max-[680px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Час', 'Клиент', 'Продукти', 'Доставка', 'Статус'].map((h) => (
                <th key={h} className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                  {h}
                </th>
              ))}
              <th className="px-5 py-3.5 text-right text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                Сума
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((o) => (
              <tr
                key={o.id}
                onClick={() => setActiveId(o.id)}
                className="cursor-pointer border-b border-ff-border-2 last:border-0 hover:bg-ff-surface-2"
              >
                <td className="px-5 py-3.5 align-top">
                  <div className="text-[13.5px] font-bold text-ff-muted">{timeFromIso(o.createdAt)}</div>
                  <div className="text-xs text-ff-muted-2">#{o.id.slice(0, 8)}</div>
                </td>
                <td className="px-5 py-3.5 align-top text-[14.5px] font-bold">{o.customerName}</td>
                <td className="max-w-[280px] truncate px-5 py-3.5 align-top text-[13.5px] text-ff-ink-2">
                  {itemsSummary(o)}
                </td>
                <td className="px-5 py-3.5 align-top text-[13px]">{deliveryCell(o)}</td>
                <td className="px-5 py-3.5 align-top">
                  <StatusBadge status={o.status} size="sm" />
                </td>
                <td className="ff-fig px-5 py-3.5 text-right align-top text-[14.5px] font-extrabold">
                  {moneyFromStotinki(o.totalStotinki)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* cards (mobile) */}
        <div className="hidden flex-col max-[680px]:flex">
          {filtered.map((o) => (
            <button
              key={o.id}
              onClick={() => setActiveId(o.id)}
              className="flex flex-col gap-2.5 border-b border-ff-border-2 px-4 py-3.5 text-left last:border-0"
            >
              <div className="flex items-start justify-between gap-2.5">
                <div>
                  <div className="text-[15.5px] font-extrabold">{o.customerName}</div>
                  <div className="mt-px text-[12.5px] text-ff-muted">
                    {timeFromIso(o.createdAt)} · #{o.id.slice(0, 8)}
                  </div>
                </div>
                <StatusBadge status={o.status} size="sm" />
              </div>
              <div className="text-[13.5px] leading-[1.4] text-ff-ink-2">{itemsSummary(o)}</div>
              <div className="flex items-center justify-between border-t border-ff-border-2 pt-2.5 text-[13px]">
                {deliveryCell(o)}
                <span className="ff-fig text-[16.5px] font-extrabold">{moneyFromStotinki(o.totalStotinki)}</span>
              </div>
            </button>
          ))}
        </div>

        {filtered.length === 0 && <p className="px-5 py-12 text-center text-sm text-ff-muted">Няма поръчки за този филтър.</p>}
      </div>

      {active && (
        <OrderPanel order={active} busy={busy} onClose={() => setActiveId(null)} onAction={(s) => onAction(active, s)} />
      )}
    </div>
  );
}
