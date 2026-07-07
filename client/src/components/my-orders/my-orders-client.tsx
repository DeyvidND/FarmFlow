'use client';

import { useCallback, useState } from 'react';
import { Check, X, Loader2, Phone, Mail, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  cn,
  moneyFromStotinki,
  BG_MONTHS,
  bgWeekdayShort,
  todayIso,
  shiftIsoDate,
} from '@/lib/utils';
import {
  ApiError,
  getMyOrders,
  updateOrderStatus,
  setCodOutcome,
  type FarmerOrdersPage,
  type FarmerOrder,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const STATUS_LABEL: Record<string, string> = {
  pending: 'Чакаща',
  confirmed: 'Потвърдена',
  preparing: 'Приготвя се',
  out_for_delivery: 'На път',
  delivered: 'Доставена',
  cancelled: 'Отказана',
};

const STATUS_CLS: Record<string, string> = {
  pending: 'bg-ff-amber-softer text-ff-amber-600',
  confirmed: 'bg-ff-surface-2 text-ff-muted',
  preparing: 'bg-ff-surface-2 text-ff-muted',
  out_for_delivery: 'bg-ff-surface-2 text-ff-muted',
  delivered: 'bg-ff-green-100 text-ff-green-800',
  cancelled: 'bg-red-100 text-red-800',
};

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'Всички' },
  { key: 'pending', label: 'Чакащи' },
  { key: 'confirmed', label: 'Потвърдени' },
  { key: 'preparing', label: 'Приготвят се' },
  { key: 'out_for_delivery', label: 'На път' },
  { key: 'delivered', label: 'Доставени' },
  { key: 'cancelled', label: 'Отказани' },
];

function dayLabel(iso: string): string {
  const today = todayIso();
  if (iso === today) return 'Днес';
  if (iso === shiftIsoDate(today, -1)) return 'Вчера';
  if (iso === shiftIsoDate(today, 1)) return 'Утре';
  const [, m, d] = iso.split('-');
  return `${bgWeekdayShort(iso)}, ${Number(d)} ${BG_MONTHS[Number(m) - 1]}`;
}

function Contact({ o }: { o: FarmerOrder }) {
  if (!o.customerPhone && !o.customerEmail) {
    return <span className="text-[12.5px] text-ff-muted-2">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5 text-[12.5px] text-ff-muted">
      {o.customerPhone && (
        <a href={`tel:${o.customerPhone}`} className="inline-flex items-center gap-1 hover:text-ff-green-700">
          <Phone size={12} /> {o.customerPhone}
        </a>
      )}
      {o.customerEmail && (
        <a href={`mailto:${o.customerEmail}`} className="inline-flex items-center gap-1 hover:text-ff-green-700">
          <Mail size={12} /> {o.customerEmail}
        </a>
      )}
    </div>
  );
}

function DeliveredButton({
  id,
  busyId,
  onMark,
}: {
  id: string;
  busyId: string | null;
  onMark: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onMark(id)}
      disabled={busyId === id}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ff-green-100 bg-ff-green-50 px-2.5 py-1 text-[11px] font-extrabold text-ff-green-700 hover:bg-ff-green-100 disabled:opacity-60"
    >
      {busyId === id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
      Маркирай доставена
    </button>
  );
}

function CollectButton({
  id,
  busyId,
  onCollect,
}: {
  id: string;
  busyId: string | null;
  onCollect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCollect(id)}
      disabled={busyId === id}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ff-green-100 bg-ff-green-50 px-2.5 py-1 text-[11px] font-extrabold text-ff-green-700 hover:bg-ff-green-100 disabled:opacity-60"
    >
      {busyId === id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
      Получих парите
    </button>
  );
}

function RefuseButton({
  id,
  busyId,
  onRefuse,
}: {
  id: string;
  busyId: string | null;
  onRefuse: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onRefuse(id)}
      disabled={busyId === id}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-red-100 bg-red-50 px-2.5 py-1 text-[11px] font-extrabold text-red-700 hover:bg-red-100 disabled:opacity-60"
    >
      {busyId === id ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
      Отказана
    </button>
  );
}

