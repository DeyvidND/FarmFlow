'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Package, Coins, Hourglass, Clock, CheckCheck, Route as RouteIcon, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { cn, moneyFromStotinki, hhmm, type OrderStatus } from '@/lib/utils';
import { StatCard } from './stat-card';
import { OrdersFeed } from './orders-feed';
import { OrderPanel } from '@/components/orders/order-panel';
import { ApiError, confirmPendingOrders, updateOrderStatus } from '@/lib/api-client';
import type { DashboardSummary, Order } from '@/lib/types';

const WEEKDAYS = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function DashboardClient({
  summary,
  initialOrders,
}: {
  summary: DashboardSummary;
  initialOrders: Order[];
}) {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const feed = orders.filter((o) => o.createdAt.slice(0, 10) === summary.date);
  const pendingCount = feed.filter((o) => o.status === 'pending').length;
  const active = orders.find((o) => o.id === activeId) ?? null;

  const delta = summary.orderDelta;
  const ns = summary.nextSlot;
  const stats = [
    { Icon: Package, label: 'Поръчки днес', value: summary.orderCount, sub: `${delta >= 0 ? '+' : ''}${delta} спрямо вчера`, tone: 'green' as const },
    { Icon: Coins, label: 'Оборот днес', value: moneyFromStotinki(summary.revenueStotinki), sub: 'без отказани', tone: 'amber' as const },
    { Icon: Hourglass, label: 'Чакат потвърждение', value: summary.pendingCount, sub: summary.pendingCount ? 'изискват действие' : 'всичко чисто', tone: 'amber' as const },
    { Icon: Clock, label: 'Следващ слот', value: ns ? `${ns.booked}/${ns.maxOrders}` : '—', sub: ns ? `${hhmm(ns.timeFrom)} – ${hhmm(ns.timeTo)}` : 'няма свободни', tone: 'green' as const },
  ];

  const weekday = WEEKDAYS[new Date(`${summary.date}T00:00:00`).getDay()];

  async function confirmAll() {
    if (!pendingCount) {
      toast.info('Няма чакащи поръчки');
      return;
    }
    setBusy(true);
    try {
      const { confirmed } = await confirmPendingOrders(summary.date);
      setOrders((p) =>
        p.map((o) =>
          o.createdAt.slice(0, 10) === summary.date && o.status === 'pending'
            ? { ...o, status: 'confirmed' }
            : o,
        ),
      );
      toast.success(`${confirmed} поръчки потвърдени`);
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAction(o: Order, status: OrderStatus) {
    setBusy(true);
    const prev = o.status;
    setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status } : x)));
    try {
      await updateOrderStatus(o.id, status);
      toast.success('Статусът е обновен');
      setActiveId(null);
      router.refresh();
    } catch (e) {
      setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status: prev } : x)));
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      {!summary.subscriptionActive && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-4 py-3">
          <AlertTriangle size={18} className="mt-px shrink-0 text-ff-amber-600" />
          <div className="text-[13px] leading-[1.45] text-ff-ink-2">
            <span className="font-bold text-ff-amber-600">Абонаментът е неактивен.</span>{' '}
            Виждаш само последните 7 дни поръчки. Поднови, за да възстановиш пълния достъп.
          </div>
        </div>
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
                  <span className="text-[14.5px] font-extrabold">Потвърди всички чакащи</span>
                  <span className="text-[12.5px] opacity-80">{pendingCount} поръчки</span>
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

          {/* capacity */}
          <div className="rounded-xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
            <div className="mb-3.5 flex items-center justify-between">
              <h2 className="text-[16.5px] font-extrabold">Капацитет днес</h2>
              <span className="text-[12.5px] font-bold capitalize text-ff-muted">{weekday}</span>
            </div>
            {summary.slots.length === 0 ? (
              <p className="text-[13px] text-ff-muted">Няма слотове за деня.</p>
            ) : (
              summary.slots.map((s) => {
                const ratio = s.maxOrders ? s.booked / s.maxOrders : 0;
                const tone =
                  s.booked >= s.maxOrders
                    ? { bar: 'bg-ff-muted-2', txt: 'text-ff-muted-2' }
                    : ratio >= 0.8
                      ? { bar: 'bg-ff-amber', txt: 'text-ff-amber' }
                      : { bar: 'bg-ff-green-500', txt: 'text-ff-green-500' };
                return (
                  <div key={s.id} className="mb-3 last:mb-0">
                    <div className="mb-[5px] flex justify-between text-[13px]">
                      <span className="font-semibold text-ff-ink-2">
                        {hhmm(s.timeFrom)} – {hhmm(s.timeTo)}
                      </span>
                      <span className={cn('font-bold', tone.txt)}>
                        {s.booked}/{s.maxOrders}
                      </span>
                    </div>
                    <div className="h-[7px] overflow-hidden rounded-full bg-ff-border-2">
                      <div
                        className={cn('h-full rounded-full transition-[width] duration-300', tone.bar)}
                        style={{ width: `${Math.round(ratio * 100)}%` }}
                      />
                    </div>
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
    </div>
  );
}
