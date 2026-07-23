'use client';

import { useState } from 'react';
import { AlertTriangle, Check, Clock, Copy, Mail, MapPin, MapPinned, Navigation, Phone } from 'lucide-react';
import { toast } from 'sonner';
import { cn, moneyFromStotinki } from '@/lib/utils';
import type { RouteStop } from '@/lib/types';
import { isMajorRoadAddress } from './major-road';
import { windowShiftDeltaMin } from './delivery-window-shift';
import { TimeInput24 } from './time-input-24';

interface StopListProps {
  stops: RouteStop[];
  activeId: string | null;
  onPick: (id: string) => void;
  onOpenMaps: (stop: RouteStop) => void;
  onCall: (stop: RouteStop) => void;
  onEmail: (stop: RouteStop) => void;
  /** Open the „Смени адрес" modal for this stop. */
  onEditAddress: (stop: RouteStop) => void;
  /** Total courier count for this date — the per-stop courier-move select only
   *  renders when there's more than one (task #6). */
  courierCount?: number;
  /** The day's REAL leg numbers (route.courierIndex per leg), in tab order.
   *  On a board day with a gap (e.g. legs [0, 2]) these are non-contiguous —
   *  the move-select's option values must be these legs, not 0..count-1, or a
   *  move would pin the order to an unassigned leg (silently treated as auto).
   *  Falls back to 0..courierCount-1 when absent (legacy dropdown days). */
  courierLegs?: number[];
  /** Move a stop to another courier's leg, or back to auto (null) (task #6). */
  onMoveCourier?: (stopId: string, courierIndex: number | null) => void;
  /** Edit a stop's delivery-window START inline (organizer only); the backend
   *  cascades the same delta to every later stop on the leg (task #13 / WP9).
   *  Absent (e.g. driver view) → the window badge stays read-only. */
  onShiftWindow?: (stopId: string, deltaMin: number) => void;
}

/**
 * Editable delivery-window badge (organizer). Editing the START time commits a
 * signed-minute delta; the backend shifts this stop AND every later stop on the
 * same courier leg by it (so „+5 мин" moves the rest of the day +5). The end and
 * status color mirror the read-only badge. Remounted (via a key on the start
 * value) after a refresh so it always reflects the persisted time.
 */
function WindowShiftBadge({
  stopId,
  start,
  end,
  status,
  onShift,
}: {
  stopId: string;
  start: string;
  end: string;
  status: string | null;
  onShift: (stopId: string, deltaMin: number) => void;
}) {
  const approved = status === 'approved' || status === 'sent';
  return (
    <span
      onClick={(e) => e.stopPropagation()}
      title="Промени часа — следващите спирки на този куриер се изтеглят със същото време"
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold',
        approved ? 'bg-ff-green-100 text-ff-green-800' : 'bg-ff-amber-softer text-ff-amber-600',
      )}
    >
      {status === 'sent' ? <Check size={11} /> : <Clock size={11} />}
      <TimeInput24
        value={start}
        onCommit={(next) => {
          const delta = windowShiftDeltaMin(start, next);
          if (delta != null && delta !== 0) onShift(stopId, delta);
        }}
        ariaLabel="Начален час на доставка"
        className="w-[46px] bg-transparent font-bold tabular-nums outline-none"
      />
      <span>–{end}</span>
    </span>
  );
}

/** A stop is "on the map" only when it has been geocoded (has both coords). */
const isLocated = (s: RouteStop) => s.lat != null && s.lng != null;

