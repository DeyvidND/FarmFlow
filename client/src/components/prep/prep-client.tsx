'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Phone, Mail, Check, Loader2, AlertTriangle, PackageCheck, ShoppingBasket, Clock,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { cn, hhmm, relDayLabel, shiftIsoDate, todayIso } from '@/lib/utils';
import {
  ApiError, getPrep, setFulfillment,
  type PrepSummary, type TomorrowOrder, type FulfillmentState,
} from '@/lib/api-client';
import { DateNavBar } from '@/components/production/date-nav-bar';
import { aggregateByProduct } from './aggregate';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const plural = (n: number) => (n === 1 ? 'бройка' : 'бройки');

const STATE_LABEL: Record<FulfillmentState, string> = {
  pending: 'Чака', in_production: 'В процес', fulfilled: 'Готово',
};
const STATE_CLS: Record<FulfillmentState, string> = {
  pending: 'bg-ff-amber-softer text-ff-amber-600',
  in_production: 'bg-ff-surface-2 text-ff-muted',
  fulfilled: 'bg-ff-green-100 text-ff-green-800',
};
const DELIVERY_LABEL: Record<string, string> = {
  pickup: 'На място', address: 'Доставка', econt: 'Еконт офис',
  econt_address: 'Еконт до адрес', courier: 'Куриер',
};

function deliveryMeta(o: TomorrowOrder): string {
  const dt = DELIVERY_LABEL[o.deliveryType] ?? o.deliveryType;
  if (o.slotFrom) {
    const win = o.slotTo ? `${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}` : hhmm(o.slotFrom);
    return `${dt} · ${win}`;
  }
  return dt;
}

function Contact({ o }: { o: TomorrowOrder }) {
  if (!o.customerPhone && !o.customerEmail) return <span className="text-[12.5px] text-ff-muted-2">—</span>;
  return (
    <div className="flex flex-col gap-0.5 text-[12.5px]">
      {o.customerPhone && (
        <a href={`tel:${o.customerPhone}`} className="inline-flex items-center gap-1.5 font-semibold text-ff-ink-2 hover:text-ff-green-700">
          <Phone size={12.5} className="shrink-0 text-ff-muted" />{o.customerPhone}
        </a>
      )}
      {o.customerEmail && (
        <a href={`mailto:${o.customerEmail}`} className="inline-flex items-center gap-1.5 text-ff-muted hover:text-ff-green-700">
          <Mail size={12.5} className="shrink-0" />{o.customerEmail}
        </a>
      )}
    </div>
  );
}

/**
 * «Подготовка» — merged Производство + Утре. One day, two axes:
 *  - По поръчка: per-order cards, customer contact, self-tracked prep state
 *    (server-side) — the ONLY place "готово" is set.
 *  - По продукт: read-only harvest totals aggregated from the same orders;
 *    progress is derived from fulfilled orders (never disagrees).
 */