export function MyOrdersClient({ initial }: { initial: FarmerOrdersPage }) {
  const [orders, setOrders] = useState<FarmerOrder[]>(initial.orders);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [status, setStatus] = useState<string>('all');
  const [q, setQ] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async (nextStatus: string, nextQ: string) => {
    try {
      const page = await getMyOrders({
        status: nextStatus === 'all' ? undefined : nextStatus,
        q: nextQ || undefined,
        limit: 20,
      });
      setOrders(page.orders);
      setCursor(page.nextCursor);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);

  async function onTab(next: string) {
    setStatus(next);
    await reload(next, q);
  }

  async function onSearch(next: string) {
    setQ(next);
    await reload(status, next);
  }

  async function onLoadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await getMyOrders({
        status: status === 'all' ? undefined : status,
        q: q || undefined,
        cursor,
        limit: 20,
      });
      setOrders((prev) => [...prev, ...page.orders]);
      setCursor(page.nextCursor);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const onMarkDelivered = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await updateOrderStatus(id, 'delivered');
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: 'delivered' } : o)));
      toast.success('Отбелязана като доставена.');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const onCollect = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await setCodOutcome(id, 'received');
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, codOutcome: 'received' } : o)));
      toast.success('Отбелязано като получено.');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const onRefuse = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await setCodOutcome(id, 'refused');
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, codOutcome: 'refused' } : o)));
      toast.success('Отбелязано като отказана.');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <div>
      <h1 className="mb-1 text-[22px] font-extrabold text-ff-green-900">Моите поръчки</h1>
      <p className="mb-4 text-[13px] text-ff-muted">Какво трябва да приготвиш — по поръчка и статус.</p>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => void onTab(t.key)}
            className={cn(
              'rounded-full border px-3 py-1 text-[12.5px] font-bold',
              status === t.key
                ? 'border-ff-green-700 bg-ff-green-700 text-white'
                : 'border-ff-border bg-white text-ff-muted hover:bg-ff-surface-2',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <input
        type="search"
        value={q}
        onChange={(e) => void onSearch(e.target.value)}
        placeholder="Търси по име, телефон, имейл или № поръчка"
        className="mb-4 w-full rounded-[10px] border border-ff-border px-3 py-2 text-[13px]"
      />

      {orders.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-ff-muted-2">Няма поръчки в тази категория.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((o) => (
            <li key={o.id} className="rounded-[12px] border border-ff-border bg-white p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-extrabold text-ff-green-900">
                    №{o.orderNumber ?? '—'}
                  </span>
                  <span className="text-[12.5px] text-ff-muted">{dayLabel(o.day)}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', STATUS_CLS[o.status])}>
                    {STATUS_LABEL[o.status] ?? o.status}
                  </span>
                </div>
                <span className="text-[13px] font-extrabold text-ff-green-900">
                  {moneyFromStotinki(o.subtotalStotinki)}
                </span>
              </div>

              <Contact o={o} />

              <ul className="my-2 flex flex-col gap-0.5 text-[12.5px] text-ff-muted">
                {o.items.map((it) => (
                  <li key={it.productId}>
                    {it.productName} × {it.quantity}
                  </li>
                ))}
              </ul>

              {o.shared && (
                <div className="mb-2 flex items-center gap-1.5 rounded-[8px] bg-ff-amber-softer px-2.5 py-1.5 text-[12px] font-semibold text-ff-amber-600">
                  <Users size={13} />
                  Споделена поръчка — само собственикът може да я маркира.
                </div>
              )}

              {!o.shared && (
                <div className="flex flex-wrap gap-1.5">
                  {o.status !== 'delivered' && o.status !== 'cancelled' && (
                    <DeliveredButton id={o.id} busyId={busyId} onMark={onMarkDelivered} />
                  )}
                  {o.paymentMethod === 'cod' && o.codOutcome === null && (
                    <>
                      <CollectButton id={o.id} busyId={busyId} onCollect={onCollect} />
                      <RefuseButton id={o.id} busyId={busyId} onRefuse={onRefuse} />
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <button
          type="button"
          onClick={() => void onLoadMore()}
          disabled={loadingMore}
          className="mt-4 w-full rounded-[10px] border border-ff-border py-2 text-[13px] font-bold text-ff-muted hover:bg-ff-surface-2 disabled:opacity-60"
        >
          {loadingMore ? 'Зарежда…' : 'Зареди още'}
        </button>
      )}
    </div>
  );
}