/** Copy-to-clipboard contact value with a brief "copied" tick + toast. */
function CopyLine({
  icon,
  value,
  href,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  href: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} копиран`);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error('Копирането не успя');
    }
  };
  return (
    <div className="flex items-center gap-[5px] text-[13px] text-ff-ink-2">
      <span className="shrink-0 text-ff-muted">{icon}</span>
      {/* the value itself is a tap-to-call / tap-to-mail link AND selectable text */}
      <a
        href={href}
        onClick={(e) => e.stopPropagation()}
        className="truncate font-semibold text-ff-green-800 hover:underline"
        title={value}
      >
        {value}
      </a>
      <button
        onClick={copy}
        title={`Копирай ${label.toLowerCase()}`}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ff-muted transition hover:bg-ff-surface-2 hover:text-ff-ink-2"
      >
        {copied ? <Check size={13} className="text-ff-green-700" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

export function StopList({
  stops,
  activeId,
  onPick,
  onOpenMaps,
  onCall,
  onEmail,
  onEditAddress,
  courierCount,
  courierLegs,
  onMoveCourier,
  onShiftWindow,
}: StopListProps) {
  // Real leg numbers the move-select can target (see StopListProps.courierLegs).
  const legs = courierLegs ?? Array.from({ length: courierCount ?? 0 }, (_, i) => i);
  if (stops.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-14 text-center text-ff-muted">
        <div className="mb-3 grid h-[52px] w-[52px] place-items-center rounded-[14px] bg-ff-green-50 text-ff-green-600">
          <Navigation size={26} />
        </div>
        <div className="text-[15px] font-bold text-ff-ink-2">Няма спирки за този ден</div>
        <div className="mt-0.5 text-[13.5px]">Потвърдените поръчки с доставка до адрес се появяват тук.</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {stops.map((s, i) => {
        const on = activeId === s.id;
        const located = isLocated(s);
        return (
          <div
            key={s.id}
            onClick={() => onPick(s.id)}
            data-on={on}
            className={cn(
              'flex cursor-pointer gap-[13px] border-b border-ff-border-2 px-[18px] py-3.5 transition-colors',
              on ? 'bg-ff-green-50' : 'hover:bg-ff-surface-2',
            )}
          >
            {/* number bead + connector */}
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13.5px] font-extrabold',
                  on ? 'bg-ff-green-700 text-white' : 'bg-ff-green-100 text-ff-green-800',
                )}
              >
                {i + 1}
              </span>
              {i < stops.length - 1 && <span className="mt-1 min-h-[14px] w-0.5 flex-1 bg-ff-border" />}
            </div>

            {/* details */}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <div className="text-[14.5px] font-bold">{s.customer ?? 'Клиент'}</div>
                  {/* delivery time-window badge (task #13, display only) — color
                      reflects review status: draft=amber, approved/sent=green. */}
                  {s.deliveryWindowStart &&
                    (onShiftWindow ? (
                      <WindowShiftBadge
                        key={`${s.id}:${s.deliveryWindowStart}`}
                        stopId={s.id}
                        start={s.deliveryWindowStart}
                        end={s.deliveryWindowEnd ?? ''}
                        status={s.deliveryWindowStatus}
                        onShift={onShiftWindow}
                      />
                    ) : (
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold',
                          s.deliveryWindowStatus === 'approved' || s.deliveryWindowStatus === 'sent'
                            ? 'bg-ff-green-100 text-ff-green-800'
                            : 'bg-ff-amber-softer text-ff-amber-600',
                        )}
                        title={
                          s.deliveryWindowStatus === 'sent'
                            ? 'Часът е изпратен на клиента'
                            : s.deliveryWindowStatus === 'approved'
                              ? 'Часът е одобрен'
                              : 'Предложен час (чернова)'
                        }
                      >
                        {s.deliveryWindowStatus === 'sent' ? <Check size={11} /> : <Clock size={11} />}
                        {s.deliveryWindowStart}–{s.deliveryWindowEnd}
                      </span>
                    ))}
                </div>
                <div className="flex shrink-0 gap-[7px]">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditAddress(s);
                    }}
                    title="Смени адрес"
                    className="grid h-8 w-8 max-[680px]:h-10 max-[680px]:w-10 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
                  >
                    <MapPinned size={16} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenMaps(s);
                    }}
                    title="Отвори в Google Maps"
                    className="grid h-8 w-8 max-[680px]:h-10 max-[680px]:w-10 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
                  >
                    <Navigation size={16} />
                  </button>
                  {/* Call shows ONLY when there's a phone — no dead button */}
                  {s.phone && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCall(s);
                      }}
                      title={`Обади се на ${s.phone}`}
                      className="grid h-8 w-8 max-[680px]:h-10 max-[680px]:w-10 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
                    >
                      <Phone size={16} />
                    </button>
                  )}
                  {s.email && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onEmail(s);
                      }}
                      title={`Имейл до ${s.email}`}
                      className="grid h-8 w-8 max-[680px]:h-10 max-[680px]:w-10 place-items-center rounded-[9px] bg-ff-green-100 text-ff-green-700 transition hover:brightness-95"
                    >
                      <Mail size={16} />
                    </button>
                  )}
                </div>
              </div>

              {/* address + "not on the map" guard flag for un-geocoded stops */}
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ff-ink-2">
                <span className="flex min-w-0 items-center gap-[5px]">
                  <MapPin size={14} className="shrink-0" />
                  <span className="line-clamp-2 break-words">{s.address ?? 'Няма адрес'}</span>
                </span>
                {s.note && (
                  <span className="w-full pl-[19px] text-[12px] text-ff-muted">{s.note}</span>
                )}
                {!located && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditAddress(s);
                    }}
                    title="Адресът не е намерен — натисни, за да поправиш"
                    className="inline-flex items-center gap-1 rounded-md border border-ff-amber-soft bg-ff-amber-softer px-1.5 py-0.5 text-[11px] font-bold text-ff-amber-600 transition hover:brightness-95"
                  >
                    <AlertTriangle size={11} /> не е на картата — поправи
                  </button>
                )}
                {located && isMajorRoadAddress(s.address) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditAddress(s);
                    }}
                    title="Голям път — премести пина на близка уличка за удобно спиране"
                    className="inline-flex items-center gap-1 rounded-md border border-ff-amber-soft bg-ff-amber-softer px-1.5 py-0.5 text-[11px] font-bold text-ff-amber-600 transition hover:brightness-95"
                  >
                    <AlertTriangle size={11} /> голям път — спри на близка уличка
                  </button>
                )}
              </div>

              {/* full reachable contact info — visible & copyable, not just icons */}
              <div className="mt-1.5 flex flex-col gap-1">
                {s.phone ? (
                  <CopyLine
                    icon={<Phone size={13} />}
                    value={s.phone}
                    href={`tel:${s.phone.replace(/\s+/g, '')}`}
                    label="Телефон"
                  />
                ) : (
                  <div className="flex items-center gap-[5px] text-[12.5px] text-ff-muted">
                    <Phone size={13} /> няма телефон
                  </div>
                )}
                {s.email ? (
                  <CopyLine
                    icon={<Mail size={13} />}
                    value={s.email}
                    href={`mailto:${s.email}`}
                    label="Имейл"
                  />
                ) : (
                  <div className="flex items-center gap-[5px] text-[12.5px] text-ff-muted">
                    <Mail size={13} /> няма имейл
                  </div>
                )}
              </div>

              {/* move this order to another courier's leg, or back to auto (task #6) */}
              {!!courierCount && courierCount > 1 && onMoveCourier && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[12px] font-bold text-ff-ink-2">
                  <span className="text-ff-muted">Куриер</span>
                  <select
                    value={s.courierIndex ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = e.target.value;
                      onMoveCourier(s.id, v === '' ? null : Number(v));
                    }}
                    className="rounded-lg border border-ff-border bg-ff-surface-2 px-1.5 py-1 text-[12px] font-bold text-ff-ink outline-none"
                  >
                    <option value="">Авто</option>
                    {legs.map((leg) => (
                      <option key={leg} value={leg}>{`Куриер ${leg + 1}`}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="mt-1.5 text-[12.5px] text-ff-muted">{s.summary}</div>
              {/* order value: goods + (delivery, if any) + total with delivery (task #4) */}
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ff-muted">
                <span>Стоки {moneyFromStotinki(s.itemsSubtotalStotinki)}</span>
                {s.deliveryFeeStotinki > 0 && (
                  <span>Доставка {moneyFromStotinki(s.deliveryFeeStotinki)}</span>
                )}
                <span className="font-extrabold text-ff-ink-2">
                  Общо {moneyFromStotinki(s.totalStotinki)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
