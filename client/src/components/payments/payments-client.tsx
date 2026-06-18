'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CreditCard,
  ShieldCheck,
  Wallet,
  ExternalLink,
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  Search,
  Phone,
  Mail,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  cn,
  moneyFromStotinki,
  BG_MONTHS,
  bgWeekdayShort,
  todayIso,
  shiftIsoDate,
  hhmm,
} from '@/lib/utils';
import {
  startStripeOnboarding,
  getPayments,
  type StripeSummary,
  type PaymentsPage,
  type PaymentTotals,
  type PaymentOrder,
  type PaymentChannel,
} from '@/lib/api-client';

/** The farmer's own full Stripe Dashboard (Standard accounts log in here directly). */
const STRIPE_DASHBOARD_URL = 'https://dashboard.stripe.com';

type Tab = 'all' | 'cod' | 'card';

const ZERO_TOTALS: PaymentTotals = {
  totalStotinki: 0,
  count: 0,
  allCount: 0,
  codTotalStotinki: 0,
  codCount: 0,
  cardTotalStotinki: 0,
  cardCount: 0,
};

const DELIVERY_LABEL: Record<string, string> = {
  pickup: 'На място',
  address: 'Доставка',
  econt: 'Еконт офис',
  econt_address: 'Еконт до адрес',
};

/** "YYYY-MM-DD" → "Днес" / "Вчера" / "Утре" / "Пет, 12 юни". */
function dayLabel(iso: string): string {
  const today = todayIso();
  if (iso === today) return 'Днес';
  if (iso === shiftIsoDate(today, -1)) return 'Вчера';
  if (iso === shiftIsoDate(today, 1)) return 'Утре';
  const [, m, d] = iso.split('-');
  return `${bgWeekdayShort(iso)}, ${Number(d)} ${BG_MONTHS[Number(m) - 1]}`;
}

/** Delivery method + slot time when set: "Доставка · 10:00". */
function deliveryMeta(o: PaymentOrder): string {
  const dt = DELIVERY_LABEL[o.deliveryType] ?? 'Доставка';
  return o.slotFrom ? `${dt} · ${hhmm(o.slotFrom)}` : dt;
}

/** Money state for a row: collected/paid vs awaiting. */
function moneyStatus(o: PaymentOrder): { label: string; cls: string } {
  const paid = o.paymentMethod === 'cod' ? o.collected : o.paymentStatus === 'paid';
  if (paid) {
    return {
      label: o.paymentMethod === 'cod' ? 'Получено' : 'Платено',
      cls: 'bg-ff-green-100 text-ff-green-800',
    };
  }
  return {
    label: o.paymentMethod === 'cod' ? 'Очаквано' : 'Неплатена',
    cls: 'bg-ff-amber-softer text-ff-amber-600',
  };
}

interface DayGroup {
  day: string;
  totalStotinki: number;
  count: number;
  orders: PaymentOrder[];
}

