'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Package, Coins, Hourglass, Clock, CheckCheck, Route as RouteIcon, AlertTriangle, CreditCard, Info } from 'lucide-react';
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
import { ApiError, getDashboard, updateOrderStatus } from '@/lib/api-client';
import type { DashboardSummary, Order } from '@/lib/types';

const WEEKDAYS = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function DashboardClient({
  summary: initialSummary,
  initialOrders,
  nudgeCard = false,
  readiness,
}: {
  summary: DashboardSummary;
  initialOrders: Order[];
  /** Standard plan, billing live, no card yet — nudge them to add one. */
  nudgeCard?: boolean;
  /** First-run store-readiness signals — drives the getting-started checklist. */
  readiness?: StoreReadiness;
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

  const feed = orders.filter((o) => o.createdAt.slice(0, 10) === summary.date);
  const codPending = feed.filter((o) => o.status === 'pending' && o.paymentStatus === 'cash');
  const active = orders.find((o) => o.id === activeId) ?? null;

  const delta = summary.orderDelta;
  const ns = summary.nextSlot;
  const stats = [
    { Icon: Package, label: 'Поръчки днес', value: summary.orderCount, sub: `${delta >= 0 ? '+' : ''}${delta} спрямо вчера`, tone: 'green' as const },
    { Icon: Coins, label: 'Оборот днес', value: moneyFromStotinki(summary.revenueStotinki), sub: 'без отказани', tone: 'amber' as const },
    { Icon: Hourglass, label: 'Чакат потвърждение', value: summary.pendingCount, sub: summary.pendingCount ? 'изискват действие' : 'всичко чисто', tone: 'amber' as const },
    { Icon: Clock, label: 'Следващ свободен слот', value: ns ? `${hhmm(ns.timeFrom)} – ${hhmm(ns.timeTo)}` : '—', sub: ns ? 'свободен' : 'няма свободни', tone: 'green' as const },
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

      {/* stat cards */}
      <div className="grid grid-cols-4 gap-4 max-[1024px]:grid-cols-2 max-[640px]:grid-cols-1">
        {stats.map((s, i) => (
          <StatCard key={s.label} {...s} index={i} />
        ))}
      </div>

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
                  <span className="text-[14.5px] font-extrabold">Прегледай наложен платеж</span>
                  <span className="text-[12.5px] opacity-80">{codPending.length} с наложен платеж</span>
                </span>
              </button>

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
            </div>
          </div>

          {/* slots — each holds one order, so it's simply free or taken */}
          <div className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-3.5 flex items-center justify-between">
              <h2 className="text-[16.5px] font-extrabold">Слотове днес</h2>
              <span className="text-[12.5px] font-bold capitalize text-ff-muted">{weekday}</span>
            </div>
            {summary.slots.length === 0 ? (
              <p className="text-[13px] text-ff-muted">Няма слотове за деня.</p>
            ) : (
              summary.slots.map((s) => {
                const taken = s.booked >= 1;
                return (
                  <div key={s.id} className="mb-2.5 flex items-center justify-between text-[13px] last:mb-0">
                    <span className="font-semibold text-ff-ink-2">
                      {hhmm(s.timeFrom)} – {hhmm(s.timeTo)}
                    </span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11.5px] font-bold',
                        taken
                          ? 'bg-ff-gray-badge-bg text-ff-muted-2'
                          : 'bg-ff-green-50 text-ff-green-700',
                      )}
                    >
                      {taken ? 'Зает' : 'Свободен'}
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
