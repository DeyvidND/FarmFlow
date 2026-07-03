'use client';

import { useState } from 'react';
import { X, Phone, Mail, MapPin, Package, CalendarClock, Check, Truck, CreditCard, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StatusBadge } from '@/components/status-badge';
import { PaymentBadge } from './payment-badge';
import { moneyFromStotinki, hhmm, timeFromIso, relDayLabel, statusMeta, type OrderStatus } from '@/lib/utils';
import { ApiError, requestDeliveryHandoff } from '@/lib/api-client';
import type { Order } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function OrderPanel({
  order,
  busy,
  onClose,
  onAction,
}: {
  order: Order;
  busy?: boolean;
  onClose: () => void;
  onAction: (status: OrderStatus) => void;
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  return (
    <>
      <div onClick={onClose} className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.32)]" />
      <aside className="animate-ff-slide-in fixed right-0 top-0 z-[41] flex h-full w-[460px] max-w-[94vw] flex-col bg-ff-surface shadow-ff-lg max-[680px]:w-full max-[680px]:max-w-full">
        <div className="flex items-center justify-between border-b border-ff-border-2 px-6 py-[18px]">
          <div>
            <div className="mb-0.5 text-[12.5px] font-bold text-ff-muted">
              ПОРЪЧКА {order.orderNumber != null ? `#${order.orderNumber}` : `#${order.id.slice(0, 8)}`}
            </div>
            <h2 className="text-[22px] font-extrabold tracking-[-0.015em]">{order.customerName ?? 'Клиент'}</h2>
          </div>
          <button onClick={onClose} aria-label="Затвори" className="grid h-10 w-10 place-items-center rounded-[11px] border border-ff-border bg-ff-surface-2 text-ff-ink-2">
            <X size={20} />
          </button>
        </div>

        <OrderDetailBody order={order} />

        <div className="flex flex-col gap-2.5 border-t border-ff-border-2 px-6 py-5">
          {order.status === 'pending' && (
            <Button variant="primary" disabled={busy} onClick={() => onAction('confirmed')} className="w-full rounded-sm">
              <Check size={18} /> Потвърди
            </Button>
          )}
          {(order.status === 'pending' || order.status === 'confirmed') && (
            <Button variant="soft" disabled={busy} onClick={() => onAction('delivered')} className="w-full rounded-sm">
              <Truck size={18} /> Маркирай доставена
            </Button>
          )}
          {order.status !== 'cancelled' && order.status !== 'delivered' && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => setConfirmingCancel(true)}
              className="w-full rounded-sm"
            >
              <X size={18} /> Откажи
            </Button>
          )}

          <div className="flex items-center gap-2.5 border-t border-ff-border-2 pt-3.5">
            <label htmlFor="order-status-override" className="shrink-0 text-xs font-bold text-ff-muted">
              Промени статус
            </label>
            <select
              id="order-status-override"
              value={order.status}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value as OrderStatus;
                if (next !== order.status) onAction(next);
              }}
              className="flex-1 rounded-sm border border-ff-border bg-ff-surface-2 px-2.5 py-2 text-[13px] font-semibold text-ff-ink outline-none transition-colors focus:border-ff-green-500 disabled:opacity-60"
            >
              {(Object.keys(statusMeta) as OrderStatus[]).map((s) => (
                <option key={s} value={s}>
                  {statusMeta[s].label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </aside>

      {confirmingCancel && (
        <ConfirmDialog
          tone="danger"
          title="Отказване на поръчката?"
          message={
            <>
              Поръчката на <b>{order.customerName ?? 'клиента'}</b> ще бъде отказана.
              {order.slotFrom && order.slotTo ? ' Запазеният час за доставка се освобождава.' : ''}{' '}
              Веднага след това можеш да я върнеш със „Отмени“ в съобщението.
            </>
          }
          confirmLabel="Откажи поръчката"
          cancelLabel="Назад"
          busy={busy}
          onCancel={() => setConfirmingCancel(false)}
          onConfirm={() => {
            setConfirmingCancel(false);
            onAction('cancelled');
          }}
        />
      )}
    </>
  );
}

export function OrderDetailBody({ order }: { order: Order }) {
  const slotWindow = order.slotFrom && order.slotTo ? `${hhmm(order.slotFrom)} – ${hhmm(order.slotTo)}` : '';
  const slotLabel = slotWindow
    ? order.slotDate
      ? `${relDayLabel(order.slotDate)} · ${slotWindow}`
      : slotWindow
    : '—';
  const paymentValue =
    order.paymentStatus === 'paid'
      ? order.paidAt
        ? `Платена с карта · ${timeFromIso(order.paidAt)}`
        : 'Платена с карта'
      : order.paymentStatus === 'pending_online'
        ? 'Чака онлайн плащане'
        : 'Наложен платеж / при доставка';
  const isEcont = order.deliveryType === 'econt' || order.deliveryType === 'econt_address';
  const deliveryBase =
    order.deliveryType === 'econt'
      ? order.econtOffice ?? 'Еконт офис'
      : order.deliveryType === 'pickup'
        ? 'Чайка, Варна'
        : order.deliveryAddress ?? '—';
  // Append the block/entrance detail so the farmer/driver sees бл./вх. inline.
  const deliveryVal =
    order.deliveryType === 'address' && order.deliveryNote
      ? `${deliveryBase} · ${order.deliveryNote}`
      : deliveryBase;
  const deliveryLabel =
    order.deliveryType === 'econt'
      ? 'Еконт — до офис'
      : order.deliveryType === 'econt_address'
        ? 'Еконт — до адрес'
        : order.deliveryType === 'pickup'
          ? 'Вземане от пазара'
          : 'Адрес за доставка';

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <StatusBadge status={order.status} size="md" />
        <PaymentBadge status={order.paymentStatus} size="md" />
        <span className="text-[13px] text-ff-muted">· приета в {timeFromIso(order.createdAt)}</span>
      </div>

      <div className="mb-[22px] flex flex-col gap-2.5">
        <InfoRow icon={<Phone size={18} />} label="Телефон" value={order.customerPhone ?? '—'} />
        {order.customerEmail && (
          <InfoRow icon={<Mail size={18} />} label="Имейл" value={order.customerEmail} />
        )}
        <InfoRow
          icon={isEcont ? <Package size={18} /> : <MapPin size={18} />}
          label={deliveryLabel}
          value={deliveryVal}
        />
        <InfoRow icon={<CalendarClock size={18} />} label="Ден и час за доставка" value={slotLabel} />
        <InfoRow icon={<CreditCard size={18} />} label="Плащане" value={paymentValue} />
      </div>

      {/* Bridge to the separate Доставки app — товарителницата за тази поръчка
          не се създава тук, а там. Без тази линия фермерът не знае накъде да
          продължи с куриерска поръчка. */}
      {isEcont && <EcontHandoffLink />}

      {order.notes && (
        <div className="mb-[22px] rounded-xl border border-ff-amber-soft bg-ff-amber-softer px-3.5 py-3">
          <div className="mb-0.5 text-xs font-bold text-ff-amber-600">БЕЛЕЖКА ОТ КЛИЕНТА</div>
          <div className="text-[13.5px] leading-[1.45] text-ff-ink-2">{order.notes}</div>
        </div>
      )}

      <div className="mb-2.5 text-[13px] font-bold text-ff-muted">ПРОДУКТИ</div>
      <div className="mb-4 overflow-hidden rounded-xl border border-ff-border-2">
        {order.items.map((it, i) => (
          <div
            key={it.id}
            className={`flex items-center justify-between px-3.5 py-3 ${i < order.items.length - 1 ? 'border-b border-ff-border-2' : ''}`}
          >
            <span className="text-sm font-semibold">{it.productName}</span>
            <span className="text-[13.5px] font-bold text-ff-muted">× {it.quantity}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-1">
        <span className="text-[15px] font-bold">Общо</span>
        <span className="ff-fig text-[22px] font-extrabold tracking-[-0.02em]">
          {moneyFromStotinki(order.totalStotinki)}
        </span>
      </div>
    </div>
  );
}

/** One-click SSO into the separate Доставки app, landing on Пратки where this
 *  order's courier draft is waiting. Same login, no second sign-in. */
function EcontHandoffLink() {
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    try {
      const { token } = await requestDeliveryHandoff();
      const base = process.env.NEXT_PUBLIC_DELIVERY_URL ?? 'https://dostavki.fermeribg.com';
      window.open(
        `${base}/api/session/handoff?token=${encodeURIComponent(token)}&next=${encodeURIComponent('/shipments')}`,
        '_blank',
        'noopener',
      );
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      className="mb-[22px] flex w-full items-center gap-2.5 rounded-xl border border-ff-green-100 bg-ff-green-50 px-3.5 py-3 text-left text-[13px] font-semibold text-ff-green-800 transition hover:bg-ff-green-100/60 disabled:opacity-60"
    >
      <Truck size={17} className="shrink-0 text-ff-green-700" />
      <span className="flex-1">Товарителницата за тази поръчка се създава в приложението „Доставки“.</span>
      <ExternalLink size={15} className="shrink-0 text-ff-green-700" />
    </button>
  );
}

export function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-ff-border-2 bg-ff-surface-2 text-ff-green-700">
        {icon}
      </span>
      <div className="pt-px">
        <div className="text-xs font-semibold text-ff-muted">{label}</div>
        <div className="mt-px text-sm font-semibold text-ff-ink">{value}</div>
      </div>
    </div>
  );
}