/** Bucket a flat (already day-desc sorted) list into per-day groups. */
function groupByDay(list: PaymentOrder[]): DayGroup[] {
  const byDay = new Map<string, DayGroup>();
  for (const o of list) {
    let g = byDay.get(o.day);
    if (!g) {
      g = { day: o.day, totalStotinki: 0, count: 0, orders: [] };
      byDay.set(o.day, g);
    }
    g.orders.push(o);
    g.totalStotinki += o.totalStotinki;
    g.count += 1;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

export function PaymentsClient({
  stripe,
  initial,
  role = 'admin',
  farmers = [],
  multiFarmer = false,
}: {
  stripe: StripeSummary;
  initial: PaymentsPage;
  /** A producer ('farmer') sees only the money from their own products. */
  role?: 'admin' | 'farmer';
  /** Owner-only producer picker (multi-farmer shops); mirrors Статистика. */
  farmers?: { id: string; name: string }[];
  multiFarmer?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('all');
  // Owner-only: scope the whole screen to one producer's line items ('' = all).
  const [farmerId, setFarmerId] = useState<string>('');
  const showPicker = role === 'admin' && multiFarmer && farmers.length > 0;
  const [query, setQuery] = useState('');
  const [dq, setDq] = useState('');

  // SSR seed = the «Всичко» first page (method=all, no search).
  const [totals, setTotals] = useState<PaymentTotals>(initial.totals ?? ZERO_TOTALS);
  const [orders, setOrders] = useState<PaymentOrder[]>(initial.orders);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [busy, setBusy] = useState(false);

  const method = tab === 'cod' ? 'cod' : 'all';

  // Debounce the search box so each keystroke doesn't fire a request.
  useEffect(() => {
    const t = setTimeout(() => setDq(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Fetch a fresh first page whenever the tab, (debounced) search, or producer
  // filter changes. The very first run is skipped — the SSR `initial` already
  // covers all/''/whole-shop.
  const firstRun = useRef(true);
  useEffect(() => {
    if (tab === 'card') return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    getPayments({ method, q: dq, ...(farmerId ? { farmerId } : {}) })
      .then((res) => {
        if (cancelled) return;
        setOrders(res.orders);
        setCursor(res.nextCursor);
        if (res.totals) setTotals(res.totals);
      })
      .catch(() => {
        if (!cancelled) toast.error('Грешка при зареждане на плащанията.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, dq, farmerId]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await getPayments({ method, q: dq, cursor, ...(farmerId ? { farmerId } : {}) });
      setOrders((prev) => [...prev, ...res.orders]);
      setCursor(res.nextCursor);
    } catch {
      toast.error('Грешка при зареждане.');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, method, dq, farmerId]);

  /** Create/refresh the connected account and open Stripe's hosted onboarding in a new tab. */
  async function onboard() {
    setBusy(true);
    const tabRef = window.open('about:blank', '_blank');
    if (tabRef) tabRef.opener = null;
    try {
      const { url } = await startStripeOnboarding();
      if (tabRef) tabRef.location.href = url;
      else window.location.href = url;
    } catch {
      tabRef?.close();
      toast.error('Неуспешна връзка със Stripe. Опитай пак.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-5">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Плащания</h1>
        <p className="text-[13.5px] text-ff-muted">
          {role === 'farmer'
            ? 'Сумите са за твоите продукти.'
            : 'Парите от поръчки — наложен платеж и картови плащания, по клиент.'}
        </p>
      </div>

      {/* totals (tenant-wide, independent of tab/search) */}
      <div className="mb-5 grid grid-cols-3 gap-2.5">
        <StatTile
          label="Общо"
          value={moneyFromStotinki(totals.totalStotinki)}
          sub={`${totals.count} ${plural(totals.count)}`}
          accent
        />
        <StatTile
          label="Наложен платеж"
          value={moneyFromStotinki(totals.codTotalStotinki)}
          sub={`${totals.codCount} ${plural(totals.codCount)}`}
        />
        <StatTile
          label="Карта"
          value={moneyFromStotinki(totals.cardTotalStotinki)}
          sub={`${totals.cardCount} ${plural(totals.cardCount)}`}
        />
      </div>

      {/* tabs */}
      <div className="mb-4 flex gap-1.5 rounded-xl border border-ff-border bg-ff-surface p-1 shadow-ff-sm">
        <TabButton active={tab === 'all'} onClick={() => setTab('all')} count={totals.allCount}>
          Всичко
        </TabButton>
        <TabButton active={tab === 'cod'} onClick={() => setTab('cod')} count={totals.codCount}>
          Наложен платеж
        </TabButton>
        {role !== 'farmer' && (
          <TabButton active={tab === 'card'} onClick={() => setTab('card')}>
            Карта
          </TabButton>
        )}
      </div>

      {tab !== 'card' && (
        <div className="mb-4 flex items-center gap-3">
          <div className="relative w-[340px] max-w-full">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ff-muted">
              <Search size={18} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Търси по име, телефон, имейл или № поръчка…"
              className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface pl-11 pr-3 text-[14.5px] shadow-ff-sm outline-none focus:border-ff-green-500"
            />
          </div>
          {showPicker && (
            <label className="inline-flex items-center gap-2 text-[13px] font-bold text-ff-ink-2">
              Фермер:
              <select
                value={farmerId}
                onChange={(e) => setFarmerId(e.target.value)}
                className="h-11 rounded-xl border border-ff-border bg-ff-surface px-2.5 text-[13px] font-semibold text-ff-ink-2 shadow-ff-sm outline-none focus:border-ff-green-500"
              >
                <option value="">Всички</option>
                {farmers.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </label>
          )}
          {loading && (
            <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ff-muted">
              <Loader2 size={14} className="animate-spin" /> Зареждане…
            </span>
          )}
        </div>
      )}

      {tab === 'all' && (
        <AllTable
          rows={orders}
          loading={loading}
          searching={dq.length > 0}
          cursor={cursor}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
        />
      )}
      {tab === 'cod' && (
        <CodView
          rows={orders}
          loading={loading}
          searching={dq.length > 0}
          cursor={cursor}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
        />
      )}
      {tab === 'card' && role !== 'farmer' && (
        <StripeSection summary={stripe} busy={busy} onboard={onboard} />
      )}
    </div>
  );
}

function plural(n: number): string {
  return n === 1 ? 'поръчка' : 'поръчки';
}

interface ListProps {
  rows: PaymentOrder[];
  loading: boolean;
  searching: boolean;
  cursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}

/* ─────────────────────────────  Всичко (all payments table)  ───────────────────────────── */

function AllTable({ rows, loading, searching, cursor, loadingMore, onLoadMore }: ListProps) {
  return (
    <>
      <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        {/* table (desktop) */}
        <table className="w-full border-collapse max-[680px]:hidden">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-left">
              {['Поръчка', 'Клиент', 'Контакт', 'Метод', 'Статус'].map((h) => (
                <th
                  key={h}
                  className="px-5 py-3.5 text-xs font-bold uppercase tracking-[0.03em] text-ff-muted"
                >
                  {h}
                </th>
              ))}
              <th className="px-5 py-3.5 text-right text-xs font-bold uppercase tracking-[0.03em] text-ff-muted">
                Сума
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const s = moneyStatus(o);
              return (
                <tr key={o.id} className="border-b border-ff-border-2 last:border-0 hover:bg-ff-surface-2">
                  <td className="px-5 py-3.5 align-top">
                    <div className="text-[14px] font-extrabold">
                      {o.orderNumber ? `#${o.orderNumber}` : 'Поръчка'}
                    </div>
                    <div className="text-[12px] capitalize text-ff-muted">{dayLabel(o.day)}</div>
                  </td>
                  <td className="px-5 py-3.5 align-top">
                    <div className="text-[14px] font-bold">{o.customerName ?? '—'}</div>
                    <div className="text-[12px] text-ff-muted">{deliveryMeta(o)}</div>
                  </td>
                  <td className="max-w-[220px] px-5 py-3.5 align-top">
                    <Contact o={o} />
                  </td>
                  <td className="px-5 py-3.5 align-top">
                    <MethodPill method={o.paymentMethod} />
                  </td>
                  <td className="px-5 py-3.5 align-top">
                    <StatusPill {...s} />
                  </td>
                  <td className="ff-fig px-5 py-3.5 text-right align-top text-[14.5px] font-extrabold">
                    {moneyFromStotinki(o.totalStotinki)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* cards (mobile) */}
        <div className="hidden flex-col max-[680px]:flex">
          {rows.map((o) => {
            const s = moneyStatus(o);
            return (
              <div key={o.id} className="flex flex-col gap-2 border-b border-ff-border-2 px-4 py-3.5 last:border-0">
                <div className="flex items-start justify-between gap-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-extrabold">{o.customerName ?? '—'}</div>
                    <div className="mt-px text-[12px] text-ff-muted">
                      {o.orderNumber ? `#${o.orderNumber} · ` : ''}
                      <span className="capitalize">{dayLabel(o.day)}</span> · {deliveryMeta(o)}
                    </div>
                  </div>
                  <span className="ff-fig shrink-0 text-[16.5px] font-extrabold">
                    {moneyFromStotinki(o.totalStotinki)}
                  </span>
                </div>
                <Contact o={o} />
                <div className="flex flex-wrap items-center gap-2">
                  <MethodPill method={o.paymentMethod} />
                  <StatusPill {...s} />
                </div>
              </div>
            );
          })}
        </div>

        {rows.length === 0 && (
          <EmptyRow loading={loading} searching={searching} empty="Още няма плащания." />
        )}
      </div>
      <LoadMore cursor={cursor} loadingMore={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}

function Contact({ o }: { o: PaymentOrder }) {
  if (!o.customerPhone && !o.customerEmail) {
    return <span className="text-[12.5px] text-ff-muted-2">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5 text-[12.5px]">
      {o.customerPhone && (
        <a
          href={`tel:${o.customerPhone}`}
          className="inline-flex items-center gap-1.5 font-semibold text-ff-ink-2 hover:text-ff-green-700"
        >
          <Phone size={12.5} className="shrink-0 text-ff-muted" />
          {o.customerPhone}
        </a>
      )}
      {o.customerEmail && (
        <a
          href={`mailto:${o.customerEmail}`}
          className="inline-flex min-w-0 items-center gap-1.5 text-ff-muted hover:text-ff-green-700"
        >
          <Mail size={12.5} className="shrink-0" />
          <span className="truncate">{o.customerEmail}</span>
        </a>
      )}
    </div>
  );
}

/* ─────────────────────────────  Наложен платеж (grouped by day)  ───────────────────────────── */

function CodView({ rows, loading, searching, cursor, loadingMore, onLoadMore }: ListProps) {
  const days = useMemo(() => groupByDay(rows), [rows]);
  return (
    <>
      <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <div className="flex items-center gap-2 text-[13px] font-extrabold">
          <Banknote size={16} className="text-ff-green-700" /> Пари в брой при доставка
        </div>
        <p className="mt-0.5 text-[12.5px] text-ff-muted">Групирани по ден на доставка.</p>

        {rows.length === 0 ? (
          <div className="mt-5">
            <EmptyRow
              loading={loading}
              searching={searching}
              empty="Още няма плащания с наложен платеж."
              bare
            />
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-5">
            {days.map((d) => (
              <div key={d.day}>
                <div className="mb-1 flex items-baseline justify-between border-b border-ff-border-2 pb-1.5">
                  <span className="text-[12.5px] font-extrabold capitalize text-ff-ink">
                    {dayLabel(d.day)}
                  </span>
                  <span className="ff-fig text-[13px] font-extrabold text-ff-green-800">
                    {moneyFromStotinki(d.totalStotinki)}
                  </span>
                </div>
                <ul className="flex flex-col divide-y divide-ff-border-2">
                  {d.orders.map((o) => {
                    const s = moneyStatus(o);
                    return (
                      <li key={o.id} className="flex items-center gap-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-semibold text-ff-ink">
                            {o.orderNumber ? `#${o.orderNumber}` : 'Поръчка'}
                            {o.customerName ? ` · ${o.customerName}` : ''}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-ff-muted">
                            <span>{deliveryMeta(o)}</span>
                            {o.customerPhone && (
                              <a
                                href={`tel:${o.customerPhone}`}
                                className="inline-flex items-center gap-1 hover:text-ff-green-700"
                              >
                                <Phone size={11} /> {o.customerPhone}
                              </a>
                            )}
                          </div>
                        </div>
                        <StatusPill {...s} />
                        <div className="ff-fig w-[84px] shrink-0 text-right text-[14px] font-extrabold">
                          {moneyFromStotinki(o.totalStotinki)}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
      <LoadMore cursor={cursor} loadingMore={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}

/* ─────────────────────────────  shared pills / tiles / states  ───────────────────────────── */

function EmptyRow({
  loading,
  searching,
  empty,
  bare,
}: {
  loading: boolean;
  searching: boolean;
  empty: string;
  bare?: boolean;
}) {
  const text = loading ? 'Зареждане…' : searching ? 'Няма резултати за това търсене.' : empty;
  return (
    <p className={cn('text-center text-sm text-ff-muted', bare ? '' : 'px-5 py-12')}>{text}</p>
  );
}

function LoadMore({
  cursor,
  loadingMore,
  onLoadMore,
}: {
  cursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (!cursor) return null;
  return (
    <div className="mt-5 flex justify-center">
      <button
        onClick={onLoadMore}
        disabled={loadingMore}
        className="inline-flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
      >
        {loadingMore && <Loader2 size={15} className="animate-spin" />}
        {loadingMore ? 'Зареждане…' : 'Зареди още'}
      </button>
    </div>
  );
}

function MethodPill({ method }: { method: PaymentChannel }) {
  const cod = method === 'cod';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11.5px] font-bold',
        cod ? 'bg-ff-badge-bg text-ff-badge-ink' : 'bg-ff-green-50 text-ff-green-700',
      )}
    >
      {cod ? <Banknote size={13} /> : <CreditCard size={13} />}
      {cod ? 'Наложен платеж' : 'Карта'}
    </span>
  );
}

function StatusPill({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={cn('shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-extrabold', cls)}>
      {label}
    </span>
  );
}

function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-3.5 py-3 shadow-ff-sm',
        accent ? 'border-ff-green-100 bg-ff-green-50' : 'border-ff-border bg-ff-surface',
      )}
    >
      <div className="text-[10px] font-extrabold uppercase leading-tight tracking-[0.03em] text-ff-muted">
        {label}
      </div>
      <div
        className={cn(
          'ff-fig mt-1 whitespace-nowrap text-[18px] font-extrabold tracking-[-0.01em]',
          accent && 'text-ff-green-800',
        )}
      >
        {value}
      </div>
      <div className="text-[11px] font-semibold text-ff-muted">{sub}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-2 py-2 text-[13px] font-bold transition-colors',
        active ? 'bg-ff-green-700 text-white' : 'text-ff-ink-2 hover:bg-ff-surface-2',
      )}
    >
      {children}
      {count != null && count > 0 && (
        <span
          className={cn(
            'ff-fig rounded-full px-1.5 text-[11px] font-extrabold',
            active ? 'bg-white/20 text-white' : 'bg-ff-surface-2 text-ff-muted',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/* ─────────────────────────────  Card payments (Stripe)  ───────────────────────────── */

/** Format an ISO date as "9 юни" (Bulgarian, day + month). */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('bg-BG', { day: 'numeric', month: 'long' });
  } catch {
    return '';
  }
}

/** Map a Stripe charge status to a Bulgarian label + tone. */
function stripeChargeStatus(status: string): { label: string; cls: string } {
  switch (status) {
    case 'succeeded':
      return { label: 'Платено', cls: 'bg-ff-green-100 text-ff-green-800' };
    case 'pending':
      return { label: 'Изчаква', cls: 'bg-ff-amber-softer text-ff-amber-600' };
    case 'failed':
      return { label: 'Неуспешно', cls: 'bg-ff-surface-2 text-ff-red' };
    default:
      return { label: status, cls: 'bg-ff-surface-2 text-ff-ink-2' };
  }
}

function StripeSection({
  summary,
  busy,
  onboard,
}: {
  summary: StripeSummary;
  busy: boolean;
  onboard: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2 text-[13px] font-extrabold">
          <CreditCard size={16} className="text-ff-green-700" /> Картови плащания
        </div>
        <p className="mt-0.5 text-[12.5px] text-ff-muted">
          Плащане с карта онлайн — парите идват по банковата ти сметка.
        </p>
      </div>
      {/* Platform hasn't enabled card payments (no Stripe secret key on the server). */}
      {!summary.enabled ? (
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 text-[14px] leading-[1.55] text-ff-ink-2 shadow-ff-sm">
          Картовите плащания още не са активирани от платформата. Свържи се с поддръжката, за да ги
          включим за твоята ферма.
        </div>
      ) : !summary.connected ? (
        // Not connected yet — explainer CTA. No Stripe account is created until the
        // farmer clicks "Свържи Stripe".
        <ConnectCta busy={busy} onStart={onboard} />
      ) : !summary.chargesEnabled ? (
        // Connected but onboarding isn't finished — Stripe still wants details.
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2.5 rounded-2xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3.5">
            <AlertTriangle size={18} className="mt-px shrink-0 text-ff-amber-600" />
            <div>
              <div className="text-[13.5px] font-extrabold text-ff-amber-600">Почти готово</div>
              <div className="text-[12.5px] leading-[1.45] text-ff-ink-2">
                Stripe иска още няколко данни (банкова сметка / документ), за да активира плащанията.
              </div>
            </div>
          </div>
          <Button
            variant="primary"
            onClick={onboard}
            disabled={busy}
            className="self-start rounded-sm px-6 py-3 text-[15px]"
          >
            <CreditCard size={18} /> {busy ? 'Отваряне…' : 'Довърши регистрацията'}
          </Button>
        </div>
      ) : (
        // Fully connected — native FarmFlow dashboard.
        <StripeDashboard summary={summary} />
      )}
    </section>
  );
}

function StripeDashboard({ summary }: { summary: StripeSummary }) {
  return (
    <div className="flex flex-col gap-4">
      {/* status header */}
      <div className="flex flex-wrap items-center gap-3.5 rounded-2xl border border-ff-green-100 bg-ff-green-50 px-5 py-4">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-ff-green-600 shadow-[0_0_0_4px_rgba(56,112,64,0.18)]" />
        <div className="min-w-0">
          <div className="text-[15px] font-extrabold text-ff-green-800">
            Свързано · приемаш плащания с карта
          </div>
          <div className="text-[12.5px] font-semibold text-ff-green-700">
            {summary.payoutsEnabled
              ? 'Картовите плащания и изплащанията са активни.'
              : 'Картовите плащания са активни.'}
          </div>
        </div>
        <a
          href={STRIPE_DASHBOARD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-ff-green-500 bg-ff-surface px-3.5 py-2 text-[12.5px] font-extrabold text-ff-green-700 transition-colors hover:bg-ff-green-50"
        >
          <ExternalLink size={15} /> Отвори Stripe
        </a>
      </div>

      {/* payout / balance card */}
      <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <div className="mb-1 flex items-center gap-2 text-[13px] font-extrabold">
          <Wallet size={16} className="text-ff-green-700" /> Кога идват парите
        </div>
        <p className="mb-3 text-[12.5px] text-ff-muted">Следващо изплащане по банковата ти сметка</p>
        {summary.nextPayout ? (
          <>
            <div className="ff-fig text-[30px] font-extrabold tracking-[-0.01em]">
              {moneyFromStotinki(summary.nextPayout.amountStotinki)}
            </div>
            <div className="text-[12.5px] font-semibold text-ff-muted">
              очаквано {formatDate(summary.nextPayout.arrivalDate)}
            </div>
          </>
        ) : (
          <div className="text-[14px] font-semibold text-ff-ink-2">Няма предстоящо изплащане.</div>
        )}
        <div className="mt-4 flex gap-2.5">
          <Mini k="Налично сега" v={moneyFromStotinki(summary.availableStotinki)} />
          <Mini k="Изчакващо" v={moneyFromStotinki(summary.pendingStotinki)} />
        </div>
      </div>

      {/* recent payments (native) */}
      <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold">
          <ArrowUpRight size={16} className="text-ff-green-700" /> Скорошни плащания
        </div>
        {summary.recentPayments.length === 0 ? (
          <div className="text-[13.5px] text-ff-muted">Още няма плащания.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-ff-border-2">
            {summary.recentPayments.map((p, i) => {
              const s = stripeChargeStatus(p.status);
              return (
                <li key={i} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-semibold text-ff-ink">
                      {p.description ?? 'Плащане'}
                    </div>
                    <div className="text-[11.5px] text-ff-muted">{formatDate(p.created)}</div>
                  </div>
                  <StatusPill {...s} />
                  <div className="ff-fig w-[84px] shrink-0 text-right text-[14px] font-extrabold">
                    {moneyFromStotinki(p.amountStotinki)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <a
          href={STRIPE_DASHBOARD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-[12px] font-bold text-ff-green-700 hover:underline"
        >
          Всички плащания в Stripe <ExternalLink size={12} />
        </a>
      </div>

      {/* commission transparency */}
      <p className="text-center text-[12px] text-ff-muted">
        {summary.feeBps > 0
          ? `Комисиона FarmFlow: ${summary.feeBps / 100}%`
          : 'Получаваш 100% от плащанията.'}
      </p>
    </div>
  );
}

function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex-1 rounded-xl border border-ff-border-2 bg-ff-surface-2 px-3 py-2.5">
      <div className="text-[9.5px] font-extrabold uppercase tracking-[0.03em] text-ff-muted">{k}</div>
      <div className="ff-fig mt-0.5 text-[16px] font-extrabold">{v}</div>
    </div>
  );
}

const CTA_STEPS = [
  'Натисни „Свържи Stripe“ — отваря се сигурната страница на Stripe.',
  'Попълни данните си и IBAN на банковата сметка (около 5 минути).',
  'Връщаш се готов — клиентите вече плащат с карта, парите идват при теб.',
];

function ConnectCta({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  return (
    <div className="rounded-2xl border border-ff-border bg-ff-surface p-8 shadow-ff-sm">
      <div className="text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-ff-green-100 text-ff-green-700">
          <CreditCard size={26} />
        </div>
        <h2 className="mb-2 text-[18px] font-extrabold">Приемай плащания с карта</h2>
        <p className="mx-auto mb-5 max-w-[460px] text-[13.5px] leading-[1.55] text-ff-muted">
          Свържи Stripe — услуга за картови плащания. Клиентите плащат онлайн, а парите идват
          директно при теб, по твоята банкова сметка. 0% комисиона върху поръчките.
        </p>
      </div>

      {/* what you need */}
      <div className="mx-auto max-w-[520px] rounded-xl border border-ff-border-2 bg-ff-surface-2 px-4 py-3">
        <div className="text-[10.5px] font-extrabold uppercase tracking-[0.03em] text-ff-muted">
          Какво ти трябва
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] font-semibold text-ff-ink-2">
          <span>Лична карта</span>
          <span>IBAN на сметката</span>
          <span>~5 минути</span>
        </div>
      </div>

      {/* steps */}
      <ol className="mx-auto mt-4 flex max-w-[520px] flex-col gap-2.5">
        {CTA_STEPS.map((s, i) => (
          <li key={i} className="flex items-start gap-3 text-[13.5px] leading-[1.5] text-ff-ink-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ff-green-700 text-[12px] font-extrabold text-[#EAF1E4]">
              {i + 1}
            </span>
            <span className="mt-0.5">{s}</span>
          </li>
        ))}
      </ol>

      <div className="mt-6 text-center">
        <Button
          variant="primary"
          onClick={onStart}
          disabled={busy}
          className="rounded-sm px-6 py-3 text-[15px]"
        >
          <CreditCard size={18} /> {busy ? 'Отваряне…' : 'Свържи Stripe'}
        </Button>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] font-semibold text-ff-muted-2">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck size={14} /> Сигурно · регистрацията се обработва от Stripe
          </span>
          <a href="/help#stripe-connect" className="text-ff-green-700 hover:underline">
            Виж пълния гид
          </a>
        </div>
      </div>
    </div>
  );
}
