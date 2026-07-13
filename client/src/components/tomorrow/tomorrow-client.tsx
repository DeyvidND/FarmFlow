'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, Mail, Check, Loader2, AlertTriangle, PackageCheck } from 'lucide-react';
import { toast } from 'sonner';
import { cn, hhmm } from '@/lib/utils';
import {
  ApiError,
  getTomorrow,
  setFulfillment,
  type TomorrowOrder,
  type FulfillmentState,
} from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const STATE_LABEL: Record<FulfillmentState, string> = {
  pending: 'Чака',
  in_production: 'В процес',
  fulfilled: 'Готово',
};

const STATE_CLS: Record<FulfillmentState, string> = {
  pending: 'bg-ff-amber-softer text-ff-amber-600',
  in_production: 'bg-ff-surface-2 text-ff-muted',
  fulfilled: 'bg-ff-green-100 text-ff-green-800',
};

const DELIVERY_LABEL: Record<string, string> = {
  pickup: 'На място',
  address: 'Доставка',
  econt: 'Еконт офис',
  econt_address: 'Еконт до адрес',
  courier: 'Куриер',
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
          className="inline-flex items-center gap-1.5 text-ff-muted hover:text-ff-green-700"
        >
          <Mail size={12.5} className="shrink-0" />
          {o.customerEmail}
        </a>
      )}
    </div>
  );
}

/**
 * Task #14 — «Утре»: tomorrow's confirmed orders, self-tracked prep state
 * (pending → in_production → fulfilled), and the customer's contact so the
 * farmer knows exactly whom to call about a gap. Every order not yet
 * 'fulfilled' is a potential gap — surfaced in a banner up top.
 */
export function TomorrowClient({
  initial,
  role,
  farmers = [],
  multiFarmer = false,
  defaultFarmerId = '',
}: {
  initial: TomorrowOrder[];
  role?: 'admin' | 'farmer';
  /** Owner-only producer picker (multi-farmer shops); mirrors Плащания/Статистика. */
  farmers?: { id: string; name: string }[];
  multiFarmer?: boolean;
  /** Owner-only: the sole farmer (single-farmer shop, auto, no picker) or the
   *  first producer (multi-farmer shop, switchable). Ignored for role='farmer'
   *  — the token always resolves its own scope server-side. */
  defaultFarmerId?: string;
}) {
  const showPicker = role === 'admin' && multiFarmer && farmers.length > 1;
  const [farmerId, setFarmerId] = useState(defaultFarmerId);
  const [orders, setOrders] = useState<TomorrowOrder[]>(initial);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (role === 'admin' && !farmerId) return;
    let live = true;
    setLoading(true);
    getTomorrow(role === 'admin' ? farmerId : undefined)
      .then((rows) => {
        if (live) setOrders(rows);
      })
      .catch((e) => {
        if (live) toast.error(errMsg(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [farmerId, role]);

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

  const gaps = orders.filter((o) => o.fulfillmentState !== 'fulfilled');
  const day = orders[0]?.day;

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Утре</h1>
          <p className="text-[13.5px] text-ff-muted">
            Поръчките за утре{day ? ` (${day})` : ''} — отбелязвай ги, докато ги приготвяш.
          </p>
        </div>
        {showPicker && (
          <label className="inline-flex items-center gap-2 text-[13px] font-bold text-ff-ink-2">
            Фермер:
            <select
              value={farmerId}
              onChange={(e) => setFarmerId(e.target.value)}
              className="h-10 rounded-xl border border-ff-border bg-ff-surface px-2.5 text-[13px] font-semibold text-ff-ink-2 shadow-ff-sm outline-none focus:border-ff-green-500"
            >
              {farmers.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

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

      {loading && (
        <p className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-ff-muted">
          <Loader2 size={14} className="animate-spin" /> Зареждане…
        </p>
      )}

      {orders.length === 0 ? (
        <div className="rounded-xl border border-ff-border bg-ff-surface px-5 py-12 text-center text-[13.5px] text-ff-muted shadow-ff-sm">
          <PackageCheck size={28} className="mx-auto mb-2 text-ff-muted-2" />
          Няма поръчки за утре.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((o) => (
            <li
              key={o.id}
              className="rounded-[12px] border border-ff-border bg-ff-surface p-4 shadow-ff-sm"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-extrabold text-ff-ink">
                    №{o.orderNumber ?? '—'}
                  </span>
                  <span className="text-[12.5px] text-ff-muted">{deliveryMeta(o)}</span>
                </div>
                <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', STATE_CLS[o.fulfillmentState])}>
                  {STATE_LABEL[o.fulfillmentState]}
                </span>
              </div>

              <div className="mb-2 text-[13.5px] font-bold text-ff-ink-2">{o.customerName ?? '—'}</div>
              <Contact o={o} />

              <ul className="my-2.5 flex flex-col gap-0.5 text-[12.5px] text-ff-muted">
                {o.items.map((it) => (
                  <li key={it.productId}>
                    {it.productName} × {it.quantity}
                  </li>
                ))}
              </ul>

              {o.fulfillmentState !== 'fulfilled' && (
                <div className="flex flex-wrap gap-1.5">
                  {o.fulfillmentState === 'pending' && (
                    <button
                      type="button"
                      onClick={() => void onMark(o.id, 'in_production')}
                      disabled={busyId === o.id}
                      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-ff-border bg-ff-surface-2 px-2.5 py-1 text-[11px] font-extrabold text-ff-ink-2 hover:bg-ff-border-2 disabled:opacity-60"
                    >
                      {busyId === o.id ? <Loader2 size={12} className="animate-spin" /> : null}
                      Започвам
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void onMark(o.id, 'fulfilled')}
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
      )}
    </div>
  );
}
