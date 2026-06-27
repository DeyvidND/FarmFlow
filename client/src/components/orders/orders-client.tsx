'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, MapPin, Package, Store, Info } from 'lucide-react';
import { toast } from 'sonner';
import { cn, moneyFromStotinki, timeFromIso, hhmm, relDayLabel, type OrderStatus } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { HelpModal } from '@/components/delivery/ui';
import { ORDERS_HELP } from '@/lib/help-content';
import { StatusBadge } from '@/components/status-badge';
import { PaymentBadge } from './payment-badge';
import { OrderPanel } from './order-panel';
import { ApiError, listOrders, updateOrderStatus } from '@/lib/api-client';
import { Pagination } from '@/components/ui/pagination';
import type { Order, Paged } from '@/lib/types';

const FILTERS: [string, string][] = [
  ['all', 'Всички'],
  ['pending', 'Чакащи'],
  ['confirmed', 'Потвърдени'],
  ['delivered', 'Доставени'],
  ['cancelled', 'Отказани'],
];
/** Orders per numbered page. Exported so the server page seeds the same first page. */
export const ORDERS_PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
/** Human order ref — the per-tenant number, falling back to a short id for legacy rows. */
const orderNo = (o: Order) => (o.orderNumber != null ? `#${o.orderNumber}` : `#${o.id.slice(0, 8)}`);

