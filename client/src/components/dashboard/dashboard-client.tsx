'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Package, Coins, Hourglass, Clock, CheckCheck, Route as RouteIcon, AlertTriangle, CreditCard, ClipboardCheck, Info, Truck, Settings, Users } from 'lucide-react';
import { toast } from 'sonner';
import { cn, moneyFromStotinki, hhmm, type OrderStatus } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { HelpModal } from '@/components/delivery/ui';
import { DASHBOARD_HELP } from '@/lib/help-content';
import { StatCard } from './stat-card';
import { StoreReadinessCard, type StoreReadiness } from './store-readiness-card';
import { OrdersFeed } from './orders-feed';
import { OrderPanel } from '@/components/orders/order-panel';
import { CodReviewDrawer } from '@/components/orders/cod-review-drawer';
import { ApiError, getDashboard, pendingReviewCount, updateOrderStatus } from '@/lib/api-client';
import type { DashboardSummary, Order } from '@/lib/types';

const WEEKDAYS = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function DashboardClient({
  summary: initialSummary,
  initialOrders,
  nudgeCard = false,
  readiness,
  deliveryEnabled = false,
}: {
  summary: DashboardSummary;
  initialOrders: Order[];
  /** Standard plan, billing live, no card yet — nudge them to add one. */
  nudgeCard?: boolean;
  /** First-run store-readiness signals — drives the getting-started checklist. */
  readiness?: StoreReadiness;
  /** Personal-delivery flag — hides the route quick-action when the farm doesn't deliver. */
  deliveryEnabled?: boolean;
}) {
  const router = useRouter();
  // Local so a status action can refresh ONLY the summary (one lean /dashboard
  // call) instead of router.refresh() re-running the whole server page — which
  // also re-fetched /orders?limit=100 (discarded here) and the Stripe-backed
  // /billing/summary nudge on every single click.
  const [summary, setSummary] = useState(initialSummary);
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const [codReviewOpen, setCodReviewOpen] = useState(false);
  // Surfaced up front so a farmer-submitted product doesn't sit invisible until
  // the operator happens to open Продукти — the review queue itself has no other
  // proactive nudge (products-client.tsx's badge only shows once you're already there).
  const [pendingProducts, setPendingProducts] = useState(0);
  useEffect(() => {
    let alive = true;
    pendingReviewCount()
      .then((r) => {
        if (alive) setPendingProducts(r.count);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const feed = orders.filter((o) => o.createdAt.slice(0, 10) === summary.date);
  const codPending = feed.filter((o) => o.status === 'pending' && o.paymentStatus === 'cash');
  const active = orders.find((o) => o.id === activeId) ?? null;

  const delta = summary.orderDelta;
  const ns = summary.nextSlot;
  const stats = [
    { Icon: Package, label: 'Поръчки днес', value: summary.orderCount, sub: `${delta >= 0 ? '+' : ''}${delta} спрямо вчера`, tone: 'green' as const },
    { Icon: Coins, label: 'Оборот днес', value: moneyFromStotinki(summary.revenueStotinki), sub: 'без отказани и доставка', tone: 'amber' as const },
    { Icon: Hourglass, label: 'Чакат потвърждение', value: summary.pendingCount, sub: summary.pendingCount ? 'изискват действие' : 'всичко чисто', tone: 'amber' as const },
    {
      Icon: Clock,
      label: 'Свободни места днес',
      value: ns ? `${Math.max(0, ns.capacity - ns.booked)}` : '—',
      sub: ns ? 'свободни' : 'няма свободни',
      tone: 'green' as const,
    },
  ];

  const weekday = WEEKDAYS[new Date(`${summary.date}T00:00:00`).getDay()];

  /** Refresh just the stat cards / capacity bars (revenue, pending, next slot)
   *  via the single lean dashboard endpoint after an order action. */
  async function refreshSummary() {
    try {
      setSummary(await getDashboard(summary.date));
    } catch {
      /* keep the current figures if the refresh fails */
    }
  }

  function confirmAll() {
    if (!codPending.length) {
      toast.info('Няма чакащи поръчки с наложен платеж');
      return;
    }
    setCodReviewOpen(true);
  }

  async function codConfirm(o: Order) {
    const prev = o.status;
    setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status: 'confirmed' } : x)));
    setBusy(true);
    try {
      await updateOrderStatus(o.id, 'confirmed');
      toast.success('Статусът е обновен', {
        action: { label: 'Отмени', onClick: () => void revertStatus(o.id, prev) },
      });
      void refreshSummary();
    } catch (e) {
      setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status: prev } : x)));
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function codReject(o: Order) {
    const prev = o.status;
    setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status: 'cancelled' } : x)));
    setBusy(true);
    try {
      await updateOrderStatus(o.id, 'cancelled');
      toast.success('Поръчката е отказана', {
        action: { label: 'Отмени', onClick: () => void revertStatus(o.id, prev) },
      });
      void refreshSummary();
    } catch (e) {
      setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status: prev } : x)));
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function codConfirmRemaining(list: Order[]) {
    if (!list.length) return;
    const prevStatuses = list.map((o) => ({ id: o.id, status: o.status }));
    setOrders((p) => p.map((x) => (list.some((o) => o.id === x.id) ? { ...x, status: 'confirmed' } : x)));
    setBusy(true);
    try {
      await Promise.all(list.map((o) => updateOrderStatus(o.id, 'confirmed')));
      toast.success(`${list.length} поръчки потвърдени`);
      void refreshSummary();
      setCodReviewOpen(false);
    } catch (e) {
      setOrders((p) =>
        p.map((x) => {
          const prev = prevStatuses.find((s) => s.id === x.id);
          return prev ? { ...x, status: prev.status } : x;
        }),
      );
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function revertStatus(id: string, to: OrderStatus) {
    setOrders((p) => p.map((x) => (x.id === id ? { ...x, status: to } : x))); // optimistic
    try {
      await updateOrderStatus(id, to);
      toast.success('Върнато');
      void refreshSummary();
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  useEffect(() => {
    if (codReviewOpen && codPending.length === 0) setCodReviewOpen(false);
  }, [codReviewOpen, codPending.length]);

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
      void refreshSummary();
    } catch (e) {
      setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status: prev } : x)));
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-[18px] flex items-center justify-between gap-3">
        <p className="text-sm capitalize text-ff-muted">{weekday}</p>
        <Button variant="ghost" size="sm" onClick={() => setHelp(true)}>
          <Info size={16} /> Обяснения
        </Button>
      </div>

      {readiness && <StoreReadinessCard readiness={readiness} />}

      {!summary.subscriptionActive && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3">
          <AlertTriangle size={18} className="mt-px shrink-0 text-ff-amber-600" />
          <div className="text-[13px] leading-[1.45] text-ff-ink-2">
            <span className="font-bold text-ff-amber-600">Абонаментът е неактивен.</span>{' '}
            Виждаш само последните 7 дни поръчки. Поднови, за да възстановиш пълния достъп.
          </div>
        </div>
      )}

      {nudgeCard && summary.subscriptionActive && (
        <Link
          href="/payments"
          className="mb-4 flex items-center gap-3 rounded-xl border border-ff-green-100 bg-ff-green-50 px-4 py-3 no-underline transition-colors hover:bg-ff-green-100/60"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ff-green-100 text-ff-green-700">
            <CreditCard size={18} />
          </span>
          <div className="flex-1 text-[13px] leading-[1.45] text-ff-ink-2">
            <span className="font-bold text-ff-green-800">Добави карта за абонамента.</span>{' '}
            За да продължи магазинът да работи без прекъсване, добави карта за плащане.
          </div>
          <span className="shrink-0 text-[12.5px] font-extrabold text-ff-green-700">Добави →</span>
        </Link>
      )}

      {pendingProducts > 0 && (
        <Link
          href="/products"
          className="mb-4 flex items-center gap-3 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3 no-underline transition-colors hover:brightness-[0.97]"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ff-amber-soft text-ff-amber-600">
            <ClipboardCheck size={18} />
          </span>
          <div className="flex-1 text-[13px] leading-[1.45] text-ff-ink-2">
            <span className="font-bold text-ff-amber-600">
              {pendingProducts} {pendingProducts === 1 ? 'продукт чака' : 'продукта чакат'} проверка.
            </span>{' '}
            Фермер добави продукт — прегледай и одобри, за да се появи в магазина.
          </div>
          <span className="shrink-0 text-[12.5px] font-extrabold text-ff-amber-600">Провери →</span>
        </Link>
      )}

      {/* stat cards */}
      <div className="grid grid-cols-4 gap-4 max-[1024px]:grid-cols-2 max-[640px]:grid-cols-1">
        {stats.map((s, i) => (
          <StatCard key={s.label} {...s} index={i} />
        ))}
      </div>

      {summary.deliveryRevenueStotinki > 0 && (
        <div className="mt-2.5 flex items-center gap-2 text-[13px] text-ff-muted">
          <Truck size={15} className="shrink-0 text-ff-ink-2" />
          <span>
            Такси за доставка днес (не влизат в оборота):{' '}
            <span className="font-bold text-ff-ink-2">{moneyFromStotinki(summary.deliveryRevenueStotinki)}</span>
          </span>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[1.6fr_1fr] items-start gap-4 max-[900px]:grid-cols-1">
        <OrdersFeed orders={feed} onOpen={setActiveId} onSeeAll={() => router.push('/orders')} />

        <div className="flex flex-col gap-4">
          {/* quick actions */}
          <div className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <h2 className="mb-1 text-[16.5px] font-extrabold">Бързи действия</h2>
            <p className="mb-4 text-[13px] leading-[1.45] text-ff-muted">Започни деня с няколко клика.</p>
            <div className="flex flex-col gap-2.5">
              <button
                onClick={confirmAll}
                disabled={busy}
                className="flex w-full items-center gap-[13px] rounded-[13px] bg-ff-amber p-[13px] text-left text-[#3a2a08] transition hover:brightness-95 disabled:opacity-60"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-white/35">
                  <CheckCheck size={22} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5 leading-[1.3]">
                  <span className="text-[14.5px] font-extrabold">Провери и потвърди поръчките</span>
                  <span className="text-[12.5px] opacity-80">{codPending.length} чакат потвърждение (наложен платеж)</span>
                </span>
              </button>

              {deliveryEnabled && (
                <button
                  onClick={() => router.push('/route')}
                  className="flex w-full items-center gap-[13px] rounded-[13px] border border-ff-border bg-ff-surface-2 p-[13px] text-left transition hover:brightness-95"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ff-green-100 text-ff-green-700">
                    <RouteIcon size={22} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5 leading-[1.3]">
                    <span className="text-[14.5px] font-extrabold text-ff-ink">Виж маршрута за днес</span>
                    <span className="text-[12.5px] text-ff-muted">Планирай доставките за деня</span>
                  </span>
                </button>
              )}

              {/* Standing shortcut to the config hub — not just the first-run
                  onboarding modal. A farmer who forgot where to turn on card
                  payment / courier weeks later shouldn't have to dig 3 taps
                  through Настройки → Конфигурации to find it again. */}
              <Link
                href="/settings"
                className="flex w-full items-center gap-[13px] rounded-[13px] border border-ff-border bg-ff-surface-2 p-[13px] text-left transition hover:brightness-95"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ff-green-100 text-ff-green-700">
                  <Settings size={22} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5 leading-[1.3]">
                  <span className="text-[14.5px] font-extrabold text-ff-ink">Настрой магазина</span>
                  <span className="text-[12.5px] text-ff-muted">Плащане, доставка, функции и реклама</span>
                </span>
              </Link>
            </div>
          </div>

          {/* slots — free while booked is below capacity */}
          <div className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-3.5 flex items-center justify-between">
              <h2 className="text-[16.5px] font-extrabold">Часове днес</h2>
              <span className="text-[12.5px] font-bold capitalize text-ff-muted">{weekday}</span>
            </div>
            {summary.slots.length === 0 ? (
              <p className="text-[13px] text-ff-muted">Няма часове за деня.</p>
            ) : (
              summary.slots.map((s) => {
                const cap = s.capacity ?? 1;
                const taken = s.booked >= cap;
                return (
                  <div key={s.id} className="mb-2.5 flex items-center justify-between text-[13px] last:mb-0">
                    <span className="font-semibold text-ff-ink-2">
                      {s.timeFrom && s.timeTo ? `${hhmm(s.timeFrom)} – ${hhmm(s.timeTo)}` : 'Цял ден'}
                    </span>
                    <span
                      title={cap > 1 ? (taken ? 'Запълнен' : `Още ${cap - s.booked} свободни`) : undefined}
                      className={cn(
                        'flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11.5px] font-bold',
                        taken
                          ? 'bg-ff-gray-badge-bg text-ff-muted-2'
                          : 'bg-ff-green-50 text-ff-green-700',
                      )}
                    >
                      {cap > 1 ? (
                        <>
                          <Users size={11} strokeWidth={2.75} />
                          {s.booked}/{cap}
                        </>
                      ) : taken ? (
                        'Зает'
                      ) : (
                        'Свободен'
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {active && (
        <OrderPanel
          order={active}
          busy={busy}
          onClose={() => setActiveId(null)}
          onAction={(s) => onAction(active, s)}
          onSaved={(updated) => {
            setOrders((p) => p.map((x) => (x.id === updated.id ? updated : x)));
          }}
        />
      )}

      {codReviewOpen && codPending.length > 0 && (
        <CodReviewDrawer
          orders={codPending}
          busy={busy}
          onConfirm={codConfirm}
          onReject={codReject}
          onConfirmRemaining={codConfirmRemaining}
          onClose={() => setCodReviewOpen(false)}
        />
      )}

      {help && <HelpModal {...DASHBOARD_HELP} onClose={() => setHelp(false)} />}
    </div>
  );
}
