'use client';

import { X, Phone, MapPin, Package, CalendarClock, Check, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/status-badge';
import { moneyFromStotinki, hhmm, timeFromIso, type OrderStatus } from '@/lib/utils';
import type { Order } from '@/lib/types';

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
  const slotLabel = order.slotFrom && order.slotTo ? `${hhmm(order.slotFrom)} – ${hhmm(order.slotTo)}` : '—';
  const deliveryVal =
    order.deliveryType === 'econt' ? order.econtOffice ?? 'Еконт офис' : order.deliveryAddress ?? '—';
  const deliveryLabel = order.deliveryType === 'econt' ? 'Еконт офис' : 'Адрес за доставка';

  return (
    <>
      <div onClick={onClose} className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.32)]" />
      <aside className="animate-ff-slide-in fixed right-0 top-0 z-[41] flex h-full w-[460px] max-w-[94vw] flex-col bg-ff-surface shadow-ff-lg max-[680px]:w-full max-[680px]:max-w-full">
        <div className="flex items-center justify-between border-b border-ff-border-2 px-6 py-[18px]">
          <div>
            <div className="mb-0.5 text-[12.5px] font-bold text-ff-muted">ПОРЪЧКА #{order.id.slice(0, 8)}</div>
            <h2 className="text-[22px] font-extrabold tracking-[-0.015em]">{order.customerName ?? 'Клиент'}</h2>
          </div>
          <button onClick={onClose} aria-label="Затвори" className="grid h-10 w-10 place-items-center rounded-[11px] border border-ff-border bg-ff-surface-2 text-ff-ink-2">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mb-5 flex items-center gap-2.5">
            <StatusBadge status={order.status} size="md" />
            <span className="text-[13px] text-ff-muted">· приета в {timeFromIso(order.createdAt)}</span>
          </div>

          <div className="mb-[22px] flex flex-col gap-2.5">
            <InfoRow icon={<Phone size={18} />} label="Телефон" value={order.customerPhone ?? '—'} />
            <InfoRow
              icon={order.deliveryType === 'econt' ? <Package size={18} /> : <MapPin size={18} />}
              label={deliveryLabel}
              value={deliveryVal}
            />
            <InfoRow icon={<CalendarClock size={18} />} label="Слот за доставка" value={slotLabel} />
          </div>

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
            <Button variant="danger" disabled={busy} onClick={() => onAction('cancelled')} className="w-full rounded-sm">
              <X size={18} /> Откажи
            </Button>
          )}
        </div>
      </aside>
    </>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
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