export function PrepClient({
  initial,
  initialDate,
  role,
  farmers = [],
  multiFarmer = false,
  defaultFarmerId = '',
}: {
  initial: PrepSummary;
  initialDate: string;
  role?: 'admin' | 'farmer';
  farmers?: { id: string; name: string }[];
  multiFarmer?: boolean;
  defaultFarmerId?: string;
}) {
  const showPicker = role === 'admin' && multiFarmer && farmers.length > 1;
  const [farmerId, setFarmerId] = useState(defaultFarmerId);
  const [date, setDate] = useState(initialDate || shiftIsoDate(todayIso(), 1));
  const [orders, setOrders] = useState<TomorrowOrder[]>(initial.orders);
  const [pendingOrders, setPendingOrders] = useState(initial.pendingOrders);
  const [view, setView] = useState<'orders' | 'products'>('orders');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const firstRun = useRef(true);

  // Refetch whenever the day or the selected farmer changes (skip the SSR-provided
  // first render). Mirrors the old /tomorrow screen's client refetch.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (role === 'admin' && !farmerId) return;
    let live = true;
    setLoading(true);
    getPrep(date, role === 'admin' ? farmerId : undefined)
      .then((s) => { if (live) { setOrders(s.orders); setPendingOrders(s.pendingOrders); } })
      .catch((e) => { if (live) toast.error(errMsg(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [date, farmerId, role]);

  const onMark = useCallback(
    async (id: string, state: FulfillmentState) => {
      setBusyId(id);
      try {
        await setFulfillment(id, state, role === 'admin' ? farmerId : undefined);
        setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, fulfillmentState: state } : o)));
        toast.success(state === 'fulfilled' ? 'Отбелязано като готово.' : 'Отбелязано като в процес.');
      } catch (e) {
        toast.error(errMsg(e));
      } finally {
        setBusyId(null);
      }
    },
    [farmerId, role],
  );

  const productRows = aggregateByProduct(orders);
  const totalQty = productRows.reduce((s, r) => s + r.totalQty, 0);
  const pickedQty = productRows.reduce((s, r) => s + r.pickedQty, 0);
  const allDone = totalQty > 0 && pickedQty === totalQty;
  const gaps = orders.filter((o) => o.fulfillmentState !== 'fulfilled');

  return (
    <div className="animate-ff-fade-up">
      {/* header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Подготовка</h1>
          <p className="text-[13.5px] text-ff-muted">Какво да приготвиш за деня — по поръчка или по продукт.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showPicker && (
            <label className="inline-flex items-center gap-2 text-[13px] font-bold text-ff-ink-2">
              Фермер:
              <select
                value={farmerId}
                onChange={(e) => setFarmerId(e.target.value)}
                className="h-10 rounded-xl border border-ff-border bg-ff-surface px-2.5 text-[13px] font-semibold text-ff-ink-2 shadow-ff-sm outline-none focus:border-ff-green-500"
              >
                {farmers.map((f) => (<option key={f.id} value={f.id}>{f.name}</option>))}
              </select>
            </label>
          )}
          <DateNavBar date={date} dateLabel={relDayLabel(date)} onSelect={setDate} />
        </div>
      </div>

      {/* pending-confirm nudge */}
      {pendingOrders > 0 && (
        <Link
          href="/orders"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-2.5 transition hover:brightness-[0.98]"
        >
          <AlertTriangle size={16} className="shrink-0 text-ff-amber-600" />
          <span className="text-[12.5px] font-bold text-ff-amber-600">
            {pendingOrders === 1
              ? '1 поръчка чака потвърждение — не е в списъка. Потвърди я.'
              : `${pendingOrders} поръчки чакат потвърждение — не са в списъка. Потвърди ги.`}
          </span>
          <span className="ml-auto whitespace-nowrap text-[12.5px] font-extrabold text-ff-amber-600 underline">Към поръчките →</span>
        </Link>
      )}

      {/* view toggle + progress */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-ff-border bg-ff-surface p-1 shadow-ff-sm" role="tablist">
          {([['orders', 'По поръчка'], ['products', 'По продукт']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={cn(
                'rounded-lg px-3.5 py-1.5 text-[13px] font-extrabold transition-colors',
                view === key ? 'bg-ff-green-600 text-white' : 'text-ff-ink-2 hover:bg-ff-surface-2',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className={cn('text-[13px] font-bold', allDone ? 'text-ff-green-700' : 'text-ff-muted')}>
          {pickedQty}/{totalQty} {plural(totalQty)} готови
        </span>
      </div>

      {loading && (
        <p className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-ff-muted">
          <Loader2 size={14} className="animate-spin" /> Зареждане…
        </p>
      )}

      {orders.length === 0 ? (
        <div className="rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-[13.5px] text-ff-muted shadow-ff-sm">
          <PackageCheck size={28} className="mx-auto mb-2 text-ff-muted-2" />
          Няма потвърдени поръчки за този ден.
        </div>
      ) : view === 'orders' ? (
        <OrdersView orders={orders} gaps={gaps} busyId={busyId} onMark={onMark} />
      ) : (
        <ProductsView rows={productRows} pickedQty={pickedQty} totalQty={totalQty} allDone={allDone} />
      )}
    </div>
  );
}

function OrdersView({
  orders, gaps, busyId, onMark,
}: {
  orders: TomorrowOrder[];
  gaps: TomorrowOrder[];
  busyId: string | null;
  onMark: (id: string, state: FulfillmentState) => void;
}) {
  return (
    <>
      {gaps.length > 0 && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-ff-amber-600" />
          <div className="text-[13px] leading-[1.5] text-ff-ink-2">
            <b className="text-ff-amber-600">{gaps.length}</b>{' '}
            {gaps.length === 1 ? 'поръчка още чака' : 'поръчки още чакат'} — ако не смогнеш, обади се на клиента
            (номерата са до всяка поръчка).
          </div>
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {orders.map((o) => (
          <li key={o.id} className="rounded-[12px] border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-extrabold text-ff-ink">№{o.orderNumber ?? '—'}</span>
                <span className="text-[12.5px] text-ff-muted">{deliveryMeta(o)}</span>
              </div>
              <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', STATE_CLS[o.fulfillmentState])}>
                {STATE_LABEL[o.fulfillmentState]}
              </span>
            </div>
            <div className="mb-2 text-[13.5px] font-bold text-ff-ink-2">{o.customerName ?? '—'}</div>
            <Contact o={o} />
            <ul className="my-2.5 flex flex-col gap-0.5 text-[12.5px] text-ff-muted">
              {o.items.map((it) => (<li key={it.productId}>{it.productName} × {it.quantity}</li>))}
            </ul>
            {o.fulfillmentState !== 'fulfilled' && (
              <div className="flex flex-wrap gap-1.5">
                {o.fulfillmentState === 'pending' && (
                  <button
                    type="button"
                    onClick={() => onMark(o.id, 'in_production')}
                    disabled={busyId === o.id}
                    className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ff-border bg-ff-surface-2 px-2.5 py-1 text-[11px] font-extrabold text-ff-ink-2 hover:bg-ff-border-2 disabled:opacity-60"
                  >
                    {busyId === o.id ? <Loader2 size={12} className="animate-spin" /> : null}
                    Започвам
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onMark(o.id, 'fulfilled')}
                  disabled={busyId === o.id}
                  className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ff-green-100 bg-ff-green-50 px-2.5 py-1 text-[11px] font-extrabold text-ff-green-700 hover:bg-ff-green-100 disabled:opacity-60"
                >
                  {busyId === o.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Готово
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function ProductsView({
  rows, pickedQty, totalQty, allDone,
}: {
  rows: ReturnType<typeof aggregateByProduct>;
  pickedQty: number;
  totalQty: number;
  allDone: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_300px] items-start gap-4 max-[900px]:grid-cols-1">
      <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="flex items-center justify-between border-b border-ff-border-2 px-[22px] pb-[15px] pt-[18px]">
          <h2 className="text-[17px] font-extrabold">За приготвяне</h2>
          <span className={cn('text-[13px] font-bold', allDone ? 'text-ff-green-700' : 'text-ff-muted')}>
            {pickedQty}/{totalQty} набрани
          </span>
        </div>
        {rows.map((r, i) => {
          const isDone = r.totalQty > 0 && r.pickedQty === r.totalQty;
          return (
            <div
              key={r.productName}
              className={cn(
                'grid w-full grid-cols-[1fr_auto] items-center gap-[18px] px-[22px] py-5 text-left',
                i < rows.length - 1 && 'border-b border-ff-border-2',
              )}
            >
              <div className="min-w-0">
                <div className={cn('text-[18px] font-extrabold tracking-[-0.01em]', isDone ? 'text-ff-muted' : 'text-ff-ink')}>
                  {r.productName}
                </div>
                <div className="mt-0.5 text-[13px] text-ff-muted">
                  от {r.orderCount} {r.orderCount === 1 ? 'поръчка' : 'поръчки'}
                  {r.pickedQty > 0 && !isDone && <span className="text-ff-green-700"> · {r.pickedQty} набрани</span>}
                  {isDone && <span className="text-ff-green-700"> · готово</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-baseline gap-1.5">
                <span className={cn('ff-fig text-[34px] font-extrabold leading-none tracking-[-0.03em]', isDone ? 'text-ff-muted-2' : 'text-ff-green-700')}>
                  {r.totalQty}
                </span>
                <span className="text-[15px] font-bold text-ff-muted">бр</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sticky top-0 flex flex-col gap-4 max-[900px]:static">
        <div className="rounded-xl border border-ff-border border-t-[3px] border-t-ff-green-600 bg-ff-surface p-5 shadow-ff-sm">
          <div className="mb-3 text-[13.5px] font-bold text-ff-muted">Напредък</div>
          <div className="flex items-baseline gap-2">
            <span className="ff-fig text-[40px] font-extrabold tracking-[-0.03em] text-ff-ink">{pickedQty}</span>
            <span className="text-[18px] font-bold text-ff-muted-2">/ {totalQty}</span>
          </div>
          <div className="mt-3.5 h-[9px] overflow-hidden rounded-full bg-ff-border-2">
            <div
              className={cn('h-full rounded-full transition-[width] duration-300', allDone ? 'bg-ff-green-600' : 'bg-ff-green-500')}
              style={{ width: `${totalQty ? (pickedQty / totalQty) * 100 : 0}%` }}
            />
          </div>
          <div className={cn('mt-3 text-[13px] font-semibold leading-[1.4]', allDone ? 'text-ff-green-700' : 'text-ff-muted')}>
            {allDone ? 'Всичко е приготвено — готов за доставка! 🌿' : `Остават ${totalQty - pickedQty} от ${totalQty} ${plural(totalQty)}.`}
          </div>
        </div>
        <div className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
          <div className="flex items-start gap-[11px]">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-ff-amber-softer text-ff-amber-600">
              <Clock size={19} />
            </span>
            <div>
              <div className="text-[14px] font-extrabold">Преди бране</div>
              <div className="mt-0.5 text-[13px] leading-[1.5] text-ff-ink-2">
                {'Отмятай поръчките в „По поръчка" — тук виждаш общо колко да набереш от всеки продукт.'}
              </div>
            </div>
          </div>
        </div>
        {rows.length === 0 && (
          <div className="rounded-xl border border-ff-border bg-ff-surface p-5 text-center text-ff-muted shadow-ff-sm">
            <ShoppingBasket size={24} className="mx-auto mb-2 text-ff-muted-2" />
            <div className="text-[13.5px]">Няма продукти за приготвяне.</div>
          </div>
        )}
      </div>
    </div>
  );
}
