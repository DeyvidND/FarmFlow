'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { cn, relDayLabel, type OrderStatus } from '@/lib/utils';
import { DateNavBar } from '@/components/production/date-nav-bar';
import { OrdersFeed } from '@/components/dashboard/orders-feed';
import { StoreReadinessCard, type StoreReadiness } from '@/components/dashboard/store-readiness-card';
import { OnboardingModal } from '@/components/dashboard/onboarding-modal';
import { OrderPanel } from '@/components/orders/order-panel';
import {
  ApiError,
  confirmPending,
  getTodaySummary,
  listOrders,
  updateOrderStatus,
} from '@/lib/api-client';
import type { Order, TodaySummary } from '@/lib/types';
import { PipelineStrip } from './pipeline-strip';
import { PrepTile, RouteTile, ProtocolsTile, CodTile } from './summary-tiles';
import { applyConfirmAll, markDelivered, bucketForStatus } from './today-logic';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/** „Днес" — the delivery-day operations cockpit that replaces the old „Табло"
 *  home. Owns the day's summary + feed and two inline mutations (confirm-all,
 *  mark-delivered) with optimistic updates + a lean re-fetch (no router.refresh). */
export default function TodayClient({
  summary: initialSummary,
  orders: initialOrders,
  date: initialDate,
  readiness,
  deliveryEnabled = false,
}: {
  summary: TodaySummary;
  orders: Order[];
  date: string;
  readiness?: StoreReadiness;
  /** Personal-delivery flag — hides the Маршрут tile when the farm doesn't deliver. */
  deliveryEnabled?: boolean;
}) {
  const router = useRouter();
  const [summary, setSummary] = useState(initialSummary);
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [date, setDate] = useState(initialDate);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = orders.find((o) => o.id === activeId) ?? null;

  // `orders` already comes from /orders?date= (delivery-day-scoped server-side,
  // via scheduledForDay) — re-filtering by createdAt here would drop every order
  // whose delivery slot day differs from its placement day. DateNavBar's loadDay
  // re-fetch is what keeps this the right set per day, not a client-side filter.
  const feed = orders;

  /** Switch days: re-fetch both the summary and the feed for `d` (client-side, no
   *  full server round-trip). */
  async function loadDay(d: string) {
    setDate(d);
    try {
      const [s, page] = await Promise.all([getTodaySummary(d), listOrders({ date: d, limit: 100 })]);
      setSummary(s);
      setOrders(page.items);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  /** «Потвърди всички» — confirm every «Нови» order for the day at once. The
   *  mutation and the post-mutation refetch are handled as separate failure
   *  domains: only a failed `confirmPending` rolls back the optimistic pipeline
   *  and shows an error — a refetch blip AFTER a successful confirm must not,
   *  since the confirm itself already succeeded server-side. */
  async function onConfirmAll() {
    const prev = summary;
    setConfirming(true);
    setSummary((s) => ({ ...s, pipeline: applyConfirmAll(s.pipeline) })); // optimistic
    try {
      await confirmPending(date);
    } catch (e) {
      setSummary(prev); // rollback — the confirm itself failed
      toast.error(errMsg(e));
      setConfirming(false);
      return;
    }
    toast.success('Поръчките са потвърдени');
    try {
      const [s, page] = await Promise.all([getTodaySummary(date), listOrders({ date, limit: 100 })]);
      setSummary(s);
      setOrders(page.items);
    } catch (e) {
      // Confirm already succeeded — a refetch blip is not a user-facing failure.
      // Leave the optimistic state in place rather than rolling back a real success.
      console.error('Днес: post-confirm refetch failed', e);
    } finally {
      setConfirming(false);
    }
  }

  /** Inline «Достави» from the feed — optimistic status + pipeline shift. */
  async function onDeliver(o: Order) {
    const prevOrders = orders;
    const prevSummary = summary;
    setBusy(true);
    setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status: 'delivered' } : x)));
    setSummary((s) => ({ ...s, pipeline: markDelivered(s.pipeline, bucketForStatus(o.status)) }));
    try {
      await updateOrderStatus(o.id, 'delivered');
      toast.success('Отбелязано като доставено');
    } catch (e) {
      setOrders(prevOrders);
      setSummary(prevSummary);
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  /** Status actions from the OrderPanel drawer — optimistic status update, then
   *  (mirroring onConfirmAll's failure-domain split) a lean re-fetch of both the
   *  summary and the feed so the pipeline/tiles reflect the change. Only a failed
   *  `updateOrderStatus` rolls back; a refetch blip after a successful update must
   *  not, since the update itself already succeeded server-side. */
  async function onAction(o: Order, status: OrderStatus) {
    const prevOrders = orders;
    setBusy(true);
    setOrders((p) => p.map((x) => (x.id === o.id ? { ...x, status } : x))); // optimistic
    try {
      await updateOrderStatus(o.id, status);
    } catch (e) {
      setOrders(prevOrders); // rollback — the update itself failed
      toast.error(errMsg(e));
      setBusy(false);
      return;
    }
    toast.success('Статусът е обновен');
    setActiveId(null);
    try {
      const [s, page] = await Promise.all([getTodaySummary(date), listOrders({ date, limit: 100 })]);
      setSummary(s);
      setOrders(page.items);
    } catch (e) {
      // Update already succeeded — a refetch blip is not a user-facing failure.
      console.error('Днес: post-action refetch failed', e);
    } finally {
      setBusy(false);
    }
  }

  const tiles = [
    <PrepTile key="prep" prep={summary.prep} index={0} />,
    deliveryEnabled ? <RouteTile key="route" route={summary.route} index={1} /> : null,
    <ProtocolsTile key="protocols" protocols={summary.protocols} index={2} />,
    <CodTile key="cod" cod={summary.cod} index={3} />,
  ].filter(Boolean);

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold tracking-[-0.01em] text-ff-ink">Днес</h1>
          <p className="text-[13.5px] text-ff-muted">Поръчки, подготовка, маршрут и пари за деня.</p>
        </div>
        <DateNavBar date={date} dateLabel={relDayLabel(date)} onSelect={loadDay} hrefBase="/dashboard" />
      </div>

      {/* Roadside quick action — a courier pulled over mid-delivery must reach
          the day's signed protocols in one tap from the landing screen, not
          three taps deep via the Протоколи tile → Проверка button. Only shown
          when there's anything to show for today. */}
      {summary.protocols.total > 0 && (
        <Link
          href="/protocols/check"
          className="mb-4 flex w-full items-center gap-[13px] rounded-[13px] border border-ff-border bg-ff-surface-2 p-[13px] text-left shadow-ff-sm transition hover:brightness-95"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ff-green-100 text-ff-green-700">
            <ShieldCheck size={22} />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 leading-[1.3]">
            <span className="text-[14.5px] font-extrabold text-ff-ink">Протоколи при проверка</span>
            <span className="text-[12.5px] text-ff-muted">
              {summary.protocols.signed} подписани за днес
            </span>
          </span>
        </Link>
      )}

      {readiness && <StoreReadinessCard readiness={readiness} />}
      {readiness && <OnboardingModal readiness={readiness} />}

      <PipelineStrip pipeline={summary.pipeline} onConfirmAll={onConfirmAll} confirming={confirming} />

      <div
        className={cn(
          'mt-4 grid gap-4 max-[1024px]:grid-cols-2 max-[640px]:grid-cols-1',
          deliveryEnabled ? 'grid-cols-4' : 'grid-cols-3',
        )}
      >
        {tiles}
      </div>

      <div className="mt-4">
        <OrdersFeed
          orders={feed}
          onOpen={setActiveId}
          onSeeAll={() => router.push('/orders')}
          onDeliver={onDeliver}
          busy={busy}
        />
      </div>

      {active && (
        <OrderPanel
          order={active}
          busy={busy}
          onClose={() => setActiveId(null)}
          onAction={(s) => onAction(active, s)}
          onSaved={(updated) => setOrders((p) => p.map((x) => (x.id === updated.id ? updated : x)))}
        />
      )}
    </div>
  );
}