export function OrdersClient({ initial }: { initial: Paged<Order> }) {
  // Server-side search / filter / pagination — the screen no longer drains every
  // page on mount. The server-rendered `initial` is page 1 (all statuses, no query).
  const [orders, setOrders] = useState<Order[]>(initial.items);
  const [total, setTotal] = useState(initial.total);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState(''); // debounced query actually sent to the API
  const [filter, setFilter] = useState('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [help, setHelp] = useState(false);
  const [page, setPage] = useState(1);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // A new search term or status tab always restarts at page 1.
  useEffect(() => {
    setPage(1);
  }, [dq, filter]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listOrders({
        page,
        limit: ORDERS_PAGE_SIZE,
        q: dq || undefined,
        status: filter,
      });
      setOrders(res.items);
      setTotal(res.total);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [page, dq, filter]);

  // Skip the very first run: the server already rendered page 1 / all / no query.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      if (page === 1 && !dq && filter === 'all') return;
    }
    void load();
  }, [load, page, dq, filter]);

  const pageCount = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));
  const paged = orders;
  const active = orders.find((o) => o.id === activeId) ?? null;

  async function revertStatus(id: string, to: OrderStatus) {
    setOrders((p) => p.map((x) => (x.id === id ? { ...x, status: to } : x))); // optimistic
    try {
      await updateOrderStatus(id, to);
      toast.success('Върнато');
      void load(); // reconcile membership (the row may leave/enter the active filter) + counts
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  async function onAction(o: Order, status: OrderStatus) {
    setBusy(true);
    const prev = o.status;
    setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status } : x)));
    try {
      await updateOrderStatus(o.id, status);
      toast.success('Статусът е обновен', {
        action: { label: 'Отмени', onClick: () => void revertStatus(o.id, prev) },
      });
      setActiveId(null);
      void load(); // reconcile: a row may leave a status tab; keep counts/pagination correct
    } catch (e) {
      setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status: prev } : x)));
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const itemsSummary = (o: Order) => o.items.map((i) => `${i.productName} × ${i.quantity}`).join(', ');
  const deliveryCell = (o: Order) => {
    if (o.deliveryType === 'econt' || o.deliveryType === 'econt_address') {
      return (
        <span className="inline-flex items-center gap-1.5 font-semibold text-ff-amber-600">
          <Package size={15} /> {o.deliveryType === 'econt_address' ? 'Еконт адрес' : 'Еконт офис'}
        </span>
      );
    }
    if (o.deliveryType === 'pickup') {
      return (
        <span className="inline-flex items-center gap-1.5 font-semibold text-ff-ink-2">
          <Store size={15} /> Пазар
        </span>
      );
    }
    // Local (address) delivery — show the chosen delivery day + time window. Flag in
    // amber when it's missing, since a local delivery must have a slot to be routed.
    const slot =
      o.slotDate && o.slotFrom && o.slotTo
        ? `${relDayLabel(o.slotDate)} · ${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}`
        : null;
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className="inline-flex items-center gap-1.5 font-semibold text-ff-green-700">
          <MapPin size={15} /> Адрес
        </span>
        {slot ? (
          <span className="text-[12px] font-semibold text-ff-ink-2">{slot}</span>
        ) : (
          <span className="text-[12px] font-semibold text-ff-amber-600">няма зададен час</span>
        )}
      </span>
    );
  };

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
            placeholder="Търси име, телефон, имейл или № поръчка…"
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
        <Button variant="ghost" size="sm" onClick={() => setHelp(true)} className="max-[680px]:w-full">
          <Info size={16} /> Обяснения
        </Button>
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
            {paged.map((o) => (
              <tr
                key={o.id}
                onClick={() => setActiveId(o.id)}
                className="cursor-pointer border-b border-ff-border-2 last:border-0 hover:bg-ff-surface-2"
              >
                <td className="px-5 py-3.5 align-top">
                  <div className="text-[13.5px] font-bold text-ff-muted">{timeFromIso(o.createdAt)}</div>
                  <div className="text-xs text-ff-muted-2">{orderNo(o)}</div>
                </td>
                <td className="px-5 py-3.5 align-top text-[14.5px] font-bold">{o.customerName}</td>
                <td className="max-w-[280px] truncate px-5 py-3.5 align-top text-[13.5px] text-ff-ink-2">
                  {itemsSummary(o)}
                </td>
                <td className="px-5 py-3.5 align-top text-[13px]">{deliveryCell(o)}</td>
                <td className="px-5 py-3.5 align-top">
                  <div className="flex flex-col items-start gap-1.5">
                    <StatusBadge status={o.status} size="sm" />
                    <PaymentBadge status={o.paymentStatus} size="sm" />
                  </div>
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
          {paged.map((o) => (
            <button
              key={o.id}
              onClick={() => setActiveId(o.id)}
              className="flex flex-col gap-2.5 border-b border-ff-border-2 px-4 py-3.5 text-left last:border-0"
            >
              <div className="flex items-start justify-between gap-2.5">
                <div>
                  <div className="text-[15.5px] font-extrabold">{o.customerName}</div>
                  <div className="mt-px text-[12.5px] text-ff-muted">
                    {timeFromIso(o.createdAt)} · {orderNo(o)}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <StatusBadge status={o.status} size="sm" />
                  <PaymentBadge status={o.paymentStatus} size="sm" />
                </div>
              </div>
              <div className="text-[13.5px] leading-[1.4] text-ff-ink-2">{itemsSummary(o)}</div>
              <div className="flex items-center justify-between border-t border-ff-border-2 pt-2.5 text-[13px]">
                {deliveryCell(o)}
                <span className="ff-fig text-[16.5px] font-extrabold">{moneyFromStotinki(o.totalStotinki)}</span>
              </div>
            </button>
          ))}
        </div>

        {orders.length === 0 && (
          <p className="px-5 py-12 text-center text-sm text-ff-muted">
            {loading ? 'Зареждане…' : 'Няма поръчки за този филтър.'}
          </p>
        )}
      </div>

      <Pagination page={page} pageCount={pageCount} onPage={setPage} total={total} />
      {loading && (
        <p className="mt-2 text-center text-[12px] text-ff-muted">Зареждане на още поръчки…</p>
      )}

      {active && (
        <OrderPanel order={active} busy={busy} onClose={() => setActiveId(null)} onAction={(s) => onAction(active, s)} />
      )}

      {help && <HelpModal {...ORDERS_HELP} onClose={() => setHelp(false)} />}
    </div>
  );
}
